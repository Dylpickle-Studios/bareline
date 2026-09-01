import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../database/database.js';
import { OutboundPolicy } from '../security/outbound-policy.js';
import { SecretBox } from '../security/secret-box.js';
import type { AuditService } from '../audit/audit-service.js';

const EVENT_NAME = /^(repository|branch|tag|commit|issue)\.[A-Za-z][A-Za-z0-9]*$/;

export class WebhookError extends Error {
  readonly statusCode = 400;
}

export class WebhookService {
  private readonly policy = new OutboundPolicy();
  private readonly box: SecretBox | null;

  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {
    this.box = config.security.masterKey ? new SecretBox(config.security.masterKey) : null;
  }

  create(
    repositoryId: number,
    actorUserId: number,
    url: string,
    events: unknown,
  ): { id: number; secret: string } {
    if (!this.box) throw new WebhookError('security.masterKey is required for webhooks');
    const safeUrl = this.policy.validateUrl(url, {
      allowedHosts: this.config.webhooks.allowedHosts,
      protocols: ['https:'],
      ports: [443],
    });
    const normalizedEvents = normalizeEvents(events);
    const secret = randomBytes(32).toString('base64url');
    const result = this.database
      .prepare(
        `INSERT INTO webhooks(repository_id, url, events_json, secret_encrypted, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repositoryId,
        safeUrl.toString(),
        JSON.stringify(normalizedEvents),
        this.box.encrypt(secret, `webhook:${String(repositoryId)}`),
        actorUserId,
        new Date().toISOString(),
      );
    const id = Number(result.lastInsertRowid);
    this.audit.record({
      actorUserId,
      action: 'webhook.created',
      targetType: 'webhook',
      targetId: String(id),
      metadata: { repositoryId, events: normalizedEvents.length },
    });
    return { id, secret };
  }

  list(repositoryId: number): unknown[] {
    return this.database
      .prepare(
        `SELECT id, url, events_json AS eventsJson, enabled, created_at AS createdAt,
        last_success_at AS lastSuccessAt, last_error AS lastError
       FROM webhooks WHERE repository_id=? ORDER BY id DESC`,
      )
      .all(repositoryId)
      .map((row) => ({
        ...(row as object),
        events: parseEvents((row as { eventsJson: string }).eventsJson),
      }));
  }

  remove(repositoryId: number, actorUserId: number, id: number): void {
    const result = this.database
      .prepare('DELETE FROM webhooks WHERE id=? AND repository_id=?')
      .run(id, repositoryId);
    if (result.changes !== 1) throw new WebhookError('Webhook not found');
    this.audit.record({
      actorUserId,
      action: 'webhook.deleted',
      targetType: 'webhook',
      targetId: String(id),
      metadata: { repositoryId },
    });
  }

  publish(eventName: string, payload: Readonly<Record<string, unknown>>): void {
    if (!EVENT_NAME.test(eventName)) return;
    const repositoryId = typeof payload.repositoryId === 'number' ? payload.repositoryId : null;
    if (!repositoryId || !Number.isSafeInteger(repositoryId)) return;
    const encoded = JSON.stringify({
      event: eventName,
      occurredAt: new Date().toISOString(),
      ...payload,
    });
    if (encoded.length > 65_536) return;
    const total = this.database
      .prepare(
        "SELECT count(*) AS count FROM webhook_deliveries WHERE state IN ('pending', 'running')",
      )
      .get() as { count: number };
    if (total.count >= this.config.webhooks.maxPending) return;
    const hooks = this.database
      .prepare(
        'SELECT id, events_json AS eventsJson FROM webhooks WHERE repository_id=? AND enabled=1',
      )
      .all(repositoryId) as { id: number; eventsJson: string }[];
    const now = new Date().toISOString();
    const insert = this.database.prepare(
      'INSERT INTO webhook_deliveries(id, webhook_id, event_name, payload_json, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const write = this.database.transaction(() => {
      for (const hook of hooks) {
        const events = JSON.parse(hook.eventsJson) as unknown[];
        if (events.includes(eventName))
          insert.run(randomUUID(), hook.id, eventName, encoded, now, now);
      }
    });
    write();
  }

  async processNext(): Promise<void> {
    const now = new Date().toISOString();
    const delivery = this.database
      .prepare(
        `SELECT d.id, d.webhook_id AS webhookId, d.event_name AS eventName, d.payload_json AS payloadJson,
        d.attempts, w.repository_id AS repositoryId, w.url, w.secret_encrypted AS secretEncrypted
       FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id
       WHERE (d.state='pending' AND d.available_at <= ?) OR (d.state='running' AND d.lease_until < ?)
       ORDER BY d.created_at LIMIT 1`,
      )
      .get(now, now) as
      | undefined
      | {
          id: string;
          webhookId: number;
          eventName: string;
          payloadJson: string;
          attempts: number;
          repositoryId: number;
          url: string;
          secretEncrypted: Buffer;
        };
    if (!delivery || !this.box) return;
    const lease = new Date(Date.now() + this.config.webhooks.timeoutMs + 5000).toISOString();
    const claimed = this.database
      .prepare(
        `UPDATE webhook_deliveries SET state='running', attempts=attempts+1, lease_until=?
         WHERE id=? AND (state='pending' OR (state='running' AND lease_until < ?))`,
      )
      .run(lease, delivery.id, now);
    if (claimed.changes !== 1) return;
    try {
      const target = await this.policy.assertSafeUrl(delivery.url, {
        allowedHosts: this.config.webhooks.allowedHosts,
        protocols: ['https:'],
        ports: [443],
      });
      const secret = this.box.decrypt(
        delivery.secretEncrypted,
        `webhook:${String(delivery.repositoryId)}`,
      );
      const signature = `sha256=${createHmac('sha256', secret).update(delivery.payloadJson).digest('hex')}`;
      const response = await fetch(target, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.webhooks.timeoutMs),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Bareline-Webhooks/1.1',
          'x-bareline-event': delivery.eventName,
          'x-bareline-delivery': delivery.id,
          'x-bareline-signature-256': signature,
        },
        body: delivery.payloadJson,
      });
      if (!response.ok) throw new Error(`Webhook receiver returned ${String(response.status)}`);
      this.database
        .prepare(
          "UPDATE webhook_deliveries SET state='delivered', lease_until=NULL, delivered_at=?, last_error=NULL WHERE id=?",
        )
        .run(new Date().toISOString(), delivery.id);
      this.database
        .prepare('UPDATE webhooks SET last_success_at=?, last_error=NULL WHERE id=?')
        .run(new Date().toISOString(), delivery.webhookId);
    } catch (error) {
      const attempts = delivery.attempts + 1;
      const message =
        error instanceof Error ? error.message.slice(0, 500) : 'Webhook delivery failed';
      if (attempts >= this.config.webhooks.maxAttempts) {
        this.database
          .prepare(
            "UPDATE webhook_deliveries SET state='failed', lease_until=NULL, last_error=? WHERE id=?",
          )
          .run(message, delivery.id);
      } else {
        const delay = Math.min(3_600_000, 1000 * 2 ** Math.min(attempts, 10));
        this.database
          .prepare(
            "UPDATE webhook_deliveries SET state='pending', lease_until=NULL, available_at=?, last_error=? WHERE id=?",
          )
          .run(new Date(Date.now() + delay).toISOString(), message, delivery.id);
      }
      this.database
        .prepare('UPDATE webhooks SET last_error=? WHERE id=?')
        .run(message, delivery.webhookId);
    }
  }
}

function normalizeEvents(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16)
    throw new WebhookError('Webhook events must be a non-empty bounded list');
  const events = [...new Set(value)];
  if (!events.every((event) => typeof event === 'string' && EVENT_NAME.test(event)))
    throw new WebhookError('Webhook event is invalid');
  return events as string[];
}

function parseEvents(value: string): string[] {
  try {
    return normalizeEvents(JSON.parse(value) as unknown);
  } catch {
    return [];
  }
}
