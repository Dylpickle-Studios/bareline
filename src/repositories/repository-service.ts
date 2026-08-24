import { randomBytes } from 'node:crypto';
import { product } from '../app/metadata.js';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AuditService } from '../audit/audit-service.js';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../database/database.js';
import type { GitRunner } from '../git/git-runner.js';
import {
  ValidationError,
  validateObjectId,
  validateRef,
  validateRepoPath,
  validateSlug,
} from '../security/validation.js';
import type {
  Permission,
  Repository,
  RepositoryEventPublisher,
  TreeEntry,
  Visibility,
} from './repository-types.js';

interface RepositoryRow {
  id: number;
  owner_type: 'user' | 'group';
  owner_id: number;
  owner_slug: string;
  slug: string;
  description: string;
  visibility: Visibility;
  storage_id: string;
  storage_kind: 'hosted_bare' | 'imported_bare' | 'working_tree';
  storage_path: string | null;
  default_branch: string;
}

export class RepositoryService {
  private publishEvent: RepositoryEventPublisher = () => undefined;

  constructor(
    private readonly database: Database,
    private readonly git: GitRunner,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  setEventPublisher(publisher: RepositoryEventPublisher): void {
    this.publishEvent = publisher;
  }

  async createForUser(input: {
    actorUserId: number;
    ownerUserId: number;
    slug: string;
    description?: string;
    visibility: Visibility;
    initializeReadme?: boolean;
    gitignore?: string;
    license?: string;
  }): Promise<Repository> {
    if (input.actorUserId !== input.ownerUserId) throw new AuthorizationError();
    return await this.createOwned({
      actorUserId: input.actorUserId,
      ownerType: 'user',
      ownerId: input.ownerUserId,
      slug: input.slug,
      description: input.description ?? '',
      visibility: input.visibility,
      initializeReadme: input.initializeReadme ?? false,
      gitignore: input.gitignore ?? '',
      license: input.license ?? '',
    });
  }

  async createForGroup(input: {
    actorUserId: number;
    ownerGroupId: number;
    slug: string;
    description?: string;
    visibility: Visibility;
    initializeReadme?: boolean;
    gitignore?: string;
    license?: string;
  }): Promise<Repository> {
    const role = this.database
      .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(input.ownerGroupId, input.actorUserId) as { role: string } | undefined;
    if (role?.role !== 'owner' && role?.role !== 'manager') throw new AuthorizationError();
    return await this.createOwned({
      actorUserId: input.actorUserId,
      ownerType: 'group',
      ownerId: input.ownerGroupId,
      slug: input.slug,
      description: input.description ?? '',
      visibility: input.visibility,
      initializeReadme: input.initializeReadme ?? false,
      gitignore: input.gitignore ?? '',
      license: input.license ?? '',
    });
  }

  async importExisting(input: {
    actorUserId: number;
    ownerType: 'user' | 'group';
    ownerId: number;
    slug: string;
    description?: string;
    visibility: Visibility;
    sourcePath: string;
  }): Promise<Repository> {
    const administrator = this.database
      .prepare("SELECT id FROM users WHERE id = ? AND status = 'active' AND is_admin = 1")
      .get(input.actorUserId);
    if (!administrator) throw new AuthorizationError();
    const requestedSource = resolve(input.sourcePath);
    if ((await lstat(requestedSource)).isSymbolicLink())
      throw new ValidationError('Repository import path may not be a symbolic link');
    const source = await realpath(requestedSource);
    let allowed = false;
    for (const configuredRoot of this.config.storage.importRoots) {
      const root = await realpath(configuredRoot);
      if (source === root || source.startsWith(`${root}/`)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) throw new ValidationError('Repository path is outside configured import roots');
    const bareResult = await this.git.run(['-C', source, 'rev-parse', '--is-bare-repository']);
    const bare = bareResult.stdout.toString('ascii').trim() === 'true';
    let storagePath = source;
    let storageKind: 'imported_bare' | 'working_tree' = 'imported_bare';
    if (!bare) {
      const worktree = await this.git.run(['-C', source, 'rev-parse', '--is-inside-work-tree']);
      if (worktree.stdout.toString('ascii').trim() !== 'true')
        throw new ValidationError('Import path is not a Git repository');
      storagePath = await realpath(join(source, '.git'));
      storageKind = 'working_tree';
    }
    const ownerTable = input.ownerType === 'user' ? 'users' : 'groups';
    const owner = this.database
      .prepare(`SELECT id FROM ${ownerTable} WHERE id = ?`)
      .get(input.ownerId);
    if (!owner) throw new ValidationError('Repository owner does not exist');
    const slug = validateSlug(input.slug, 'repository');
    const head = await this.git.run(['--git-dir', storagePath, 'symbolic-ref', '--short', 'HEAD'], {
      acceptedExitCodes: [0, 1],
    });
    const defaultBranch =
      head.exitCode === 0
        ? head.stdout
            .toString('utf8')
            .trim()
            .replace(/^refs\/heads\//, '')
        : 'main';
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        `INSERT INTO repositories(owner_type, owner_id, slug, description, visibility, storage_id, storage_kind, storage_path, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.ownerType,
        input.ownerId,
        slug,
        input.description ?? '',
        input.visibility,
        randomBytes(32).toString('hex'),
        storageKind,
        storagePath,
        defaultBranch,
        now,
        now,
      );
    const repository = this.getById(Number(result.lastInsertRowid));
    this.audit.record({
      actorUserId: input.actorUserId,
      action: 'repository.imported',
      targetType: 'repository',
      targetId: String(repository.id),
      metadata: { storageKind },
    });
    this.publishEvent('repository.created', repositoryEvent(repository));
    return repository;
  }

  async importExistingByOwnerName(input: {
    actorUserId: number;
    ownerType: 'user' | 'group';
    ownerSlug: string;
    slug: string;
    description?: string;
    visibility: Visibility;
    sourcePath: string;
  }): Promise<Repository> {
    const table = input.ownerType === 'user' ? 'users' : 'groups';
    const column = input.ownerType === 'user' ? 'username' : 'slug';
    const row = this.database
      .prepare(`SELECT id FROM ${table} WHERE ${column} = ?`)
      .get(input.ownerSlug.toLowerCase()) as { id: number } | undefined;
    if (!row) throw new ValidationError('Repository owner does not exist');
    return await this.importExisting({
      actorUserId: input.actorUserId,
      ownerType: input.ownerType,
      ownerId: row.id,
      slug: input.slug,
      ...(input.description === undefined ? {} : { description: input.description }),
      visibility: input.visibility,
      sourcePath: input.sourcePath,
    });
  }

  private async createOwned(input: {
    actorUserId: number;
    ownerType: 'user' | 'group';
    ownerId: number;
    slug: string;
    description: string;
    visibility: Visibility;
    initializeReadme: boolean;
    gitignore: string;
    license: string;
  }): Promise<Repository> {
    const slug = validateSlug(input.slug, 'repository');
    const storageId = randomBytes(32).toString('hex');
    const now = new Date().toISOString();
    const row = this.database.transaction(() => {
      const result = this.database
        .prepare(
          `
          INSERT INTO repositories
            (owner_type, owner_id, slug, description, visibility, storage_id, storage_kind, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'hosted_bare', ?, ?)
        `,
        )
        .run(
          input.ownerType,
          input.ownerId,
          slug,
          input.description,
          input.visibility,
          storageId,
          now,
          now,
        );
      this.audit.record({
        actorUserId: input.actorUserId,
        action: 'repository.created',
        targetType: 'repository',
        targetId: String(result.lastInsertRowid),
        metadata: { visibility: input.visibility },
      });
      return Number(result.lastInsertRowid);
    })();

    const repository = this.getById(row);
    try {
      await this.initializeStorage(repository, {
        readme: input.initializeReadme,
        gitignore: input.gitignore,
        license: input.license,
      });
    } catch (error) {
      this.database.prepare('DELETE FROM repositories WHERE id = ?').run(repository.id);
      throw error;
    }
    this.publishEvent('repository.created', repositoryEvent(repository));
    return repository;
  }

  private async initializeStorage(
    repository: Repository,
    initialization: { readme: boolean; gitignore: string; license: string },
  ): Promise<void> {
    const path = this.hostedPath(repository.storageId);
    await mkdir(join(path, '..'), { recursive: true, mode: 0o750 });
    await this.git.run([
      'init',
      '--bare',
      '--initial-branch',
      repository.defaultBranch,
      '--',
      path,
    ]);
    const files = new Map<string, string>();
    if (initialization.readme) files.set('README.md', `# ${repository.slug}\n`);
    if (initialization.gitignore) {
      const content = gitignoreTemplates[initialization.gitignore];
      if (!content) throw new ValidationError('Unknown .gitignore template');
      files.set('.gitignore', content);
    }
    if (initialization.license) {
      const content = licenseTemplates[initialization.license];
      if (!content) throw new ValidationError('Unknown license template');
      files.set(
        'LICENSE',
        content
          .replaceAll('{{ year }}', String(new Date().getUTCFullYear()))
          .replaceAll('{{ owner }}', repository.ownerSlug),
      );
    }
    if (files.size > 0) {
      const treeEntries: string[] = [];
      for (const [filename, content] of [...files].sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        const blob = await this.git.run(['--git-dir', path, 'hash-object', '-w', '--stdin'], {
          input: Buffer.from(content),
        });
        treeEntries.push(`100644 blob ${blob.stdout.toString('ascii').trim()}\t${filename}\n`);
      }
      const tree = await this.git.run(['--git-dir', path, 'mktree'], {
        input: Buffer.from(treeEntries.join('')),
      });
      const envMessage = Buffer.from('Initial commit\n');
      const commit = await this.git.run(
        [
          '-c',
          `user.name=${product.name}`,
          '-c',
          'user.email=noreply@localhost',
          '--git-dir',
          path,
          'commit-tree',
          tree.stdout.toString('ascii').trim(),
        ],
        { input: envMessage },
      );
      await this.git.run([
        '--git-dir',
        path,
        'update-ref',
        `refs/heads/${repository.defaultBranch}`,
        commit.stdout.toString('ascii').trim(),
      ]);
    }
  }

  getById(id: number): Repository {
    const row = this.database
      .prepare(this.selectSql('WHERE r.id = ? AND r.deleted_at IS NULL'))
      .get(id) as RepositoryRow | undefined;
    if (!row) throw new NotFoundError();
    return mapRepository(row);
  }

  find(owner: string, slug: string): Repository | null {
    const row = this.database
      .prepare(
        this.selectSql(`WHERE r.slug = ? AND r.deleted_at IS NULL AND (
          (r.owner_type = 'user' AND u.username = ?) OR (r.owner_type = 'group' AND g.slug = ?)
        )`),
      )
      .get(slug.toLowerCase(), owner.toLowerCase(), owner.toLowerCase()) as
      RepositoryRow | undefined;
    return row ? mapRepository(row) : null;
  }

  listAccessible(
    userId: number | null,
    page = 1,
    pageSize = 30,
    filters: { owner?: string; visibility?: Visibility; query?: string } = {},
  ): Repository[] {
    const limit = Math.min(Math.max(pageSize, 1), 100);
    const offset = Math.max(page - 1, 0) * limit;
    const publicAccess = this.config.anonymous.publicRepositories ? 1 : 0;
    const filterSql = [
      filters.owner ? 'owner_slug = ?' : null,
      filters.visibility ? 'r.visibility = ?' : null,
      filters.query ? "(r.slug LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\')" : null,
    ]
      .filter((clause): clause is string => clause !== null)
      .map((clause) => ` AND ${clause}`)
      .join('');
    const search = filters.query
      ? `%${filters.query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
      : null;
    const filterValues = [
      ...(filters.owner ? [filters.owner] : []),
      ...(filters.visibility ? [filters.visibility] : []),
      ...(search ? [search, search] : []),
    ];
    return (
      this.database
        .prepare(
          this.selectSql(`WHERE r.deleted_at IS NULL AND (
            (r.visibility = 'public' AND ? = 1)
            OR (r.owner_type = 'user' AND r.owner_id = ?)
            OR (r.owner_type = 'group' AND EXISTS (
              SELECT 1 FROM group_members gm WHERE gm.group_id = r.owner_id AND gm.user_id = ?
            ))
            OR EXISTS (
              SELECT 1 FROM repository_grants rg WHERE rg.repository_id = r.id AND (
                (rg.principal_type = 'user' AND rg.principal_id = ?)
                OR (rg.principal_type = 'group' AND EXISTS (
                  SELECT 1 FROM group_members gm WHERE gm.group_id = rg.principal_id AND gm.user_id = ?
                ))
              )
            )
          )${filterSql} ORDER BY owner_slug, r.slug LIMIT ? OFFSET ?`),
        )
        .all(
          publicAccess,
          userId,
          userId,
          userId,
          userId,
          ...filterValues,
          limit,
          offset,
        ) as RepositoryRow[]
    ).map(mapRepository);
  }

  permission(repository: Repository, userId: number | null): Permission {
    if (repository.ownerType === 'user' && repository.ownerId === userId) return 'owner';
    if (repository.ownerType === 'group' && userId !== null) {
      const membership = this.database
        .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
        .get(repository.ownerId, userId) as { role: string } | undefined;
      if (membership?.role === 'owner') return 'owner';
      if (membership?.role === 'manager') return 'admin';
    }
    if (userId !== null) {
      const row = this.database
        .prepare(
          `
          SELECT level FROM repository_grants
          WHERE repository_id = ? AND (
            (principal_type = 'user' AND principal_id = ?) OR
            (principal_type = 'group' AND principal_id IN
              (SELECT group_id FROM group_members WHERE user_id = ?))
          )
          ORDER BY CASE level WHEN 'admin' THEN 3 WHEN 'write' THEN 2 ELSE 1 END DESC LIMIT 1
        `,
        )
        .get(repository.id, userId, userId) as { level: Permission } | undefined;
      if (row) return row.level;
    }
    return repository.visibility === 'public' && this.config.anonymous.publicRepositories
      ? 'read'
      : 'none';
  }

  require(
    repository: Repository,
    userId: number | null,
    minimum: Exclude<Permission, 'none'>,
  ): Permission {
    const levels: Record<Permission, number> = { none: 0, read: 1, write: 2, admin: 3, owner: 4 };
    const actual = this.permission(repository, userId);
    if (levels[actual] < levels[minimum]) throw new NotFoundError();
    return actual;
  }

  async storagePath(repository: Repository): Promise<string> {
    const path = repository.storagePath ?? this.hostedPath(repository.storageId);
    if (!repository.storagePath)
      return await this.git.assertRepository(
        path,
        await realpath(this.config.storage.repositories),
      );
    for (const configuredRoot of this.config.storage.importRoots) {
      const root = await realpath(configuredRoot);
      const candidate = await realpath(path);
      if (candidate === root || candidate.startsWith(`${root}/`))
        return await this.git.assertRepository(candidate, root);
    }
    throw new NotFoundError();
  }

  async resolveCommit(repository: Repository, ref: string): Promise<string> {
    const path = await this.storagePath(repository);
    const result = await this.git.run([
      '--git-dir',
      path,
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${ref}^{commit}`,
    ]);
    return validateObjectId(result.stdout.toString('ascii').trim());
  }

  async updateDefaultBranchHead(repository: Repository, branch: string): Promise<void> {
    const safeBranch = validateRef(branch);
    const repositoryPath = await this.storagePath(repository);
    await this.git.run([
      '--git-dir',
      repositoryPath,
      'symbolic-ref',
      'HEAD',
      `refs/heads/${safeBranch}`,
    ]);
  }

  async populateFromTemplate(target: Repository, source: Repository): Promise<void> {
    const sourcePath = await this.storagePath(source);
    const targetPath = await this.storagePath(target);
    await this.git.run([
      '--git-dir',
      targetPath,
      'fetch',
      '--prune',
      sourcePath,
      '+refs/heads/*:refs/heads/*',
      '+refs/tags/*:refs/tags/*',
    ]);
    target.defaultBranch = source.defaultBranch;
    await this.git.run([
      '--git-dir',
      targetPath,
      'symbolic-ref',
      'HEAD',
      `refs/heads/${validateRef(source.defaultBranch)}`,
    ]);
    this.database
      .prepare('UPDATE repositories SET default_branch=?, updated_at=? WHERE id=?')
      .run(source.defaultBranch, new Date().toISOString(), target.id);
  }

  async discardFailedCreation(repository: Repository): Promise<void> {
    if (repository.storageKind !== 'hosted_bare' || repository.storagePath)
      throw new ValidationError('Only newly hosted repositories can be discarded');
    const path = this.hostedPath(repository.storageId);
    const root = resolve(this.config.storage.repositories);
    if (!resolve(path).startsWith(`${root}/`))
      throw new ValidationError('Repository storage path is unsafe');
    await rm(path, { recursive: true, force: true });
    this.database.prepare('DELETE FROM repositories WHERE id=?').run(repository.id);
  }

  async listTree(repository: Repository, ref: string, directory = ''): Promise<TreeEntry[]> {
    const path = await this.storagePath(repository);
    const commit = await this.resolveCommit(repository, ref);
    const safeDirectory = directory ? validateRepoPath(directory) : '';
    const treeish = safeDirectory ? `${commit}:${safeDirectory}` : commit;
    const result = await this.git.run([
      '--git-dir',
      path,
      'ls-tree',
      '-z',
      '--long',
      '--full-name',
      '--end-of-options',
      treeish,
    ]);
    const entries = parseTree(result.stdout);
    return safeDirectory
      ? entries.map((entry) => ({
          ...entry,
          name: entry.name.startsWith(`${safeDirectory}/`)
            ? entry.name
            : `${safeDirectory}/${entry.name}`,
        }))
      : entries;
  }

  async readBlob(
    repository: Repository,
    ref: string,
    file: string,
    options: { allowLarge?: boolean } = {},
  ): Promise<Buffer> {
    const path = await this.storagePath(repository);
    const commit = await this.resolveCommit(repository, ref);
    const safePath = validateRepoPath(file);
    const treeResult = await this.git.run([
      '--git-dir',
      path,
      'ls-tree',
      '-z',
      '--long',
      '--full-name',
      commit,
      '--',
      `:(literal)${safePath}`,
    ]);
    const entry = parseTree(treeResult.stdout).find((candidate) => candidate.name === safePath);
    if (entry?.type !== 'blob') throw new NotFoundError();
    const maximum = options.allowLarge
      ? this.config.limits.gitOutputBytes
      : this.config.limits.filePreviewBytes;
    if ((entry.size ?? maximum + 1) > maximum) throw new PayloadTooLargeError(entry.size ?? null);
    const result = await this.git.run(['--git-dir', path, 'cat-file', 'blob', entry.objectId], {
      maxOutputBytes: maximum,
      truncateOutput: true,
    });
    if (result.truncated) throw new PayloadTooLargeError(entry.size ?? null);
    return result.stdout;
  }

  async submoduleUrls(repository: Repository, ref: string): Promise<Map<string, string>> {
    try {
      return parseGitmodules(
        (await this.readBlob(repository, ref, '.gitmodules')).toString('utf8'),
      );
    } catch (error) {
      if (error instanceof NotFoundError) return new Map();
      throw error;
    }
  }

  private hostedPath(storageId: string): string {
    return join(this.config.storage.repositories, storageId.slice(0, 2), `${storageId}.git`);
  }

  private selectSql(where: string): string {
    return `SELECT r.*, COALESCE(u.username, g.slug) AS owner_slug
      FROM repositories r
      LEFT JOIN users u ON r.owner_type = 'user' AND r.owner_id = u.id
      LEFT JOIN groups g ON r.owner_type = 'group' AND r.owner_id = g.id
      ${where}`;
  }
}

export const gitignoreTemplates: Readonly<Record<string, string>> = Object.freeze({
  node: 'node_modules/\ndist/\ncoverage/\n.env\n',
  python: '__pycache__/\n*.py[cod]\n.venv/\ndist/\n',
  rust: '/target/\nCargo.lock\n',
});

export const licenseTemplates: Readonly<Record<string, string>> = Object.freeze({
  mit: 'MIT License\n\nCopyright (c) {{ year }} {{ owner }}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, subject to the conditions of the MIT License.\n',
  'apache-2.0':
    'Apache License\nVersion 2.0, January 2004\nhttps://www.apache.org/licenses/LICENSE-2.0\n',
  'agpl-3.0':
    'GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007\nhttps://www.gnu.org/licenses/agpl-3.0.html\n',
});

export function parseGitmodules(value: string): Map<string, string> {
  if (value.length > 1024 * 1024) return new Map();
  const result = new Map<string, string>();
  let path: string | null = null;
  let url: string | null = null;
  const commit = () => {
    if (path && url) {
      try {
        result.set(validateRepoPath(path), url.slice(0, 2048));
      } catch {
        // Invalid paths in hostile repository configuration are ignored.
      }
    }
    path = null;
    url = null;
  };
  for (const line of value.split(/\r?\n/).slice(0, 20_000)) {
    if (/^\s*\[submodule\s+"[^"]+"\]\s*$/.test(line)) {
      commit();
      continue;
    }
    const property = /^\s*(path|url)\s*=\s*(.*?)\s*$/.exec(line);
    if (property?.[1] === 'path') path = property[2] ?? null;
    else if (property?.[1] === 'url') url = property[2] ?? null;
  }
  commit();
  return result;
}

function mapRepository(row: RepositoryRow): Repository {
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    ownerSlug: row.owner_slug,
    slug: row.slug,
    description: row.description,
    visibility: row.visibility,
    storageId: row.storage_id,
    storageKind: row.storage_kind,
    storagePath: row.storage_path,
    defaultBranch: row.default_branch,
  };
}

function repositoryEvent(repository: Repository): Readonly<Record<string, unknown>> {
  return {
    repositoryId: repository.id,
    owner: repository.ownerSlug,
    repository: repository.slug,
    visibility: repository.visibility,
  };
}

function parseTree(output: Buffer): TreeEntry[] {
  return output
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+) (blob|tree|commit) ([0-9a-f]+)\s+(-|\d+)\t(.+)$/.exec(line);
      if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5]) {
        throw new Error('Git returned an invalid tree entry');
      }
      return {
        mode: match[1],
        type: match[2] as TreeEntry['type'],
        objectId: validateObjectId(match[3]),
        size: match[4] === '-' ? null : Number(match[4]),
        name: match[5],
      };
    });
}

export class NotFoundError extends Error {
  readonly statusCode = 404;
}
export class AuthorizationError extends Error {
  readonly statusCode = 403;
}
export class PayloadTooLargeError extends Error {
  readonly statusCode = 413;

  constructor(readonly bytes: number | null = null) {
    super('Repository blob exceeds the configured rendering limit');
  }
}
