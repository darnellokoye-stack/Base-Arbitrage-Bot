const client = require('prom-client');
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const histogramBuckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

const metrics = {
  scanner_latency_ms: new client.Histogram({ name: 'scanner_latency_ms', help: 'Full scanner cycle latency in ms', labelNames: ['module'], registers: [register], buckets: histogramBuckets }),
  quote_latency_ms: new client.Histogram({ name: 'quote_latency_ms', help: 'DEX quote latency in ms', labelNames: ['venue', 'method'], registers: [register], buckets: histogramBuckets }),
  rpc_latency_ms: new client.Histogram({ name: 'rpc_latency_ms', help: 'RPC call latency in ms', labelNames: ['provider', 'method', 'success'], registers: [register], buckets: histogramBuckets }),
  relay_request_latency_ms: new client.Histogram({ name: 'relay_request_latency_ms', help: 'Relay request latency in ms', labelNames: ['relay', 'success'], registers: [register], buckets: histogramBuckets }),
  simulation_latency_ms: new client.Histogram({ name: 'simulation_latency_ms', help: 'Simulation latency in ms', labelNames: ['source'], registers: [register], buckets: histogramBuckets }),
  submission_latency_ms: new client.Histogram({ name: 'submission_latency_ms', help: 'Submission latency in ms', labelNames: ['viaPrivate'], registers: [register], buckets: histogramBuckets }),
  confirmation_latency_ms: new client.Histogram({ name: 'confirmation_latency_ms', help: 'Confirmation wait latency in ms', labelNames: ['status'], registers: [register], buckets: histogramBuckets }),
  block_processing_ms: new client.Histogram({ name: 'block_processing_ms', help: 'Block processing time in ms', labelNames: ['stage'], registers: [register], buckets: histogramBuckets }),
  opportunities_detected_total: new client.Counter({ name: 'opportunities_detected_total', help: 'Number of opportunities detected', labelNames: ['source'], registers: [register] }),
  opportunities_simulated_total: new client.Counter({ name: 'opportunities_simulated_total', help: 'Number of opportunities simulated', labelNames: ['source'], registers: [register] }),
  trades_submitted_total: new client.Counter({ name: 'trades_submitted_total', help: 'Number of trades submitted', labelNames: ['viaPrivate'], registers: [register] }),
  trades_confirmed_total: new client.Counter({ name: 'trades_confirmed_total', help: 'Number of trades confirmed', labelNames: ['status'], registers: [register] }),
  trades_reverted_total: new client.Counter({ name: 'trades_reverted_total', help: 'Number of trades reverted', labelNames: ['reason'], registers: [register] }),
  trades_expired_total: new client.Counter({ name: 'trades_expired_total', help: 'Number of trades expired or timed out', labelNames: [], registers: [register] }),
  relay_failures_total: new client.Counter({ name: 'relay_failures_total', help: 'Number of relay failures', labelNames: ['relay'], registers: [register] }),
  rpc_failures_total: new client.Counter({ name: 'rpc_failures_total', help: 'Number of RPC failures', labelNames: ['provider', 'method'], registers: [register] }),
  circuit_breaker_trips_total: new client.Counter({ name: 'circuit_breaker_trips_total', help: 'Circuit breaker trips', labelNames: ['reason'], registers: [register] }),
  rpc_health_status: new client.Gauge({ name: 'rpc_health_status', help: 'RPC provider health status (1 healthy, 0 unhealthy)', labelNames: ['provider'], registers: [register] }),
  relay_health_status: new client.Gauge({ name: 'relay_health_status', help: 'Relay health status (1 healthy, 0 unhealthy)', labelNames: ['relay'], registers: [register] }),
};

function observeLatency(metricName, ms, labels = {}) {
  const metric = metrics[metricName];
  if (!metric) return;
  metric.observe(labels, ms);
}

function incrCounter(metricName, labels = {}, value = 1) {
  const metric = metrics[metricName];
  if (!metric) return;
  metric.inc(labels, value);
}

function setGauge(metricName, value, labels = {}) {
  const metric = metrics[metricName];
  if (!metric) return;
  metric.set(labels, value);
}

function getRegister() {
  return register;
}

module.exports = { observeLatency, incrCounter, setGauge, getRegister };
