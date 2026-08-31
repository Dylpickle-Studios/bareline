import type { AppRouteContext } from './route-context.js';
import * as routeHelpers from './route-helpers.js';
import * as runtime from './route-runtime.js';

// Repository discovery, lifecycle, access, and enhancement routes.
export function registerApiRepositoryManagementRoutes(context: AppRouteContext): void {
  const {
    app,
    database,
    repositories,
    browser,
    enhancements,
    repositoryAdmin,
    groups,
    search,
    webhooks,
    apiPrincipal,
    apiRepository,
  } = context;
  app.get(
    '/api/v1/search',
    {
      schema: routeHelpers.apiContract('search', {
        authenticated: false,
        query: {
          type: 'object',
          additionalProperties: false,
          required: ['q'],
          properties: {
            q: { type: 'string', minLength: 1, maxLength: 200 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
        response: runtime.searchResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'repository:read');
      const query = request.query as { q: string; limit?: number };
      const limit = query.limit ?? 30;
      return reply.send({
        items: search.search(query.q, principal?.userId ?? null, limit),
        directory: search.searchDirectory(query.q, principal?.userId ?? null, Math.min(limit, 30)),
        documentation: await runtime.documentationSearch(query.q, Math.min(limit, 30)),
      });
    },
  );

  app.get(
    '/api/v1/repositories',
    {
      schema: routeHelpers.apiContract('repositories', {
        authenticated: false,
        response: runtime.repositoryListResponse,
        query: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1 },
            perPage: { type: 'integer', minimum: 1, maximum: 100 },
            owner: { type: 'string' },
            visibility: { type: 'string', enum: ['public', 'private'] },
            q: { type: 'string', maxLength: 100 },
          },
        },
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'repository:read');
      const query = request.query as {
        page?: string;
        perPage?: string;
        owner?: string;
        visibility?: runtime.Visibility;
        q?: string;
      };
      const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
      const perPage = Math.min(100, Math.max(1, Number.parseInt(query.perPage ?? '30', 10) || 30));
      const items = repositories
        .listAccessible(principal?.userId ?? null, page, perPage, {
          ...(query.owner ? { owner: query.owner.toLowerCase() } : {}),
          ...(query.visibility ? { visibility: query.visibility } : {}),
          ...(query.q ? { query: query.q.slice(0, 100) } : {}),
        })
        .map(routeHelpers.repositoryJson);
      return reply.send({
        items,
        pagination: {
          page,
          perPage,
          hasMore: items.length === perPage,
          filters: {
            owner: query.owner ?? null,
            visibility: query.visibility ?? null,
            q: query.q ?? null,
          },
        },
      });
    },
  );

  app.post(
    '/api/v1/repositories',
    {
      schema: routeHelpers.apiContract('repositories', {
        success: 201,
        body: routeHelpers.repositoryCreateBody,
        response: runtime.repositoryResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'repository:write');
      if (!principal) throw new runtime.AuthorizationError();
      const body = request.body as {
        owner?: unknown;
        ownerType?: unknown;
        name?: unknown;
        description?: unknown;
        visibility?: unknown;
        initializeReadme?: unknown;
        gitignore?: unknown;
        license?: unknown;
      };
      if (
        typeof body.owner !== 'string' ||
        typeof body.name !== 'string' ||
        (body.description !== undefined && typeof body.description !== 'string') ||
        !['public', 'private'].includes(typeof body.visibility === 'string' ? body.visibility : '')
      )
        throw new runtime.ValidationError(
          'Valid owner, name, description, and visibility are required',
        );
      let repository;
      if (body.ownerType === 'group') {
        const group = groups.getBySlug(body.owner, principal.userId);
        repository = await repositories.createForGroup({
          actorUserId: principal.userId,
          ownerGroupId: group.id,
          slug: body.name,
          description: body.description ?? '',
          visibility: body.visibility as runtime.Visibility,
          initializeReadme: body.initializeReadme === true,
          gitignore: typeof body.gitignore === 'string' ? body.gitignore : '',
          license: typeof body.license === 'string' ? body.license : '',
        });
      } else {
        const account = database
          .prepare("SELECT username FROM users WHERE id = ? AND status = 'active'")
          .get(principal.userId) as { username: string } | undefined;
        if (account?.username !== body.owner.toLowerCase()) throw new runtime.AuthorizationError();
        repository = await repositories.createForUser({
          actorUserId: principal.userId,
          ownerUserId: principal.userId,
          slug: body.name,
          description: body.description ?? '',
          visibility: body.visibility as runtime.Visibility,
          initializeReadme: body.initializeReadme === true,
          gitignore: typeof body.gitignore === 'string' ? body.gitignore : '',
          license: typeof body.license === 'string' ? body.license : '',
        });
      }
      search.enqueue(repository.id);
      return reply.code(201).send(routeHelpers.repositoryJson(repository));
    },
  );

  app.get(
    '/api/v1/repositories/:owner/:repository',
    {
      schema: routeHelpers.apiContract('repositories', {
        authenticated: false,
        params: routeHelpers.repositoryParameters,
        response: runtime.repositoryResponse,
      }),
    },
    async (request, reply) => {
      const parameters = request.params as { owner: string; repository: string };
      const repository = repositories.find(parameters.owner, parameters.repository);
      if (!repository) throw new runtime.NotFoundError();
      const principal = apiPrincipal(request, 'repository:read');
      repositories.require(repository, principal?.userId ?? null, 'read');
      return reply.send(routeHelpers.repositoryJson(repository));
    },
  );

  app.get(
    '/api/v1/repositories/:owner/:repository/commits',
    {
      schema: routeHelpers.apiContract('commits', {
        authenticated: false,
        params: routeHelpers.repositoryParameters,
        query: {
          type: 'object',
          properties: { ref: { type: 'string' }, page: { type: 'integer', minimum: 1 } },
        },
        response: runtime.commitListResponse,
      }),
    },
    async (request, reply) => {
      const parameters = request.params as { owner: string; repository: string };
      const query = request.query as { ref?: string; page?: number };
      const repository = repositories.find(parameters.owner, parameters.repository);
      if (!repository) throw new runtime.NotFoundError();
      const principal = apiPrincipal(request, 'repository:read');
      repositories.require(repository, principal?.userId ?? null, 'read');
      const page = query.page ?? 1;
      const items = await browser.commits(repository, query.ref ?? repository.defaultBranch, page);
      return reply.send({
        items,
        page,
        pagination: { page, perPage: 30, hasMore: items.length === 30 },
      });
    },
  );

  app.get(
    '/api/v1/repositories/:owner/:repository/history/*',
    {
      schema: routeHelpers.apiContract('commits', {
        authenticated: false,
        params: routeHelpers.repositoryWildcardParameters,
        query: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ref: { type: 'string', maxLength: 255 },
            page: { type: 'integer', minimum: 1 },
          },
        },
        response: runtime.commitListResponse,
      }),
    },
    async (request, reply) => {
      const { repository } = apiRepository(request, 'repository:read', 'read');
      const query = request.query as { ref?: string; page?: number };
      const page = query.page ?? 1;
      const items = await browser.fileHistory(
        repository,
        query.ref ?? repository.defaultBranch,
        (request.params as { '*': string })['*'],
        page,
      );
      return reply.send({
        items,
        page,
        pagination: { page, perPage: 30, hasMore: items.length === 30 },
      });
    },
  );

  app.patch(
    '/api/v1/repositories/:owner/:repository',
    {
      schema: routeHelpers.apiContract('repositories', {
        params: routeHelpers.repositoryParameters,
        body: routeHelpers.repositoryUpdateBody,
        response: runtime.repositoryResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      const body = request.body as {
        name?: unknown;
        description?: unknown;
        visibility?: unknown;
        defaultBranch?: unknown;
        owner?: unknown;
        ownerType?: unknown;
      };
      let updated = repository;
      if (body.description !== undefined || body.defaultBranch !== undefined) {
        if (
          (body.description !== undefined && typeof body.description !== 'string') ||
          (body.defaultBranch !== undefined && typeof body.defaultBranch !== 'string')
        )
          throw new runtime.ValidationError('Invalid repository details');
        updated = await repositoryAdmin.updateDetails(
          updated,
          principal.userId,
          body.description ?? updated.description,
          body.defaultBranch ?? updated.defaultBranch,
        );
      }
      if (body.visibility !== undefined) {
        if (body.visibility !== 'public' && body.visibility !== 'private')
          throw new runtime.ValidationError('Invalid visibility');
        updated = repositoryAdmin.changeVisibility(updated, principal.userId, body.visibility);
      }
      if (body.name !== undefined) {
        if (typeof body.name !== 'string')
          throw new runtime.ValidationError('Invalid repository name');
        updated = repositoryAdmin.rename(updated, principal.userId, body.name);
      }
      if (body.owner !== undefined || body.ownerType !== undefined) {
        if (
          typeof body.owner !== 'string' ||
          (body.ownerType !== 'user' && body.ownerType !== 'group')
        )
          throw new runtime.ValidationError('owner and ownerType are required for transfer');
        updated = repositoryAdmin.transfer(updated, principal.userId, body.ownerType, body.owner);
      }
      return reply.send(routeHelpers.repositoryJson(updated));
    },
  );

  app.delete(
    '/api/v1/repositories/:owner/:repository',
    {
      schema: routeHelpers.apiContract('repositories', {
        success: 204,
        params: routeHelpers.repositoryParameters,
        query: {
          type: 'object',
          required: ['confirm'],
          properties: { confirm: { type: 'string' } },
        },
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      const confirmation = (request.query as { confirm?: string }).confirm;
      if (confirmation !== `${repository.ownerSlug}/${repository.slug}`)
        throw new runtime.ValidationError('Exact owner/repository confirmation is required');
      await repositoryAdmin.delete(repository, principal.userId);
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/repositories/:owner/:repository/collaborators',
    {
      schema: routeHelpers.apiContract('repositories', {
        params: routeHelpers.repositoryParameters,
        response: runtime.collaboratorListResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      return reply.send({ items: repositoryAdmin.grants(repository, principal.userId) });
    },
  );

  app.put(
    '/api/v1/repositories/:owner/:repository/collaborators',
    {
      schema: routeHelpers.apiContract('repositories', {
        params: routeHelpers.repositoryParameters,
        body: routeHelpers.collaboratorBody,
        response: runtime.okResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      const body = request.body as { type?: unknown; name?: unknown; permission?: unknown };
      if (
        !['user', 'group'].includes(typeof body.type === 'string' ? body.type : '') ||
        typeof body.name !== 'string' ||
        !['read', 'write', 'admin'].includes(
          typeof body.permission === 'string' ? body.permission : '',
        )
      )
        throw new runtime.ValidationError(
          'Valid collaborator type, name, and permission are required',
        );
      repositoryAdmin.setGrantByName(
        repository,
        principal.userId,
        body.type as 'user' | 'group',
        body.name,
        body.permission as 'read' | 'write' | 'admin',
      );
      return reply.send({ ok: true });
    },
  );

  app.delete(
    '/api/v1/repositories/:owner/:repository/collaborators/:type/:principalId',
    {
      schema: routeHelpers.apiContract('repositories', {
        success: 204,
        params: {
          type: 'object',
          required: ['owner', 'repository', 'type', 'principalId'],
          properties: {
            owner: { type: 'string' },
            repository: { type: 'string' },
            type: { type: 'string', enum: ['user', 'group'] },
            principalId: { type: 'integer', minimum: 1 },
          },
        },
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      const parameters = request.params as { type: string; principalId: string };
      const principalId = Number.parseInt(parameters.principalId, 10);
      if (
        !['user', 'group'].includes(parameters.type) ||
        !Number.isSafeInteger(principalId) ||
        principalId <= 0
      )
        throw new runtime.ValidationError('Invalid collaborator');
      repositoryAdmin.removeGrant(
        repository,
        principal.userId,
        parameters.type as 'user' | 'group',
        principalId,
      );
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/repositories/:owner/:repository/activity',
    {
      schema: routeHelpers.apiContract('repositories', {
        authenticated: false,
        params: routeHelpers.repositoryParameters,
        response: routeHelpers.enhancementListResponse,
      }),
    },
    async (request, reply) => {
      const { repository } = apiRepository(request, 'repository:read', 'read');
      return reply.send({ items: enhancements.activity(repository.id) });
    },
  );

  app.get(
    '/api/v1/repositories/:owner/:repository/policies',
    {
      schema: routeHelpers.apiContract('repositories', {
        params: routeHelpers.repositoryParameters,
        response: routeHelpers.enhancementListResponse,
      }),
    },
    async (request, reply) => {
      const { repository } = apiRepository(request, 'repository:read', 'read');
      return reply.send({ items: enhancements.policies(repository.id) });
    },
  );

  app.get(
    '/api/v1/repositories/:owner/:repository/webhooks',
    {
      schema: routeHelpers.apiContract('repositories', {
        params: routeHelpers.repositoryParameters,
        response: routeHelpers.enhancementListResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:read', 'read');
      if (!principal) throw new runtime.AuthorizationError();
      repositories.require(repository, principal.userId, 'admin');
      return reply.send({ items: webhooks.list(repository.id) });
    },
  );

  app.post(
    '/api/v1/repositories/:owner/:repository/webhooks',
    {
      schema: routeHelpers.apiContract('repositories', {
        success: 201,
        params: routeHelpers.repositoryParameters,
        response: routeHelpers.enhancementMutationResponse,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['url', 'events'],
          properties: {
            url: { type: 'string', maxLength: 2048 },
            events: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string' } },
          },
        },
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      repositories.require(repository, principal.userId, 'admin');
      const body = request.body as { url: string; events: unknown };
      return reply
        .code(201)
        .send(webhooks.create(repository.id, principal.userId, body.url, body.events));
    },
  );

  app.delete(
    '/api/v1/repositories/:owner/:repository/webhooks/:webhookId',
    {
      schema: routeHelpers.apiContract('repositories', {
        success: 204,
        params: {
          ...routeHelpers.repositoryParameters,
          required: ['owner', 'repository', 'webhookId'],
          properties: {
            ...routeHelpers.repositoryParameters.properties,
            webhookId: { type: 'integer', minimum: 1 },
          },
        },
        response: routeHelpers.enhancementMutationResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      repositories.require(repository, principal.userId, 'admin');
      const id = Number((request.params as { webhookId: string }).webhookId);
      webhooks.remove(repository.id, principal.userId, id);
      return reply.code(204).send();
    },
  );

  app.put(
    '/api/v1/repositories/:owner/:repository/policies',
    {
      schema: routeHelpers.apiContract('repositories', {
        params: routeHelpers.repositoryParameters,
        response: routeHelpers.enhancementListResponse,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['refPattern'],
          properties: {
            refPattern: { type: 'string' },
            blockForcePush: { type: 'boolean' },
            blockDeletion: { type: 'boolean' },
            requireSignedCommits: { type: 'boolean' },
            commitMessagePrefix: { type: ['string', 'null'] },
          },
        },
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      const body = request.body as {
        refPattern: string;
        blockForcePush?: boolean;
        blockDeletion?: boolean;
        requireSignedCommits?: boolean;
        commitMessagePrefix?: string | null;
      };
      await enhancements.setPolicy(repository, principal.userId, {
        refPattern: body.refPattern,
        blockForcePush: body.blockForcePush ?? true,
        blockDeletion: body.blockDeletion ?? true,
        requireSignedCommits: body.requireSignedCommits ?? false,
        commitMessagePrefix: body.commitMessagePrefix ?? null,
      });
      return reply.send({ items: enhancements.policies(repository.id) });
    },
  );

  app.get(
    '/api/v1/repositories/:owner/:repository/deploy-keys',
    {
      schema: routeHelpers.apiContract('repositories', {
        params: routeHelpers.repositoryParameters,
        response: routeHelpers.enhancementListResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:read', 'read');
      if (!principal) throw new runtime.AuthorizationError();
      repositories.require(repository, principal.userId, 'admin');
      return reply.send({ items: enhancements.deployKeys(repository.id) });
    },
  );

  app.post(
    '/api/v1/repositories/:owner/:repository/deploy-keys',
    {
      schema: routeHelpers.apiContract('repositories', {
        success: 201,
        response: routeHelpers.enhancementMutationResponse,
        params: routeHelpers.repositoryParameters,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'publicKey'],
          properties: { name: { type: 'string' }, publicKey: { type: 'string' } },
        },
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      const body = request.body as { name: string; publicKey: string };
      const id = await enhancements.addDeployKey(
        repository,
        principal.userId,
        body.name,
        body.publicKey,
      );
      return reply.code(201).send({ id });
    },
  );

  app.get(
    '/api/v1/repositories/:owner/:repository/mirror',
    {
      schema: routeHelpers.apiContract('repositories', {
        params: routeHelpers.repositoryParameters,
        response: routeHelpers.mirrorResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:read', 'read');
      if (!principal) throw new runtime.AuthorizationError();
      repositories.require(repository, principal.userId, 'admin');
      return reply.send({ mirror: enhancements.mirror(repository.id) ?? null });
    },
  );

  app.put(
    '/api/v1/repositories/:owner/:repository/mirror',
    {
      schema: routeHelpers.apiContract('repositories', {
        params: routeHelpers.repositoryParameters,
        response: routeHelpers.mirrorResponse,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['direction', 'remoteUrl', 'intervalMinutes'],
          properties: {
            direction: { type: 'string', enum: ['pull', 'push'] },
            remoteUrl: { type: 'string' },
            intervalMinutes: { type: 'integer', minimum: 5, maximum: 10080 },
          },
        },
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      enhancements.configureMirror(
        repository,
        principal.userId,
        request.body as { direction: 'pull' | 'push'; remoteUrl: string; intervalMinutes: number },
      );
      return reply.send({ mirror: enhancements.mirror(repository.id) });
    },
  );

  app.put(
    '/api/v1/repositories/:owner/:repository/pin',
    {
      schema: routeHelpers.apiContract('repositories', {
        params: routeHelpers.repositoryParameters,
        response: routeHelpers.enhancementMutationResponse,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['pinned'],
          properties: { pinned: { type: 'boolean' } },
        },
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:read', 'read');
      if (!principal) throw new runtime.AuthorizationError();
      enhancements.pin(
        principal.userId,
        repository.id,
        (request.body as { pinned: boolean }).pinned,
      );
      return reply.send({ pinned: (request.body as { pinned: boolean }).pinned });
    },
  );

  app.delete(
    '/api/v1/repositories/:owner/:repository/policies',
    {
      schema: routeHelpers.apiContract('repositories', {
        success: 204,
        params: routeHelpers.repositoryParameters,
        response: routeHelpers.enhancementMutationResponse,
        query: {
          type: 'object',
          additionalProperties: false,
          required: ['refPattern'],
          properties: { refPattern: { type: 'string' } },
        },
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      await enhancements.removePolicy(
        repository,
        principal.userId,
        (request.query as { refPattern: string }).refPattern,
      );
      return reply.code(204).send();
    },
  );

  app.delete(
    '/api/v1/repositories/:owner/:repository/deploy-keys/:keyId',
    {
      schema: routeHelpers.apiContract('repositories', {
        success: 204,
        params: {
          type: 'object',
          required: ['owner', 'repository', 'keyId'],
          properties: {
            owner: { type: 'string' },
            repository: { type: 'string' },
            keyId: { type: 'integer', minimum: 1 },
          },
        },
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      enhancements.removeDeployKey(
        repository,
        principal.userId,
        Number((request.params as { keyId: string }).keyId),
      );
      return reply.code(204).send();
    },
  );

  app.delete(
    '/api/v1/repositories/:owner/:repository/mirror',
    {
      schema: routeHelpers.apiContract('repositories', {
        success: 204,
        params: routeHelpers.repositoryParameters,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      enhancements.removeMirror(repository, principal.userId);
      return reply.code(204).send();
    },
  );

  app.put(
    '/api/v1/repositories/:owner/:repository/template',
    {
      schema: routeHelpers.apiContract('repositories', {
        params: routeHelpers.repositoryParameters,
        response: routeHelpers.enhancementMutationResponse,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['enabled'],
          properties: { enabled: { type: 'boolean' } },
        },
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new runtime.AuthorizationError();
      const enabled = (request.body as { enabled: boolean }).enabled;
      enhancements.setTemplate(repository, principal.userId, enabled);
      return reply.send({ enabled });
    },
  );
}
