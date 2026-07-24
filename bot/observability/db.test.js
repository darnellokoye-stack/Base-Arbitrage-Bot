const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dbFile = path.join(__dirname, "..", ".data", `observability-test-${process.pid}.db`);
try {
  fs.rmSync(dbFile, { force: true });
} catch (_) {}
process.env.OBS_DB_FILE = dbFile;

const db = require("./db");

(async () => {
  await db.init();

  await db.insertTrade({
    ts: new Date().toISOString(),
    blockNumber: 123,
    route: "a>b>c",
    dexSequence: "univ2,aero",
    flashAmountWei: "100",
    grossProfitWei: "20",
    netProfitWei: "15",
    gasUsed: 21000,
    gasCostWei: "5",
    flashFeeWei: "1",
    execDurationMs: 42,
    relay: "private",
    confirmationTimeMs: 10,
    success: true,
  });
  await db.insertScan({
    module: "scanner",
    routesConsidered: 3,
    profitableRoutes: 1,
    submitted: true,
    durationMs: 55,
    success: true,
  });
  await db.insertFailure({
    module: "scanner",
    stage: "simulate",
    route: "a>b>c",
    reason: "revert",
    payload: { code: "CALL_EXCEPTION" },
  });

  const trades = await db.all("SELECT * FROM trades");
  const scans = await db.all("SELECT * FROM scans");
  const failures = await db.all("SELECT * FROM failures");
  assert.equal(trades.length, 1);
  assert.equal(scans.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(trades[0].success, 1);
  assert.equal(failures[0].reason, "revert");

  await assert.rejects(
    db.insertTrade({ ts: null }),
    /SQLITE_CONSTRAINT|NOT NULL/
  );

  await db.close();
  fs.rmSync(dbFile, { force: true });
  console.log("observability db tests passed");
})().catch(async (err) => {
  try {
    await db.close();
  } catch (_) {}
  console.error(err);
  process.exit(1);
});
