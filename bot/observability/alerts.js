const fetch = global.fetch || require('node-fetch');
const db = require('./db');
const logger = require('./logger');

// ALERT_WEBHOOKS expects a comma-separated list of URLs
const WEBHOOKS = (process.env.ALERT_WEBHOOKS || '').split(',').map((s) => s.trim()).filter(Boolean);

async function dispatchWebhook(url, payload) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    logger.info('observability.alerts', `dispatched alert to ${url}`, { type: payload.type });
  } catch (err) {
    logger.warn('observability.alerts', `failed to send alert to ${url}`, { error: err.message });
  }
}

async function triggerAlert(type, payload = {}) {
  const record = { type, payload, ts: new Date().toISOString() };
  try {
    db.insertAlert(type, payload);
  } catch (err) {
    logger.warn('observability.alerts', 'failed to persist alert', { error: err.message });
  }

  if (WEBHOOKS.length === 0) {
    logger.warn('observability.alerts', 'no alert webhooks configured', { type });
    return;
  }

  for (const url of WEBHOOKS) {
    dispatchWebhook(url, record);
  }
}

module.exports = { triggerAlert };
