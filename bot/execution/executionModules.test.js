const assert = require("assert");
const { NonceManager } = require("./nonceManager");
const { GasPricer, MIN_REPLACEMENT_BUMP_BPS } = require("./gasPricer");
const { CircuitBreaker } = require("./circuitBreaker");
const { submitPreferPrivate } = require("./privateSubmit");

(async () => {
  {
    const nm = new NonceManager({
      async getTransactionCount() {
        return 5;
      },
    }, "0x0000000000000000000000000000000000000001");
    assert.equal(await nm.sync(), 5);
    assert.equal(nm.reserveNext(), 5);
    assert.equal(nm.reserveNext(), 6);
    nm.onConfirmed(6);
    assert.equal(nm.reserveNext(), 7);
  }

  {
    const gasPricer = new GasPricer({
      async estimateFeesPerGas() {
        return { maxFeePerGas: 120n, maxPriorityFeePerGas: 1n };
      },
      async getBlock() {
        return { baseFeePerGas: 100n };
      },
    }, {
      priorityFeeFloorWei: 10n,
      maxFeeCeilingWei: 1_000_000n,
      escalationBps: MIN_REPLACEMENT_BUMP_BPS,
      baseFeeHeadroomBlocks: 1,
    });
    const fees = await gasPricer.suggestFees();
    assert.equal(fees.maxPriorityFeePerGas, 10n);
    const replacement = await gasPricer.suggestReplacementFees({
      previousMaxFeePerGas: 200n,
      previousMaxPriorityFeePerGas: 20n,
    });
    assert(replacement.maxFeePerGas >= 220n);
    assert(replacement.maxPriorityFeePerGas >= 22n);
  }

  {
    let tripped = null;
    const cb = new CircuitBreaker({
      dailyLossLimitWei: 100n,
      dailyGasBudgetWei: 1_000n,
      maxConsecutiveFailures: 2,
      onTrip: (reason) => {
        tripped = reason;
      },
    });
    assert.equal(cb.checkAllowed().allowed, true);
    cb.recordFailure("one");
    assert.equal(cb.checkAllowed().allowed, true);
    cb.recordFailure("two");
    assert.equal(cb.checkAllowed().allowed, false);
    assert(tripped.includes("2 consecutive"));
  }

  {
    const result = await submitPreferPrivate({
      relayClient: {
        async sendPrivateTransaction() {
          throw new Error("relay failed");
        },
      },
      publicClient: {
        async sendRawTransaction() {
          return "0xpublic";
        },
      },
      allowPublicFallback: true,
    }, "0xraw", "route");
    assert.deepEqual(result, { hash: "0xpublic", viaPrivateRelay: false });
  }

  console.log("execution module tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
