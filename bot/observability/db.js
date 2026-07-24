const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');

const DATA_DIR = path.join(__dirname, '..', '.data');
const DB_FILE = path.join(DATA_DIR, 'observability.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new sqlite3.Database(DB_FILE);

function init() {
  // Run schema creation in serialized mode
  db.serialize(() => {
    db.run(
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

    db.run(
      `CREATE TABLE IF NOT EXISTS relay_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        relay TEXT,
        ts TEXT,
        latency_ms INTEGER,
        success INTEGER
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS rpc_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT,
        ts TEXT,
        latency_ms INTEGER,
        success INTEGER
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT,
        alert_type TEXT,
        payload TEXT
      )`
    );
  });
}

function insertTrade(record) {
  const stmt = db.prepare(
    `INSERT INTO trades (ts, block_number, route, dex_sequence, flash_amount_wei, gross_profit_wei, net_profit_wei, gas_used, gas_cost_wei, flash_fee_wei, exec_duration_ms, relay, confirmation_time_ms, success, failure_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  stmt.run(
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
  );
  stmt.finalize();
}

function insertRelayStat({ relay, latencyMs, success }) {
  const stmt = db.prepare(`INSERT INTO relay_stats (relay, ts, latency_ms, success) VALUES (?,?,?,?)`);
  stmt.run(relay, new Date().toISOString(), latencyMs || null, success ? 1 : 0);
  stmt.finalize();
}

function insertRpcStat({ provider, latencyMs, success }) {
  const stmt = db.prepare(`INSERT INTO rpc_stats (provider, ts, latency_ms, success) VALUES (?,?,?,?)`);
  stmt.run(provider, new Date().toISOString(), latencyMs || null, success ? 1 : 0);
  stmt.finalize();
}

function insertAlert(type, payload) {
  const stmt = db.prepare(`INSERT INTO alerts (ts, alert_type, payload) VALUES (?,?,?)`);
  stmt.run(new Date().toISOString(), type, JSON.stringify(payload || {}));
  stmt.finalize();
}

function cleanupRetention(days = 90) {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  db.serialize(() => {
    db.run(`DELETE FROM trades WHERE ts < ?`, [cutoff]);
    db.run(`DELETE FROM relay_stats WHERE ts < ?`, [cutoff]);
    db.run(`DELETE FROM rpc_stats WHERE ts < ?`, [cutoff]);
    db.run(`DELETE FROM alerts WHERE ts < ?`, [cutoff]);
  });
}

function queryTrades(limit = 100, cb) {
  db.all(`SELECT * FROM trades ORDER BY id DESC LIMIT ?`, [limit], (err, rows) => cb(err, rows));
}

module.exports = { init, insertTrade, insertRelayStat, insertRpcStat, insertAlert, cleanupRetention, queryTrades };
