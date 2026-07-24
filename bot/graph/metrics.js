/**
 * Structured metrics for the graph scanner (Phase 5).
 *
 * WHAT THIS IS: a small in-process counter/timer/histogram store plus a
 * periodic summary log line. Nothing here influences a decision anywhere
 * in the pipeline — it only observes it. That's a deliberate scope
 * boundary: Phase 5 in the review is "performance improvements" via
 * visibility (quote latency, cache stats, simulation success rate, route
 * profitability), not new filtering or execution logic. Phases 1-4
 * already own every decision this scanner makes; this module only reports
 * on how those decisions played out.
 *
 * WHY NOT A METRICS LIBRARY (prom-client, statsd, etc.): this project has
 * no metrics backend wired up yet (no Prometheus scrape endpoint, no
 * statsd sink configured anywhere in bot/config.js), and adding one is a
 * deployment/ops decision, not a code one — pulling in a client library
 * for a backend that may not exist yet would be dead weight. This module
 * is deliberately backend-agnostic: it accumulates in memory and logs a
 * structured summary line periodically (parseable by any log-shipping
 * setup) and exposes a snapshot() for anything that wants to read the
 * numbers directly (e.g. a future HTTP /metrics endpoint, or a test).
 * Swapping in a real backend later means changing this module's internals,
 * not every call site that reports a metric.
 *
 * WHAT THIS DOES NOT DO: no persistence across restarts (in-memory only —
 * see Phase 5's "structured metrics" item; a historical profitability
 * database is explicitly out of scope, same as graph-scanner.js's header
 * comment already says about negativeCycle.js's ranking). No alerting. No
 * export to an external system. Adding any of those is a separate,
 * larger decision (what backend, what retention, what alerting policy)
 * that shouldn't be smuggled in under "add metrics."
 */

class Metrics {
  constructor() {
    // name -> count
    this._counters = new Map();
    // name -> { count, sum, min, max } in milliseconds
    this._timers = new Map();
    // startedAt, for uptime in the summary line
    this._startedAtMs = Date.now();
  }

  /// Increment a named counter by `by` (default 1). Counters are the
  /// right shape for anything that's a running total of discrete events —
  /// scan cycles run, candidates found/filtered/rejected (per reason),
  /// quotes attempted/failed, simulations attempted/succeeded/reverted,
  /// submissions attempted/confirmed/failed.
  incr(name, by = 1) {
    this._counters.set(name, (this._counters.get(name) || 0) + by);
  }

  /// Record one observed duration (ms) under `name`. Used for quote
  /// latency (time spent inside batchQuote), simulation latency (time
  /// spent inside simulateExecution), and full scan-cycle latency (time
  /// spent inside one scanOnce() call) — the three latencies the review's
  /// Phase 5 item explicitly calls out ("quote latency monitoring").
  recordDuration(name, durationMs) {
    const existing = this._timers.get(name);
    if (!existing) {
      this._timers.set(name, { count: 1, sum: durationMs, min: durationMs, max: durationMs });
      return;
    }
    existing.count += 1;
    existing.sum += durationMs;
    if (durationMs < existing.min) existing.min = durationMs;
    if (durationMs > existing.max) existing.max = durationMs;
  }

  /// Convenience wrapper: times an async function, records the duration
  /// under `name` regardless of success/failure (a slow failing quote is
  /// still latency worth seeing), and re-throws/returns exactly as the
  /// wrapped function would — this must be transparent to the caller, or
  /// wrapping a call in timeAsync() could itself change scanOnce()'s
  /// control flow, which a pure observability module must never do.
  async timeAsync(name, fn) {
    const startedAt = Date.now();
    try {
      return await fn();
    } finally {
      this.recordDuration(name, Date.now() - startedAt);
    }
  }

  /// Plain-object snapshot of every counter/timer so far, with derived
  /// avg/min/max per timer — used both by the periodic summary log line
  /// and by anything else that wants the raw numbers (a future /metrics
  /// endpoint, or a test asserting on specific values).
  snapshot() {
    const counters = Object.fromEntries(this._counters.entries());
    const timers = {};
    for (const [name, t] of this._timers.entries()){
      timers[name] = {
        count: t.count,
        avgMs: Math.round((t.sum / t.count) * 10) / 10,
        minMs: t.min,
        maxMs: t.max,
      };
    }
    return {
      uptimeSec: Math.round((Date.now() - this._startedAtMs) / 1000),
      counters,
      timers,
    };
  }

  /// One structured, single-line summary — deliberately one console.log
  /// call with a JSON payload (not a multi-line pretty-print) so a log
  /// aggregator can parse/index it as one event, per this module's header
  /// comment on being log-shipping-friendly without assuming a specific
  /// backend.
  logSummary() {
    console.log(`[metrics] ${JSON.stringify(this.snapshot())}`);
  }

  /// Starts a periodic logSummary() call. Returns a function that stops
  /// it — callers (graph-scanner.js's main()) should keep this and call
  /// it on shutdown, same pattern as LiquidityGraph.close()/watchBlockNumber's
  /// unwatch functions, so nothing is left as a dangling, unstoppable timer.
  startPeriodicLogging(intervalMs) {
    const handle = setInterval(() => this.logSummary(), intervalMs);
    return () => clearInterval(handle);
  }
}

module.exports = { Metrics };
