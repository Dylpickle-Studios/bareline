export type MetricLabels = Readonly<Record<string, string | number>>;

type MetricKind = 'counter' | 'gauge' | 'histogram';

interface MetricDefinition {
  kind: MetricKind;
  labels: readonly string[];
}

const HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
const MAX_LABEL_LENGTH = 64;
const MAX_SERIES = 256;

const definitions: Readonly<Record<string, MetricDefinition>> = {
  http_requests_total: { kind: 'counter', labels: ['method', 'route', 'status'] },
  http_request_duration_seconds: { kind: 'histogram', labels: ['method', 'route'] },
  git_operations_total: { kind: 'counter', labels: ['route', 'status'] },
  git_operation_duration_seconds: { kind: 'histogram', labels: ['route'] },
  auth_failures_total: { kind: 'counter', labels: ['route', 'status'] },
  plugin_executions_total: { kind: 'counter', labels: ['route', 'status'] },
  plugin_execution_duration_seconds: { kind: 'histogram', labels: ['route'] },
  backup_operations_total: { kind: 'counter', labels: ['route', 'status'] },
  backup_operation_duration_seconds: { kind: 'histogram', labels: ['route'] },
  storage_queue_saturation: { kind: 'gauge', labels: [] },
};

interface Histogram {
  buckets: number[];
  count: number;
  sum: number;
}

function cleanLabel(value: string | number): string {
  return String(value)
    .replace(/[^A-Za-z0-9_.:/-]/g, '_')
    .slice(0, MAX_LABEL_LENGTH);
}

function labelsKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join(',');
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * A deliberately small, in-process metrics registry.
 *
 * Metric names and label keys are allow-listed and the number of label series
 * is bounded. This keeps the endpoint useful for operations without allowing
 * request-controlled cardinality or sensitive values to accumulate in memory.
 */
export class MetricsRegistry {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly gauges = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<string, Map<string, Histogram>>();

  increment(name: string, labels: MetricLabels = {}, amount = 1): void {
    const definition = definitions[name];
    if (definition?.kind !== 'counter') return;
    if (!Number.isFinite(amount) || amount < 0) return;
    const normalized = this.normalizeLabels(definition, labels);
    const key = labelsKey(normalized);
    const series = this.counters.get(name) ?? new Map<string, number>();
    if (!series.has(key) && series.size >= MAX_SERIES) return;
    series.set(key, (series.get(key) ?? 0) + amount);
    this.counters.set(name, series);
  }

  setGauge(name: string, value: number, labels: MetricLabels = {}): void {
    const definition = definitions[name];
    if (definition?.kind !== 'gauge' || !Number.isFinite(value)) return;
    const normalized = this.normalizeLabels(definition, labels);
    const key = labelsKey(normalized);
    const series = this.gauges.get(name) ?? new Map<string, number>();
    if (!series.has(key) && series.size >= MAX_SERIES) return;
    series.set(key, value);
    this.gauges.set(name, series);
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    const definition = definitions[name];
    if (definition?.kind !== 'histogram' || !Number.isFinite(value) || value < 0) return;
    const normalized = this.normalizeLabels(definition, labels);
    const key = labelsKey(normalized);
    const series = this.histograms.get(name) ?? new Map<string, Histogram>();
    let histogram = series.get(key);
    if (!histogram) {
      if (series.size >= MAX_SERIES) return;
      histogram = { buckets: HISTOGRAM_BUCKETS.map(() => 0), count: 0, sum: 0 };
      series.set(key, histogram);
    }
    histogram.count += 1;
    histogram.sum += value;
    for (const [index, bucket] of HISTOGRAM_BUCKETS.entries()) {
      if (value <= bucket) histogram.buckets[index] = (histogram.buckets[index] ?? 0) + 1;
    }
    this.histograms.set(name, series);
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const [name, series] of this.counters) {
      lines.push(`# TYPE bareline_${name} counter`);
      for (const [key, value] of series) lines.push(this.sample(`bareline_${name}`, key, value));
    }
    for (const [name, series] of this.gauges) {
      lines.push(`# TYPE bareline_${name} gauge`);
      for (const [key, value] of series) lines.push(this.sample(`bareline_${name}`, key, value));
    }
    for (const [name, series] of this.histograms) {
      lines.push(`# TYPE bareline_${name} histogram`);
      for (const [key, histogram] of series) {
        const labels = this.parseKey(key);
        for (const [index, bucket] of HISTOGRAM_BUCKETS.entries()) {
          lines.push(
            this.sample(`bareline_${name}_bucket`, key, histogram.buckets[index] ?? 0, {
              ...labels,
              le: String(bucket),
            }),
          );
        }
        lines.push(
          this.sample(`bareline_${name}_bucket`, key, histogram.count, {
            ...labels,
            le: '+Inf',
          }),
        );
        lines.push(this.sample(`bareline_${name}_sum`, key, histogram.sum));
        lines.push(this.sample(`bareline_${name}_count`, key, histogram.count));
      }
    }
    return lines.length ? `${lines.join('\n')}\n` : '';
  }

  snapshot(): Record<string, unknown> {
    return {
      counters: this.copySeries(this.counters),
      gauges: this.copySeries(this.gauges),
      histograms: this.copySeries(this.histograms),
    };
  }

  private normalizeLabels(
    definition: MetricDefinition,
    labels: MetricLabels,
  ): Record<string, string> {
    return Object.fromEntries(
      definition.labels.map((name) => [name, cleanLabel(labels[name] ?? 'unknown')]),
    );
  }

  private parseKey(key: string): Record<string, string> {
    if (!key) return {};
    return Object.fromEntries(
      key.split(',').map((entry) => {
        const separator = entry.indexOf('=');
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
    );
  }

  private sample(
    name: string,
    key: string,
    value: number,
    extra: Record<string, string> = {},
  ): string {
    const labels = { ...this.parseKey(key), ...extra };
    const encoded = Object.entries(labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, labelValue]) => `${label}="${escapeLabel(labelValue)}"`)
      .join(',');
    return `${name}${encoded ? `{${encoded}}` : ''} ${String(value)}`;
  }

  private copySeries(source: Map<string, Map<string, unknown>>): Record<string, unknown> {
    return Object.fromEntries(
      [...source.entries()].map(([name, values]) => [name, Object.fromEntries(values)]),
    );
  }
}
