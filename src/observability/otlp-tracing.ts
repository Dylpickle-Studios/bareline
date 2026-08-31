import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../config/config.js';
import { OutboundPolicy } from '../security/outbound-policy.js';

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceparent: string;
  startedAt: number;
}

interface CompletedSpan extends TraceContext {
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
  requestId: string;
}

/**
 * Small opt-in OTLP/HTTP exporter. It deliberately generates a new trace for
 * each untrusted request and bounds the in-memory queue. Export failures are
 * isolated from request handling and never retry redirects.
 */
export class OtlpTracing {
  private readonly spans: CompletedSpan[] = [];
  private flushing = false;
  private readonly endpoint: string | undefined;
  private readonly policy: OutboundPolicy;

  constructor(
    private readonly config: AppConfig['observability'],
    policy = new OutboundPolicy(),
  ) {
    this.endpoint = config.otlpEndpoint;
    this.policy = policy;
  }

  start(): TraceContext {
    const traceId = randomBytes(16).toString('hex');
    const spanId = randomBytes(8).toString('hex');
    return {
      traceId,
      spanId,
      traceparent: `00-${traceId}-${spanId}-01`,
      startedAt: Date.now(),
    };
  }

  complete(context: TraceContext, input: Omit<CompletedSpan, keyof TraceContext>): void {
    if (!this.endpoint) return;
    if (this.spans.length >= this.config.maxPendingSpans) this.spans.shift();
    this.spans.push({ ...context, ...input });
  }

  async flush(): Promise<void> {
    if (!this.endpoint || this.flushing || this.spans.length === 0) return;
    this.flushing = true;
    const spans = this.spans.splice(0, 64);
    try {
      const target = await this.policy.assertSafeUrl(this.endpoint, {
        allowedHosts: this.config.allowedHosts,
        protocols: ['https:'],
        ports: [443],
      });
      const response = await fetch(target, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: {
                attributes: [
                  { key: 'service.name', value: { stringValue: this.config.serviceName } },
                ],
              },
              scopeSpans: [
                {
                  scope: { name: 'bareline.http' },
                  spans: spans.map((span) => ({
                    traceId: span.traceId,
                    spanId: span.spanId,
                    name: `${span.method} ${span.route}`,
                    kind: 2,
                    startTimeUnixNano: String(BigInt(span.startedAt) * 1_000_000n),
                    endTimeUnixNano: String(BigInt(span.startedAt + span.durationMs) * 1_000_000n),
                    attributes: [
                      { key: 'http.request.method', value: { stringValue: span.method } },
                      { key: 'http.route', value: { stringValue: span.route } },
                      {
                        key: 'http.response.status_code',
                        value: { intValue: String(span.statusCode) },
                      },
                      { key: 'bareline.request_id', value: { stringValue: span.requestId } },
                    ],
                  })),
                },
              ],
            },
          ],
        }),
      });
      if (!response.ok) throw new Error(`OTLP collector returned ${String(response.status)}`);
    } catch {
      // Preserve bounded recent spans for the next periodic attempt. Requests
      // never block on telemetry or expose exporter errors to callers.
      this.spans.unshift(...spans);
      this.spans.splice(this.config.maxPendingSpans);
    } finally {
      this.flushing = false;
    }
  }
}
