/**
 * Adaptive EIP-1559 gas pricing + replacement-fee escalation (Phase 6).
 *
 * WHAT THIS IS: Base is an EIP-1559 chain (OP-stack, same fee mechanism
 * as L1 post-London), so this targets maxFeePerGas/maxPriorityFeePerGas,
 * not legacy gasPrice. scanner.js's existing gasCostInStartToken() reads
 * a single legacy-style gasPrice via publicClient.getGasPrice() purely
 * for its own profitability estimate — that's a read-only estimate and
 * is NOT changed here. This module is specifically for the fee values
 * actually attached to a submitted (or replacement) transaction, which
 * is a separate concern from "how much do we THINK this will cost."
 *
 * WHY ADAPTIVE RATHER THAN STATIC: a fixed priority fee either overpays
 * during quiet periods or underpays during congestion (landing too slowly
 * for an arbitrage window that may close within a block or two). Basing
 * the priority fee on a recent-history percentile, and the max fee on the
 * current base fee plus headroom for it to rise across a few blocks, is
 * standard EIP-1559 practice for anything latency-sensitive.
 *
 * WHY THIS EXISTS FOR REPLACEMENTS: a same-nonce replacement transaction
 * is REQUIRED by every EIP-1559-aware mempool to strictly increase both
 * maxFeePerGas and maxPriorityFeePerGas versus the original (a common
 * minimum is +10%) or it will simply be rejected/ignored — this module
 * is the one place that escalation math lives, so txReplace.js doesn't
 * reimplement it.
 */

// Minimum bump required by geth's default mempool policy (and mirrored by
// most other clients) for a replacement to be accepted at all. Escalating
// by more than the bare minimum (see escalationBps default below) is a
// deliberate choice to actually improve inclusion odds, not just satisfy
// the mempool's acceptance floor.
const MIN_REPLACEMENT_BUMP_BPS = 1000n; // +10%

class GasPricer {
  /**
   * @param {object} publicClient - viem public client.
   * @param {object} opts
   * @param {bigint} [opts.priorityFeeFloorWei] - never suggest a priority
   *   fee below this, regardless of what recent blocks looked like — a
   *   near-zero priority fee "estimate" during an unusually quiet moment
   *   is a bad basis for something time-sensitive.
   * @param {bigint} [opts.maxFeeCeilingWei] - hard ceiling on
   *   maxFeePerGas this module will ever suggest, independent of how
   *   high the base fee climbs. This is the gas-side analogue of
   *   circuitBreaker's daily gas budget: a spot check per-transaction
   *   rather than a cumulative one, so a single freak base-fee spike
   *   can't produce one enormous transaction even if the day's
   *   cumulative budget would technically still allow it.
   * @param {bigint} [opts.escalationBps] - bump applied per replacement
   *   attempt, on top of MIN_REPLACEMENT_BUMP_BPS if this is lower.
   * @param {number} [opts.baseFeeHeadroomBlocks] - how many blocks of
   *   base-fee increase to buffer into maxFeePerGas, since base fee can
   *   rise up to 12.5% per block (EIP-1559 max change) and a transaction
   *   sent now may not land for several blocks under congestion.
   */
  constructor(
    publicClient,
    {
      priorityFeeFloorWei = 10_000_000n, // 0.01 gwei
      maxFeeCeilingWei = 5_000_000_000n, // 5 gwei — Base's fees are normally far below this
      escalationBps = 1250n, // +12.5% per replacement, above the +10% mempool floor
      baseFeeHeadroomBlocks = 3,
    } = {}
  ) {
    this.publicClient = publicClient;
    this.priorityFeeFloorWei = priorityFeeFloorWei;
    this.maxFeeCeilingWei = maxFeeCeilingWei;
    this.escalationBps = escalationBps > MIN_REPLACEMENT_BUMP_BPS ? escalationBps : MIN_REPLACEMENT_BUMP_BPS;
    this.baseFeeHeadroomBlocks = baseFeeHeadroomBlocks;
  }

  /// Computes fee values for a brand-new (non-replacement) transaction.
  /// Returns { maxFeePerGas, maxPriorityFeePerGas }, both bigint wei.
  async suggestFees() {
    // viem's estimateFeesPerGas gives a priority-fee suggestion derived
    // from recent blocks (percentile-based, same idea as
    // eth_maxPriorityFeePerGas) plus the current block's base fee — this
    // is the "recent history" input this module's header comment
    // describes, without reimplementing percentile math by hand.
    const { maxFeePerGas: suggestedMaxFee, maxPriorityFeePerGas: suggestedPriority } =
      await this.publicClient.estimateFeesPerGas();

    let maxPriorityFeePerGas = suggestedPriority;
    if (maxPriorityFeePerGas < this.priorityFeeFloorWei) {
      maxPriorityFeePerGas = this.priorityFeeFloorWei;
    }

    // Re-derive maxFeePerGas from the current base fee plus headroom for
    // several blocks of base-fee increase, rather than trusting viem's
    // suggestedMaxFee blindly — this makes the headroom assumption
    // explicit and tunable (baseFeeHeadroomBlocks) instead of implicit
    // inside a library default.
    const latestBlock = await this.publicClient.getBlock({ blockTag: "latest" });
    const baseFee = latestBlock.baseFeePerGas;
    if (baseFee === null || baseFee === undefined) {
      throw new Error("gasPricer: latest block has no baseFeePerGas — is this chain actually EIP-1559?");
    }

    // Base fee can rise at most 12.5% per block; compounding that over
    // baseFeeHeadroomBlocks gives a worst-case base fee this many blocks
    // out, which maxFeePerGas must cover for the tx to still be includable
    // that far into the future.
    let projectedBaseFee = baseFee;
    for (let i = 0; i < this.baseFeeHeadroomBlocks; i++) {
      projectedBaseFee = (projectedBaseFee * 1125n) / 1000n;
    }

    let maxFeePerGas = projectedBaseFee + maxPriorityFeePerGas;
    if (maxFeePerGas < suggestedMaxFee) {
      // Never suggest less than what viem itself thinks is needed right
      // now — our projection is a floor reasoning, not a ceiling on it.
      maxFeePerGas = suggestedMaxFee;
    }
    if (maxFeePerGas > this.maxFeeCeilingWei) {
      throw new Error(
        `gasPricer: computed maxFeePerGas ${maxFeePerGas} wei exceeds ceiling ${this.maxFeeCeilingWei} ` +
        "wei — refusing to suggest a fee this high. Investigate base fee conditions before overriding " +
        "the ceiling."
      );
    }

    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  /// Computes escalated fees for REPLACING an already-submitted
  /// transaction, given its previous fee values. Guarantees both values
  /// strictly exceed the mempool's minimum-bump requirement, and also
  /// never falls below what a fresh suggestFees() would suggest right
  /// now (congestion may have risen since the original submission,
  /// independent of the escalation itself).
  async suggestReplacementFees({ previousMaxFeePerGas, previousMaxPriorityFeePerGas }) {
    const bumpedMaxFee = (previousMaxFeePerGas * (10000n + this.escalationBps)) / 10000n;
    const bumpedPriority = (previousMaxPriorityFeePerGas * (10000n + this.escalationBps)) / 10000n;

    const fresh = await this.suggestFees();

    const maxFeePerGas = bumpedMaxFee > fresh.maxFeePerGas ? bumpedMaxFee : fresh.maxFeePerGas;
    const maxPriorityFeePerGas =
      bumpedPriority > fresh.maxPriorityFeePerGas ? bumpedPriority : fresh.maxPriorityFeePerGas;

    if (maxFeePerGas > this.maxFeeCeilingWei) {
      throw new Error(
        `gasPricer: replacement maxFeePerGas ${maxFeePerGas} wei exceeds ceiling ${this.maxFeeCeilingWei} ` +
        "wei — refusing to escalate further. A stuck transaction that can't be replaced within the " +
        "ceiling should be investigated manually, not force-bumped past a configured safety limit."
      );
    }

    return { maxFeePerGas, maxPriorityFeePerGas };
  }
}

module.exports = { GasPricer, MIN_REPLACEMENT_BUMP_BPS };
