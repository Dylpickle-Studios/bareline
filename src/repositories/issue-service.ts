import type { AuditService } from '../audit/audit-service.js';
import type { Database } from '../database/database.js';
import { NotFoundError, RepositoryService } from './repository-service.js';
import type { RepositoryEnhancementService } from './repository-enhancement-service.js';
import type { Repository } from './repository-types.js';

export type IssueEventPublisher = (
  event:
    | 'issue.created'
    | 'issue.commented'
    | 'issue.closed'
    | 'issue.reopened'
    | 'issue.assigned'
    | 'issue.labeled',
  payload: Readonly<Record<string, unknown>>,
) => void;

export interface IssueLabel {
  id: number;
  name: string;
  color: string;
}
export interface IssueSummary {
  number: number;
  title: string;
  status: 'open' | 'closed';
  authorUsername: string | null;
  assigneeUsername: string | null;
  labels: IssueLabel[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}
export interface IssueComment {
  id: number;
  authorUsername: string | null;
  body: string;
  createdAt: string;
  updatedAt: string | null;
}
export interface IssueDetail extends IssueSummary {
  body: string;
  comments: IssueComment[];
}

const MAX_TEXT_BYTES = 65_536;
const PAGE_SIZE = 25;

export class IssueService {
  private publishEvent: IssueEventPublisher = () => undefined;

  constructor(
    private readonly database: Database,
    private readonly repositories: RepositoryService,
    private readonly enhancements: RepositoryEnhancementService,
    private readonly audit: AuditService,
  ) {}

  setEventPublisher(publisher: IssueEventPublisher): void {
    this.publishEvent = publisher;
  }

  list(
    repository: Repository,
    userId: number | null,
    filters: {
      status?: 'open' | 'closed' | 'all';
      label?: string;
      assignee?: string;
      page?: number;
    } = {},
  ): { items: IssueSummary[]; pagination: { page: number; perPage: number; hasMore: boolean } } {
    this.repositories.require(repository, userId, 'read');
    const status = filters.status ?? 'open';
    const page = Math.max(Math.trunc(filters.page ?? 1) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;
    const conditions = ['i.repository_id = ?'];
    const params: (string | number)[] = [repository.id];
    if (status !== 'all') {
      conditions.push('i.status = ?');
      params.push(status);
    }
    if (filters.label) {
      conditions.push(
        'EXISTS (SELECT 1 FROM issue_label_assignments la JOIN issue_labels l ON l.id = la.label_id WHERE la.issue_id = i.id AND l.name = ?)',
      );
      params.push(filters.label);
    }
    if (filters.assignee) {
      conditions.push(
        'EXISTS (SELECT 1 FROM users u WHERE u.id = i.assignee_user_id AND u.username = ?)',
      );
      params.push(filters.assignee);
    }
    const rows = this.database
      .prepare(
        `SELECT i.id, i.number, i.title, i.status, i.created_at AS createdAt, i.updated_at AS updatedAt,
           i.closed_at AS closedAt, au.username AS authorUsername, asu.username AS assigneeUsername
         FROM issues i
         LEFT JOIN users au ON au.id = i.author_user_id
         LEFT JOIN users asu ON asu.id = i.assignee_user_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY i.number DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, PAGE_SIZE + 1, offset) as {
      id: number;
      number: number;
      title: string;
      status: 'open' | 'closed';
      createdAt: string;
      updatedAt: string;
      closedAt: string | null;
      authorUsername: string | null;
      assigneeUsername: string | null;
    }[];
    const hasMore = rows.length > PAGE_SIZE;
    const page_ = rows.slice(0, PAGE_SIZE);
    const labels = this.labelsByIssueId(page_.map((row) => row.id));
    return {
      items: page_.map(({ id, ...rest }) => ({ ...rest, labels: labels.get(id) ?? [] })),
      pagination: { page, perPage: PAGE_SIZE, hasMore },
    };
  }

  get(repository: Repository, userId: number | null, number: number): IssueDetail {
    this.repositories.require(repository, userId, 'read');
    const row = this.database
      .prepare(
        `SELECT i.id, i.number, i.title, i.body, i.status, i.created_at AS createdAt,
           i.updated_at AS updatedAt, i.closed_at AS closedAt,
           au.username AS authorUsername, asu.username AS assigneeUsername
         FROM issues i
         LEFT JOIN users au ON au.id = i.author_user_id
         LEFT JOIN users asu ON asu.id = i.assignee_user_id
         WHERE i.repository_id = ? AND i.number = ?`,
      )
      .get(repository.id, number) as
      | {
          id: number;
          number: number;
          title: string;
          body: string;
          status: 'open' | 'closed';
          createdAt: string;
          updatedAt: string;
          closedAt: string | null;
          authorUsername: string | null;
          assigneeUsername: string | null;
        }
      | undefined;
    if (!row) throw new NotFoundError();
    const comments = this.comments(row.id);
    const labels = this.labelsByIssueId([row.id]).get(row.id) ?? [];
    const { id, ...rest } = row;
    void id;
    return { ...rest, labels, comments };
  }

  create(
    repository: Repository,
    actorUserId: number,
    input: { title: string; body: string; labelIds?: number[]; assigneeUserId?: number | null },
  ): IssueDetail {
    this.repositories.require(repository, actorUserId, 'read');
    const title = validateTitle(input.title);
    const body = validateBody(input.body);
    const assigneeUserId = input.assigneeUserId ?? null;
    this.validateAssignee(repository, assigneeUserId);
    const now = new Date().toISOString();
    const number = this.database.transaction(() => {
      const allocated = this.database
        .prepare(
          'UPDATE repositories SET next_issue_number = next_issue_number + 1 WHERE id = ? RETURNING next_issue_number - 1 AS number',
        )
        .get(repository.id) as { number: number };
      const inserted = this.database
        .prepare(
          `INSERT INTO issues(repository_id, number, title, body, status, author_user_id, assignee_user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
        )
        .run(repository.id, allocated.number, title, body, actorUserId, assigneeUserId, now, now);
      const issueId = Number(inserted.lastInsertRowid);
      if (input.labelIds?.length) this.applyLabels(issueId, repository.id, input.labelIds);
      this.audit.record({
        actorUserId,
        action: 'issue.created',
        targetType: 'issue',
        targetId: String(issueId),
        metadata: { repositoryId: repository.id, number: allocated.number },
      });
      return allocated.number;
    })();
    this.enhancements.recordActivity(repository.id, actorUserId, 'issue.created', undefined, {
      number,
    });
    this.publishEvent('issue.created', { repositoryId: repository.id, number });
    return this.get(repository, actorUserId, number);
  }

  updateDetails(
    repository: Repository,
    actorUserId: number,
    number: number,
    input: { title?: string; body?: string },
  ): IssueDetail {
    const issue = this.findIssue(repository, number);
    this.requireWriteOrAuthor(repository, actorUserId, issue.authorUserId);
    const updates: string[] = [];
    const params: string[] = [];
    if (input.title !== undefined) {
      updates.push('title = ?');
      params.push(validateTitle(input.title));
    }
    if (input.body !== undefined) {
      updates.push('body = ?');
      params.push(validateBody(input.body));
    }
    if (updates.length > 0) {
      const now = new Date().toISOString();
      updates.push('updated_at = ?');
      params.push(now);
      this.database
        .prepare(`UPDATE issues SET ${updates.join(', ')} WHERE id = ?`)
        .run(...params, issue.id);
      this.audit.record({
        actorUserId,
        action: 'issue.edited',
        targetType: 'issue',
        targetId: String(issue.id),
        metadata: { repositoryId: repository.id, number },
      });
    }
    return this.get(repository, actorUserId, number);
  }

  setStatus(
    repository: Repository,
    actorUserId: number,
    number: number,
    status: 'open' | 'closed',
  ): IssueDetail {
    const issue = this.findIssue(repository, number);
    this.requireWriteOrAuthor(repository, actorUserId, issue.authorUserId);
    if (issue.status !== status) {
      const now = new Date().toISOString();
      this.database
        .prepare('UPDATE issues SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?')
        .run(status, status === 'closed' ? now : null, now, issue.id);
      const action = status === 'closed' ? 'issue.closed' : 'issue.reopened';
      this.audit.record({
        actorUserId,
        action,
        targetType: 'issue',
        targetId: String(issue.id),
        metadata: { repositoryId: repository.id, number },
      });
      this.enhancements.recordActivity(repository.id, actorUserId, action, undefined, { number });
      this.publishEvent(action, { repositoryId: repository.id, number });
    }
    return this.get(repository, actorUserId, number);
  }

  assign(
    repository: Repository,
    actorUserId: number,
    number: number,
    assigneeUserId: number | null,
  ): IssueDetail {
    this.repositories.require(repository, actorUserId, 'write');
    const issue = this.findIssue(repository, number);
    this.validateAssignee(repository, assigneeUserId);
    const now = new Date().toISOString();
    this.database
      .prepare('UPDATE issues SET assignee_user_id = ?, updated_at = ? WHERE id = ?')
      .run(assigneeUserId, now, issue.id);
    this.audit.record({
      actorUserId,
      action: 'issue.assigned',
      targetType: 'issue',
      targetId: String(issue.id),
      metadata: { repositoryId: repository.id, number, assigneeUserId },
    });
    this.enhancements.recordActivity(repository.id, actorUserId, 'issue.assigned', undefined, {
      number,
    });
    this.publishEvent('issue.assigned', { repositoryId: repository.id, number });
    return this.get(repository, actorUserId, number);
  }

  setLabels(
    repository: Repository,
    actorUserId: number,
    number: number,
    labelIds: number[],
  ): IssueDetail {
    this.repositories.require(repository, actorUserId, 'write');
    const issue = this.findIssue(repository, number);
    this.applyLabels(issue.id, repository.id, labelIds);
    const now = new Date().toISOString();
    this.database.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(now, issue.id);
    this.audit.record({
      actorUserId,
      action: 'issue.labeled',
      targetType: 'issue',
      targetId: String(issue.id),
      metadata: { repositoryId: repository.id, number },
    });
    this.enhancements.recordActivity(repository.id, actorUserId, 'issue.labeled', undefined, {
      number,
    });
    this.publishEvent('issue.labeled', { repositoryId: repository.id, number });
    return this.get(repository, actorUserId, number);
  }

  addComment(
    repository: Repository,
    actorUserId: number,
    number: number,
    body: string,
  ): IssueComment {
    this.repositories.require(repository, actorUserId, 'read');
    const issue = this.findIssue(repository, number);
    const trimmed = validateCommentBody(body);
    const now = new Date().toISOString();
    const inserted = this.database
      .prepare(
        'INSERT INTO issue_comments(issue_id, author_user_id, body, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(issue.id, actorUserId, trimmed, now);
    this.database.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(now, issue.id);
    this.audit.record({
      actorUserId,
      action: 'issue.commented',
      targetType: 'issue',
      targetId: String(issue.id),
      metadata: { repositoryId: repository.id, number },
    });
    this.enhancements.recordActivity(repository.id, actorUserId, 'issue.commented', undefined, {
      number,
    });
    this.publishEvent('issue.commented', { repositoryId: repository.id, number });
    return this.findComment(issue.id, Number(inserted.lastInsertRowid), true);
  }

  updateComment(
    repository: Repository,
    actorUserId: number,
    number: number,
    commentId: number,
    body: string,
  ): IssueComment {
    this.repositories.require(repository, actorUserId, 'read');
    const issue = this.findIssue(repository, number);
    const comment = this.findComment(issue.id, commentId, false);
    this.requireWriteOrAuthor(repository, actorUserId, comment.authorUserId);
    const trimmed = validateCommentBody(body);
    const now = new Date().toISOString();
    this.database
      .prepare('UPDATE issue_comments SET body = ?, updated_at = ? WHERE id = ?')
      .run(trimmed, now, commentId);
    this.audit.record({
      actorUserId,
      action: 'issue.commentEdited',
      targetType: 'issue',
      targetId: String(issue.id),
      metadata: { repositoryId: repository.id, number, commentId },
    });
    return this.findComment(issue.id, commentId, true);
  }

  removeComment(
    repository: Repository,
    actorUserId: number,
    number: number,
    commentId: number,
  ): void {
    this.repositories.require(repository, actorUserId, 'read');
    const issue = this.findIssue(repository, number);
    const comment = this.findComment(issue.id, commentId, false);
    this.requireWriteOrAuthor(repository, actorUserId, comment.authorUserId);
    this.database.prepare('DELETE FROM issue_comments WHERE id = ?').run(commentId);
    this.audit.record({
      actorUserId,
      action: 'issue.commentRemoved',
      targetType: 'issue',
      targetId: String(issue.id),
      metadata: { repositoryId: repository.id, number, commentId },
    });
  }

  labels(repositoryId: number): IssueLabel[] {
    return this.database
      .prepare('SELECT id, name, color FROM issue_labels WHERE repository_id = ? ORDER BY name')
      .all(repositoryId) as IssueLabel[];
  }

  createLabel(
    repository: Repository,
    actorUserId: number,
    name: string,
    color: string,
  ): IssueLabel {
    this.repositories.require(repository, actorUserId, 'write');
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length > 50)
      throw new IssueError('Label name must be between 1 and 50 characters');
    const normalizedColor = color.trim().replace(/^#/, '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(normalizedColor))
      throw new IssueError('Label color must be a 6-digit hex value');
    const now = new Date().toISOString();
    let inserted;
    try {
      inserted = this.database
        .prepare(
          'INSERT INTO issue_labels(repository_id, name, color, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(repository.id, trimmedName, normalizedColor, now);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE'))
        throw new IssueError('A label with this name already exists', 409);
      throw error;
    }
    this.audit.record({
      actorUserId,
      action: 'issue.labelCreated',
      targetType: 'repository',
      targetId: String(repository.id),
      metadata: { name: trimmedName },
    });
    return { id: Number(inserted.lastInsertRowid), name: trimmedName, color: normalizedColor };
  }

  removeLabel(repository: Repository, actorUserId: number, labelId: number): void {
    this.repositories.require(repository, actorUserId, 'write');
    const result = this.database
      .prepare('DELETE FROM issue_labels WHERE id = ? AND repository_id = ?')
      .run(labelId, repository.id);
    if (result.changes !== 1) throw new NotFoundError();
    this.audit.record({
      actorUserId,
      action: 'issue.labelRemoved',
      targetType: 'repository',
      targetId: String(repository.id),
      metadata: { labelId },
    });
  }

  private comments(issueId: number): IssueComment[] {
    return this.database
      .prepare(
        `SELECT c.id, c.body, c.created_at AS createdAt, c.updated_at AS updatedAt,
           u.username AS authorUsername
         FROM issue_comments c
         LEFT JOIN users u ON u.id = c.author_user_id
         WHERE c.issue_id = ?
         ORDER BY c.created_at, c.id`,
      )
      .all(issueId) as IssueComment[];
  }

  private findIssue(
    repository: Repository,
    number: number,
  ): { id: number; authorUserId: number | null; status: 'open' | 'closed' } {
    const row = this.database
      .prepare(
        'SELECT id, author_user_id AS authorUserId, status FROM issues WHERE repository_id = ? AND number = ?',
      )
      .get(repository.id, number) as
      { id: number; authorUserId: number | null; status: 'open' | 'closed' } | undefined;
    if (!row) throw new NotFoundError();
    return row;
  }

  private findComment(issueId: number, commentId: number, includeBody: true): IssueComment;
  private findComment(
    issueId: number,
    commentId: number,
    includeBody: false,
  ): { id: number; authorUserId: number | null };
  private findComment(issueId: number, commentId: number, includeBody: boolean) {
    if (includeBody) {
      const row = this.database
        .prepare(
          `SELECT c.id, c.body, c.created_at AS createdAt, c.updated_at AS updatedAt,
             u.username AS authorUsername
           FROM issue_comments c
           LEFT JOIN users u ON u.id = c.author_user_id
           WHERE c.id = ? AND c.issue_id = ?`,
        )
        .get(commentId, issueId) as IssueComment | undefined;
      if (!row) throw new NotFoundError();
      return row;
    }
    const row = this.database
      .prepare(
        'SELECT id, author_user_id AS authorUserId FROM issue_comments WHERE id = ? AND issue_id = ?',
      )
      .get(commentId, issueId) as { id: number; authorUserId: number | null } | undefined;
    if (!row) throw new NotFoundError();
    return row;
  }

  private labelsByIssueId(issueIds: number[]): Map<number, IssueLabel[]> {
    const map = new Map<number, IssueLabel[]>();
    if (issueIds.length === 0) return map;
    const placeholders = issueIds.map(() => '?').join(',');
    const rows = this.database
      .prepare(
        `SELECT la.issue_id AS issueId, l.id, l.name, l.color
         FROM issue_label_assignments la
         JOIN issue_labels l ON l.id = la.label_id
         WHERE la.issue_id IN (${placeholders})
         ORDER BY l.name`,
      )
      .all(...issueIds) as { issueId: number; id: number; name: string; color: string }[];
    for (const row of rows) {
      const list = map.get(row.issueId) ?? [];
      list.push({ id: row.id, name: row.name, color: row.color });
      map.set(row.issueId, list);
    }
    return map;
  }

  private applyLabels(issueId: number, repositoryId: number, labelIds: number[]): void {
    const unique = Array.from(new Set(labelIds));
    if (unique.length > 20) throw new IssueError('An issue may have at most 20 labels');
    if (unique.length > 0) {
      const placeholders = unique.map(() => '?').join(',');
      const valid = this.database
        .prepare(`SELECT id FROM issue_labels WHERE repository_id = ? AND id IN (${placeholders})`)
        .all(repositoryId, ...unique) as { id: number }[];
      if (valid.length !== unique.length)
        throw new IssueError('One or more labels do not belong to this repository');
    }
    this.database.prepare('DELETE FROM issue_label_assignments WHERE issue_id = ?').run(issueId);
    const insert = this.database.prepare(
      'INSERT INTO issue_label_assignments(issue_id, label_id) VALUES (?, ?)',
    );
    for (const labelId of unique) insert.run(issueId, labelId);
  }

  private validateAssignee(repository: Repository, assigneeUserId: number | null): void {
    if (
      assigneeUserId !== null &&
      this.repositories.permission(repository, assigneeUserId) === 'none'
    )
      throw new IssueError('Assignee does not have access to this repository', 422);
  }

  /** Collaborators (write/admin/owner) may act on any issue; a read-level reporter may only act on
   *  their own issue or comment. Insufficient access is reported as 404, matching
   *  RepositoryService.require()'s non-disclosing convention for every other repository resource. */
  private requireWriteOrAuthor(
    repository: Repository,
    actorUserId: number,
    ownerUserId: number | null,
  ): void {
    const level = this.repositories.permission(repository, actorUserId);
    const hasWrite = level === 'write' || level === 'admin' || level === 'owner';
    if (!hasWrite && actorUserId !== ownerUserId) throw new NotFoundError();
  }
}

export class IssueError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function validateTitle(value: string): string {
  const title = value.trim();
  if (!title || title.length > 255)
    throw new IssueError('Issue title must be between 1 and 255 characters');
  return title;
}
function validateBody(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES)
    throw new IssueError('Issue body is too long', 413);
  return value;
}
function validateCommentBody(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new IssueError('Comment body is required');
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_TEXT_BYTES)
    throw new IssueError('Comment body is too long', 413);
  return trimmed;
}
