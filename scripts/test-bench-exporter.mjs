import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportPrometheusMetrics, exportOtelMetrics, handleExports } from './bench-concurrency.mjs';

console.log('[TEST] Checking Prometheus metrics export formatting...');

const mockResult = {
  workers: 4,
  opsPerWorker: 10,
  totalOps: 4,
  expectedWrites: 2,
  durationMs: 1000,
  records: [
    { worker: 1, step: 0, op: 'write', durationMs: 10.0, success: true },
    { worker: 1, step: 1, op: 'search', durationMs: 5.0, success: true },
    { worker: 2, step: 0, op: 'write', durationMs: 20.0, success: false, error: 'busy' },
    { worker: 2, step: 1, op: 'sync', durationMs: 30.0, success: true },
  ],
  audit: {
    integrityOk: true,
    totalWrites: 1,
    distinctClaims: 1,
    branchCount: 4,
    syncLogs: 2,
  },
};

const prom = exportPrometheusMetrics(mockResult);

assert.ok(prom.includes('# HELP lore_bench_ops_total'), 'Prometheus missing ops_total help');
assert.ok(prom.includes('# TYPE lore_bench_ops_total counter'), 'Prometheus missing ops_total type');
assert.ok(prom.includes('lore_bench_ops_total{op="write",status="success"} 1'), 'Missing write success counter');
assert.ok(prom.includes('lore_bench_ops_total{op="write",status="failure"} 1'), 'Missing write failure counter');
assert.ok(prom.includes('lore_bench_ops_total{op="search",status="success"} 1'), 'Missing search success counter');

assert.ok(prom.includes('# HELP lore_bench_latency_seconds'), 'Missing latency summary help');
assert.ok(prom.includes('lore_bench_latency_seconds{op="write",quantile="0.5"}'), 'Missing latency p50');
assert.ok(prom.includes('lore_bench_latency_seconds_count{op="write"} 2'), 'Missing latency count');

assert.ok(prom.includes('lore_bench_duration_seconds 1.000'), 'Missing duration gauge');
assert.ok(prom.includes('lore_bench_throughput_ops_per_second 4.0'), 'Missing throughput gauge');
assert.ok(prom.includes('lore_bench_sqlite_integrity 1'), 'Missing sqlite integrity metric');
assert.ok(prom.includes('lore_bench_sqlite_writes_persisted 1'), 'Missing writes persisted metric');
console.log('[OK] Prometheus export verified');

console.log('[TEST] Checking OpenTelemetry JSON metrics export formatting...');
const otel = exportOtelMetrics(mockResult);

assert.ok(otel.resourceMetrics && Array.isArray(otel.resourceMetrics), 'Missing resourceMetrics');
assert.equal(otel.resourceMetrics.length, 1);

const res = otel.resourceMetrics[0];
assert.ok(res.resource && res.resource.attributes, 'Missing resource attributes');
const serviceNameAttr = res.resource.attributes.find((a) => a.key === 'service.name');
assert.equal(serviceNameAttr?.value?.stringValue, 'lore-benchmark');

assert.ok(res.scopeMetrics && res.scopeMetrics.length >= 1, 'Missing scopeMetrics');
const metrics = res.scopeMetrics[0].metrics;
assert.ok(Array.isArray(metrics) && metrics.length >= 5, 'Expected at least 5 metrics in scope');

const opsMetric = metrics.find((m) => m.name === 'lore.bench.ops.total');
assert.ok(opsMetric, 'Missing lore.bench.ops.total in OTel metrics');
assert.ok(opsMetric.sum && opsMetric.sum.dataPoints.length >= 2, 'Missing sum data points');

const integrityMetric = metrics.find((m) => m.name === 'lore.bench.sqlite.integrity');
assert.ok(integrityMetric, 'Missing lore.bench.sqlite.integrity in OTel metrics');
assert.equal(integrityMetric.gauge.dataPoints[0].asInt, 1);

console.log('[OK] OpenTelemetry export verified');

console.log('[TEST] Checking handleExports file persistence...');
const testDir = mkdtempSync(path.join(tmpdir(), 'lore-bench-export-test-'));

try {
  const promFile = path.join(testDir, 'subdir', 'metrics.prom');
  const otelFile = path.join(testDir, 'subdir', 'metrics.json');

  handleExports(mockResult, {
    exportPrometheus: promFile,
    exportOtel: otelFile,
  });

  assert.ok(existsSync(promFile), 'Prometheus file was not created');
  assert.ok(existsSync(otelFile), 'OpenTelemetry file was not created');

  const promContent = readFileSync(promFile, 'utf8');
  assert.ok(promContent.includes('# HELP lore_bench_ops_total'));

  const otelContent = JSON.parse(readFileSync(otelFile, 'utf8'));
  assert.ok(otelContent.resourceMetrics);

  console.log('[OK] handleExports file persistence verified');
} finally {
  rmSync(testDir, { recursive: true, force: true });
}
