/**
 * Circuit breaker + daily loss/gas budget limits (Phase 6).
 *
 * WHAT THIS IS: a single in-process gate that submit()-style call sites
 * check BEFORE sending a transaction. It does not touch quoting, gas
 * estimation, or simulation — those remain scanner.js's job. This module
 * only answers one question: "given everything observed so far today, is
 * it still safe to submit another transaction?"
 *
 * WHY THIS EXISTS: simulateExecution() (the pre-flight eth_call) already
 * catches routes that would revert given the exact calldata at simulation
 * time. It does NOT catch:
 *   - a run of REAL on-chain losses from confirmed-but-unprofitable fills
 *     (e.g. sandwiched despite simulation, oracle/price movement between
 *     simulate and confirm, a mispriced adapter)
 *   - a string of consecutive submission/confirmation failures suggesting
 *     something structural is wrong (bad RPC, misconfigured contract,
 *     nonce desync, an adapter silently broken) rather than one-off bad
 *     luck
 *   - cumulative gas spend running away across many small submissions,
 *     none of which individually looked alarming
 * A circuit breaker is the backstop for exactly these "confirmed harm
 * despite every prior check passing" scenarios. Fail loudly and stop
 * trading is always the correct default over "keep trying and hope."
 *
 * WHAT THIS DOES NOT DO: it does not retry, resubmit, or adjust gas — see
 * txReplace.js / gasPricer.js for that. It does not persist across
 * process restarts (in-memory only, resets at UTC midnight or process
 * start) — a restart-persistent ledger is a real-money-ops decision
 * (which DB, what retention, multi-instance coordination) explicitly out
 * of scope here, same reasoning as bot/graph/metrics.js's header comment
 * on why it doesn't pull in a metrics backend.
 */

// UTC day boundary, not local time, since "daily" limits on an
// always-on bot should mean the same wall-clock instant everywhere this
// runs, not wherever the operator's machine happens to be.
function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

class CircuitBreaker {
  /**
   * @param {object} opts
   * @param {bigint} opts.dailyLossLimitWei - max cumulative realized loss
   *   (in the start-token's wei units, i.e. WETH per gasCostInStartToken's
   *   existing WETH-only assumption) before trading halts for the day.
   * @param {bigint} opts.dailyGasBudgetWei - max cumulative gas spend
   *   (successful submissions only, in wei) before trading halts for the
   *   day, independent of whether those submissions were individually
   *   profitable — a runaway high-gas-price period souring EVERY trade's
   *   economics is a real failure mode this catches even if each trade
   *   still cleared its own profit floor at submission time.
   * @param {number} opts.maxConsecutiveFailures - trip the breaker after
   *   this many consecutive submit/confirm failures in a row (reset to 0
   *   by any success). Independent of loss/gas totals — this catches
   *   "something is structurally broken" even before it's cost real
   *   money (e.g. every tx reverting on-chain despite passing
   *   simulation, which smells like a race/reentrancy/nonce problem).
   * @param {(msg: string) => void} [opts.onTrip] - called once, the
   *   instant the breaker trips, with a human-readable reason. Wire this
   *   to whatever alerting exists (console.error today; a page/Slack
   *   webhook later) — trading silently stopping with no signal is its
   *   own operational risk.
   */
  constructor({ dailyLossLimitWei, dailyGasBudgetWei, maxConsecutiveFailures, onTrip = null }) {
    if (dailyLossLimitWei < 0n) throw new Error("dailyLossLimitWei must be >= 0");
    if (dailyGasBudgetWei < 0n) throw new Error("dailyGasBudgetWei must be >= 0");
    if (!Number.isInteger(maxConsecutiveFailures) || maxConsecutiveFailures < 1) {
      throw new Error("maxConsecutiveFailures must be a positive integer");
    }

    this.dailyLossLimitWei = dailyLossLimitWei;
    this.dailyGasBudgetWei = dailyGasBudgetWei;
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.onTrip = onTrip;

    this._dayKey = utcDayKey();
    this._realizedLossWei = 0n;
    this._gasSpentWei = 0n;
    this._consecutiveFailures = 0;

    // Manual trip is separate from the daily counters so an operator (or
    // an external monitor) can halt trading immediately for a reason this
    // module has no way to compute itself (e.g. "contract found to have a
    // bug", "RPC provider is misbehaving") without waiting for a
    // threshold to be crossed.
    this._manuallyTripped = false;
    this._tripReason = null;
  }

  /// Rolls daily counters over if UTC midnight has passed since the last
  /// check. Called at the top of every public method so callers never
  /// have to think about day boundaries themselves.
  _rollDayIfNeeded() {
    const today = utcDayKey();
    if (today !== this._dayKey) {
      console.log(
        `circuitBreaker: new UTC day (${this._dayKey} -> ${today}) — resetting daily loss/gas ` +
        `counters and consecutive-failure count. Manual trip state is NOT reset by a day roll; ` +
        "call reset() explicitly if the underlying issue has been confirmed fixed."
      );
      this._dayKey = today;
      this._realizedLossWei = 0n;
      this._gasSpentWei = 0n;
      this._consecutiveFailures = 0;
    }
  }

  _trip(reason) {
    if (this._manuallyTripped) return; // already tripped; don't re-fire onTrip
    this._manuallyTripped = true;
    this._tripReason = reason;
    console.error(`circuitBreaker: TRIPPED — ${reason}`);
    if (this.onTrip) {
      try {
        this.onTrip(reason);
      } catch (err) {
        console.error("circuitBreaker: onTrip callback itself threw:", err.message);
      }
    }
  }

  /// Returns { allowed: boolean, reason?: string }. Call this
  /// immediately before every submit() attempt — the one required
  /// integration point.
  checkAllowed() {
    this._rollDayIfNeeded();
    if (this._manuallyTripped) {
      return { allowed: false, reason: this._tripReason };
    }
    return { allowed: true };
  }

  /// Record a CONFIRMED transaction outcome. `lossWei` is the realized
  /// loss in start-token wei for this fill (0n for a profitable or
  /// break-even trade — this is specifically for tracking harm, not
  /// total volume). `gasWei` is the actual gas cost paid (gasUsed *
  /// effectiveGasPrice from the receipt), always recorded regardless of
  /// profitability, per this module's header comment on gas-budget being
  /// independent of loss.
  recordFill({ lossWei = 0n, gasWei = 0n }) {
    this._rollDayIfNeeded();
    if (lossWei < 0n || gasWei < 0n) {
      throw new Error("recordFill: lossWei and gasWei must both be >= 0");
    }

    this._realizedLossWei += lossWei;
    this._gasSpentWei += gasWei;
    this._consecutiveFailures = 0; // any confirmed fill, profitable or not, is not a "failure"

    if (this._realizedLossWei > this.dailyLossLimitWei) {
      this._trip(
        `daily realized loss ${this._realizedLossWei} wei exceeds limit ${this.dailyLossLimitWei} wei`
      );
    }
    if (this._gasSpentWei > this.dailyGasBudgetWei) {
      this._trip(
        `daily gas spend ${this._gasSpentWei} wei exceeds budget ${this.dailyGasBudgetWei} wei`
      );
    }
  }

  /// Record a submission/confirmation FAILURE (revert, dropped tx that
  /// never lands after every replacement attempt is exhausted, RPC error
  /// preventing submission, etc.) — distinct from recordFill(), which is
  /// only for transactions that actually confirmed on-chain.
  recordFailure(reason) {
    this._rollDayIfNeeded();
    this._consecutiveFailures += 1;
    console.warn(
      `circuitBreaker: recorded failure (${this._consecutiveFailures}/${this.maxConsecutiveFailures} ` +
      `before trip): ${reason}`
    );
    if (this._consecutiveFailures >= this.maxConsecutiveFailures) {
      this._trip(`${this._consecutiveFailures} consecutive submission/confirmation failures: ${reason}`);
    }
  }

  /// Explicit manual halt, for an operator or external monitor that has
  /// its own reason to stop trading immediately.
  tripManually(reason) {
    this._trip(`manually tripped: ${reason}`);
  }

  /// Clears manual-trip state. Does NOT clear daily loss/gas/failure
  /// counters — those only reset on a UTC day roll, so re-enabling
  /// trading mid-day after a manual trip still respects whatever budget
  /// remains for today. Requires an explicit reason so a reset always
  /// leaves an audit trail of who/why in the logs, same discipline as
  /// _trip()'s required reason.
  reset(reason) {
    if (!reason) throw new Error("reset() requires a reason, for the audit trail.");
    console.log(`circuitBreaker: manually reset (was tripped: ${this._tripReason}). Reason: ${reason}`);
    this._manuallyTripped = false;
    this._tripReason = null;
  }

  snapshot() {
    this._rollDayIfNeeded();
    return {
      dayKey: this._dayKey,
      realizedLossWei: this._realizedLossWei,
      dailyLossLimitWei: this.dailyLossLimitWei,
      gasSpentWei: this._gasSpentWei,
      dailyGasBudgetWei: this.dailyGasBudgetWei,
      consecutiveFailures: this._consecutiveFailures,
      maxConsecutiveFailures: this.maxConsecutiveFailures,
      tripped: this._manuallyTripped,
      tripReason: this._tripReason,
    };
  }
}

module.exports = { CircuitBreaker, utcDayKey };
