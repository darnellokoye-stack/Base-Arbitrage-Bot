const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');

const DATA_DIR = path.join(__dirname, '..', '.data');
const DB_FILE = process.env.OBS_DB_FILE || path.join(DATA_DIR, 'observability.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new sqlite3.Database(DB_FILE);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

async function init() {
  await run(
      `CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        block_number INTEGER,
        route TEXT,
        dex_sequence TEXT,
        flash_amount_wei TEXT,
        gross_profit_wei TEXT,
        net_profit_wei TEXT,
        gas_used INTEGER,
        gas_cost_wei TEXT,
        flash_fee_wei TEXT,
        exec_duration_ms INTEGER,
        relay TEXT,
        confirmation_time_ms INTEGER,
        success INTEGER,
        failure_reason TEXT
      )`
  );

  await run(
      `CREATE TABLE IF NOT EXISTS relay_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        relay TEXT,
        ts TEXT,
        latency_ms INTEGER,
        success INTEGER
      )`
  );

  await run(
      `CREATE TABLE IF NOT EXISTS rpc_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT,
        ts TEXT,
        latency_ms INTEGER,
        success INTEGER
      )`
  );

  await run(
      `CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT,
        alert_type TEXT,
        payload TEXT
      )`
  );

  await run(
        `CREATE TABLE IF NOT EXISTS scans (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          module TEXT,
          routes_considered INTEGER,
          profitable_routes INTEGER,
          submitted INTEGER,
          duration_ms INTEGER,
          success INTEGER,
          failure_reason TEXT
        )`
  );

  await run(
        `CREATE TABLE IF NOT EXISTS failures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          module TEXT,
          stage TEXT,
          route TEXT,
          reason TEXT,
          payload TEXT
        )`
  );
}

function insertTrade(record) {
  return run(
    `INSERT INTO trades (ts, block_number, route, dex_sequence, flash_amount_wei, gross_profit_wei, net_profit_wei, gas_used, gas_cost_wei, flash_fee_wei, exec_duration_ms, relay, confirmation_time_ms, success, failure_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
    record.ts,
    record.blockNumber || null,
    record.route || null,
    record.dexSequence || null,
    record.flashAmountWei ? record.flashAmountWei.toString() : null,
    record.grossProfitWei ? record.grossProfitWei.toString() : null,
    record.netProfitWei ? record.netProfitWei.toString() : null,
    record.gasUsed || null,
    record.gasCostWei ? record.gasCostWei.toString() : null,
    record.flashFeeWei ? record.flashFeeWei.toString() : null,
    record.execDurationMs || null,
    record.relay || null,
    record.confirmationTimeMs || null,
    record.success ? 1 : 0,
    record.failureReason || null
    ]
  );
}

function insertRelayStat({ relay, latencyMs, success }) {
  return run(`INSERT INTO relay_stats (relay, ts, latency_ms, success) VALUES (?,?,?,?)`, [
    relay,
    new Date().toISOString(),
    latencyMs || null,
    success ? 1 : 0,
  ]);
}

function insertRpcStat({ provider, latencyMs, success }) {
  return run(`INSERT INTO rpc_stats (provider, ts, latency_ms, success) VALUES (?,?,?,?)`, [
    provider,
    new Date().toISOString(),
    latencyMs || null,
    success ? 1 : 0,
  ]);
}

function insertAlert(type, payload) {
  return run(`INSERT INTO alerts (ts, alert_type, payload) VALUES (?,?,?)`, [
    new Date().toISOString(),
    type,
    JSON.stringify(payload || {}),
  ]);
}

function insertScan(record) {
  return run(
    `INSERT INTO scans (ts, module, routes_considered, profitable_routes, submitted, duration_ms, success, failure_reason) VALUES (?,?,?,?,?,?,?,?)`,
    [
      record.ts || new Date().toISOString(),
      record.module || null,
      record.routesConsidered || 0,
      record.profitableRoutes || 0,
      record.submitted ? 1 : 0,
      record.durationMs || null,
      record.success ? 1 : 0,
      record.failureReason || null,
    ]
  );
}

function insertFailure(record) {
  return run(
    `INSERT INTO failures (ts, module, stage, route, reason, payload) VALUES (?,?,?,?,?,?)`,
    [
      record.ts || new Date().toISOString(),
      record.module || null,
      record.stage || null,
      record.route || null,
      record.reason || null,
      record.payload ? JSON.stringify(record.payload) : null,
    ]
  );
}

function cleanupRetention(days = 90) {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`DELETE FROM trades WHERE ts < ?`, [cutoff]);
      db.run(`DELETE FROM relay_stats WHERE ts < ?`, [cutoff]);
      db.run(`DELETE FROM rpc_stats WHERE ts < ?`, [cutoff]);
      db.run(`DELETE FROM alerts WHERE ts < ?`, [cutoff]);
      db.run(`DELETE FROM scans WHERE ts < ?`, [cutoff]);
      db.run(`DELETE FROM failures WHERE ts < ?`, [cutoff], (err) => (err ? reject(err) : resolve()));
    });
  });
}

function queryTrades(limit = 100, cb) {
  db.all(`SELECT * FROM trades ORDER BY id DESC LIMIT ?`, [limit], (err, rows) => cb(err, rows));
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function close() {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  init,
  insertTrade,
  insertRelayStat,
  insertRpcStat,
  insertAlert,
  insertScan,
  insertFailure,
  cleanupRetention,
  queryTrades,
  all,
  close,
};
