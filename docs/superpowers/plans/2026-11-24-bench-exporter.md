# Plan: High-Resolution Benchmark Dashboard Exporter (Prometheus/OpenTelemetry)

**Issue**: [#159](https://github.com/529-studio/lore/issues/159)  
**Charter**: Implement Prometheus exposition format and OpenTelemetry JSON metrics exporters in `scripts/bench-concurrency.mjs`.

---

## Task 1: Prometheus and OpenTelemetry Exporter Functions in `scripts/bench-concurrency.mjs`

- Implement `exportPrometheusMetrics(result, options)`:
  - Counters for total operations and status breakdown (`lore_bench_ops_total{op=..., status=...}`).
  - Summaries with quantiles (`0.5`, `0.95`, `0.99`, min, max) and latency sum/count (`lore_bench_latency_seconds`).
  - Gauges for duration, throughput, and SQLite invariants (`lore_bench_sqlite_integrity`, `lore_bench_sqlite_writes_persisted`).
- Implement `exportOtelMetrics(result, options)`:
  - Generate OTLP-compliant JSON payload (`resourceMetrics`, `scopeMetrics`, `metrics`) with standard semantic conventions.
- Create unit test in `scripts/test-bench-exporter.mjs` verifying schema validity, metric calculations, and quantiles.

## Task 2: CLI Options and File Persistence in `scripts/bench-concurrency.mjs`

- Parse `--export-prometheus <path>` and `--export-otel <path>` command-line arguments.
- Support environment variable overrides (`LORE_BENCH_EXPORT_PROMETHEUS`, `LORE_BENCH_EXPORT_OTEL`).
- Integrate file writing in `main()` with error handling and success logging.
- Add CLI integration assertions in `scripts/test-bench-exporter.mjs`.

## Task 3: Living Documentation & Autonomous PR Lifecycle

- Document exporter CLI options and metrics in `README.md` within 16 KB context budget.
- Add deviation entry in `SPEC.md` §15 within 25 KB context budget.
- Run full verification suite: `npm run docs:lint && npm run build && npm run typecheck && npm run check:public && node scripts/test-bench-exporter.mjs && npm run smoke`.
- Execute autonomous PR lifecycle: push branch, `gh pr create`, reviewer subagent, await CI checks, merge via `--merge`, checkout `main` and pull.
