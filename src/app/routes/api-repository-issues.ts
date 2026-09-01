import type { AppRouteContext } from './route-context.js';
import * as routeHelpers from './route-helpers.js';
import * as runtime from './route-runtime.js';

const issueParameters = {
  type: 'object',
  required: ['owner', 'repository', 'number'],
  properties: {
    owner: { type: 'string' },
    repository: { type: 'string' },
    number: { type: 'string' },
  },
};
const issueCommentParameters = {
  type: 'object',
  required: ['owner', 'repository', 'number', 'commentId'],
  properties: {
    owner: { type: 'string' },
    repository: { type: 'string' },
    number: { type: 'string' },
    commentId: { type: 'string' },
  },
};

function parseIssueNumber(value: string): number {
  const number = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new runtime.ValidationError('Invalid issue number');
  return number;
}

// Repository issue-tracker API: issues, comments, and labels.
export function registerApiIssueRoutes(context: AppRouteContext): void {
  const { app, database, issues, apiRepository } = context;

  const resolveAssignee = (username: string | null | undefined): number | null => {
    if (!username) return null;
    const row = database
      .prepare("SELECT id FROM users WHERE username = ? AND status = 'active'")
      .get(username.toLowerCase()) as { id: number } | undefined;
    if (!row) throw new runtime.ValidationError('Unknown assignee');
    return row.id;
  };

  app.get(
    '/api/v1/repositories/:owner/:repository/issues',
    {
      schema: routeHelpers.apiContract('issues', {
        authenticated: false,
        params: routeHelpers.repositoryParameters,
        query: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['open', 'closed', 'all'] },
            label: { type: 'string', maxLength: 50 },
            assignee: { type: 'string', maxLength: 39 },
            page: { type: 'integer', minimum: 1 },
          },
        },
        response: runtime.issueListResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:read', 'read');
      const query = request.query as {
        status?: 'open' | 'closed' | 'all';
        label?: string;
        assignee?: string;
        page?: number;
      };
      return reply.send(
        issues.list(repository, principal?.userId ?? null, {
          ...(query.status ? { status: query.status } : {}),
          ...(query.label ? { label: query.label } : {}),
          ...(query.assignee ? { assignee: query.assignee } : {}),
          ...(query.page ? { page: query.page } : {}),
        }),
      );
    },
  );

  app.post(
    '/api/v1/repositories/:owner/:repository/issues',
    {
      schema: routeHelpers.apiContract('issues', {
        success: 201,
        params: routeHelpers.repositoryParameters,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['title'],
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 255 },
            body: { type: 'string', maxLength: 65_536 },
            labelIds: { type: 'array', items: { type: 'integer' }, maxItems: 20 },
            assigneeUsername: { anyOf: [{ type: 'string', maxLength: 39 }, { type: 'null' }] },
          },
        },
        response: runtime.issueResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'read');
      if (!principal) throw new runtime.AuthorizationError();
      const body = request.body as {
        title: string;
        body?: string;
        labelIds?: number[];
        assigneeUsername?: string | null;
      };
      const created = issues.create(repository, principal.userId, {
        title: body.title,
        body: body.body ?? '',
        ...(body.labelIds ? { labelIds: body.labelIds } : {}),
        assigneeUserId: resolveAssignee(body.assigneeUsername),
      });
      return reply.code(201).send(created);
    },
  );

  app.get(
    '/api/v1/repositories/:owner/:repository/issues/:number',
    {
      schema: routeHelpers.apiContract('issues', {
        authenticated: false,
        params: issueParameters,
        response: runtime.issueResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:read', 'read');
      const number = parseIssueNumber((request.params as { number: string }).number);
      return reply.send(issues.get(repository, principal?.userId ?? null, number));
    },
  );

  app.patch(
    '/api/v1/repositories/:owner/:repository/issues/:number',
    {
      schema: routeHelpers.apiContract('issues', {
        params: issueParameters,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 255 },
            body: { type: 'string', maxLength: 65_536 },
            status: { type: 'string', enum: ['open', 'closed'] },
          },
        },
        response: runtime.issueResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'read');
      if (!principal) throw new runtime.AuthorizationError();
      const number = parseIssueNumber((request.params as { number: string }).number);
      const body = request.body as { title?: string; body?: string; status?: 'open' | 'closed' };
      if (body.title !== undefined || body.body !== undefined)
        issues.updateDetails(repository, principal.userId, number, {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.body !== undefined ? { body: body.body } : {}),
        });
      if (body.status !== undefined)
        issues.setStatus(repository, principal.userId, number, body.status);
      return reply.send(issues.get(repository, principal.userId, number));
    },
  );

  app.put(
    '/api/v1/repositories/:owner/:repository/issues/:number/assignee',
    {
      schema: routeHelpers.apiContract('issues', {
        params: issueParameters,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['username'],
          properties: {
            username: { anyOf: [{ type: 'string', maxLength: 39 }, { type: 'null' }] },
          },
        },
        response: runtime.issueResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      const number = parseIssueNumber((request.params as { number: string }).number);
      const body = request.body as { username: string | null };
      return reply.send(
        issues.assign(repository, principal.userId, number, resolveAssignee(body.username)),
      );
    },
  );

  app.put(
    '/api/v1/repositories/:owner/:repository/issues/:number/labels',
    {
      schema: routeHelpers.apiContract('issues', {
        params: issueParameters,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['labelIds'],
          properties: { labelIds: { type: 'array', items: { type: 'integer' }, maxItems: 20 } },
        },
        response: runtime.issueResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      const number = parseIssueNumber((request.params as { number: string }).number);
      const body = request.body as { labelIds: number[] };
      return reply.send(issues.setLabels(repository, principal.userId, number, body.labelIds));
    },
  );

  app.get(
    '/api/v1/repositories/:owner/:repository/issues/:number/comments',
    {
      schema: routeHelpers.apiContract('issues', {
        authenticated: false,
        params: issueParameters,
        response: runtime.issueCommentListResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:read', 'read');
      const number = parseIssueNumber((request.params as { number: string }).number);
      return reply.send({
        items: issues.get(repository, principal?.userId ?? null, number).comments,
      });
    },
  );

  app.post(
    '/api/v1/repositories/:owner/:repository/issues/:number/comments',
    {
      schema: routeHelpers.apiContract('issues', {
        success: 201,
        params: issueParameters,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['body'],
          properties: { body: { type: 'string', minLength: 1, maxLength: 65_536 } },
        },
        response: runtime.issueCommentResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'read');
      if (!principal) throw new runtime.AuthorizationError();
      const number = parseIssueNumber((request.params as { number: string }).number);
      const body = request.body as { body: string };
      return reply
        .code(201)
        .send(issues.addComment(repository, principal.userId, number, body.body));
    },
  );

  app.patch(
    '/api/v1/repositories/:owner/:repository/issues/:number/comments/:commentId',
    {
      schema: routeHelpers.apiContract('issues', {
        params: issueCommentParameters,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['body'],
          properties: { body: { type: 'string', minLength: 1, maxLength: 65_536 } },
        },
        response: runtime.issueCommentResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'read');
      if (!principal) throw new runtime.AuthorizationError();
      const parameters = request.params as { number: string; commentId: string };
      const number = parseIssueNumber(parameters.number);
      const commentId = Number.parseInt(parameters.commentId, 10);
      if (!Number.isSafeInteger(commentId) || commentId <= 0)
        throw new runtime.ValidationError('Invalid comment');
      const body = request.body as { body: string };
      return reply.send(
        issues.updateComment(repository, principal.userId, number, commentId, body.body),
      );
    },
  );

  app.delete(
    '/api/v1/repositories/:owner/:repository/issues/:number/comments/:commentId',
    {
      schema: routeHelpers.apiContract('issues', { success: 204, params: issueCommentParameters }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'read');
      if (!principal) throw new runtime.AuthorizationError();
      const parameters = request.params as { number: string; commentId: string };
      const number = parseIssueNumber(parameters.number);
      const commentId = Number.parseInt(parameters.commentId, 10);
      if (!Number.isSafeInteger(commentId) || commentId <= 0)
        throw new runtime.ValidationError('Invalid comment');
      issues.removeComment(repository, principal.userId, number, commentId);
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/repositories/:owner/:repository/labels',
    {
      schema: routeHelpers.apiContract('issues', {
        authenticated: false,
        params: routeHelpers.repositoryParameters,
        response: runtime.issueLabelListResponse,
      }),
    },
    async (request, reply) => {
      const { repository } = apiRepository(request, 'repository:read', 'read');
      return reply.send({ items: issues.labels(repository.id) });
    },
  );

  app.post(
    '/api/v1/repositories/:owner/:repository/labels',
    {
      schema: routeHelpers.apiContract('issues', {
        success: 201,
        params: routeHelpers.repositoryParameters,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 50 },
            color: { type: 'string', pattern: '^[0-9a-fA-F]{6}$' },
          },
        },
        response: runtime.issueLabelResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      const body = request.body as { name: string; color?: string };
      return reply
        .code(201)
        .send(issues.createLabel(repository, principal.userId, body.name, body.color ?? '6b7280'));
    },
  );

  app.delete(
    '/api/v1/repositories/:owner/:repository/labels/:labelId',
    {
      schema: routeHelpers.apiContract('issues', {
        success: 204,
        params: routeHelpers.stringPathParameters('owner', 'repository', 'labelId'),
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      const labelId = Number.parseInt((request.params as { labelId: string }).labelId, 10);
      if (!Number.isSafeInteger(labelId) || labelId <= 0)
        throw new runtime.ValidationError('Invalid label');
      issues.removeLabel(repository, principal.userId, labelId);
      return reply.code(204).send();
    },
  );
}
