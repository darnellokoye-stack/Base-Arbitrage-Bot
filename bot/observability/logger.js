const { format } = require('util');

function isoNow() {
  return new Date().toISOString();
}

function baseRecord(level, module, msg, extra = {}) {
  const rec = Object.assign({}, extra, {
    ts: isoNow(),
    level,
    module,
    msg: typeof msg === 'string' ? msg : format(msg),
  });
  // Always print as a single JSON line to stdout/stderr for easy ingestion
  const line = JSON.stringify(rec);
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

module.exports = {
  info: (module, msg, extra) => baseRecord('info', module, msg, extra),
  warn: (module, msg, extra) => baseRecord('warn', module, msg, extra),
  error: (module, msg, extra) => baseRecord('error', module, msg, extra),
  debug: (module, msg, extra) => baseRecord('debug', module, msg, extra),
};
