import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditService } from '../audit/audit-service.js';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../database/database.js';
import { NotFoundError, PayloadTooLargeError } from './repository-service.js';
import type { RepositoryMutationService } from './repository-mutation-service.js';
import type { RepositoryService } from './repository-service.js';
import type { Repository } from './repository-types.js';
import { validateRef, ValidationError } from '../security/validation.js';

export interface ReleaseAsset {
  id: number;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface ReleaseSummary {
  id: number;
  tagName: string;
  name: string;
  objectId: string;
  createdAt: string;
  assetCount: number;
}

export interface ReleaseDetail extends ReleaseSummary {
  body: string;
  assets: ReleaseAsset[];
}

interface ReleaseRow {
  id: number;
  tagName: string;
  name: string;
  body: string;
  objectId: string;
  createdAt: string;
}

export class ReleaseService {
  constructor(
    private readonly database: Database,
    private readonly repositories: RepositoryService,
    private readonly mutations: RepositoryMutationService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  list(repositoryId: number): ReleaseSummary[] {
    return this.database
      .prepare(
        `
        SELECT r.id, r.tag_name AS tagName, r.name, r.object_id AS objectId, r.created_at AS createdAt,
          (SELECT count(*) FROM release_assets WHERE release_id = r.id) AS assetCount
        FROM releases r WHERE r.repository_id = ? ORDER BY r.created_at DESC
      `,
      )
      .all(repositoryId) as ReleaseSummary[];
  }

  get(repositoryId: number, tagNameInput: string): ReleaseDetail | null {
    const row = this.database
      .prepare(
        `SELECT id, tag_name AS tagName, name, body, object_id AS objectId, created_at AS createdAt
         FROM releases WHERE repository_id = ? AND tag_name = ?`,
      )
      .get(repositoryId, tagNameInput) as ReleaseRow | undefined;
    if (!row) return null;
    const assets = this.database
      .prepare(
        `SELECT id, filename, content_type AS contentType, size, created_at AS createdAt
         FROM release_assets WHERE release_id = ? ORDER BY filename`,
      )
      .all(row.id) as ReleaseAsset[];
    return { ...row, assetCount: assets.length, assets };
  }

  async create(input: {
    repository: Repository;
    actorUserId: number;
    tagName: string;
    name: string;
    body: string;
    ref?: string;
  }): Promise<ReleaseDetail> {
    this.repositories.require(input.repository, input.actorUserId, 'write');
    const tagName = validateRef(input.tagName);
    const name = input.name.trim();
    if (name.length > 255)
      throw new ValidationError('Release title must be at most 255 characters');
    const body = input.body;
    if (body.length > 65_536) throw new ValidationError('Release notes must be at most 64KB');
    let objectId: string;
    try {
      objectId = await this.repositories.resolveCommit(input.repository, tagName);
    } catch {
      await this.mutations.createTag(
        input.repository,
        input.actorUserId,
        tagName,
        input.ref && input.ref.length > 0 ? input.ref : input.repository.defaultBranch,
      );
      objectId = await this.repositories.resolveCommit(input.repository, tagName);
    }
    const existing = this.database
      .prepare('SELECT 1 FROM releases WHERE repository_id = ? AND tag_name = ?')
      .get(input.repository.id, tagName);
    if (existing) throw new ValidationError('A release for this tag already exists');
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO releases(repository_id, tag_name, name, body, object_id, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.repository.id, tagName, name, body, objectId, input.actorUserId, now);
    this.audit.record({
      actorUserId: input.actorUserId,
      action: 'release.created',
      targetType: 'repository',
      targetId: String(input.repository.id),
      metadata: { tagName },
    });
    const release = this.get(input.repository.id, tagName);
    if (!release) throw new NotFoundError();
    return release;
  }

  async delete(repository: Repository, actorUserId: number, tagNameInput: string): Promise<void> {
    this.repositories.require(repository, actorUserId, 'write');
    const tagName = validateRef(tagNameInput);
    const release = this.database
      .prepare('SELECT id FROM releases WHERE repository_id = ? AND tag_name = ?')
      .get(repository.id, tagName) as { id: number } | undefined;
    if (!release) throw new NotFoundError();
    const assets = this.database
      .prepare('SELECT storage_key AS storageKey FROM release_assets WHERE release_id = ?')
      .all(release.id) as { storageKey: string }[];
    this.database.prepare('DELETE FROM releases WHERE id = ?').run(release.id);
    await Promise.all(assets.map((asset) => rm(this.assetPath(asset.storageKey), { force: true })));
    this.audit.record({
      actorUserId,
      action: 'release.deleted',
      targetType: 'repository',
      targetId: String(repository.id),
      metadata: { tagName },
    });
  }

  async addAsset(input: {
    repository: Repository;
    actorUserId: number;
    tagName: string;
    filename: string;
    contentType: string;
    content: Buffer;
  }): Promise<ReleaseAsset> {
    this.repositories.require(input.repository, input.actorUserId, 'write');
    if (input.content.length > this.config.limits.requestBodyBytes)
      throw new PayloadTooLargeError(input.content.length);
    const tagName = validateRef(input.tagName);
    const release = this.database
      .prepare('SELECT id FROM releases WHERE repository_id = ? AND tag_name = ?')
      .get(input.repository.id, tagName) as { id: number } | undefined;
    if (!release) throw new NotFoundError();
    const filename = input.filename.replaceAll(/[/\\\0]/g, '_').slice(0, 255);
    if (filename.length < 1) throw new ValidationError('Invalid asset filename');
    const storageKey = randomBytes(24).toString('hex');
    const directory = join(this.config.storage.data, 'releases');
    await mkdir(directory, { recursive: true, mode: 0o750 });
    await writeFile(join(directory, storageKey), input.content, { mode: 0o640 });
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        `INSERT INTO release_assets(release_id, filename, content_type, size, storage_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        release.id,
        filename,
        input.contentType || 'application/octet-stream',
        input.content.length,
        storageKey,
        now,
      );
    return {
      id: Number(result.lastInsertRowid),
      filename,
      contentType: input.contentType || 'application/octet-stream',
      size: input.content.length,
      createdAt: now,
    };
  }

  async readAsset(
    repository: Repository,
    assetId: number,
  ): Promise<{ content: Buffer; filename: string; contentType: string }> {
    const asset = this.database
      .prepare(
        `SELECT ra.filename AS filename, ra.content_type AS contentType, ra.storage_key AS storageKey
         FROM release_assets ra JOIN releases r ON r.id = ra.release_id
         WHERE ra.id = ? AND r.repository_id = ?`,
      )
      .get(assetId, repository.id) as
      { filename: string; contentType: string; storageKey: string } | undefined;
    if (!asset) throw new NotFoundError();
    const content = await readFile(this.assetPath(asset.storageKey));
    return { content, filename: asset.filename, contentType: asset.contentType };
  }

  private assetPath(storageKey: string): string {
    if (!/^[0-9a-f]{48}$/.test(storageKey)) throw new ValidationError('Invalid asset storage key');
    return join(this.config.storage.data, 'releases', storageKey);
  }
}
