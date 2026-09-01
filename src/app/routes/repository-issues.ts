import type { AppRouteContext, Repository, Session } from './route-context.js';
import * as runtime from './route-runtime.js';

function parseIssueNumber(value: string): number {
  const number = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new runtime.ValidationError('Invalid issue number');
  return number;
}

// Repository issue-tracker routes: issues, comments, and labels.
export function registerIssueHtmlRoutes(context: AppRouteContext): void {
  const { app, auth, database, issues, repositories, search, render, readableRepository } = context;

  const canTriage = (repository: Repository, current: Session | null) =>
    !!current &&
    ['write', 'admin', 'owner'].includes(repositories.permission(repository, current.user.id));

  const resolveAssignee = (username: string | undefined): number | null => {
    if (!username) return null;
    const row = database
      .prepare("SELECT id FROM users WHERE username = ? AND status = 'active'")
      .get(username.toLowerCase()) as { id: number } | undefined;
    if (!row) throw new runtime.ValidationError('Unknown assignee');
    return row.id;
  };

  const selectedLabelIds = (body: runtime.FormBody, availableLabels: { id: number }[]): number[] =>
    availableLabels
      .filter((label) => body[`label:${String(label.id)}`] === 'on')
      .map((label) => label.id);

  app.get('/:owner/:repository/issues', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const query = request.query as {
      status?: string;
      label?: string;
      assignee?: string;
      page?: string;
    };
    const status =
      query.status === 'open' || query.status === 'closed' || query.status === 'all'
        ? query.status
        : 'open';
    const page = query.page ? Number.parseInt(query.page, 10) : 1;
    return reply.type('text/html').send(
      await render('issues', {
        user: current?.user ?? null,
        csrf: current?.csrfToken ?? null,
        repository,
        canTriage: canTriage(repository, current),
        canReport: !!current,
        labels: issues.labels(repository.id),
        filters: { status, label: query.label ?? '', assignee: query.assignee ?? '' },
        ...issues.list(repository, current?.user.id ?? null, {
          status,
          ...(query.label ? { label: query.label } : {}),
          ...(query.assignee ? { assignee: query.assignee } : {}),
          page: Number.isSafeInteger(page) && page > 0 ? page : 1,
        }),
      }),
    );
  });

  app.get('/:owner/:repository/issues/new', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    if (!current) throw new runtime.AuthorizationError();
    return reply.type('text/html').send(
      await render('issue-new', {
        user: current.user,
        csrf: current.csrfToken,
        repository,
        labels: issues.labels(repository.id),
      }),
    );
  });

  app.post('/:owner/:repository/issues', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    if (!current) throw new runtime.AuthorizationError();
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const availableLabels = issues.labels(repository.id);
    const created = issues.create(repository, current.user.id, {
      title: body.title ?? '',
      body: body.body ?? '',
      labelIds: selectedLabelIds(body, availableLabels),
      assigneeUserId: resolveAssignee(body.assignee),
    });
    search.enqueue(repository.id);
    return await reply.redirect(
      `/${repository.ownerSlug}/${repository.slug}/issues/${String(created.number)}`,
    );
  });

  app.get('/:owner/:repository/issues/:number', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const number = parseIssueNumber((request.params as { number: string }).number);
    const issue = issues.get(repository, current?.user.id ?? null, number);
    return reply.type('text/html').send(
      await render('issue', {
        user: current?.user ?? null,
        csrf: current?.csrfToken ?? null,
        repository,
        issue,
        bodyHtml: runtime.renderMarkdown(issue.body),
        comments: issue.comments.map((comment) => ({
          ...comment,
          bodyHtml: runtime.renderMarkdown(comment.body),
        })),
        availableLabels: issues.labels(repository.id),
        canTriage: canTriage(repository, current),
        isAuthor: !!current && current.user.username === issue.authorUsername,
      }),
    );
  });

  app.post('/:owner/:repository/issues/:number', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    if (!current) throw new runtime.AuthorizationError();
    const number = parseIssueNumber((request.params as { number: string }).number);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    if (body.action === 'comment') {
      issues.addComment(repository, current.user.id, number, body.body ?? '');
    } else if (body.action === 'edit') {
      issues.updateDetails(repository, current.user.id, number, {
        title: body.title ?? '',
        body: body.body ?? '',
      });
    } else if (body.action === 'close') {
      issues.setStatus(repository, current.user.id, number, 'closed');
    } else if (body.action === 'reopen') {
      issues.setStatus(repository, current.user.id, number, 'open');
    } else if (body.action === 'assign') {
      issues.assign(repository, current.user.id, number, resolveAssignee(body.assignee));
    } else if (body.action === 'label') {
      const availableLabels = issues.labels(repository.id);
      issues.setLabels(
        repository,
        current.user.id,
        number,
        selectedLabelIds(body, availableLabels),
      );
    } else throw new runtime.ValidationError('Invalid issue action');
    search.enqueue(repository.id);
    return await reply.redirect(
      `/${repository.ownerSlug}/${repository.slug}/issues/${String(number)}`,
    );
  });

  app.post('/:owner/:repository/issues/:number/comments/:commentId', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    if (!current) throw new runtime.AuthorizationError();
    const parameters = request.params as { number: string; commentId: string };
    const number = parseIssueNumber(parameters.number);
    const commentId = Number.parseInt(parameters.commentId, 10);
    if (!Number.isSafeInteger(commentId) || commentId <= 0)
      throw new runtime.ValidationError('Invalid comment');
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    if (body.action === 'edit')
      issues.updateComment(repository, current.user.id, number, commentId, body.body ?? '');
    else if (body.action === 'remove')
      issues.removeComment(repository, current.user.id, number, commentId);
    else throw new runtime.ValidationError('Invalid comment action');
    return await reply.redirect(
      `/${repository.ownerSlug}/${repository.slug}/issues/${String(number)}`,
    );
  });

  app.get('/:owner/:repository/labels', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    if (!current) throw new runtime.AuthorizationError();
    repositories.require(repository, current.user.id, 'write');
    return reply.type('text/html').send(
      await render('repository-labels', {
        user: current.user,
        csrf: current.csrfToken,
        repository,
        labels: issues.labels(repository.id),
      }),
    );
  });

  app.post('/:owner/:repository/labels', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    if (!current) throw new runtime.AuthorizationError();
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    if (body.action === 'create')
      issues.createLabel(repository, current.user.id, body.name ?? '', body.color ?? '6b7280');
    else if (body.action === 'remove')
      issues.removeLabel(repository, current.user.id, Number.parseInt(body.labelId ?? '', 10));
    else throw new runtime.ValidationError('Invalid label action');
    return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}/labels`);
  });
}
