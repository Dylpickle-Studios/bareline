import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { IssueService } from '../src/repositories/issue-service.js';
import { RepositoryAdminService } from '../src/repositories/repository-admin-service.js';
import { RepositoryEnhancementService } from '../src/repositories/repository-enhancement-service.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

async function setup() {
  const config = temporaryConfig();
  config.registration.mode = 'open';
  const database = openDatabase(config.database.path);
  const audit = new AuditService(database);
  const auth = new AuthService(database, config, audit);
  const git = new GitRunner('git', 10_000, 16 * 1024 * 1024);
  const repositories = new RepositoryService(database, git, config, audit);
  const enhancements = new RepositoryEnhancementService(database, git, repositories, audit);
  const admin = new RepositoryAdminService(database, repositories, config, audit);
  const issues = new IssueService(database, repositories, enhancements, audit);
  const owner = await auth.register({
    username: 'owner',
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  const repository = await repositories.createForUser({
    actorUserId: owner.id,
    ownerUserId: owner.id,
    slug: 'tracker',
    visibility: 'private',
    initializeReadme: true,
  });
  return { database, audit, repositories, enhancements, admin, issues, auth, owner, repository };
}

describe('issue tracker', () => {
  it('allocates sequential, gapless numbers per repository', async () => {
    const { issues, owner, repository, repositories } = await setup();
    const first = issues.create(repository, owner.id, { title: 'First', body: '' });
    const second = issues.create(repository, owner.id, { title: 'Second', body: '' });
    const third = issues.create(repository, owner.id, { title: 'Third', body: '' });
    expect([first.number, second.number, third.number]).toEqual([1, 2, 3]);

    const other = await repositories.createForUser({
      actorUserId: owner.id,
      ownerUserId: owner.id,
      slug: 'tracker-two',
      visibility: 'private',
      initializeReadme: true,
    });
    const otherFirst = issues.create(other, owner.id, { title: 'Other repo issue', body: '' });
    expect(otherFirst.number).toBe(1);
  });

  it("enforces the permission matrix: read-only collaborators can create/comment but not triage someone else's issue", async () => {
    const { issues, admin, auth, owner, repository } = await setup();
    const reporter = await auth.register({
      username: 'reporter',
      displayName: 'Reporter',
      password: 'correct horse battery staple',
    });
    const otherReader = await auth.register({
      username: 'other-reader',
      displayName: 'Other Reader',
      password: 'correct horse battery staple',
    });
    admin.setGrant(repository, owner.id, 'user', reporter.id, 'read');
    admin.setGrant(repository, owner.id, 'user', otherReader.id, 'read');

    expect(() => issues.create(repository, 999_999, { title: 'Nope', body: '' })).toThrow();

    const issue = issues.create(repository, reporter.id, { title: 'Reported bug', body: 'Steps' });
    issues.addComment(repository, reporter.id, issue.number, 'More detail');
    issues.addComment(repository, otherReader.id, issue.number, 'Also confirming');

    expect(() => issues.setStatus(repository, otherReader.id, issue.number, 'closed')).toThrow();
    expect(() => issues.assign(repository, otherReader.id, issue.number, otherReader.id)).toThrow();
    expect(() => issues.setLabels(repository, otherReader.id, issue.number, [])).toThrow();
  });

  it('lets the issue author close/reopen/edit their own issue without write access, but not label/assign', async () => {
    const { issues, admin, auth, owner, repository } = await setup();
    const reporter = await auth.register({
      username: 'author-only',
      displayName: 'Author',
      password: 'correct horse battery staple',
    });
    admin.setGrant(repository, owner.id, 'user', reporter.id, 'read');
    const issue = issues.create(repository, reporter.id, { title: 'My issue', body: '' });

    const closed = issues.setStatus(repository, reporter.id, issue.number, 'closed');
    expect(closed.status).toBe('closed');
    const reopened = issues.setStatus(repository, reporter.id, issue.number, 'open');
    expect(reopened.status).toBe('open');
    const edited = issues.updateDetails(repository, reporter.id, issue.number, {
      title: 'Renamed',
    });
    expect(edited.title).toBe('Renamed');

    expect(() => issues.assign(repository, reporter.id, issue.number, reporter.id)).toThrow();
    expect(() => issues.setLabels(repository, reporter.id, issue.number, [])).toThrow();
  });

  it('manages many-to-many labels and cascades removal', async () => {
    const { issues, owner, repository } = await setup();
    const bug = issues.createLabel(repository, owner.id, 'bug', 'ff0000');
    const docs = issues.createLabel(repository, owner.id, 'docs', '00ff00');
    const issue = issues.create(repository, owner.id, {
      title: 'Needs labels',
      body: '',
      labelIds: [bug.id, docs.id],
    });
    expect(issue.labels.map((label) => label.name).sort()).toEqual(['bug', 'docs']);

    const relabeled = issues.setLabels(repository, owner.id, issue.number, [bug.id]);
    expect(relabeled.labels.map((label) => label.name)).toEqual(['bug']);

    issues.removeLabel(repository, owner.id, bug.id);
    const after = issues.get(repository, owner.id, issue.number);
    expect(after.labels).toEqual([]);
  });

  it('rejects a label from a different repository and enforces assignee repo access', async () => {
    const { issues, repositories, owner, repository } = await setup();
    const other = await repositories.createForUser({
      actorUserId: owner.id,
      ownerUserId: owner.id,
      slug: 'other-labels',
      visibility: 'private',
      initializeReadme: true,
    });
    const foreignLabel = issues.createLabel(other, owner.id, 'foreign', 'abcdef');
    expect(() =>
      issues.create(repository, owner.id, { title: 'x', body: '', labelIds: [foreignLabel.id] }),
    ).toThrow(/do not belong/);
    expect(() =>
      issues.create(repository, owner.id, { title: 'x', body: '', assigneeUserId: 999_999 }),
    ).toThrow(/does not have access/);
  });

  it('publishes issue events and records audit/activity entries', async () => {
    const { issues, enhancements, database, owner, repository } = await setup();
    const events: string[] = [];
    issues.setEventPublisher((event) => {
      events.push(event);
    });
    const issue = issues.create(repository, owner.id, { title: 'Tracked', body: '' });
    issues.addComment(repository, owner.id, issue.number, 'Update');
    issues.setStatus(repository, owner.id, issue.number, 'closed');
    issues.setStatus(repository, owner.id, issue.number, 'open');
    issues.assign(repository, owner.id, issue.number, owner.id);
    issues.setLabels(repository, owner.id, issue.number, []);

    expect(events).toEqual([
      'issue.created',
      'issue.commented',
      'issue.closed',
      'issue.reopened',
      'issue.assigned',
      'issue.labeled',
    ]);
    expect(enhancements.activity(repository.id).length).toBeGreaterThanOrEqual(6);
    const auditCount = database
      .prepare("SELECT count(*) AS count FROM audit_events WHERE action LIKE 'issue.%'")
      .get() as { count: number };
    expect(auditCount.count).toBeGreaterThanOrEqual(6);
  });

  it('reads back a full issue with comments in creation order', async () => {
    const { issues, owner, repository } = await setup();
    const issue = issues.create(repository, owner.id, { title: 'Detail', body: 'Body text' });
    issues.addComment(repository, owner.id, issue.number, 'First comment');
    issues.addComment(repository, owner.id, issue.number, 'Second comment');
    const detail = issues.get(repository, owner.id, issue.number);
    expect(detail.body).toBe('Body text');
    expect(detail.comments.map((comment) => comment.body)).toEqual([
      'First comment',
      'Second comment',
    ]);
    expect(detail.authorUsername).toBe('owner');
  });
});
