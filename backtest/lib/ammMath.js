// Deliberately byte-for-byte the same formula as bot/scanner.js's
// quoteConstantProduct — this is what makes the backtest a faithful
// replay of the live scanner's math rather than a reimplementation that
// could quietly drift from it. If bot/scanner.js's formula ever changes,
// update this copy too (kept separate rather than imported because
// bot/scanner.js has top-level side effects — env var validation that
// calls process.exit(1) — that make it unsafe to require() from a
// backtest context).
function quoteConstantProduct(amountIn, reserveIn, reserveOut, feeBps) {
  if (reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * BigInt(10000 - feeBps);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 10000n + amountInWithFee;
  return denominator === 0n ? 0n : numerator / denominator;
}

// Given a pool's {token0, token1} ordering and its current {reserve0,
// reserve1}, quotes tokenIn -> tokenOut through that pool. Throws rather
// than guessing if tokenIn/tokenOut don't match the pool's known tokens —
// a silent wrong-side quote is worse than a loud error here.
function quoteThroughPool(pool, tokenIn, tokenOut, amountIn) {
  const tokenInLc = tokenIn.toLowerCase();
  const tokenOutLc = tokenOut.toLowerCase();
  const t0 = pool.token0.toLowerCase();
  const t1 = pool.token1.toLowerCase();

  let reserveIn, reserveOut;
  if (tokenInLc === t0 && tokenOutLc === t1) {
    reserveIn = pool.reserve0;
    reserveOut = pool.reserve1;
  } else if (tokenInLc === t1 && tokenOutLc === t0) {
    reserveIn = pool.reserve1;
    reserveOut = pool.reserve0;
  } else {
    throw new Error(
      `quoteThroughPool: pool ${pool.address} tokens (${pool.token0}/${pool.token1}) don't match ` +
      `requested ${tokenIn} -> ${tokenOut}`
    );
  }

  return quoteConstantProduct(amountIn, reserveIn, reserveOut, pool.feeBps);
}

module.exports = { quoteConstantProduct, quoteThroughPool };
