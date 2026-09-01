import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../config/config.js';
import type { GitRunner } from '../git/git-runner.js';
import { GitError } from '../git/errors.js';
import { NotFoundError } from './repository-service.js';
import type { RepositoryService } from './repository-service.js';
import type { Repository } from './repository-types.js';
import { ValidationError } from '../security/validation.js';

const wikiBranch = 'main';
const pagePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export interface WikiPageSummary {
  name: string;
  updatedAt: string;
  subject: string;
}

export interface WikiPageHistoryEntry {
  objectId: string;
  shortId: string;
  authorName: string;
  authoredAt: string;
  subject: string;
}

function validatePageName(name: string): string {
  if (!pagePattern.test(name)) throw new ValidationError('Invalid wiki page name');
  return name;
}

/**
 * Each repository's wiki is itself a small bare Git repository (Markdown pages at the root,
 * one commit per edit) instead of a bespoke content store, so the same "no working tree"
 * commit machinery used elsewhere in the app applies here unchanged.
 */
export class WikiService {
  constructor(
    private readonly git: GitRunner,
    private readonly repositories: RepositoryService,
    private readonly config: AppConfig,
  ) {}

  private path(repository: Repository): string {
    return join(this.config.storage.data, 'wikis', `${repository.storageId}.git`);
  }

  async exists(repository: Repository): Promise<boolean> {
    try {
      await access(this.path(repository));
      return true;
    } catch {
      return false;
    }
  }

  private async ensureRepo(repository: Repository): Promise<string> {
    const path = this.path(repository);
    if (!(await this.exists(repository))) {
      await mkdir(join(path, '..'), { recursive: true, mode: 0o750 });
      await this.git.run(['init', '--bare', '--initial-branch', wikiBranch, '--', path]);
    }
    return path;
  }

  /** Bare repositories have no on-disk index, so index-mutating commands need a scratch one. */
  private async withScratchIndex<T>(fn: (indexFile: string) => Promise<T>): Promise<T> {
    const temporaryRoot = join(this.config.storage.data, 'tmp');
    await mkdir(temporaryRoot, { recursive: true, mode: 0o750 });
    const temporaryDirectory = await mkdtemp(join(temporaryRoot, 'wiki-'));
    try {
      return await fn(join(temporaryDirectory, 'index'));
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async headCommit(path: string): Promise<string | null> {
    try {
      const result = await this.git.run([
        '--git-dir',
        path,
        'rev-parse',
        '--verify',
        '--end-of-options',
        `refs/heads/${wikiBranch}`,
      ]);
      return result.stdout.toString('ascii').trim();
    } catch {
      return null;
    }
  }

  async listPages(repository: Repository): Promise<WikiPageSummary[]> {
    if (!(await this.exists(repository))) return [];
    const path = this.path(repository);
    const head = await this.headCommit(path);
    if (!head) return [];
    const result = await this.git.run([
      '--git-dir',
      path,
      'log',
      '--name-only',
      '--diff-filter=A',
      '--format=%x01%H%x00%aI%x00%s%x02',
      '--end-of-options',
      head,
    ]);
    const pages = new Map<string, WikiPageSummary>();
    for (const entry of result.stdout.toString('utf8').split('\x01').slice(1)) {
      const [header, filesBlock] = entry.split('\x02');
      const [, authoredAt, subject] = (header ?? '').split('\x00');
      for (const file of (filesBlock ?? '').split('\n')) {
        const name = file.trim().replace(/\.md$/, '');
        if (name.length > 0 && !pages.has(name))
          pages.set(name, { name, updatedAt: authoredAt ?? '', subject: subject ?? '' });
      }
    }
    return [...pages.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async readPage(repository: Repository, pageInput: string): Promise<string | null> {
    const page = validatePageName(pageInput);
    if (!(await this.exists(repository))) return null;
    const path = this.path(repository);
    const head = await this.headCommit(path);
    if (!head) return null;
    try {
      const result = await this.git.run([
        '--git-dir',
        path,
        'cat-file',
        'blob',
        `${head}:${page}.md`,
      ]);
      return result.stdout.toString('utf8');
    } catch (error) {
      if (error instanceof GitError) return null;
      throw error;
    }
  }

  async writePage(input: {
    repository: Repository;
    actorUserId: number;
    page: string;
    content: string;
    message: string;
  }): Promise<void> {
    this.repositories.require(input.repository, input.actorUserId, 'write');
    const page = validatePageName(input.page);
    if (input.content.length > this.config.limits.filePreviewBytes)
      throw new ValidationError('Wiki page exceeds the configured size limit');
    const message = input.message.trim() || `Update ${page}`;
    if (message.length > 10_000) throw new ValidationError('Commit message is too long');
    const path = await this.ensureRepo(input.repository);
    const oldCommit = await this.headCommit(path);
    const blob = await this.git.run(['--git-dir', path, 'hash-object', '-w', '--stdin'], {
      input: Buffer.from(input.content, 'utf8'),
    });
    const blobId = blob.stdout.toString('ascii').trim();
    const treeId = await this.withScratchIndex(async (indexFile) => {
      if (oldCommit) await this.git.run(['--git-dir', path, 'read-tree', oldCommit], { indexFile });
      await this.git.run(
        ['--git-dir', path, 'update-index', '--add', '--cacheinfo', `100644,${blobId},${page}.md`],
        { indexFile },
      );
      const tree = await this.git.run(['--git-dir', path, 'write-tree'], { indexFile });
      return tree.stdout.toString('ascii').trim();
    });
    const actor = this.repositories.identityFor(input.actorUserId);
    if (!actor) throw new ValidationError('Account is not active');
    const commit = await this.git.run(
      [
        '-c',
        `user.name=${actor.displayName}`,
        '-c',
        `user.email=${actor.email}`,
        '--git-dir',
        path,
        'commit-tree',
        treeId,
        ...(oldCommit ? ['-p', oldCommit] : []),
      ],
      { input: Buffer.from(`${message}\n`) },
    );
    const commitId = commit.stdout.toString('ascii').trim();
    try {
      await this.git.run(
        oldCommit
          ? ['--git-dir', path, 'update-ref', `refs/heads/${wikiBranch}`, commitId, oldCommit]
          : ['--git-dir', path, 'update-ref', `refs/heads/${wikiBranch}`, commitId],
      );
    } catch (error) {
      if (error instanceof GitError)
        throw new ValidationError('The wiki changed while this page was being saved');
      throw error;
    }
  }

  async history(repository: Repository, pageInput: string): Promise<WikiPageHistoryEntry[]> {
    const page = validatePageName(pageInput);
    if (!(await this.exists(repository))) return [];
    const path = this.path(repository);
    const head = await this.headCommit(path);
    if (!head) return [];
    const result = await this.git.run([
      '--git-dir',
      path,
      'log',
      '--max-count=50',
      '--format=%H%x00%h%x00%an%x00%aI%x00%s%x00',
      '--end-of-options',
      head,
      '--',
      `${page}.md`,
    ]);
    const fields = result.stdout.toString('utf8').split('\0');
    const entries: WikiPageHistoryEntry[] = [];
    for (let index = 0; index + 4 < fields.length; index += 5) {
      const objectId = fields[index]?.trim();
      if (!objectId) continue;
      entries.push({
        objectId,
        shortId: fields[index + 1] ?? '',
        authorName: fields[index + 2] ?? '',
        authoredAt: fields[index + 3] ?? '',
        subject: fields[index + 4] ?? '',
      });
    }
    return entries;
  }

  async deletePage(input: {
    repository: Repository;
    actorUserId: number;
    page: string;
    message: string;
  }): Promise<void> {
    this.repositories.require(input.repository, input.actorUserId, 'write');
    const page = validatePageName(input.page);
    const path = this.path(input.repository);
    const oldCommit = await this.headCommit(path);
    if (!oldCommit) throw new NotFoundError();
    // Wiki pages live flat at the tree root, so the removal is a plain ls-tree/mktree filter
    // rather than an index-based update-index --force-remove (which insists on a work tree).
    const listing = await this.git.run(['--git-dir', path, 'ls-tree', `${oldCommit}^{tree}`]);
    const lines = listing.stdout
      .toString('utf8')
      .split('\n')
      .filter((line) => line.length > 0);
    const remaining = lines.filter((line) => !line.endsWith(`\t${page}.md`));
    if (remaining.length === lines.length) throw new NotFoundError();
    const tree = await this.git.run(['--git-dir', path, 'mktree'], {
      input: Buffer.from(remaining.map((line) => `${line}\n`).join('')),
    });
    const treeId = tree.stdout.toString('ascii').trim();
    const actor = this.repositories.identityFor(input.actorUserId);
    if (!actor) throw new ValidationError('Account is not active');
    const commit = await this.git.run(
      [
        '-c',
        `user.name=${actor.displayName}`,
        '-c',
        `user.email=${actor.email}`,
        '--git-dir',
        path,
        'commit-tree',
        treeId,
        '-p',
        oldCommit,
      ],
      { input: Buffer.from((input.message.trim() || `Delete ${page}`) + '\n') },
    );
    const commitId = commit.stdout.toString('ascii').trim();
    try {
      await this.git.run([
        '--git-dir',
        path,
        'update-ref',
        `refs/heads/${wikiBranch}`,
        commitId,
        oldCommit,
      ]);
    } catch (error) {
      if (error instanceof GitError)
        throw new ValidationError('The wiki changed while this page was being deleted');
      throw error;
    }
  }
}
