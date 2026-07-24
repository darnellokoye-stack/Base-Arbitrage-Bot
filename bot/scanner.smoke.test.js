const assert = require("assert");
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
const env = {
  ...process.env,
  ENABLE_METRICS_SERVER: "0",
  LIVE_TRADING_REQUIRES_PRIVATE_RELAY: "false",
  BASE_USDC: "0x0000000000000000000000000000000000000003",
  BASE_TRIANGLE_ARB: "0x0000000000000000000000000000000000000004",
  BASE_TRIANGLE_ARB_AAVE_FLASH: "0x0000000000000000000000000000000000000005",
  BASE_UNIV2_ADAPTER: "0x0000000000000000000000000000000000000006",
  BASE_AERODROME_ADAPTER: "0x0000000000000000000000000000000000000007",
  BASE_WS_RPC_URL: "ws://127.0.0.1:8546",
  OBS_DB_FILE: path.join(root, "bot", ".data", `scanner-smoke-${process.pid}.db`),
};

const graph = spawnSync(process.execPath, ["-e", "require('./bot/graph-scanner'); process.exit(0);"], {
  cwd: root,
  env,
  encoding: "utf8",
});
assert.equal(graph.status, 0, graph.stderr || graph.stdout);

const scanner = spawnSync(process.execPath, ["-e", "const s = require('./bot/scanner'); if (s.netProfitFromSimulation(100n) !== 100n) process.exit(2); process.exit(0);"], {
  cwd: root,
  env,
  encoding: "utf8",
});
assert.equal(scanner.status, 0, scanner.stderr || scanner.stdout);

console.log("scanner smoke tests passed");
