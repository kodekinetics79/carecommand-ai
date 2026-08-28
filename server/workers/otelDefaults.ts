// Give the worker its own service identity on traces/metrics/logs so API and
// worker are actually distinguishable in the telemetry backend. Must be
// imported BEFORE ../lib/tracing (and therefore before config/env parses).
// dotenv loads first so an explicit OTEL_SERVICE_NAME — in the environment or
// in .env — always wins; this only fills the gap.
import 'dotenv/config';

process.env.OTEL_SERVICE_NAME ??= 'carecommand-worker';
