import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../database/database.js';
import type { GitBrowser } from '../git/git-browser.js';
import type { GitRunner } from '../git/git-runner.js';
import type { RepositoryService } from '../repositories/repository-service.js';
import type { Repository } from '../repositories/repository-types.js';

interface SearchDocument {
  resourceType: string;
  resourceId: string;
  repositoryId: number;
  title: string;
  path: string;
  content: string;
}

export interface SearchResult {
  type: string;
  repositoryId: number;
  owner: string;
  repository: string;
  title: string;
  path: string;
  excerpt: string;
  url: string;
}

export interface DirectorySearchResult {
  type: 'user' | 'group';
  title: string;
  subtitle: string;
  url: string;
}

export class SearchService {
  constructor(
    private readonly database: Database,
    private readonly git: GitRunner,
    private readonly repositories: RepositoryService,
    private readonly browser: GitBrowser,
    private readonly config: AppConfig,
  ) {}

  enqueue(repositoryId: number): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `
        INSERT INTO search_jobs(repository_id, kind, available_at, created_at)
        VALUES (?, 'repository', ?, ?)
        ON CONFLICT(repository_id, kind) DO UPDATE SET
          state = CASE WHEN search_jobs.state = 'running' THEN 'running' ELSE 'pending' END,
          generation = search_jobs.generation + 1, available_at = excluded.available_at, attempts = 0, error = NULL
      `,
      )
      .run(repositoryId, now, now);
  }

  async processNext(): Promise<boolean> {
    const now = new Date();
    const claimToken = randomUUID();
    const leaseUntil = new Date(now.getTime() + 5 * 60_000).toISOString();
    const job = this.database.transaction(() => {
      const candidate = this.database
        .prepare(
          `
          SELECT id, repository_id, generation FROM search_jobs
          WHERE available_at <= ? AND (state = 'pending' OR (state = 'running' AND lease_until < ?))
          ORDER BY available_at, id LIMIT 1
        `,
        )
        .get(now.toISOString(), now.toISOString()) as
        { id: number; repository_id: number; generation: number } | undefined;
      if (!candidate) return null;
      const changed = this.database
        .prepare(
          `
          UPDATE search_jobs SET state = 'running', lease_until = ?, claim_token = ?, attempts = attempts + 1
          WHERE id = ? AND (state = 'pending' OR lease_until < ?)
        `,
        )
        .run(leaseUntil, claimToken, candidate.id, now.toISOString());
      return changed.changes === 1 ? candidate : null;
    })();
    if (!job) return false;
    try {
      await this.rebuildRepository(job.repository_id, () =>
        Boolean(
          this.database
            .prepare('SELECT 1 FROM search_jobs WHERE id = ? AND claim_token = ?')
            .get(job.id, claimToken),
        ),
      );
      this.database.transaction(() => {
        this.database
          .prepare('DELETE FROM search_jobs WHERE id = ? AND claim_token = ? AND generation = ?')
          .run(job.id, claimToken, job.generation);
        this.database
          .prepare(
            "UPDATE search_jobs SET state = 'pending', lease_until = NULL, claim_token = NULL WHERE id = ? AND claim_token = ?",
          )
          .run(job.id, claimToken);
      })();
    } catch (error) {
      const row = this.database
        .prepare('SELECT attempts, generation FROM search_jobs WHERE id = ? AND claim_token = ?')
        .get(job.id, claimToken) as { attempts: number; generation: number } | undefined;
      if (!row) return true;
      const changed = row.generation !== job.generation;
      const attempts = changed ? 0 : row.attempts;
      const delay = Math.min(3600, 2 ** attempts * 5);
      this.database
        .prepare(
          `
          UPDATE search_jobs SET state = ?, lease_until = NULL, claim_token = NULL, available_at = ?, error = ? WHERE id = ? AND claim_token = ?
        `,
        )
        .run(
          attempts >= 5 ? 'failed' : 'pending',
          new Date(Date.now() + (changed ? 0 : delay * 1000)).toISOString(),
          error instanceof Error ? error.message.slice(0, 1000) : 'Unknown indexing error',
          job.id,
          claimToken,
        );
    }
    return true;
  }

  async rebuildRepository(
    repositoryId: number,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const repository = this.repositories.getById(repositoryId);
    const documents = await this.collect(repository);
    this.database.transaction(() => {
      if (!isCurrent()) return;
      this.database
        .prepare('DELETE FROM search_documents WHERE repository_id = ?')
        .run(repository.id);
      const insert = this.database.prepare(`
        INSERT INTO search_documents(resource_type, resource_id, repository_id, title, path, content)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const document of documents) {
        insert.run(
          document.resourceType,
          document.resourceId,
          document.repositoryId,
          document.title,
          document.path,
          document.content,
        );
      }
    })();
  }

  async rebuildAll(): Promise<number> {
    const rows = this.database
      .prepare('SELECT id FROM repositories WHERE deleted_at IS NULL ORDER BY id')
      .all() as { id: number }[];
    for (const row of rows) await this.rebuildRepository(row.id);
    return rows.length;
  }

  search(queryInput: string, userId: number | null, limit = 30): SearchResult[] {
    const query = ftsQuery(queryInput);
    if (!query) return [];
    const rows = this.database
      .prepare(
        `
        SELECT resource_type, resource_id, repository_id, title, path,
          snippet(search_documents, 5, '⟦', '⟧', ' … ', 18) AS excerpt
        FROM search_documents WHERE search_documents MATCH ?
          AND repository_id IN (
            SELECT r.id FROM repositories r WHERE r.deleted_at IS NULL AND (
              (r.visibility = 'public' AND ? = 1)
              OR (r.owner_type = 'user' AND r.owner_id = ?)
              OR (r.owner_type = 'group' AND EXISTS (SELECT 1 FROM group_members gm
                  WHERE gm.group_id = r.owner_id AND gm.user_id = ? AND gm.role IN ('owner', 'manager')))
              OR EXISTS (SELECT 1 FROM repository_grants rg WHERE rg.repository_id = r.id AND (
                  (rg.principal_type = 'user' AND rg.principal_id = ?)
                  OR (rg.principal_type = 'group' AND EXISTS (SELECT 1 FROM group_members gm
                      WHERE gm.group_id = rg.principal_id AND gm.user_id = ?))))
            )
          )
        ORDER BY bm25(search_documents, 2.0, 1.0, 3.0) LIMIT ?
      `,
      )
      .all(
        query,
        this.config.anonymous.publicRepositories ? 1 : 0,
        userId,
        userId,
        userId,
        userId,
        Math.min(Math.max(limit, 1), 100),
      ) as {
      resource_type: string;
      resource_id: string;
      repository_id: number;
      title: string;
      path: string;
      excerpt: string;
    }[];
    const results: SearchResult[] = [];
    for (const row of rows) {
      let repository: Repository;
      try {
        repository = this.repositories.getById(row.repository_id);
        this.repositories.require(repository, userId, 'read');
      } catch {
        continue;
      }
      const encodedPath = row.path.split('/').map(encodeURIComponent).join('/');
      results.push({
        type: row.resource_type,
        repositoryId: repository.id,
        owner: repository.ownerSlug,
        repository: repository.slug,
        title: row.title,
        path: row.path,
        excerpt: safeExcerpt(row.excerpt),
        url:
          row.resource_type === 'file'
            ? `/${repository.ownerSlug}/${repository.slug}/blob/${encodedPath}?ref=${encodeURIComponent(row.resource_id)}`
            : row.resource_type === 'commit'
              ? `/${repository.ownerSlug}/${repository.slug}/commit/${row.resource_id}`
              : row.resource_type === 'branch'
                ? `/${repository.ownerSlug}/${repository.slug}/tree?ref=${encodeURIComponent(row.path)}`
                : row.resource_type === 'tag'
                  ? `/${repository.ownerSlug}/${repository.slug}/tree?ref=${encodeURIComponent(row.path)}`
                  : row.resource_type === 'issue'
                    ? `/${repository.ownerSlug}/${repository.slug}/issues/${row.resource_id}`
                    : `/${repository.ownerSlug}/${repository.slug}`,
      });
      if (results.length >= limit) break;
    }
    return results;
  }

  searchDirectory(queryInput: string, userId: number | null, limit = 20): DirectorySearchResult[] {
    if (userId === null) return [];
    const query = queryInput.normalize('NFKC').trim().toLocaleLowerCase();
    if (!query) return [];
    if (query.length > 200) throw new SearchInputError('Search query is too long');
    const pattern = `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    const users = this.database
      .prepare(
        `SELECT username, display_name AS displayName FROM users
         WHERE status = 'active' AND (lower(username) LIKE ? ESCAPE '\\' OR lower(display_name) LIKE ? ESCAPE '\\')
         ORDER BY username LIMIT ?`,
      )
      .all(pattern, pattern, limit) as { username: string; displayName: string }[];
    const remaining = Math.max(0, limit - users.length);
    const groups = this.database
      .prepare(
        `SELECT g.slug, g.display_name AS displayName FROM groups g
         JOIN group_members gm ON gm.group_id = g.id
         WHERE gm.user_id = ? AND (lower(g.slug) LIKE ? ESCAPE '\\' OR lower(g.display_name) LIKE ? ESCAPE '\\')
         ORDER BY g.slug LIMIT ?`,
      )
      .all(userId, pattern, pattern, remaining) as { slug: string; displayName: string }[];
    return [
      ...users.map((user) => ({
        type: 'user' as const,
        title: user.displayName,
        subtitle: `@${user.username}`,
        url: `/users/${encodeURIComponent(user.username)}`,
      })),
      ...groups.map((group) => ({
        type: 'group' as const,
        title: group.displayName,
        subtitle: group.slug,
        url: `/groups/${encodeURIComponent(group.slug)}/settings`,
      })),
    ];
  }

  status(): { pending: number; running: number; failed: number; documents: number } {
    const counts = this.database
      .prepare(
        `
        SELECT
          sum(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
          sum(CASE WHEN state = 'running' THEN 1 ELSE 0 END) AS running,
          sum(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM search_jobs
      `,
      )
      .get() as { pending: number | null; running: number | null; failed: number | null };
    const documents = this.database
      .prepare('SELECT count(*) AS count FROM search_documents')
      .get() as {
      count: number;
    };
    return {
      pending: counts.pending ?? 0,
      running: counts.running ?? 0,
      failed: counts.failed ?? 0,
      documents: documents.count,
    };
  }

  private async collect(repository: Repository): Promise<SearchDocument[]> {
    const documents: SearchDocument[] = [
      {
        resourceType: 'repository',
        resourceId: String(repository.id),
        repositoryId: repository.id,
        title: `${repository.ownerSlug}/${repository.slug}`,
        path: '',
        content: repository.description,
      },
    ];
    const branches = await this.browser.branches(repository);
    for (const branch of branches) {
      documents.push({
        resourceType: 'branch',
        resourceId: branch.objectId,
        repositoryId: repository.id,
        title: branch.name,
        path: branch.name,
        content: branch.subject,
      });
    }
    for (const tag of await this.browser.tags(repository)) {
      documents.push({
        resourceType: 'tag',
        resourceId: tag.objectId,
        repositoryId: repository.id,
        title: tag.name,
        path: tag.name,
        content: tag.subject,
      });
    }
    const repositoryPath = await this.repositories.storagePath(repository);
    const configuredBranches = new Set([
      repository.defaultBranch,
      ...this.config.search.indexedBranches,
    ]);
    const availableBranches = new Set(branches.map((branch) => branch.name));
    const indexedCommits = new Set<string>();
    for (const branch of configuredBranches) {
      if (!availableBranches.has(branch)) continue;
      const commits = await this.browser.commits(
        repository,
        branch,
        1,
        this.config.search.maxCommitsPerBranch,
      );
      for (const commit of commits) {
        if (indexedCommits.has(commit.objectId)) continue;
        indexedCommits.add(commit.objectId);
        documents.push({
          resourceType: 'commit',
          resourceId: commit.objectId,
          repositoryId: repository.id,
          title: commit.subject,
          path: '',
          content: `${commit.authorName} ${commit.authorEmail}`,
        });
      }
      const commit = await this.repositories.resolveCommit(repository, branch);
      const tree = await this.git.run([
        '--git-dir',
        repositoryPath,
        'ls-tree',
        '-r',
        '-z',
        '--long',
        commit,
      ]);
      const entries = parseBlobEntries(tree.stdout).slice(0, this.config.search.maxFilesPerBranch);
      let indexedBytes = 0;
      for (const entry of entries) {
        let content = '';
        const perFileLimit = Math.min(this.config.limits.filePreviewBytes, 256 * 1024);
        if (entry.size <= perFileLimit && indexedBytes < this.config.limits.gitOutputBytes) {
          const blob = await this.git.run(
            ['--git-dir', repositoryPath, 'cat-file', 'blob', entry.objectId],
            {
              maxOutputBytes: entry.size + 1,
            },
          );
          if (!blob.stdout.includes(0)) {
            content = blob.stdout.toString('utf8');
            indexedBytes += blob.stdout.length;
          }
        }
        documents.push({
          resourceType: 'file',
          resourceId: branch,
          repositoryId: repository.id,
          title: entry.path.split('/').at(-1) ?? entry.path,
          path: entry.path,
          content,
        });
      }
    }
    const issueRows = this.database
      .prepare('SELECT number, title, body, status FROM issues WHERE repository_id = ?')
      .all(repository.id) as { number: number; title: string; body: string; status: string }[];
    for (const issue of issueRows) {
      documents.push({
        resourceType: 'issue',
        resourceId: String(issue.number),
        repositoryId: repository.id,
        title: `#${String(issue.number)} ${issue.title}`,
        path: '',
        content: `${issue.body} ${issue.status}`,
      });
    }
    return documents;
  }
}

function parseBlobEntries(output: Buffer): { objectId: string; size: number; path: string }[] {
  return output
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .flatMap((line) => {
      const match = /^\d+ blob ([0-9a-f]{40,64})\s+(\d+)\t(.+)$/.exec(line);
      return match?.[1] && match[2] && match[3]
        ? [{ objectId: match[1], size: Number(match[2]), path: match[3] }]
        : [];
    });
}

function ftsQuery(input: string): string {
  if (input.length > 200) throw new SearchInputError('Search query is too long');
  return input
    .normalize('NFKC')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' AND ');
}

function safeExcerpt(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('⟦', '<mark>')
    .replaceAll('⟧', '</mark>');
}

export class SearchInputError extends Error {
  readonly statusCode = 400;
}
