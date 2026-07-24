/**
 * Backtest step 3: summarize backtest/output/replay.csv.
 * Run: node backtest/report.js
 */
const fs = require("fs");
const path = require("path");
const cfg = require("./config");

function formatEth(wei) {
  const sign = wei < 0n ? "-" : "";
  const abs = wei < 0n ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, "0").slice(0, 6);
  return `${sign}${whole}.${frac}`;
}

function parseCsv(text) {
  const [headerLine, ...lines] = text.trim().split("\n");
  const headers = headerLine.split(",");
  return lines.map((line) => {
    // naive split is fine here — the only field that could contain a
    // comma (route) is quoted by replay.js's csvEscape.
    const values = [];
    let cur = "";
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === "," && !inQuotes) { values.push(cur); cur = ""; }
      else cur += ch;
    }
    values.push(cur);
    const row = {};
    headers.forEach((h, i) => (row[h] = values[i]));
    return row;
  });
}

function main() {
  const csvPath = path.join(cfg.backtest.outputDir, "replay.csv");
  if (!fs.existsSync(csvPath)) {
    console.error(`No replay output found at ${csvPath} — run node backtest/replay.js first.`);
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
  const withCandidate = rows.filter((r) => r.route !== "");
  const profitable = rows.filter((r) => r.profitable === "true");

  console.log(`Backtest window: ${new Date(cfg.backtest.startMs).toISOString()} -> ${new Date(cfg.backtest.endMs).toISOString()}`);
  console.log(`Sample interval: ${cfg.backtest.sampleIntervalMinutes} minute(s)`);
  console.log(`Amount in per trade: ${formatEth(cfg.amountInWei)} WETH`);
  console.log("");
  console.log(`Total samples:              ${rows.length}`);
  console.log(`Samples with a quoted route: ${withCandidate.length} (${((withCandidate.length / rows.length) * 100).toFixed(2)}%)`);
  console.log(`Samples net-profitable:      ${profitable.length} (${((profitable.length / rows.length) * 100).toFixed(2)}%)`);

  if (profitable.length > 0) {
    const netProfits = profitable.map((r) => BigInt(r.netProfitWei)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const total = netProfits.reduce((a, b) => a + b, 0n);
    const max = netProfits[netProfits.length - 1];
    const min = netProfits[0];
    const median = netProfits[Math.floor(netProfits.length / 2)];

    console.log("");
    console.log("--- If every profitable window had been captured exactly (no competition, no slippage beyond the configured buffer) ---");
    console.log(`Sum of net profit:    ${formatEth(total)} WETH`);
    console.log(`Median net profit:    ${formatEth(median)} WETH`);
    console.log(`Max net profit:       ${formatEth(max)} WETH`);
    console.log(`Min (of profitable):  ${formatEth(min)} WETH`);

    const best5 = profitable
      .slice()
      .sort((a, b) => (BigInt(b.netProfitWei) > BigInt(a.netProfitWei) ? 1 : -1))
      .slice(0, 5);
    console.log("\nTop 5 opportunities:");
    for (const r of best5) {
      console.log(`  ${r.timestamp}  block ${r.blockNumber}  net ${formatEth(BigInt(r.netProfitWei))} WETH  ${r.route}`);
    }
  } else {
    console.log("\nNo net-profitable windows found at the current amountIn / gas / slippage assumptions.");
    console.log("Try: a larger AMOUNT_IN_WEI, a lower BACKTEST_GAS_UNITS_* estimate if you have real numbers, or a wider BASE_TRIANGLE_TOKENS universe.");
  }

  console.log(`\nFull per-sample detail: ${csvPath}`);
}

main();
