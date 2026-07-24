// Shared retry/backoff helper for calls against rate-limited RPC
// endpoints (mainnet.base.org in particular returns -32016 "over rate
// limit" under sustained load — see fetch-data.js step 4's original
// failure mode). fetchReserveHistory.js already has its own
// range-error-specific backoff for getLogs; this is the equivalent for
// arbitrary per-block calls (getBlock, eth_call, etc.) that don't have a
// "shrink the request" option — only "wait and retry" does anything.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikeRateLimitError(err) {
  const msg = (err.shortMessage || err.message || "").toLowerCase();
  const code = err.code ?? err.cause?.code;
  return code === -32016 || msg.includes("rate limit") || msg.includes("too many requests");
}

// Retries fn() on rate-limit errors with exponential backoff + jitter.
// Anything that doesn't look like a rate-limit error is rethrown
// immediately — this is deliberately narrow so it doesn't mask real bugs.
async function withRateLimitRetry(fn, { retries = 6, baseDelayMs = 1000, label = "rpc call" } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!looksLikeRateLimitError(err) || attempt >= retries) throw err;
      attempt++;
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      console.warn(`${label}: rate limited, retry ${attempt}/${retries} in ${delay}ms...`);
      await sleep(delay);
    }
  }
}

module.exports = { sleep, looksLikeRateLimitError, withRateLimitRetry };
