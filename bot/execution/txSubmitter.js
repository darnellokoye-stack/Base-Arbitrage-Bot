/**
 * Transaction submission with retry/replacement, wired to nonceManager,
 * gasPricer, and circuitBreaker (Phase 6).
 *
 * WHAT THIS IS: the successor to scanner.js's plain submit() — same
 * external contract (send this calldata, wait for confirmation, report
 * what happened) but with:
 *   - a circuit-breaker check before every attempt
 *   - locally-tracked nonces (nonceManager) instead of trusting a fresh
 *     eth_getTransactionCount on every call
 *   - adaptive EIP-1559 fees (gasPricer) instead of a bare writeContract
 *     with no explicit fee control
 *   - automatic fee-bumped replacement if a transaction doesn't confirm
 *     within a configurable number of blocks, up to a configurable
 *     number of attempts
 *   - circuit-breaker recording of every real outcome (recordFill on
 *     confirmation, recordFailure on exhausted retries/reverts)
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not decide WHETHER to
 * submit — that remains evaluateAndMaybeSubmit()'s job (profitability
 * check, simulateExecution pre-flight). This module starts from "yes,
 * submit this exact calldata" and is responsible only for getting that
 * decision onto the chain reliably, or failing loudly and reporting why.
 * The existing txInFlight single-flight guard in scanner.js is preserved
 * by callers (this module doesn't manage concurrency across DIFFERENT
 * candidate routes, only the lifecycle of the one transaction it's
 * given).
 */

/**
 * @param {object} deps
 * @param {object} deps.walletClient - viem wallet client.
 * @param {object} deps.publicClient - viem public client.
 * @param {import("./nonceManager").NonceManager} deps.nonceManager
 * @param {import("./gasPricer").GasPricer} deps.gasPricer
 * @param {import("./circuitBreaker").CircuitBreaker} deps.circuitBreaker
 * @param {object} [deps.metrics] - same duck-typed metrics interface
 *   scanner.js's evaluateAndMaybeSubmit already accepts (incr/
 *   recordDuration/timeAsync), defaulted to a no-op if omitted so this
 *   module has no hard dependency on bot/graph/metrics.js.
 * @param {object} opts
 * @param {number} [opts.confirmationTimeoutBlocks] - blocks to wait for
 *   confirmation before attempting a fee-bumped replacement.
 * @param {number} [opts.maxReplacementAttempts] - max number of
 *   replacement attempts before giving up and recording a circuit-breaker
 *   failure. Bounded on purpose — unboundedly replacing forever on a
 *   chain that simply won't include the tx at any reasonable fee is its
 *   own failure mode, not a fix.
 */
const { encodeFunctionData } = require("viem");
const { submitPreferPrivate } = require("./privateSubmit");

const cfg = require("../config");

function looksLikeNonceDrift(err) {
  const message = `${err.shortMessage || ""} ${err.message || ""}`.toLowerCase();
  return /nonce too low|nonce too high|replacement transaction underpriced|already known|already imported/.test(message);
}

function createTxSubmitter(deps, opts = {}) {
  const {
    walletClient,
    publicClient,
    nonceManager,
    gasPricer,
    circuitBreaker,
    relayClient,
    allowPublicFallback,
    publicBroadcastMaxWei,
    estimationAccount,
    simulatePrivateRelay,
  } = deps;
  const metrics = deps.metrics || {
    incr() {},
    recordDuration() {},
    async timeAsync(_name, fn) {
      return fn();
    },
  };
  const confirmationTimeoutBlocks = opts.confirmationTimeoutBlocks ?? 3;
  const maxReplacementAttempts = opts.maxReplacementAttempts ?? 3;

  if (!walletClient) throw new Error("createTxSubmitter: walletClient is required.");
  if (!publicClient) throw new Error("createTxSubmitter: publicClient is required.");
  if (!nonceManager) throw new Error("createTxSubmitter: nonceManager is required.");
  if (!gasPricer) throw new Error("createTxSubmitter: gasPricer is required.");
  if (!circuitBreaker) throw new Error("createTxSubmitter: circuitBreaker is required.");

  /// Waits up to `blocks` blocks (polling waitForTransactionReceipt with
  /// a bounded timeout derived from Base's ~2s block time) for `hash` to
  /// confirm. Returns the receipt, or null if it didn't confirm in time
  /// — null is NOT an error, it's the normal signal to attempt a
  /// replacement.
  async function waitUpToBlocks(hash, blocks) {
    const timeoutMs = blocks * 2500; // small buffer above Base's ~2s block time
    try {
      return await publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs });
    } catch (err) {
      // viem throws a timeout-flavored error when waitForTransactionReceipt's
      // own timeout elapses — distinguish that (expected, means "try a
      // replacement") from every other error (unexpected, rethrow).
      const isTimeout =
        err.name === "WaitForTransactionReceiptTimeoutError" || /timed out/i.test(err.message || "");
      if (isTimeout) return null;
      throw err;
    }
  }

  /**
   * Submits `writeArgs` (the same {address, abi, functionName, args}
   * shape scanner.js already builds for writeContract) with full
   * retry/replacement handling. `describeForLogs` is a short label (e.g.
   * routeLabel(route)) purely for log readability.
   *
   * Returns { confirmed: boolean, hash?: string, receipt?: object,
   * reason?: string }.
   */
  async function submitWithReplacement(writeArgs, describeForLogs = "route") {
    const gate = circuitBreaker.checkAllowed();
    if (!gate.allowed) {
      console.warn(`txSubmitter: submission blocked by circuit breaker: ${gate.reason}`);
      metrics.incr("submit.blocked_by_circuit_breaker");
      return { confirmed: false, reason: `circuit breaker: ${gate.reason}` };
    }

    const nonce = nonceManager.reserveNext();
    let fees;
    try {
      fees = await gasPricer.suggestFees();
    } catch (err) {
      console.error(`txSubmitter: gas pricing failed for ${describeForLogs}: ${err.message}`);
      await nonceManager.onAbandoned(nonce);
      metrics.incr("submit.gas_pricing_failed");
      return { confirmed: false, reason: `gas pricing failed: ${err.message}` };
    }

    let attempt = 0;
    let currentHash = null;
    let currentFees = fees;
    let submitResult = null;
    let viaPrivate = false;
    const mutableArgs = Array.isArray(writeArgs.args) ? [...writeArgs.args] : writeArgs.args;

    while (attempt <= maxReplacementAttempts) {
      try {
        const argsForAttempt = mutableArgs || writeArgs.args;
        // Build calldata from the provided writeArgs (address, abi,
        // functionName, args). We estimate gas, sign the transaction,
        // then submit the signed raw tx via the private relay (preferred)
        // or the public mempool as allowed by policy.
        const calldata = encodeFunctionData({
          abi: writeArgs.abi,
          functionName: writeArgs.functionName,
          args: argsForAttempt,
        });

        // Estimate gas units for this exact calldata; use the same
        // account that will send the tx so the estimate matches the
        // real sender context. Apply a configurable safety buffer.
        let gasLimit = await publicClient.estimateContractGas({
          address: writeArgs.address,
          abi: writeArgs.abi,
          functionName: writeArgs.functionName,
          args: argsForAttempt,
          account: estimationAccount || walletClient.account?.address || undefined,
        });
        // gasLimit is a BigInt from viem; apply buffer in basis points.
        const bufferBps = BigInt(cfg.execution.gasLimitBufferBps || 1500);
        gasLimit = (gasLimit * (10000n + bufferBps) + 9999n) / 10000n; // ceil

        // If no private relay is configured and public fallback is
        // disallowed, optionally refuse to broadcast large trades.
        if (!relayClient && !allowPublicFallback) {
          // The contract's function signature for executeTriangle uses
          // args: [legs, amountIn, minProfit, deadline] — amountIn is
          // at index 1 when called from scanner.js. Use it if present.
          const amountIn = (argsForAttempt && argsForAttempt.length > 1) ? BigInt(argsForAttempt[1]) : 0n;
          if (amountIn > BigInt(publicBroadcastMaxWei || 0n)) {
            console.error(
              `txSubmitter: refusing public broadcast for ${describeForLogs} — ` +
                `no private relay configured and amountIn ${amountIn} > publicBroadcastMaxWei`
            );
            await nonceManager.onAbandoned(nonce);
            circuitBreaker.recordFailure("broadcast refused: private relay disabled and public fallback disallowed");
            metrics.incr("submit.public_broadcast_refused");
            return { confirmed: false, reason: "private relay disabled and public broadcast disallowed for this amount" };
          }
        }

        const tx = {
          to: writeArgs.address,
          data: calldata,
          nonce,
          gas: gasLimit,
          type: 2,
          maxFeePerGas: currentFees.maxFeePerGas,
          maxPriorityFeePerGas: currentFees.maxPriorityFeePerGas,
        };

        // Sign the transaction locally; this returns a serialized raw tx.
        const signedRawTx = await walletClient.signTransaction(tx);

        if (simulatePrivateRelay && relayClient && relayClient.supportsBundleSimulation && relayClient.simulateBundle) {
          await metrics.timeAsync("submit.private_relay_sim_ms", () =>
            relayClient.simulateBundle([signedRawTx])
          );
          metrics.incr("submit.private_relay_sim_ok");
        }

        // Submit the signed transaction preferring the private relay.
        submitResult = await metrics.timeAsync('submit.relay_ms', () =>
          submitPreferPrivate({ publicClient, relayClient, allowPublicFallback: !!allowPublicFallback }, signedRawTx, describeForLogs)
        );
        currentHash = submitResult.hash;
        viaPrivate = !!submitResult.viaPrivateRelay;
      } catch (err) {
        // A broadcast-time failure (not a confirmation-time one) means
        // this nonce was never accepted by the network at all — abandon
        // it and resync rather than continuing to loop on the same
        // reserved nonce.
        console.error(
          `txSubmitter: broadcast failed for ${describeForLogs} (nonce=${nonce}, attempt=${attempt}): ` +
          (err.shortMessage || err.message)
        );
        await nonceManager.onAbandoned(nonce);
        if (looksLikeNonceDrift(err)) {
          console.warn(`txSubmitter: nonce drift suspected for ${describeForLogs}; forcing an on-chain nonce resync.`);
          await nonceManager.sync();
        }
        circuitBreaker.recordFailure(`broadcast failed: ${err.shortMessage || err.message}`);
        metrics.incr("submit.broadcast_failed");
        return { confirmed: false, reason: `broadcast failed: ${err.shortMessage || err.message}` };
      }

      console.log(
        `txSubmitter: submitted ${describeForLogs} — hash=${currentHash} nonce=${nonce} ` +
        `attempt=${attempt} maxFee=${currentFees.maxFeePerGas} maxPriority=${currentFees.maxPriorityFeePerGas}`
      );
      metrics.incr(attempt === 0 ? "submit.broadcast" : "submit.replacement_broadcast");

      const receipt = await metrics.timeAsync("submit.confirm_wait_ms", () =>
        waitUpToBlocks(currentHash, confirmationTimeoutBlocks)
      );

      if (receipt) {
        nonceManager.onConfirmed(nonce);
        console.log(
          `txSubmitter: confirmed ${describeForLogs} — hash=${currentHash} status=${receipt.status} ` +
          `block=${receipt.blockNumber} gasUsed=${receipt.gasUsed}`
        );
        metrics.incr(receipt.status === "success" ? "submit.confirmed_success" : "submit.confirmed_reverted");
        return { confirmed: true, hash: currentHash, receipt, viaPrivateRelay: viaPrivate };
      }

      // Didn't confirm within the timeout — attempt a fee-bumped
      // replacement at the SAME nonce, up to maxReplacementAttempts.
      attempt += 1;
      if (attempt > maxReplacementAttempts) break;
      try {
        currentFees = await gasPricer.suggestReplacementFees({
          previousMaxFeePerGas: currentFees.maxFeePerGas,
          previousMaxPriorityFeePerGas: currentFees.maxPriorityFeePerGas,
        });
      } catch (err) {
        console.error(
          `txSubmitter: replacement fee escalation refused for ${describeForLogs} (nonce=${nonce}): ` +
          err.message
        );
        break; // fall through to the "exhausted" handling below
      }

      // Before attempting a replacement, re-run an on-chain simulation
      // with an updated `minProfit` that uses the replacement fees. If
      // the simulation reverts or reports insufficient profit, cancel
      // the replacement attempts.
      try {
        // Derive legs/amountIn/deadline from writeArgs.args (caller
        // constructs these in scanner.js as [legs, amountIn, minProfit, deadline]).
        const argsClone = Array.isArray(mutableArgs) ? [...mutableArgs] : [];
        const legs = argsClone[0];
        const amountIn = argsClone[1] || 0n;
        const deadline = argsClone[3] || BigInt(Math.floor(Date.now() / 1000) + 300);

        // Re-estimate gas for the upcoming replacement (could differ),
        // apply buffer.
        let replacementGas = await publicClient.estimateContractGas({
          address: writeArgs.address,
          abi: writeArgs.abi,
          functionName: writeArgs.functionName,
          args: [legs, amountIn, argsClone[2], deadline],
          account: estimationAccount || walletClient.account?.address || undefined,
        });
        replacementGas = (replacementGas * (10000n + BigInt(cfg.execution.gasLimitBufferBps || 1500)) + 9999n) / 10000n;

        const gasWei = replacementGas * currentFees.maxFeePerGas;
        const requiredProfit = gasWei + (gasWei * cfg.minProfitMarginBps) / 10000n;

        // Run the simulation with the updated minProfit
        const sim = await publicClient.simulateContract({
          address: writeArgs.address,
          abi: writeArgs.abi,
          functionName: writeArgs.functionName,
          args: [legs, amountIn, requiredProfit, deadline],
          account: estimationAccount || walletClient.account?.address || undefined,
        });

        const simulatedProfit = sim.result;
        if (simulatedProfit < requiredProfit) {
          console.warn(`txSubmitter: replacement canceled — simulated profit ${simulatedProfit} < required ${requiredProfit}`);
          await nonceManager.onAbandoned(nonce);
          circuitBreaker.recordFailure("replacement canceled: no longer profitable on resim");
          metrics.incr("submit.replacement_canceled_unprofitable");
          return { confirmed: false, reason: "replacement canceled: simulation no longer profitable" };
        }
        if (Array.isArray(mutableArgs)) {
          mutableArgs[2] = requiredProfit;
          mutableArgs[3] = deadline;
        }
      } catch (err) {
        console.warn(`txSubmitter: replacement canceled due to simulation error: ${err.message}`);
        await nonceManager.onAbandoned(nonce);
        circuitBreaker.recordFailure("replacement canceled: simulation error");
        metrics.incr("submit.replacement_canceled_sim_error");
        return { confirmed: false, reason: `replacement canceled: simulation error: ${err.message}` };
      }

      console.warn(
        `txSubmitter: ${describeForLogs} (hash=${currentHash}) not confirmed within ` +
        `${confirmationTimeoutBlocks} blocks — attempting replacement ${attempt}/${maxReplacementAttempts} ` +
        `at nonce ${nonce}.`
      );
      metrics.incr("submit.replacement_attempted");
    }

    // Exhausted all replacement attempts without confirmation. The
    // original/last-replacement transaction may still confirm later on
    // its own (nothing about this loop cancels it), but from this
    // process's point of view it must stop waiting and report failure —
    // onAbandoned() forces a nonce resync since we no longer know
    // whether this nonce is truly free.
    console.error(
      `txSubmitter: giving up on ${describeForLogs} after ${maxReplacementAttempts} replacement ` +
      `attempts (nonce=${nonce}, last hash=${currentHash}) — no confirmation.`
    );
    await nonceManager.onAbandoned(nonce);
    circuitBreaker.recordFailure(
      `${describeForLogs}: no confirmation after ${maxReplacementAttempts} replacement attempts`
    );
    metrics.incr("submit.exhausted_replacements");
    return {
      confirmed: false,
      hash: currentHash,
      reason: `no confirmation after ${maxReplacementAttempts} replacement attempts`,
      viaPrivateRelay: !!submitResult && !!submitResult.viaPrivateRelay,
    };
  }

  return { submitWithReplacement };
}

module.exports = { createTxSubmitter };
