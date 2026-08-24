import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditService } from '../audit/audit-service.js';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../database/database.js';
import { GitError } from '../git/errors.js';
import type { GitRunner } from '../git/git-runner.js';
import { validateObjectId, validateRef, validateRepoPath } from '../security/validation.js';
import type { RepositoryService } from './repository-service.js';
import type { Repository, RepositoryEventPublisher } from './repository-types.js';

export class RepositoryMutationService {
  private publishEvent: RepositoryEventPublisher = () => undefined;

  constructor(
    private readonly database: Database,
    private readonly git: GitRunner,
    private readonly repositories: RepositoryService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  setEventPublisher(publisher: RepositoryEventPublisher): void {
    this.publishEvent = publisher;
  }

  async commitFile(input: {
    repository: Repository;
    actorUserId: number;
    branch: string;
    filePath: string;
    content?: Buffer;
    message: string;
  }): Promise<string> {
    return await this.commitFiles({
      repository: input.repository,
      actorUserId: input.actorUserId,
      branch: input.branch,
      files: [
        {
          path: input.filePath,
          ...(input.content === undefined ? {} : { content: input.content }),
        },
      ],
      message: input.message,
    });
  }

  async commitFiles(input: {
    repository: Repository;
    actorUserId: number;
    branch: string;
    files: readonly { path: string; content?: Buffer }[];
    message: string;
  }): Promise<string> {
    this.repositories.require(input.repository, input.actorUserId, 'write');
    ensureWebWritable(input.repository);
    const branch = validateRef(input.branch);
    if (input.files.length < 1 || input.files.length > 100)
      throw new WebCommitInputError('A web commit must contain between 1 and 100 files', 400);
    const files = input.files.map((file) => ({ ...file, path: validateRepoPath(file.path) }));
    if (new Set(files.map((file) => file.path)).size !== files.length)
      throw new WebCommitInputError('A web commit contains duplicate paths', 400);
    const totalBytes = files.reduce((total, file) => total + (file.content?.length ?? 0), 0);
    if (
      totalBytes > this.config.limits.requestBodyBytes ||
      files.some((file) => (file.content?.length ?? 0) > this.config.limits.filePreviewBytes)
    )
      throw new WebCommitInputError('File upload exceeds configured limits', 413);
    const message = input.message.trim();
    if (message.length < 1 || message.length > 10_000 || message.includes('\0')) {
      throw new WebCommitInputError('Commit message must be between 1 and 10,000 characters', 400);
    }
    const repositoryPath = await this.repositories.storagePath(input.repository);
    const oldCommit = await this.repositories.resolveCommit(input.repository, branch);
    const temporaryRoot = join(this.config.storage.data, 'tmp');
    await mkdir(temporaryRoot, { recursive: true, mode: 0o750 });
    const temporaryDirectory = await mkdtemp(join(temporaryRoot, 'web-commit-'));
    const indexFile = join(temporaryDirectory, 'index');
    try {
      await this.git.run(['--git-dir', repositoryPath, 'read-tree', oldCommit], { indexFile });
      for (const file of files) {
        if (file.content !== undefined) {
          const blob = await this.git.run(
            ['--git-dir', repositoryPath, 'hash-object', '-w', '--stdin'],
            { input: file.content },
          );
          const blobId = validateObjectId(blob.stdout.toString('ascii').trim());
          await this.git.run(
            [
              '--git-dir',
              repositoryPath,
              'update-index',
              '--add',
              '--cacheinfo',
              `100644,${blobId},${file.path}`,
            ],
            { indexFile },
          );
        } else {
          await this.git.run(['--git-dir', repositoryPath, 'update-index', '-z', '--index-info'], {
            indexFile,
            input: Buffer.from(`0 ${'0'.repeat(40)}\t${file.path}\0`),
          });
        }
      }
      const tree = await this.git.run(['--git-dir', repositoryPath, 'write-tree'], { indexFile });
      const treeId = validateObjectId(tree.stdout.toString('ascii').trim());
      const actor = this.database
        .prepare('SELECT username, display_name, email FROM users WHERE id = ? AND status = ?')
        .get(input.actorUserId, 'active') as
        { username: string; display_name: string; email: string | null } | undefined;
      if (!actor) throw new WebCommitInputError('Account is not active', 403);
      const commit = await this.git.run(
        [
          '-c',
          `user.name=${actor.display_name}`,
          '-c',
          `user.email=${actor.email ?? `${actor.username}@users.noreply.local`}`,
          '--git-dir',
          repositoryPath,
          'commit-tree',
          treeId,
          '-p',
          oldCommit,
        ],
        { input: Buffer.from(`${message}\n`) },
      );
      const commitId = validateObjectId(commit.stdout.toString('ascii').trim());
      try {
        await this.git.run([
          '--git-dir',
          repositoryPath,
          'update-ref',
          `refs/heads/${branch}`,
          commitId,
          oldCommit,
        ]);
      } catch (error) {
        if (error instanceof GitError) {
          throw new WebCommitConflictError('The branch changed while the commit was being created');
        }
        throw error;
      }
      const now = new Date().toISOString();
      this.database.transaction(() => {
        this.database
          .prepare('UPDATE repositories SET updated_at = ? WHERE id = ?')
          .run(now, input.repository.id);
        this.database
          .prepare(
            `
            INSERT INTO search_jobs(repository_id, kind, available_at, created_at)
            VALUES (?, 'repository', ?, ?)
            ON CONFLICT(repository_id, kind) DO UPDATE SET
              state = 'pending', available_at = excluded.available_at, lease_until = NULL, error = NULL
          `,
          )
          .run(input.repository.id, now, now);
        this.audit.record({
          actorUserId: input.actorUserId,
          action: 'commit.createdViaWeb',
          targetType: 'repository',
          targetId: String(input.repository.id),
          metadata: {
            branch,
            paths: files
              .map((file) => file.path)
              .join(',')
              .slice(0, 2000),
            fileCount: files.length,
          },
        });
      })();
      this.publishEvent('commit.createdViaWeb', {
        ...repositoryEvent(input.repository),
        branch,
      });
      return commitId;
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async createBranch(
    repository: Repository,
    actorUserId: number,
    nameInput: string,
    source: string,
  ): Promise<void> {
    this.repositories.require(repository, actorUserId, 'write');
    ensureWebWritable(repository);
    const name = validateRef(nameInput);
    const sourceId = await this.repositories.resolveCommit(repository, source);
    const path = await this.repositories.storagePath(repository);
    await this.git.run([
      '--git-dir',
      path,
      'update-ref',
      `refs/heads/${name}`,
      sourceId,
      '0'.repeat(40),
    ]);
    this.audit.record({
      actorUserId,
      action: 'branch.created',
      targetType: 'repository',
      targetId: String(repository.id),
      metadata: { branch: name },
    });
    this.publishEvent('branch.created', { ...repositoryEvent(repository), branch: name });
  }

  async deleteBranch(
    repository: Repository,
    actorUserId: number,
    nameInput: string,
  ): Promise<void> {
    this.repositories.require(repository, actorUserId, 'write');
    ensureWebWritable(repository);
    const name = validateRef(nameInput);
    if (name === repository.defaultBranch)
      throw new WebCommitConflictError('The default branch cannot be deleted');
    const path = await this.repositories.storagePath(repository);
    await this.git.run(['--git-dir', path, 'update-ref', '-d', `refs/heads/${name}`]);
    this.audit.record({
      actorUserId,
      action: 'branch.deleted',
      targetType: 'repository',
      targetId: String(repository.id),
      metadata: { branch: name },
    });
    this.publishEvent('branch.deleted', { ...repositoryEvent(repository), branch: name });
  }

  async createTag(
    repository: Repository,
    actorUserId: number,
    nameInput: string,
    source: string,
  ): Promise<void> {
    this.repositories.require(repository, actorUserId, 'write');
    ensureWebWritable(repository);
    const name = validateRef(nameInput);
    const sourceId = await this.repositories.resolveCommit(repository, source);
    const path = await this.repositories.storagePath(repository);
    await this.git.run([
      '--git-dir',
      path,
      'update-ref',
      `refs/tags/${name}`,
      sourceId,
      '0'.repeat(40),
    ]);
    this.audit.record({
      actorUserId,
      action: 'tag.created',
      targetType: 'repository',
      targetId: String(repository.id),
      metadata: { tag: name },
    });
    this.publishEvent('tag.created', { ...repositoryEvent(repository), tag: name });
  }

  async deleteTag(repository: Repository, actorUserId: number, nameInput: string): Promise<void> {
    this.repositories.require(repository, actorUserId, 'write');
    ensureWebWritable(repository);
    const name = validateRef(nameInput);
    const path = await this.repositories.storagePath(repository);
    await this.git.run(['--git-dir', path, 'update-ref', '-d', `refs/tags/${name}`]);
    this.audit.record({
      actorUserId,
      action: 'tag.deleted',
      targetType: 'repository',
      targetId: String(repository.id),
      metadata: { tag: name },
    });
    this.publishEvent('tag.deleted', { ...repositoryEvent(repository), tag: name });
  }
}

function repositoryEvent(repository: Repository): Readonly<Record<string, unknown>> {
  return {
    repositoryId: repository.id,
    owner: repository.ownerSlug,
    repository: repository.slug,
    visibility: repository.visibility,
  };
}

function ensureWebWritable(repository: Repository): void {
  if (repository.storageKind === 'working_tree')
    throw new WebCommitInputError(
      'Working-tree repositories are browse-only in the web interface',
      409,
    );
}

export class WebCommitInputError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}
export class WebCommitConflictError extends Error {
  readonly statusCode = 409;
}
