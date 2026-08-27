import type { AppRouteContext } from './route-context.js';
import * as routeHelpers from './route-helpers.js';
import * as runtime from './route-runtime.js';

// Repository tree, history, refs, and file mutation routes.
export function registerApiRepositoryContentRoutes(context: AppRouteContext): void {
  const { app, repositories, browser, mutations, apiRepository } = context;
  app.get(
    '/api/v1/repositories/:owner/:repository/tree',
    {
      schema: routeHelpers.apiContract('repositories', {
        authenticated: false,
        params: routeHelpers.repositoryParameters,
        response: runtime.treeResponse,
        query: {
          type: 'object',
          properties: { ref: { type: 'string' }, path: { type: 'string' } },
        },
      }),
    },
    async (request, reply) => {
      const { repository } = apiRepository(request, 'repository:read', 'read');
      const query = request.query as { ref?: string; path?: string };
      const ref = query.ref ?? repository.defaultBranch;
      const submodules = await repositories.submoduleUrls(repository, ref);
      const items = (await repositories.listTree(repository, ref, query.path ?? '')).map((entry) =>
        routeHelpers.presentTreeEntry(entry, submodules),
      );
      return reply.send({ items, ref, path: query.path ?? '' });
    },
  );

  app.get(
    '/api/v1/repositories/:owner/:repository/blob/*',
    {
      schema: routeHelpers.apiContract('repositories', {
        authenticated: false,
        params: routeHelpers.repositoryWildcardParameters,
        response: runtime.blobResponse,
        query: { type: 'object', properties: { ref: { type: 'string' } } },
      }),
    },
    async (request, reply) => {
      const { repository } = apiRepository(request, 'repository:read', 'read');
      const path = (request.params as { '*': string })['*'];
      const ref = (request.query as { ref?: string }).ref ?? repository.defaultBranch;
      const content = await repositories.readBlob(repository, ref, path);
      return reply.send({
        path,
        ref,
        size: content.length,
        encoding: 'base64',
        content: content.toString('base64'),
      });
    },
  );

  app.get(
    '/api/v1/repositories/:owner/:repository/blame/*',
    {
      schema: routeHelpers.apiContract('repositories', {
        params: routeHelpers.repositoryWildcardParameters,
        query: {
          type: 'object',
          additionalProperties: false,
          properties: { ref: { type: 'string', maxLength: 255 } },
        },
        response: runtime.blameResponse,
      }),
    },
    async (request, reply) => {
      const { repository } = apiRepository(request, 'repository:read', 'read');
      const path = (request.params as { '*': string })['*'];
      const ref = (request.query as { ref?: string }).ref ?? repository.defaultBranch;
      return reply.send({ path, ref, items: await browser.blame(repository, ref, path) });
    },
  );

  app.get(
    '/api/v1/repositories/:owner/:repository/commits/:objectId',
    {
      schema: routeHelpers.apiContract('commits', {
        authenticated: false,
        response: runtime.commitDetailResponse,
        params: {
          type: 'object',
          required: ['owner', 'repository', 'objectId'],
          properties: {
            owner: { type: 'string' },
            repository: { type: 'string' },
            objectId: { type: 'string', pattern: '^[0-9a-f]{40}(?:[0-9a-f]{24})?$' },
          },
        },
      }),
    },
    async (request, reply) => {
      const { repository } = apiRepository(request, 'repository:read', 'read');
      return reply.send(
        await browser.commit(repository, (request.params as { objectId: string }).objectId),
      );
    },
  );

  for (const kind of ['branches', 'tags'] as const) {
    app.get(
      `/api/v1/repositories/:owner/:repository/${kind}`,
      {
        schema: routeHelpers.apiContract('refs', {
          authenticated: false,
          params: routeHelpers.repositoryParameters,
          response: runtime.refListResponse,
        }),
      },
      async (request, reply) => {
        const { repository } = apiRepository(request, 'repository:read', 'read');
        return reply.send({ items: await browser[kind](repository) });
      },
    );
  }

  app.get(
    '/api/v1/repositories/:owner/:repository/compare',
    {
      schema: routeHelpers.apiContract('commits', {
        authenticated: false,
        params: routeHelpers.repositoryParameters,
        response: runtime.comparisonResponse,
        query: {
          type: 'object',
          required: ['base', 'head'],
          properties: { base: { type: 'string' }, head: { type: 'string' } },
        },
      }),
    },
    async (request, reply) => {
      const { repository } = apiRepository(request, 'repository:read', 'read');
      const query = request.query as { base?: string; head?: string };
      if (!query.base || !query.head)
        throw new runtime.ValidationError('base and head are required');
      return reply.send(await browser.compare(repository, query.base, query.head));
    },
  );

  app.post(
    '/api/v1/repositories/:owner/:repository/branches',
    {
      schema: routeHelpers.apiContract('refs', {
        success: 201,
        params: routeHelpers.repositoryParameters,
        body: routeHelpers.refCreateBody,
        response: runtime.okResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      const body = request.body as { name?: unknown; source?: unknown };
      if (typeof body.name !== 'string' || typeof body.source !== 'string')
        throw new runtime.ValidationError('name and source are required');
      await mutations.createBranch(repository, principal.userId, body.name, body.source);
      return reply.code(201).send({ ok: true });
    },
  );

  app.post(
    '/api/v1/repositories/:owner/:repository/tags',
    {
      schema: routeHelpers.apiContract('refs', {
        success: 201,
        params: routeHelpers.repositoryParameters,
        body: routeHelpers.refCreateBody,
        response: runtime.okResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      const body = request.body as { name?: unknown; source?: unknown };
      if (typeof body.name !== 'string' || typeof body.source !== 'string')
        throw new runtime.ValidationError('name and source are required');
      await mutations.createTag(repository, principal.userId, body.name, body.source);
      return reply.code(201).send({ ok: true });
    },
  );

  app.delete(
    '/api/v1/repositories/:owner/:repository/branches/:name',
    {
      schema: routeHelpers.apiContract('refs', {
        success: 204,
        params: routeHelpers.stringPathParameters('owner', 'repository', 'name'),
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      await mutations.deleteBranch(
        repository,
        principal.userId,
        (request.params as { name: string }).name,
      );
      return reply.code(204).send();
    },
  );

  app.delete(
    '/api/v1/repositories/:owner/:repository/tags/:name',
    {
      schema: routeHelpers.apiContract('refs', {
        success: 204,
        params: routeHelpers.stringPathParameters('owner', 'repository', 'name'),
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      await mutations.deleteTag(
        repository,
        principal.userId,
        (request.params as { name: string }).name,
      );
      return reply.code(204).send();
    },
  );

  app.put(
    '/api/v1/repositories/:owner/:repository/files/*',
    {
      schema: routeHelpers.apiContract('repositories', {
        success: 201,
        params: routeHelpers.repositoryWildcardParameters,
        body: routeHelpers.fileWriteBody,
        response: runtime.objectIdResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      const body = request.body as {
        branch?: unknown;
        message?: unknown;
        content?: unknown;
        encoding?: unknown;
      };
      if (
        typeof body.branch !== 'string' ||
        typeof body.message !== 'string' ||
        typeof body.content !== 'string' ||
        body.encoding !== 'base64' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.content)
      )
        throw new runtime.ValidationError('branch, message, and valid base64 content are required');
      const objectId = await mutations.commitFile({
        repository,
        actorUserId: principal.userId,
        branch: body.branch,
        filePath: (request.params as { '*': string })['*'],
        content: Buffer.from(body.content, 'base64'),
        message: body.message,
      });
      return reply.code(201).send({ objectId });
    },
  );

  app.delete(
    '/api/v1/repositories/:owner/:repository/files/*',
    {
      schema: routeHelpers.apiContract('repositories', {
        params: routeHelpers.repositoryWildcardParameters,
        body: routeHelpers.fileDeleteBody,
        response: runtime.objectIdResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      const body = request.body as { branch?: unknown; message?: unknown };
      if (typeof body.branch !== 'string' || typeof body.message !== 'string')
        throw new runtime.ValidationError('branch and message are required');
      const objectId = await mutations.commitFile({
        repository,
        actorUserId: principal.userId,
        branch: body.branch,
        filePath: (request.params as { '*': string })['*'],
        message: body.message,
      });
      return reply.send({ objectId });
    },
  );
}
