/**
 * Private transaction / bundle submission (Phase 7).
 *
 * WHAT THIS IS: an alternative to broadcasting a signed transaction to
 * the public mempool. Instead, the signed tx is sent directly to a
 * relay/builder endpoint (an `eth_sendPrivateTransaction`-shaped RPC
 * call, the same interface Flashbots Protect and most OP-stack-chain
 * relay/builder services expose), so it never sits in the public mempool
 * where a generic frontrunning/sandwiching bot can see and react to it
 * before it's included. This protects THIS bot's own transaction from
 * being sandwiched — it does not target, interfere with, or gain
 * information about anyone else's transactions.
 *
 * WHY THIS MATTERS FOR THIS BOT SPECIFICALLY: a triangle-arb transaction
 * broadcast publicly reveals the exact profitable route before it
 * confirms. Generic MEV bots that already do this to every DEX
 * transaction on this chain — not something this module adds — routinely
 * copy the calldata, resubmit with a higher fee, and take the same
 * arbitrage themselves. Private submission removes that specific
 * exposure window; it does not change what the underlying arbitrage
 * transaction does on-chain.
 *
 * WHAT THIS DOES NOT DO / EXPLICITLY OUT OF SCOPE:
 *   - No bundling of multiple transactions together, and no bundling
 *     with OTHER PARTIES' transactions in any way (no "backrun a victim
 *     tx" logic lives here — see bot/backrun-monitor.js's own header for
 *     the project's existing stance that it only watches, it does not
 *     act on other users' pending transactions).
 *   - No relay-specific reputation/scoring logic, no multi-relay racing.
 *     One configured relay endpoint, with the public mempool as an
 *     explicit, always-available fallback if that relay is unreachable
 *     or misconfigured — never a silent swallow-and-do-nothing.
 *   - Does not choose which relay to use for you. RELAY_URL must be
 *     configured with an endpoint YOU have verified — see the config.js
 *     addition alongside this file for why no default is provided.
 *
 * INTEGRATION NOTE: this module sends an ALREADY-SIGNED raw transaction
 * (walletClient.signTransaction, not writeContract) to the relay via a
 * raw JSON-RPC POST, since relay endpoints generally are not part of the
 * chain's own public RPC and don't fit viem's transport abstraction
 * directly.
 */

/**
 * @param {object} opts
 * @param {string} opts.relayUrl - the relay/builder RPC endpoint. No
 *   default — must be explicitly configured and verified by the operator
 *   (see cfg.execution.privateRelayUrl).
 * @param {object} [opts.fetchImpl] - injectable fetch, defaults to
 *   global fetch (Node 18+/viem's own runtime already assumes this is
 *   available) — override only for tests.
 */
function createPrivateRelayClient({ relayUrl, fetchImpl = fetch }) {
  if (!relayUrl) {
    throw new Error(
      "createPrivateRelayClient: relayUrl is required. Set BASE_PRIVATE_RELAY_URL to a relay/builder " +
      "endpoint you have independently verified — there is no default, since blindly trusting an " +
      "unverified relay means handing it your signed transactions before they're public."
    );
  }

  /// Sends a single signed raw transaction privately via
  /// eth_sendPrivateTransaction. Returns the transaction hash the relay
  /// reports accepting (NOT confirmation — same as a normal
  /// eth_sendRawTransaction, the caller still waits for a receipt via the
  /// normal public client against the chain itself, since private
  /// submission only changes HOW the tx reaches a block builder, not how
  /// its eventual on-chain confirmation is observed).
  async function sendPrivateTransaction(signedRawTx) {
    const start = Date.now();
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendPrivateTransaction",
      params: [{ tx: signedRawTx }],
    };

    const res = await fetchImpl(relayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const latency = Date.now() - start;
    try {
      const metrics = require('../observability/metrics');
      const db = require('../observability/db');
      metrics.observeLatency('relay_request_latency_ms', latency, { relay: relayUrl });
      db.insertRelayStat({ relay: relayUrl, latencyMs: latency, success: res.ok });
      metrics.incrCounter('relay_request_total', { relay: relayUrl }, res.ok ? 1 : 0);
    } catch (err) {
      // best-effort observability; do not throw
    }

    if (!res.ok) {
      throw new Error(`privateSubmit: relay HTTP ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    if (json.error) {
      throw new Error(`privateSubmit: relay returned an error: ${json.error.message || JSON.stringify(json.error)}`);
    }
    if (!json.result) {
      throw new Error("privateSubmit: relay response had no result field.");
    }

    return json.result; // transaction hash
  }

  /// Bundle simulation, per Phase 7's explicit "bundle simulation" item.
  /// Even a single-transaction "bundle" benefits from asking the relay
  /// to simulate against its own current view of pending state before
  /// committing to send it privately — catching a would-revert tx here
  /// costs nothing (no public exposure either way) versus finding out
  /// only after the private send.
  async function simulateBundle(signedRawTxs, { blockNumber } = {}) {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_callBundle",
      params: [
        {
          txs: signedRawTxs,
          blockNumber: blockNumber ? `0x${blockNumber.toString(16)}` : undefined,
        },
      ],
    };

    const res = await fetchImpl(relayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`privateSubmit: relay simulation HTTP ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    if (json.error) {
      throw new Error(`privateSubmit: relay simulation error: ${json.error.message || JSON.stringify(json.error)}`);
    }
    return json.result;
  }

  return { sendPrivateTransaction, simulateBundle, supportsBundleSimulation: true };
}

/**
 * bloXroute-specific client — their Base Network private-transaction API
 * is shaped differently from the generic eth_sendPrivateTransaction
 * above:
 *   - method is `blxr_tx`, not `eth_sendPrivateTransaction`
 *   - auth is a bearer-style `Authorization` header (from bloXroute's
 *     Account Portal), not just a bare POST body
 *   - the transaction goes in as raw hex WITHOUT the `0x` prefix
 *   - blockchain_network must be the literal string "Base-Mainnet"
 *   - response is `{ result: { txHash } }`, not `{ result: <hash> }`
 * See https://docs.bloxroute.com/base/submit-transactions/submit-transactions
 *
 * @param {object} opts
 * @param {string} opts.authHeader - from bloXroute's Account Portal. No
 *   default — same "you must independently verify/configure this"
 *   standard as the generic relay client above.
 * @param {object} [opts.fetchImpl] - injectable fetch, defaults to global fetch.
 */
function createBloxrouteRelayClient({ authHeader, fetchImpl = fetch }) {
  if (!authHeader) {
    throw new Error(
      "createBloxrouteRelayClient: authHeader is required. Set BASE_PRIVATE_RELAY_AUTH_HEADER to the " +
      "Authorization value from your bloXroute Account Portal — there is no default."
    );
  }

  const CLOUD_API_URL = "https://api.blxrbdn.com";

  async function sendPrivateTransaction(signedRawTx) {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "blxr_tx",
      params: {
        // bloXroute wants raw tx bytes WITHOUT the 0x prefix — unlike
        // the generic eth_sendPrivateTransaction client above, which
        // passes the tx through unchanged.
        transaction: signedRawTx.startsWith("0x") ? signedRawTx.slice(2) : signedRawTx,
        blockchain_network: "Base-Mainnet",
      },
    };

    const res = await fetchImpl(CLOUD_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`privateSubmit (bloxroute): relay HTTP ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    if (json.error) {
      throw new Error(`privateSubmit (bloxroute): relay returned an error: ${json.error.message || JSON.stringify(json.error)}`);
    }
    if (!json.result || !json.result.txHash) {
      throw new Error("privateSubmit (bloxroute): relay response had no result.txHash field.");
    }

    return json.result.txHash;
  }

  // bloXroute's Base Network docs don't publish an eth_callBundle-style
  // simulation endpoint (unlike their ETH/BSC bundle APIs) — fail loudly
  // if this is ever called rather than silently no-op'ing or guessing
  // at a request shape that isn't confirmed to exist.
  async function simulateBundle() {
    throw new Error(
      "privateSubmit (bloxroute): bundle simulation is not implemented for the Base Network " +
      "blxr_tx endpoint — bloXroute's docs don't publish an equivalent to eth_callBundle for Base. " +
      "Verify current bloXroute docs before relying on pre-send simulation with this provider."
    );
  }

  return { sendPrivateTransaction, simulateBundle, supportsBundleSimulation: false };
}

/**
 * Submits a signed transaction preferring the private relay, falling
 * back to the normal public client if the relay is unreachable,
 * misconfigured, or explicitly disabled — the fallback is deliberate and
 * always-on rather than a config toggle deep in the call site, so a
 * relay outage degrades to "public mempool, same as before this phase"
 * rather than "transaction never sent."
 *
 * @param {object} deps
 * @param {object} deps.publicClient - viem public client (for the
 *   fallback path's eth_sendRawTransaction).
 * @param {ReturnType<typeof createPrivateRelayClient>|null} deps.relayClient
 *   - null means private submission is disabled entirely (e.g. no
 *   BASE_PRIVATE_RELAY_URL configured); every call falls back to public
 *   immediately without attempting a relay call.
 * @param {string} signedRawTx - the fully signed raw transaction.
 * @param {string} describeForLogs - short label for log readability.
 * @returns {Promise<{ hash: string, viaPrivateRelay: boolean }>}
 */
async function submitPreferPrivate({ publicClient, relayClient, allowPublicFallback = true }, signedRawTx, describeForLogs = "route") {
  if (relayClient) {
    try {
      let hash;
      if (Array.isArray(relayClient)) {
        const manager = createRelayManager({ relayClients: relayClient });
        hash = await manager.sendPrivateTransaction(signedRawTx, describeForLogs);
      } else if (relayClient.sendPrivateTransaction && typeof relayClient.sendPrivateTransaction === "function") {
        hash = await relayClient.sendPrivateTransaction(signedRawTx);
      } else {
        throw new Error("privateSubmit: relayClient is not a supported relay implementation.");
      }
      return { hash, viaPrivateRelay: true };
    } catch (err) {
      console.warn(
        `privateSubmit: private relay submission failed for ${describeForLogs} (${err.message}) — ` +
        (allowPublicFallback ? "falling back to the public mempool for this transaction." : "public fallback disabled; rejecting the trade.")
      );
      if (!allowPublicFallback) {
        throw err;
      }
    }
  }

  const hash = await publicClient.sendRawTransaction({ serializedTransaction: signedRawTx });
  console.log(`privateSubmit: ${describeForLogs} sent via public mempool — hash=${hash}`);
  return { hash, viaPrivateRelay: false };
}

/**
 * Creates a relay manager that tries multiple private relays in parallel
 * with health tracking and failover; keep single-relay compatibility and
 * honor allowPublicFallback.
 *
 * @param {object} opts
 * @param {object[]} opts.relayClients - an array of relay clients to try.
 * @param {number} opts.healthCooldownMs - the cooldown period for each relay
 *   after a failure (default: 30_000 ms).
 * @param {object} [opts.fetchImpl] - injectable fetch, defaults to global fetch.
 */
function createRelayManager({ relayClients, healthCooldownMs = 30_000, fetchImpl = fetch }) {
  if (!relayClients || relayClients.length === 0) {
    throw new Error("createRelayManager: relayClients must contain at least one relay client.");
  }

  const states = relayClients.map((relay) => ({
    relay,
    healthy: true,
    failureCount: 0,
    lastError: null,
    nextRetryAt: 0,
  }));

  function getHealthSnapshot() {
    const now = Date.now();
    return states.map((state) => ({
      healthy: state.healthy && now >= state.nextRetryAt,
      failureCount: state.failureCount,
      lastError: state.lastError,
      nextRetryAt: state.nextRetryAt,
    }));
  }

  async function sendPrivateTransaction(signedRawTx, describeForLogs = "route") {
    const now = Date.now();
    const candidates = states.filter((state) => state.healthy && now >= state.nextRetryAt);
    if (candidates.length === 0) {
      throw new Error("privateSubmit: all private relays are currently unhealthy or in cooldown.");
    }

    const attempts = candidates.map((state) =>
      Promise.resolve().then(async () => {
        try {
          const hash = await state.relay.sendPrivateTransaction(signedRawTx);
          state.healthy = true;
          state.failureCount = 0;
          state.lastError = null;
          state.nextRetryAt = 0;
          console.log(`privateSubmit: ${describeForLogs} sent via private relay — hash=${hash}`);
          return { hash, relay: state.relay };
        } catch (err) {
          state.failureCount += 1;
          state.lastError = err.message;
          state.healthy = false;
          state.nextRetryAt = Date.now() + healthCooldownMs;
          console.warn(`privateSubmit: relay failed for ${describeForLogs} (${err.message}) — marking unhealthy until ${new Date(state.nextRetryAt).toISOString()}`);
          throw err;
        }
      })
    );

    try {
      const result = await Promise.any(attempts);
      return result.hash;
    } catch (err) {
      const reason = err && err.errors ? err.errors.map((e) => e.message || String(e)).join("; ") : String(err);
      throw new Error(`privateSubmit: all private relays failed (${reason})`);
    }
  }

  return {
    sendPrivateTransaction,
    getHealthSnapshot,
    health: getHealthSnapshot(),
    supportsBundleSimulation: relayClients.every((relay) => !!relay.supportsBundleSimulation),
  };
}

module.exports = { createPrivateRelayClient, createBloxrouteRelayClient, createRelayManager, submitPreferPrivate };
