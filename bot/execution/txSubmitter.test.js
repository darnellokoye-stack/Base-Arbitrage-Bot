const assert = require("assert");
const { createTxSubmitter } = require("./txSubmitter");

const ABI = [
  {
    name: "executeTriangle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "legs", type: "bytes" },
      { name: "amountIn", type: "uint256" },
      { name: "minProfit", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
];

function createDeps(overrides = {}) {
  const signed = [];
  const estimatedArgs = [];
  const simulatedArgs = [];
  const publicHashes = [];
  const relayHashes = [];
  const receipts = overrides.receipts || [{ status: "success", blockNumber: 1n, gasUsed: 100n, effectiveGasPrice: 2n }];

  const publicClient = {
    estimateContractGas: async (args) => {
      estimatedArgs.push(args.args);
      return overrides.gas || 100n;
    },
    waitForTransactionReceipt: async () => {
      const next = receipts.shift();
      if (next === null) {
        const err = new Error("timed out");
        err.name = "WaitForTransactionReceiptTimeoutError";
        throw err;
      }
      return next;
    },
    simulateContract: async (args) => {
      simulatedArgs.push(args.args);
      return { result: overrides.simulatedProfit || 10_000_000n };
    },
    sendRawTransaction: async ({ serializedTransaction }) => {
      publicHashes.push(serializedTransaction);
      return `0xpublic${publicHashes.length}`;
    },
  };

  const relayClient = overrides.relay
    ? {
        supportsBundleSimulation: false,
        sendPrivateTransaction: async (raw) => {
          relayHashes.push(raw);
          if (overrides.relayFails) throw new Error("relay down");
          return `0xrelay${relayHashes.length}`;
        },
      }
    : null;

  const nonceManager = {
    next: 7,
    reserveNext() {
      return this.next++;
    },
    onConfirmed(nonce) {
      this.confirmed = nonce;
    },
    async onAbandoned(nonce) {
      this.abandoned = nonce;
    },
    async sync() {
      this.synced = true;
    },
  };

  const gasPricer = {
    async suggestFees() {
      return { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n };
    },
    async suggestReplacementFees({ previousMaxFeePerGas, previousMaxPriorityFeePerGas }) {
      return {
        maxFeePerGas: previousMaxFeePerGas + 50n,
        maxPriorityFeePerGas: previousMaxPriorityFeePerGas + 5n,
      };
    },
  };

  const circuitBreaker = {
    checkAllowed: () => ({ allowed: true }),
    recordFailure(reason) {
      this.failure = reason;
    },
  };

  const walletClient = {
    account: { address: "0x0000000000000000000000000000000000000001" },
    async signTransaction(tx) {
      signed.push(tx);
      return `0x${signed.length.toString(16).padStart(2, "0")}`;
    },
  };

  return {
    deps: {
      walletClient,
      publicClient,
      nonceManager,
      gasPricer,
      circuitBreaker,
      relayClient,
      allowPublicFallback: overrides.allowPublicFallback ?? true,
      publicBroadcastMaxWei: 0n,
    },
    signed,
    estimatedArgs,
    simulatedArgs,
    publicHashes,
    relayHashes,
  };
}

async function submit(ctx, args = ["0x", 1_000n, 5n, 123n], opts = {}) {
  const txSubmitter = createTxSubmitter(ctx.deps, {
    confirmationTimeoutBlocks: 1,
    maxReplacementAttempts: opts.maxReplacementAttempts ?? 1,
  });
  return txSubmitter.submitWithReplacement(
    {
      address: "0x0000000000000000000000000000000000000002",
      abi: ABI,
      functionName: "executeTriangle",
      args,
    },
    "test route"
  );
}

(async () => {
  {
    const ctx = createDeps({ relay: true });
    const result = await submit(ctx);
    assert.equal(result.confirmed, true);
    assert.equal(result.viaPrivateRelay, true);
    assert.equal(result.hash, "0xrelay1");
    assert.equal(ctx.publicHashes.length, 0);
  }

  {
    const ctx = createDeps({ relay: false });
    const result = await submit(ctx);
    assert.equal(result.confirmed, true);
    assert.equal(result.viaPrivateRelay, false);
    assert.equal(result.hash, "0xpublic1");
  }

  {
    const ctx = createDeps({ relay: true, relayFails: true, allowPublicFallback: true });
    const result = await submit(ctx);
    assert.equal(result.confirmed, true);
    assert.equal(result.viaPrivateRelay, false);
    assert.equal(result.hash, "0xpublic1");
  }

  {
    const ctx = createDeps({
      relay: false,
      receipts: [null, { status: "success", blockNumber: 2n, gasUsed: 100n, effectiveGasPrice: 2n }],
    });
    const result = await submit(ctx);
    assert.equal(result.confirmed, true);
    assert.equal(ctx.signed.length, 2);
    assert.equal(ctx.simulatedArgs.length, 1);
    const replacementMinProfit = ctx.simulatedArgs[0][2];
    assert.equal(ctx.signed[1].maxFeePerGas, 150n);
    assert.notEqual(ctx.signed[1].data, ctx.signed[0].data);
    assert.equal(replacementMinProfit, 17_250n);
  }

  console.log("txSubmitter tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
