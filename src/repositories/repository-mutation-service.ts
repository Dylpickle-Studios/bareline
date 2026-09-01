import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditService } from '../audit/audit-service.js';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../database/database.js';
import { GitError } from '../git/errors.js';
import { type DiffFile, parseDiffFiles } from '../git/git-browser.js';
import type { GitRunner } from '../git/git-runner.js';
import { validateObjectId, validateRef, validateRepoPath } from '../security/validation.js';
import type { RepositoryService } from './repository-service.js';
import type { Repository, RepositoryEventPublisher } from './repository-types.js';
import type { RepositoryEnhancementService } from './repository-enhancement-service.js';

/** Hard ceiling on how many commits a single imported patch series may create. */
const MAX_PATCH_COMMITS = 100;

export interface PatchPreviewCommit {
  subject: string;
  message: string;
  authorName: string | null;
  authorEmail: string | null;
  authoredAt: string | null;
  applied: boolean;
  error: string | null;
  additions: number;
  deletions: number;
  filesChanged: number;
  diffFiles: DiffFile[];
}

export interface PatchPreview {
  branch: string;
  baseObjectId: string;
  commits: PatchPreviewCommit[];
  valid: boolean;
}

export class RepositoryMutationService {
  private publishEvent: RepositoryEventPublisher = () => undefined;

  constructor(
    private readonly database: Database,
    private readonly git: GitRunner,
    private readonly repositories: RepositoryService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly enhancements?: RepositoryEnhancementService,
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
    this.enhancements?.assertWebCommit(input.repository.id, branch, message);
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
      this.enhancements?.recordActivity(
        input.repository.id,
        input.actorUserId,
        'commit.createdViaWeb',
        branch,
        { fileCount: files.length, commitId },
      );
      return commitId;
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  /**
   * Dry-runs a `git format-patch`-style patch (or raw unified diff) against a branch tip,
   * without creating any commit or moving any ref, so the web UI can show what an import
   * would do before the user confirms it.
   */
  async previewPatch(input: {
    repository: Repository;
    actorUserId: number;
    branch: string;
    patchContent: Buffer;
  }): Promise<PatchPreview> {
    this.repositories.require(input.repository, input.actorUserId, 'write');
    ensureWebWritable(input.repository);
    const branch = validateRef(input.branch);
    if (
      input.patchContent.length < 1 ||
      input.patchContent.length > this.config.limits.requestBodyBytes
    )
      throw new WebCommitInputError('Patch file exceeds configured limits', 413);
    const repositoryPath = await this.repositories.storagePath(input.repository);
    const baseObjectId = await this.repositories.resolveCommit(input.repository, branch);
    const temporaryRoot = join(this.config.storage.data, 'tmp');
    await mkdir(temporaryRoot, { recursive: true, mode: 0o750 });
    const temporaryDirectory = await mkdtemp(join(temporaryRoot, 'patch-preview-'));
    const indexFile = join(temporaryDirectory, 'index');
    try {
      await this.git.run(['--git-dir', repositoryPath, 'read-tree', baseObjectId], { indexFile });
      const mailFiles = await this.splitPatchMessages(temporaryDirectory, input.patchContent);
      const commits: PatchPreviewCommit[] = [];
      for (const mailFile of mailFiles) {
        const parsed = await this.readPatchMessage(temporaryDirectory, mailFile);
        let error: string | null = isBlank(parsed.patchBody)
          ? 'No recognizable patch content was found in this section'
          : null;
        if (!error) {
          try {
            await this.git.run(
              [
                '--git-dir',
                repositoryPath,
                'apply',
                '--cached',
                '--index',
                '-p1',
                '--whitespace=nowarn',
              ],
              { indexFile, input: parsed.patchBody },
            );
          } catch (applyError) {
            error =
              applyError instanceof GitError
                ? applyError.message
                : 'The patch could not be applied';
          }
        }
        const diffFiles = parseDiffFiles(
          stripPatchSignature(parsed.patchBody.toString('utf8')),
          this.config.limits.diffFiles,
          this.config.limits.diffFileBytes,
        );
        commits.push({
          subject: parsed.subject,
          message: buildCommitMessage(parsed.subject, parsed.body, ''),
          authorName: sanitizeIdentity(parsed.authorName),
          authorEmail: sanitizeIdentity(parsed.authorEmail),
          authoredAt: sanitizeIdentity(parsed.authoredAt),
          applied: error === null,
          error,
          additions: diffFiles.reduce((total, file) => total + file.additions, 0),
          deletions: diffFiles.reduce((total, file) => total + file.deletions, 0),
          filesChanged: diffFiles.length,
          diffFiles,
        });
        if (error) break;
      }
      return {
        branch,
        baseObjectId,
        commits,
        valid: commits.length > 0 && commits.every((commit) => commit.applied),
      };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  /**
   * Applies a patch (or `git format-patch` series) to a branch, creating one commit per
   * patch section without ever materializing a working tree.
   */
  async importPatch(input: {
    repository: Repository;
    actorUserId: number;
    branch: string;
    patchContent: Buffer;
    fallbackMessage?: string;
    action?: 'patch.importedViaWeb' | 'commit.cherryPickedViaWeb' | 'commit.revertedViaWeb';
  }): Promise<string> {
    const action = input.action ?? 'patch.importedViaWeb';
    this.repositories.require(input.repository, input.actorUserId, 'write');
    ensureWebWritable(input.repository);
    const branch = validateRef(input.branch);
    if (
      input.patchContent.length < 1 ||
      input.patchContent.length > this.config.limits.requestBodyBytes
    )
      throw new WebCommitInputError('Patch file exceeds configured limits', 413);
    const repositoryPath = await this.repositories.storagePath(input.repository);
    const oldCommit = await this.repositories.resolveCommit(input.repository, branch);
    const temporaryRoot = join(this.config.storage.data, 'tmp');
    await mkdir(temporaryRoot, { recursive: true, mode: 0o750 });
    const temporaryDirectory = await mkdtemp(join(temporaryRoot, 'patch-import-'));
    const indexFile = join(temporaryDirectory, 'index');
    try {
      await this.git.run(['--git-dir', repositoryPath, 'read-tree', oldCommit], { indexFile });
      const mailFiles = await this.splitPatchMessages(temporaryDirectory, input.patchContent);
      const actor = this.database
        .prepare('SELECT username, display_name, email FROM users WHERE id = ? AND status = ?')
        .get(input.actorUserId, 'active') as
        { username: string; display_name: string; email: string | null } | undefined;
      if (!actor) throw new WebCommitInputError('Account is not active', 403);
      const committerName = actor.display_name;
      const committerEmail = actor.email ?? `${actor.username}@users.noreply.local`;

      let parent = oldCommit;
      let createdCount = 0;
      for (const mailFile of mailFiles) {
        const ordinal = createdCount + 1;
        const parsed = await this.readPatchMessage(temporaryDirectory, mailFile);
        if (isBlank(parsed.patchBody))
          throw new WebCommitInputError(
            `Patch ${String(ordinal)} contains no recognizable changes`,
            400,
          );
        try {
          await this.git.run(
            [
              '--git-dir',
              repositoryPath,
              'apply',
              '--cached',
              '--index',
              '-p1',
              '--whitespace=nowarn',
            ],
            { indexFile, input: parsed.patchBody },
          );
        } catch (applyError) {
          throw new WebCommitConflictError(
            applyError instanceof GitError
              ? `Patch ${String(ordinal)} failed to apply: ${applyError.message}`
              : `Patch ${String(ordinal)} failed to apply`,
          );
        }
        const message = buildCommitMessage(
          parsed.subject,
          parsed.body,
          input.fallbackMessage ?? '',
        ).trim();
        if (message.length < 1 || message.length > 10_000 || message.includes('\0'))
          throw new WebCommitInputError(
            `Patch ${String(ordinal)} needs a commit message between 1 and 10,000 characters`,
            400,
          );
        this.enhancements?.assertWebCommit(input.repository.id, branch, message);
        const tree = await this.git.run(['--git-dir', repositoryPath, 'write-tree'], {
          indexFile,
        });
        const treeId = validateObjectId(tree.stdout.toString('ascii').trim());
        const authorName = sanitizeIdentity(parsed.authorName) ?? committerName;
        const authorEmail = sanitizeIdentity(parsed.authorEmail) ?? committerEmail;
        const authoredAt = sanitizeIdentity(parsed.authoredAt);
        const commit = await this.git.run(
          [
            '-c',
            `user.name=${committerName}`,
            '-c',
            `user.email=${committerEmail}`,
            '--git-dir',
            repositoryPath,
            'commit-tree',
            treeId,
            '-p',
            parent,
          ],
          {
            input: Buffer.from(`${message}\n`),
            env: {
              GIT_AUTHOR_NAME: authorName,
              GIT_AUTHOR_EMAIL: authorEmail,
              ...(authoredAt ? { GIT_AUTHOR_DATE: authoredAt } : {}),
            },
          },
        );
        parent = validateObjectId(commit.stdout.toString('ascii').trim());
        createdCount += 1;
      }
      if (createdCount < 1)
        throw new WebCommitInputError('The uploaded patch produced no commits', 400);

      try {
        await this.git.run([
          '--git-dir',
          repositoryPath,
          'update-ref',
          `refs/heads/${branch}`,
          parent,
          oldCommit,
        ]);
      } catch (error) {
        if (error instanceof GitError) {
          throw new WebCommitConflictError('The branch changed while the patch was being imported');
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
          action,
          targetType: 'repository',
          targetId: String(input.repository.id),
          metadata: { branch, commitCount: createdCount },
        });
      })();
      this.publishEvent(action, { ...repositoryEvent(input.repository), branch });
      this.enhancements?.recordActivity(input.repository.id, input.actorUserId, action, branch, {
        commitCount: createdCount,
        commitId: parent,
      });
      return parent;
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  /** Applies a single commit's own diff onto another branch, creating a new commit there. */
  async cherryPick(input: {
    repository: Repository;
    actorUserId: number;
    objectId: string;
    targetBranch: string;
  }): Promise<string> {
    const objectId = validateObjectId(input.objectId);
    const repositoryPath = await this.repositories.storagePath(input.repository);
    const patch = await this.git.run([
      '--git-dir',
      repositoryPath,
      'format-patch',
      '--stdout',
      '--find-renames',
      '--no-ext-diff',
      '--no-textconv',
      '-1',
      '--end-of-options',
      objectId,
    ]);
    return await this.importPatch({
      repository: input.repository,
      actorUserId: input.actorUserId,
      branch: input.targetBranch,
      patchContent: patch.stdout,
      action: 'commit.cherryPickedViaWeb',
    });
  }

  /** Applies the inverse of a single (non-merge) commit onto a branch, undoing its changes. */
  async revertCommit(input: {
    repository: Repository;
    actorUserId: number;
    objectId: string;
    targetBranch: string;
  }): Promise<string> {
    const objectId = validateObjectId(input.objectId);
    const repositoryPath = await this.repositories.storagePath(input.repository);
    const metadata = await this.git.run([
      '--git-dir',
      repositoryPath,
      'show',
      '--no-patch',
      '--format=%P%x00%s',
      '--end-of-options',
      objectId,
    ]);
    const [parents, subject] = metadata.stdout.toString('utf8').split('\0');
    const parentIds = (parents ?? '').trim().split(' ').filter(Boolean);
    if (parentIds.length !== 1)
      throw new WebCommitInputError(
        'Only commits with exactly one parent can be reverted from the web UI',
        400,
      );
    const diff = await this.git.run(
      [
        '--git-dir',
        repositoryPath,
        'diff',
        '--find-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--unified=3',
        objectId,
        validateObjectId(parentIds[0] ?? ''),
        '--',
      ],
      { maxOutputBytes: this.config.limits.diffBytes, truncateOutput: true },
    );
    const message = `Revert "${(subject ?? '').trim()}"\n\nThis reverts commit ${objectId}.`;
    return await this.importPatch({
      repository: input.repository,
      actorUserId: input.actorUserId,
      branch: input.targetBranch,
      patchContent: diff.stdout,
      fallbackMessage: message,
      action: 'commit.revertedViaWeb',
    });
  }

  /** Merges `sourceInput` into `targetBranch`, fast-forwarding when possible. */
  async mergeBranch(input: {
    repository: Repository;
    actorUserId: number;
    sourceInput: string;
    targetBranch: string;
    message?: string;
  }): Promise<string> {
    this.repositories.require(input.repository, input.actorUserId, 'write');
    ensureWebWritable(input.repository);
    const targetBranch = validateRef(input.targetBranch);
    const repositoryPath = await this.repositories.storagePath(input.repository);
    const [sourceCommit, targetCommit] = await Promise.all([
      this.repositories.resolveCommit(input.repository, input.sourceInput),
      this.repositories.resolveCommit(input.repository, targetBranch),
    ]);
    if (sourceCommit === targetCommit)
      throw new WebCommitInputError('Nothing to merge: the branches are identical', 400);
    const actor = this.repositories.identityFor(input.actorUserId);
    if (!actor) throw new WebCommitInputError('Account is not active', 403);
    const committerName = actor.displayName;
    const committerEmail = actor.email;

    const mergeBaseResult = await this.git.run(
      ['--git-dir', repositoryPath, 'merge-base', targetCommit, sourceCommit],
      { acceptedExitCodes: [0, 1] },
    );
    const fastForward =
      mergeBaseResult.exitCode === 0 &&
      mergeBaseResult.stdout.toString('ascii').trim() === targetCommit;

    let commitId: string;
    if (fastForward) {
      try {
        await this.git.run([
          '--git-dir',
          repositoryPath,
          'update-ref',
          `refs/heads/${targetBranch}`,
          sourceCommit,
          targetCommit,
        ]);
      } catch (error) {
        if (error instanceof GitError) {
          throw new WebCommitConflictError(
            'The branch changed while the merge was being performed',
          );
        }
        throw error;
      }
      commitId = sourceCommit;
    } else {
      const merge = await this.git.run(
        ['--git-dir', repositoryPath, 'merge-tree', '--write-tree', targetCommit, sourceCommit],
        { acceptedExitCodes: [0, 1] },
      );
      if (merge.exitCode !== 0)
        throw new WebCommitInputError(
          'This merge has conflicts that must be resolved locally',
          409,
        );
      const treeId = validateObjectId(merge.stdout.toString('utf8').split('\n')[0]?.trim() ?? '');
      const requestedMessage = input.message?.trim() ?? '';
      const message =
        requestedMessage.length > 0
          ? requestedMessage
          : `Merge ${input.sourceInput} into ${targetBranch}`;
      if (message.length < 1 || message.length > 10_000 || message.includes('\0'))
        throw new WebCommitInputError('Merge message must be between 1 and 10,000 characters', 400);
      this.enhancements?.assertWebCommit(input.repository.id, targetBranch, message);
      const commit = await this.git.run(
        [
          '-c',
          `user.name=${committerName}`,
          '-c',
          `user.email=${committerEmail}`,
          '--git-dir',
          repositoryPath,
          'commit-tree',
          treeId,
          '-p',
          targetCommit,
          '-p',
          sourceCommit,
        ],
        { input: Buffer.from(`${message}\n`) },
      );
      commitId = validateObjectId(commit.stdout.toString('ascii').trim());
      try {
        await this.git.run([
          '--git-dir',
          repositoryPath,
          'update-ref',
          `refs/heads/${targetBranch}`,
          commitId,
          targetCommit,
        ]);
      } catch (error) {
        if (error instanceof GitError) {
          throw new WebCommitConflictError(
            'The branch changed while the merge was being performed',
          );
        }
        throw error;
      }
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
        action: 'branch.merged',
        targetType: 'repository',
        targetId: String(input.repository.id),
        metadata: { source: input.sourceInput, target: targetBranch, fastForward },
      });
    })();
    this.publishEvent('branch.merged', {
      ...repositoryEvent(input.repository),
      source: input.sourceInput,
      target: targetBranch,
    });
    this.enhancements?.recordActivity(
      input.repository.id,
      input.actorUserId,
      'branch.merged',
      targetBranch,
      { source: input.sourceInput, commitId, fastForward },
    );
    return commitId;
  }

  /** Splits an uploaded patch into individual mail-formatted sections via `git mailsplit`. */
  private async splitPatchMessages(
    temporaryDirectory: string,
    patchContent: Buffer,
  ): Promise<string[]> {
    const mailsDirectory = join(temporaryDirectory, 'mails');
    await mkdir(mailsDirectory, { recursive: true, mode: 0o750 });
    const result = await this.git.run(['mailsplit', '-d4', '-b', `-o${mailsDirectory}`], {
      input: patchContent,
    });
    const count = Number.parseInt(result.stdout.toString('ascii').trim(), 10);
    if (!Number.isInteger(count) || count < 1)
      throw new WebCommitInputError('The uploaded patch contains no applicable changes', 400);
    if (count > MAX_PATCH_COMMITS)
      throw new WebCommitInputError(
        `A patch import must contain at most ${String(MAX_PATCH_COMMITS)} commits`,
        400,
      );
    return Array.from({ length: count }, (_, index) =>
      join(mailsDirectory, String(index + 1).padStart(4, '0')),
    );
  }

  /** Extracts headers, message body, and the clean patch body from one split mail section. */
  private async readPatchMessage(
    temporaryDirectory: string,
    mailFile: string,
  ): Promise<{
    subject: string;
    body: string;
    authorName: string | null;
    authorEmail: string | null;
    authoredAt: string | null;
    patchBody: Buffer;
  }> {
    const mailContent = await readFile(mailFile);
    const messageFile = join(temporaryDirectory, 'msg.txt');
    const patchFile = join(temporaryDirectory, 'patch.body');
    const info = await this.git.run(['mailinfo', '--encoding=UTF-8', messageFile, patchFile], {
      input: mailContent,
    });
    const report = info.stdout.toString('utf8');
    const field = (name: string): string | null => {
      const match = new RegExp(`^${name}: (.*)$`, 'm').exec(report);
      const value = match?.[1]?.trim();
      return value && value.length > 0 ? value : null;
    };
    const [body, patchBody] = await Promise.all([
      readFile(messageFile, 'utf8'),
      readFile(patchFile),
    ]);
    return {
      subject: field('Subject') ?? '',
      body: body.trim(),
      authorName: field('Author'),
      authorEmail: field('Email'),
      authoredAt: field('Date'),
      patchBody,
    };
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
    this.enhancements?.recordActivity(repository.id, actorUserId, 'branch.created', name);
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
    this.enhancements?.assertBranchDeletion(repository.id, name);
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
    this.enhancements?.recordActivity(repository.id, actorUserId, 'branch.deleted', name);
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
    this.enhancements?.recordActivity(repository.id, actorUserId, 'tag.created', name);
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
    this.enhancements?.recordActivity(repository.id, actorUserId, 'tag.deleted', name);
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
  if (repository.archivedAt)
    throw new WebCommitConflictError('This repository is archived and read-only');
  if (repository.storageKind === 'working_tree')
    throw new WebCommitInputError(
      'Working-tree repositories are browse-only in the web interface',
      409,
    );
}

function isBlank(content: Buffer): boolean {
  return content.toString('utf8').trim().length === 0;
}

/** Strips a trailing `git format-patch` mail signature (`-- \n<version>`) for display. */
function stripPatchSignature(patchText: string): string {
  const marker = patchText.indexOf('\n-- \n');
  return marker === -1 ? patchText : patchText.slice(0, marker + 1);
}

function buildCommitMessage(subject: string, body: string, fallback: string): string {
  const trimmedSubject = subject.trim();
  if (trimmedSubject.length > 0)
    return body.trim().length > 0 ? `${trimmedSubject}\n\n${body.trim()}` : trimmedSubject;
  return fallback.trim();
}

/** Bounds patch-derived identity fields (author name/email/date) to safe, single-line values. */
function sanitizeIdentity(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value
    .replaceAll(/[\r\n\0]+/g, ' ')
    .trim()
    .slice(0, 512);
  return cleaned.length > 0 ? cleaned : null;
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
