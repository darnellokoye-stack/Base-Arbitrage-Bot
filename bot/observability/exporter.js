const express = require('express');
const metrics = require('./metrics');
const db = require('./db');
const logger = require('./logger');

function startExporter(port = process.env.MONITOR_PORT || 9467, healthProvider = null) {
  const app = express();

  app.get('/metrics', async (req, res) => {
    try {
      res.set('Content-Type', metrics.getRegister().contentType);
      res.end(await metrics.getRegister().metrics());
    } catch (err) {
      logger.error('observability.exporter', 'failed to render metrics', { error: err.message });
      res.status(500).end(err.message);
    }
  });

  app.get('/analytics/trades', (req, res) => {
    const limit = Number(req.query.limit || 100);
    db.queryTrades(limit, (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  });

  app.get('/healthz', async (_req, res) => {
    try {
      const health = healthProvider ? await healthProvider() : { ok: true };
      res.status(health.ok === false ? 503 : 200).json(health);
    } catch (err) {
      logger.error('observability.exporter', 'failed to render health', { error: err.message });
      res.status(503).json({ ok: false, error: err.message });
    }
  });

  const server = app.listen(port, () => logger.info('observability.exporter', `metrics exporter listening on ${port}`));
  return server;
}

module.exports = { startExporter };
