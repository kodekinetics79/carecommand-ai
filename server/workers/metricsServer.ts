import { createServer, type Server } from 'node:http';
import { env } from '../config/env';
import { registry, metricsAccess } from '../lib/metrics';

/**
 * Standalone /metrics listener for the worker process.
 *
 * The worker is the ONLY process that records job_duration_seconds and
 * jobs_total (jobs execute here), so without this listener those series — and
 * the job_success SLO plus the JobFailureRateHigh alert — are invisible to
 * Prometheus. The API's /metrics can't help: prom-client registries are
 * per-process.
 *
 * Same access rule as the API route (metricsAccess): open outside production,
 * bearer-token (or deny-all 404) in production.
 *
 * NOTE for Render: `type: worker` services accept no inbound traffic, so this
 * port is only scrapable when the worker runs somewhere with network access
 * (private service + in-network Prometheus/agent, Fly, Railway, a VM, …). See
 * docs/OBSERVABILITY.md#worker-metrics for the options.
 *
 * Never throws — a port conflict must not take down job processing.
 */
export function startWorkerMetricsServer(): Server | null {
  if (!env.METRICS_ENABLED) return null;

  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0];
      if (req.method !== 'GET' || path !== '/metrics') {
        res.statusCode = 404;
        res.end();
        return;
      }
      const access = metricsAccess(req.headers.authorization);
      if (access !== 'ok') {
        res.statusCode = access === 'not_found' ? 404 : 401;
        res.end();
        return;
      }
      try {
        const body = await registry.metrics();
        res.setHeader('content-type', registry.contentType);
        res.end(body);
      } catch {
        res.statusCode = 500;
        res.end();
      }
    })();
  });

  server.on('error', error => {
    console.error(`[worker-metrics] listener error on :${env.WORKER_METRICS_PORT} — job metrics not scrapable this run`, error);
  });
  server.listen(env.WORKER_METRICS_PORT, () => {
    console.info(`[worker-metrics] serving /metrics on :${env.WORKER_METRICS_PORT}`);
  });
  // Never keep a draining process alive just for the metrics socket.
  server.unref();
  return server;
}
