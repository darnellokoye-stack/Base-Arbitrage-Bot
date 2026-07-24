/**
 * Bellman-Ford negative-cycle detection over the liquidity graph.
 *
 * The current scanner (bot/scanner.js's quoteTrianglePath/buildRouteCandidates)
 * only ever considers exactly-3-hop WETH -> tokenA -> tokenB -> WETH
 * triangles, built as a bounded cross-product over a manually configured
 * token list. That's a real limitation: it can't find a profitable 4-hop
 * cycle, and it can't find opportunities through tokens you didn't think
 * to list in BASE_TRIANGLE_TOKENS.
 *
 * The standard trick for "does a profitable trading cycle exist across
 * this graph of exchange rates" is to convert each edge's exchange rate r
 * into a weight of -log(r) and run a negative-cycle detector: a cycle of
 * edges (u1->u2->...->un->u1) is profitable overall (product of rates > 1)
 * exactly when the corresponding sum of -log(rate) weights is negative.
 * Bellman-Ford naturally detects negative cycles as a side effect of its
 * relaxation loop (a graph with V vertices needs at most V-1 relaxation
 * rounds to converge if there's no negative cycle; if a further round
 * still relaxes an edge, a negative cycle exists on the path to it).
 *
 * WHAT THIS FINDS: a *candidate* cycle (sequence of tokens/pools) whose
 * quoted rates at graph-snapshot time multiply out to > 1, before fees/
 * gas/slippage are subtracted. It is exactly as reliable as the
 * liquidity graph's current reserve snapshot — see liquidityGraph.js's
 * staleness/confirmation-depth comments. This module does NOT check
 * profitability after gas or flash premium, does NOT check adapter
 * allowlisting, and does NOT submit anything. It plugs into the same
 * place buildRouteCandidates() does in the existing scanner: it produces
 * candidates, which still go through gasCostInStartToken and
 * simulateExecution (the real eth_call check) before anything is
 * submitted.
 */

// Cap cycle length considered. Uncapped Bellman-Ford would happily report
// a 40-hop cycle that's real on paper but un-executable (gas cost alone
// would exceed any plausible profit, and every extra hop is another
// adapter call that can revert on a stale quote). This is a documented,
// tunable practicality bound, not a mathematical limitation of the
// algorithm.
const DEFAULT_MAX_CYCLE_LENGTH = 5;

/**
 * @param graph a LiquidityGraph instance (see liquidityGraph.js)
 * @param opts.maxCycleLength cap on returned cycle length (default 5)
 * @param opts.startToken if provided, only return cycles that pass through
 *   this token (e.g. WETH) — matches the existing scanner's WETH-anchored
 *   design, since TriangleArb's contracts require the start/end token to
 *   match and gasCostInStartToken currently assumes WETH specifically.
 * @returns array of { tokens: [addr, ...], pools: [poolAddress, ...],
 *   logProfit: number } sorted best-first (most negative weight sum =
 *   most profitable on paper). Does NOT include amounts — the caller
 *   should re-quote the exact cycle's amountIn through
 *   graph.quote()/multicallQuoter for real amountOut numbers before
 *   building Leg[] calldata, since Bellman-Ford here only needs rates,
 *   not a specific trade size, and constant-product rates are size-
 *   dependent (this is a screening pass, not a final quote).
 */
function findNegativeCycles(graph, opts = {}) {
  const maxCycleLength = opts.maxCycleLength || DEFAULT_MAX_CYCLE_LENGTH;
  const startToken = opts.startToken ? opts.startToken.toLowerCase() : null;

  const tokens = graph.tokens();
  if (tokens.length < 2) return [];

  const nodeIndex = new Map(tokens.map((t, i) => [t, i]));

  // Build edges: for every pool, both directions (tokenA->tokenB and
  // tokenB->tokenA), each with its own rate (constant-product pools are
  // NOT symmetric — the rate A->B differs from the inverse of B->A once
  // the trade has non-negligible size, though we use the marginal/
  // zero-size rate here — see the comment on marginalRate below).
  const edges = [];
  for (const pool of graph.allPools()) {
    if (pool.reserve0 === 0n || pool.reserve1 === 0n) continue; // uninitialized/empty pool

    const r0 = Number(pool.reserve0);
    const r1 = Number(pool.reserve1);
    const fee = 1 - pool.feeBps / 10000;

    // Marginal rate (infinitesimal trade size), i.e. reserveOut/reserveIn
    // adjusted for fee. This is what makes edge weights size-independent
    // so Bellman-Ford's "sum of weights" is well-defined for a cycle —
    // the tradeoff is that this screening pass can suggest a cycle whose
    // real, size-dependent amountOut (from graph.quote() at the actual
    // trade size) is less favorable than the marginal rate implied. The
    // re-quote step described in this function's @returns doc is what
    // catches that before any calldata is built.
    const rateAtoB = (r1 / r0) * fee;
    const rateBtoA = (r0 / r1) * fee;

    if (rateAtoB > 0) {
      edges.push({
        from: pool.token0.toLowerCase(),
        to: pool.token1.toLowerCase(),
        weight: -Math.log(rateAtoB),
        poolAddress: pool.address,
      });
    }
    if (rateBtoA > 0) {
      edges.push({
        from: pool.token1.toLowerCase(),
        to: pool.token0.toLowerCase(),
        weight: -Math.log(rateBtoA),
        poolAddress: pool.address,
      });
    }
  }

  const n = tokens.length;
  const dist = new Array(n).fill(Infinity);
  const predEdge = new Array(n).fill(null); // edge used to reach this node
  const predNode = new Array(n).fill(-1);

  // Single-source relaxation from startToken if given, else from every
  // node in turn is prohibitively expensive for a live scan loop — this
  // implementation requires startToken (matches the existing scanner's
  // WETH-anchored design) rather than doing a full all-pairs search.
  if (!startToken || !nodeIndex.has(startToken)) {
    throw new Error(
      "findNegativeCycles requires opts.startToken to be a token currently tracked by the graph " +
      "(matches the existing scanner's WETH-anchored triangle design)."
    );
  }
  const source = nodeIndex.get(startToken);
  dist[source] = 0;

  // Standard Bellman-Ford: n-1 relaxation rounds.
  for (let i = 0; i < n - 1; i++) {
    let relaxedAny = false;
    for (const edge of edges) {
      const u = nodeIndex.get(edge.from);
      const v = nodeIndex.get(edge.to);
      if (dist[u] === Infinity) continue;
      if (dist[u] + edge.weight < dist[v]) {
        dist[v] = dist[u] + edge.weight;
        predEdge[v] = edge;
        predNode[v] = u;
        relaxedAny = true;
      }
    }
    if (!relaxedAny) break; // converged early, no negative cycle reachable
  }

  // One more round: any edge that still relaxes lies on or reaches a
  // negative cycle. Walk predecessors from such a node backward until a
  // repeated node is found — that repeat marks the actual cycle.
  const cycleStartNodes = new Set();
  for (const edge of edges) {
    const u = nodeIndex.get(edge.from);
    const v = nodeIndex.get(edge.to);
    if (dist[u] === Infinity) continue;
    if (dist[u] + edge.weight < dist[v]) {
      cycleStartNodes.add(v);
    }
  }

  const seenCycleKeys = new Set();
  const results = [];

  for (const startNode of cycleStartNodes) {
    // Walk back up to n steps to guarantee entering the actual cycle.
    let node = startNode;
    for (let i = 0; i < n; i++) {
      node = predNode[node];
      if (node === -1) break;
    }
    if (node === -1) continue;

    // Now walk the cycle itself starting from this confirmed-in-cycle node.
    const cycleTokens = [];
    const cyclePools = [];
    let weightSum = 0;
    let cur = node;
    do {
      const edge = predEdge[cur];
      if (!edge) break;
      cycleTokens.unshift(tokens[cur]);
      cyclePools.unshift(edge.poolAddress);
      weightSum += edge.weight;
      cur = predNode[cur];
    } while (cur !== node && cycleTokens.length <= maxCycleLength);

    if (cur !== node) continue; // didn't close back to the start; malformed/too-long walk
    if (cycleTokens.length < 2 || cycleTokens.length > maxCycleLength) continue;
    if (weightSum >= 0) continue; // not actually profitable

    // The walk above finds A profitable cycle, but not necessarily one
    // that starts at startToken — Bellman-Ford's predecessor chain lands
    // wherever the relaxation happened to reach it. Every candidate this
    // module returns MUST start/end at startToken, because the on-chain
    // contracts (TriangleArb/TriangleArbAaveFlash) require
    // legs[0].tokenIn == legs[last].tokenOut, and gasCostInStartToken
    // assumes the start token is WETH specifically. Rotate the cycle to
    // start at startToken; if startToken isn't actually one of the
    // tokens in this cycle, it's not a usable candidate — discard it
    // rather than silently returning an unusable route.
    const startPos = cycleTokens.findIndex((t) => t.toLowerCase() === startToken);
    if (startPos === -1) continue;

    const rotatedTokens = [...cycleTokens.slice(startPos), ...cycleTokens.slice(0, startPos)];
    const rotatedPools = [...cyclePools.slice(startPos), ...cyclePools.slice(0, startPos)];
    rotatedTokens.push(rotatedTokens[0]); // close the loop explicitly in the output

    const cycleKey = rotatedTokens.map((t) => t.toLowerCase()).join(">");
    if (seenCycleKeys.has(cycleKey)) continue;
    seenCycleKeys.add(cycleKey);

    results.push({
      tokens: rotatedTokens,
      pools: rotatedPools,
      logProfit: -weightSum, // positive = profitable; magnitude ~ log of the multiplicative edge
    });
  }

  return results.sort((a, b) => b.logProfit - a.logProfit);
}

module.exports = { findNegativeCycles, DEFAULT_MAX_CYCLE_LENGTH };
