/**
 * Local nonce management + transaction replacement bookkeeping (Phase 6).
 *
 * WHAT THIS IS: a thin, per-account nonce allocator that sits in front of
 * viem's own nonce handling. scanner.js's existing txInFlight boolean
 * already prevents this process from ever having two of ITS OWN
 * transactions pending at once — that guard is preserved untouched. What
 * txInFlight does NOT cover:
 *   - resuming correctly after a process restart while a prior tx is
 *     still pending (txInFlight resets to false on restart even though
 *     the real on-chain nonce may be ahead of what a fresh
 *     eth_getTransactionCount(pending) would suggest, if that call races
 *     the mempool)
 *   - deliberately replacing (speeding up or cancelling) a stuck
 *     transaction, which requires resending at the SAME nonce with a
 *     higher fee, not requesting a fresh nonce
 * This module exists for those two things. It does not change the
 * one-in-flight-at-a-time policy; it makes "in flight" resilient to
 * restarts and give it a controlled way to reuse a nonce for replacement.
 *
 * WHY LOCAL TRACKING AT ALL (vs. always asking the RPC): a pending-nonce
 * read (eth_getTransactionCount(address, "pending")) is usually correct,
 * but "usually" is exactly the gap this module closes — some RPC
 * providers' mempool view lags, and immediately after this process's own
 * submission there is a window where re-deriving the nonce from a
 * possibly-stale RPC view could return the SAME nonce that was just used,
 * producing a guaranteed-fail resubmission instead of the intended next
 * nonce. Tracking locally after every submission this process makes
 * removes that race for anything this process itself has done, while
 * still falling back to the chain as the source of truth on startup and
 * after any confirmed/dropped transaction.
 */

class NonceManager {
  /**
   * @param {object} publicClient - viem public client, for
   *   getTransactionCount fallback reads.
   * @param {string} address - the account whose nonces are managed.
   */
  constructor(publicClient, address) {
    this.publicClient = publicClient;
    this.address = address;
    // null until the first sync() — deliberately not eagerly fetched in
    // the constructor so construction never does network I/O; callers
    // control when the first chain read happens.
    this._nextNonce = null;
  }

  /// Refreshes _nextNonce from the chain's "pending" view. Call this on
  /// startup before the first submission, and again any time a
  /// transaction is confirmed, dropped-and-replaced-away, or this
  /// process suspects its local view has drifted (e.g. after any
  /// unexpected nonce-related revert) — this is the resync point that
  /// keeps local tracking from silently diverging from reality forever.
  async sync() {
    const pending = await this.publicClient.getTransactionCount({
      address: this.address,
      blockTag: "pending",
    });
    console.log(
      `nonceManager: synced — chain reports next pending nonce ${pending} for ${this.address} ` +
      `(local was ${this._nextNonce}).`
    );
    this._nextNonce = pending;
    return this._nextNonce;
  }

  /// Reserves and returns the next nonce to use for a brand-new
  /// transaction (NOT a replacement — see reserveForReplacement below).
  /// Synchronous and side-effecting: increments the local counter
  /// immediately so two overlapping callers within this process can
  /// never be handed the same nonce, even before either transaction is
  /// actually broadcast. Throws if sync() hasn't been called yet, rather
  /// than silently guessing.
  reserveNext() {
    if (this._nextNonce === null) {
      throw new Error("nonceManager: reserveNext() called before sync() — call sync() first.");
    }
    const nonce = this._nextNonce;
    this._nextNonce += 1;
    return nonce;
  }

  /// Returns the CURRENT (not-yet-incremented) nonce for replacing an
  /// already-submitted-but-unconfirmed transaction. Deliberately does
  /// NOT touch _nextNonce — a replacement reuses the same nonce the
  /// stuck transaction used, it does not consume a new one. The caller
  /// (txReplace.js) is responsible for knowing which nonce that was;
  /// this method exists mainly so every nonce-related read in this
  /// codebase goes through one module rather than reading _nextNonce's
  /// internals directly from outside.
  currentReservedNonce() {
    if (this._nextNonce === null) {
      throw new Error("nonceManager: currentReservedNonce() called before sync().");
    }
    // The most recently reserved nonce is one less than the next one to
    // hand out, as long as at least one reserveNext() has happened since
    // the last sync().
    return this._nextNonce - 1;
  }

  /// Call after a transaction at `nonce` is CONFIRMED on-chain (mined,
  /// regardless of success/revert status — a reverted-but-mined tx still
  /// consumed that nonce). Advances local tracking if the confirmed
  /// nonce is ahead of what was locally expected (e.g. another process
  /// or a manual transaction used this account), but never moves it
  /// backwards.
  onConfirmed(nonce) {
    if (this._nextNonce === null || nonce >= this._nextNonce) {
      this._nextNonce = nonce + 1;
    }
  }

  /// Call if a transaction at `nonce` is abandoned WITHOUT confirming
  /// (e.g. replaced by a cancellation tx, or the caller gave up after
  /// exhausting retries) — forces a resync rather than guessing whether
  /// the abandoned nonce is now free or was actually consumed by
  /// something else in the interim (e.g. the "stuck" tx actually landed
  /// right as a cancellation was being prepared).
  async onAbandoned(nonce) {
    console.warn(`nonceManager: nonce ${nonce} abandoned without confirmation — forcing resync.`);
    await this.sync();
  }
}

module.exports = { NonceManager };
