import type { Database } from '../database/database.js';

export interface AuditEvent {
  actorUserId?: number | undefined;
  action: string;
  targetType: string;
  targetId?: string | undefined;
  requestId?: string | undefined;
  ip?: string | undefined;
  metadata?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}

export class AuditService {
  constructor(private readonly database: Database) {}

  record(event: AuditEvent): void {
    const metadata = JSON.stringify(event.metadata ?? {});
    if (/(password|token|secret|private.?key)/i.test(metadata)) {
      throw new Error('Refusing to write secret-like audit metadata');
    }
    this.database
      .prepare(
        `
        INSERT INTO audit_events
          (actor_user_id, action, target_type, target_id, request_id, ip, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        event.actorUserId ?? null,
        event.action,
        event.targetType,
        event.targetId ?? null,
        event.requestId ?? null,
        event.ip ?? null,
        metadata,
        new Date().toISOString(),
      );
  }
}
