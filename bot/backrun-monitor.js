/**
 * Dry-run backrun monitor for Base.
 *
 * This watches pending transactions, decodes swaps against the configured
 * Uniswap V2 and Aerodrome routers, and reports impacted token paths. It is
 * intentionally discovery-only: profitable backruns need private submission
 * and post-victim simulation, neither of which should be faked with a public
 * mempool send.
 */

require("dotenv").config();
const { createPublicClient, decodeFunctionData, formatEther, http, webSocket } = require("viem");
const { base } = require("viem/chains");
const cfg = require("./config");

if (!cfg.WS_RPC_URL) {
  console.error("FATAL: BASE_WS_RPC_URL is required for pending transaction backrun monitoring.");
  process.exit(1);
}

const UNIV2_SWAP_ABI = [
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "swapExactETHForTokens",
    stateMutability: "payable",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "swapExactTokensForETH",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
];

const AERODROME_SWAP_ABI = [
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "stable", type: "bool" },
          { name: "factory", type: "address" },
        ],
      },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
];

const wsClient = createPublicClient({ chain: base, transport: webSocket(cfg.WS_RPC_URL) });
const httpClient = createPublicClient({ chain: base, transport: http(cfg.RPC_URL) });

const routers = new Map([
  [cfg.dexes.uniswapV2Router.toLowerCase(), { name: "univ2", abi: UNIV2_SWAP_ABI }],
  [cfg.dexes.aerodromeRouter.toLowerCase(), { name: "aerodrome", abi: AERODROME_SWAP_ABI }],
]);

function normalizePath(routerName, functionName, args) {
  if (routerName === "univ2") {
    if (functionName === "swapExactETHForTokens") {
      return { amountIn: null, path: args[1] };
    }
    return { amountIn: args[0], path: args[2] };
  }

  if (routerName === "aerodrome") {
    const routes = args[2];
    return {
      amountIn: args[0],
      path: routes.flatMap((route, index) => index === 0 ? [route.from, route.to] : [route.to]),
    };
  }

  return null;
}

function hasTrackedToken(path) {
  const tracked = new Set([
    cfg.tokens.WETH.toLowerCase(),
    cfg.tokens.USDC && cfg.tokens.USDC.toLowerCase(),
    ...cfg.triangleTokens.map((token) => token.toLowerCase()),
  ].filter(Boolean));

  return path.some((token) => tracked.has(token.toLowerCase()));
}

async function handlePendingHash(hash) {
  let tx;
  try {
    tx = await httpClient.getTransaction({ hash });
  } catch (_) {
    return;
  }
  if (!tx || !tx.to || !tx.input || tx.input === "0x") return;

  const router = routers.get(tx.to.toLowerCase());
  if (!router) return;

  let decoded;
  try {
    decoded = decodeFunctionData({ abi: router.abi, data: tx.input });
  } catch (_) {
    return;
  }

  const normalized = normalizePath(router.name, decoded.functionName, decoded.args);
  if (!normalized || !normalized.path || normalized.path.length < 2) return;
  if (!hasTrackedToken(normalized.path)) return;

  const amount = normalized.amountIn == null ? formatEther(tx.value || 0n) : formatEther(normalized.amountIn);
  console.log(
    `[${new Date().toISOString()}] pending ${router.name} ${decoded.functionName} ` +
    `amount~${amount} path=${normalized.path.join(" -> ")} tx=${hash}`
  );
  console.log("candidate action: re-run triangle scanner after this victim tx in private bundle simulation.");
}

async function main() {
  console.log(`Starting dry-run backrun monitor on ${cfg.WS_RPC_URL}`);
  console.log(`Routers: ${Array.from(routers.keys()).join(", ")}`);

  wsClient.watchPendingTransactions({
    onTransactions: (hashes) => {
      for (const hash of hashes) {
        handlePendingHash(hash).catch((err) => console.error("pending tx decode error:", err.message));
      }
    },
    onError: (err) => {
      console.error("pending transaction watcher error:", err.message);
    },
  });

  process.stdin.resume();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
