import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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

export interface AuditLogEntry {
  id: number;
  actorUserId: number | null;
  action: string;
  targetType: string;
  targetId: string | null;
  requestId: string | null;
  ip: string | null;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
  chainHash: string;
}

export interface AuditCheckpoint {
  formatVersion: 1;
  algorithm: 'sha256-chain+hmac-sha256';
  createdAt: string;
  eventCount: number;
  lastEventId: number | null;
  chainHash: string;
  integrity: {
    algorithm: 'hmac-sha256';
    value: string;
  };
}

interface AuditEventRow {
  id: number;
  actor_user_id: number | null;
  action: string;
  target_type: string;
  target_id: string | null;
  request_id: string | null;
  ip: string | null;
  metadata_json: string;
  created_at: string;
}

const emptyChainHash = createHash('sha256').update('bareline-audit-chain-v1\0').digest('hex');

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

  /** Returns a deterministic JSONL export with the chain hash after each event. */
  exportJsonLines(): string {
    const entries = this.chain();
    return entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : '');
  }

  /**
   * Signs the current append-only audit prefix. Store the returned document outside the
   * application database; a database-only attacker cannot forge it without the master key.
   */
  createCheckpoint(masterKey: string): AuditCheckpoint {
    const entries = this.chain();
    const last = entries.at(-1);
    const unsigned = {
      formatVersion: 1 as const,
      algorithm: 'sha256-chain+hmac-sha256' as const,
      createdAt: new Date().toISOString(),
      eventCount: entries.length,
      lastEventId: last?.id ?? null,
      chainHash: last?.chainHash ?? emptyChainHash,
    };
    return {
      ...unsigned,
      integrity: {
        algorithm: 'hmac-sha256',
        value: signCheckpoint(unsigned, decodeMasterKey(masterKey)),
      },
    };
  }

  /** Verifies the checkpoint signature and the complete audit prefix it covers. */
  verifyCheckpoint(checkpoint: unknown, masterKey: string): AuditCheckpoint {
    if (!isCheckpoint(checkpoint)) throw new Error('Audit checkpoint is invalid');
    const key = decodeMasterKey(masterKey);
    const { integrity, ...unsigned } = checkpoint;
    if (!safeEqual(integrity.value, signCheckpoint(unsigned, key)))
      throw new Error('Audit checkpoint authentication failed');

    const entries = this.chain(checkpoint.lastEventId);
    const actualHash = entries.at(-1)?.chainHash ?? emptyChainHash;
    if (entries.length !== checkpoint.eventCount || actualHash !== checkpoint.chainHash)
      throw new Error('Audit log does not match checkpoint');
    if ((entries.at(-1)?.id ?? null) !== checkpoint.lastEventId)
      throw new Error('Audit log checkpoint boundary is missing');
    return checkpoint;
  }

  private chain(lastEventId?: number | null): AuditLogEntry[] {
    if (lastEventId === null) return [];
    const query =
      lastEventId === undefined
        ? 'SELECT id, actor_user_id, action, target_type, target_id, request_id, ip, metadata_json, created_at FROM audit_events ORDER BY id ASC'
        : 'SELECT id, actor_user_id, action, target_type, target_id, request_id, ip, metadata_json, created_at FROM audit_events WHERE id <= ? ORDER BY id ASC';
    const rows = (
      lastEventId === undefined
        ? this.database.prepare(query).all()
        : this.database.prepare(query).all(lastEventId)
    ) as AuditEventRow[];
    let previous = emptyChainHash;
    return rows.map((row) => {
      const entry = {
        id: row.id,
        actorUserId: row.actor_user_id,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        requestId: row.request_id,
        ip: row.ip,
        metadata: parseMetadata(row.metadata_json),
        createdAt: row.created_at,
      };
      const chainHash = createHash('sha256')
        .update('bareline-audit-chain-v1\0')
        .update(previous)
        .update('\0')
        .update(canonicalJson(entry))
        .digest('hex');
      previous = chainHash;
      return { ...entry, chainHash };
    });
  }
}

function parseMetadata(value: string): Record<string, string | number | boolean | null> {
  const parsed: unknown = JSON.parse(value);
  if (!isMetadata(parsed)) throw new Error('Audit metadata is invalid');
  return parsed;
}

function isMetadata(value: unknown): value is Record<string, string | number | boolean | null> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (item) => item === null || ['string', 'number', 'boolean'].includes(typeof item),
    )
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function signCheckpoint(checkpoint: Omit<AuditCheckpoint, 'integrity'>, key: Buffer): string {
  return createHmac('sha256', key)
    .update('bareline-audit-checkpoint-v1\0')
    .update(canonicalJson(checkpoint))
    .digest('hex');
}

function decodeMasterKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64url');
  if (key.length !== 32) throw new Error('Security master key must decode to exactly 32 bytes');
  return key;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function isCheckpoint(value: unknown): value is AuditCheckpoint {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    item.formatVersion === 1 &&
    item.algorithm === 'sha256-chain+hmac-sha256' &&
    typeof item.createdAt === 'string' &&
    Number.isSafeInteger(item.eventCount) &&
    (Number.isSafeInteger(item.lastEventId) || item.lastEventId === null) &&
    typeof item.chainHash === 'string' &&
    typeof item.integrity === 'object' &&
    item.integrity !== null &&
    (item.integrity as Record<string, unknown>).algorithm === 'hmac-sha256' &&
    typeof (item.integrity as Record<string, unknown>).value === 'string'
  );
}
