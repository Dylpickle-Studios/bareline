import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../src/observability/metrics.js';

describe('bounded metrics registry', () => {
  it('allows only bounded labels and emits histogram samples', () => {
    const metrics = new MetricsRegistry();
    metrics.increment('http_requests_total', {
      method: 'GET',
      route: '/repositories/:owner/:repository',
      status: 200,
      secret: 'must-not-be-exported',
    });
    metrics.observe('http_request_duration_seconds', 0.02, {
      method: 'GET',
      route: '/repositories/:owner/:repository',
    });
    metrics.setGauge('storage_queue_saturation', 0.25);

    const output = metrics.renderPrometheus();
    expect(output).toContain('bareline_http_requests_total');
    expect(output).toContain('bareline_http_request_duration_seconds_bucket');
    expect(output).toContain('bareline_storage_queue_saturation 0.25');
    expect(output).not.toContain('must-not-be-exported');
  });

  it('ignores unknown metric names and invalid observations', () => {
    const metrics = new MetricsRegistry();
    metrics.increment('unknown_metric', {}, -1);
    metrics.observe('http_request_duration_seconds', Number.NaN);
    expect(metrics.renderPrometheus()).toBe('');
  });
});
