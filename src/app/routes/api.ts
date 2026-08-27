import type { AppRouteContext } from './route-context.js';
import * as routeHelpers from './route-helpers.js';
import * as runtime from './route-runtime.js';

export function registerApiRoutes(context: AppRouteContext): void {
  const {
    app,
    config,
    database,
    runtimeSettings,
    auth,
    tokens,
    passkeys,
    invites,
    sshKeys,
    git,
    repositories,
    browser,
    enhancements,
    mutations,
    repositoryAdmin,
    groups,
    search,
    pluginManager,
    pluginContributions,
    administration,
    apiPrincipal,
    requireAdminPrincipal,
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

  app.get(
    '/api/v1/user/profile',
    { schema: routeHelpers.apiContract('users', { response: runtime.profileResponse }) },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:read');
      if (!principal) throw new runtime.AuthorizationError();
      return reply.send(auth.profile(principal.userId));
    },
  );

  app.patch(
    '/api/v1/user/profile',
    {
      schema: routeHelpers.apiContract('users', {
        body: routeHelpers.profileUpdateBody,
        response: runtime.profileResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new runtime.AuthorizationError();
      const existing = auth.profile(principal.userId);
      const body = request.body as {
        displayName?: string;
        email?: string;
        emailPublic?: boolean;
      };
      auth.updateProfile(principal.userId, {
        displayName: body.displayName ?? existing.displayName,
        email: body.email ?? existing.email ?? '',
        emailPublic: body.emailPublic ?? existing.emailPublic,
      });
      return reply.send(auth.profile(principal.userId));
    },
  );

  app.get(
    '/api/v1/user/appearance',
    { schema: routeHelpers.apiContract('users', { response: runtime.appearanceResponse }) },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:read');
      if (!principal) throw new runtime.AuthorizationError();
      return reply.send(auth.appearance(principal.userId));
    },
  );

  app.put(
    '/api/v1/user/appearance',
    {
      schema: routeHelpers.apiContract('users', {
        body: routeHelpers.appearanceUpdateBody,
        response: runtime.appearanceResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new runtime.AuthorizationError();
      const body = request.body as {
        theme: string;
        accent: string;
        uiFont: string;
        codeFont: string;
        reducedMotion: boolean;
        pluginTheme?: string | null;
      };
      if (body.pluginTheme && !pluginContributions.theme(body.pluginTheme))
        throw new runtime.ValidationError('Selected plugin theme is unavailable');
      auth.setAppearance(principal.userId, {
        ...body,
        pluginTheme: body.pluginTheme === '' ? null : (body.pluginTheme ?? null),
      });
      return reply.send(auth.appearance(principal.userId));
    },
  );

  app.get(
    '/api/v1/user/sessions',
    { schema: routeHelpers.apiContract('credentials', { response: runtime.sessionListResponse }) },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:read');
      if (!principal) throw new runtime.AuthorizationError();
      return reply.send({ items: auth.sessions(principal.userId) });
    },
  );

  app.delete(
    '/api/v1/user/sessions',
    { schema: routeHelpers.apiContract('credentials', { success: 204 }) },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new runtime.AuthorizationError();
      auth.revokeUserSessions(principal.userId);
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/user/passkeys',
    { schema: routeHelpers.apiContract('credentials', { response: runtime.passkeyListResponse }) },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:read');
      if (!principal) throw new runtime.AuthorizationError();
      return reply.send({ items: passkeys.list(principal.userId) });
    },
  );

  app.patch(
    '/api/v1/user/passkeys/:passkeyId',
    {
      schema: routeHelpers.apiContract('credentials', {
        params: routeHelpers.stringPathParameters('passkeyId'),
        body: routeHelpers.passkeyRenameBody,
        response: runtime.passkeyListResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new runtime.AuthorizationError();
      passkeys.rename(
        principal.userId,
        (request.params as { passkeyId: string }).passkeyId,
        (request.body as { name: string }).name,
      );
      return reply.send({ items: passkeys.list(principal.userId) });
    },
  );

  app.delete(
    '/api/v1/user/passkeys/:passkeyId',
    {
      schema: routeHelpers.apiContract('credentials', {
        success: 204,
        params: routeHelpers.stringPathParameters('passkeyId'),
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new runtime.AuthorizationError();
      passkeys.remove(principal.userId, (request.params as { passkeyId: string }).passkeyId);
      auth.revokeUserSessions(principal.userId);
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/user/repository-transfers',
    {
      schema: routeHelpers.apiContract('repositories', {
        response: runtime.repositoryTransferListResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:read');
      if (!principal) throw new runtime.AuthorizationError();
      return reply.send({ items: repositoryAdmin.pendingTransfers(principal.userId) });
    },
  );

  app.post(
    '/api/v1/user/repository-transfers/:repositoryId',
    {
      schema: routeHelpers.apiContract('repositories', {
        params: routeHelpers.stringPathParameters('repositoryId'),
        body: routeHelpers.repositoryTransferDecisionBody,
        response: runtime.okResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new runtime.AuthorizationError();
      const repositoryId = Number.parseInt(
        (request.params as { repositoryId: string }).repositoryId,
        10,
      );
      if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0)
        throw new runtime.ValidationError('Invalid repository transfer');
      const updated = repositoryAdmin.resolveTransfer(
        repositoryId,
        principal.userId,
        (request.body as { accept: boolean }).accept,
      );
      if (updated) search.enqueue(updated.id);
      return reply.send({ ok: true });
    },
  );

  app.get(
    '/api/v1/user/tokens',
    { schema: routeHelpers.apiContract('credentials', { response: runtime.tokenListResponse }) },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:read');
      if (!principal) throw new runtime.AuthorizationError();
      return reply.send({ items: tokens.list(principal.userId) });
    },
  );

  app.post(
    '/api/v1/user/tokens',
    {
      schema: routeHelpers.apiContract('credentials', {
        success: 201,
        body: routeHelpers.tokenCreateBody,
        response: runtime.tokenCreatedResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new runtime.AuthorizationError();
      const body = request.body as { name: string; scopes: string[]; expiresAt?: string };
      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : undefined;
      if (expiresAt && !Number.isFinite(expiresAt.getTime()))
        throw new runtime.ValidationError('Token expiration is invalid');
      return reply.code(201).send({
        token: tokens.create({
          userId: principal.userId,
          name: body.name,
          scopes: body.scopes,
          ...(expiresAt ? { expiresAt } : {}),
        }),
      });
    },
  );

  app.delete(
    '/api/v1/user/tokens/:tokenId',
    {
      schema: routeHelpers.apiContract('credentials', {
        success: 204,
        params: routeHelpers.stringPathParameters('tokenId'),
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new runtime.AuthorizationError();
      const tokenId = Number.parseInt((request.params as { tokenId: string }).tokenId, 10);
      if (!Number.isSafeInteger(tokenId) || tokenId <= 0)
        throw new runtime.ValidationError('Invalid token ID');
      tokens.revoke(principal.userId, tokenId);
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/user/ssh-keys',
    { schema: routeHelpers.apiContract('credentials', { response: runtime.sshKeyListResponse }) },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:read');
      if (!principal) throw new runtime.AuthorizationError();
      return reply.send({ items: sshKeys.list(principal.userId) });
    },
  );

  app.post(
    '/api/v1/user/ssh-keys',
    {
      schema: routeHelpers.apiContract('credentials', {
        success: 201,
        body: routeHelpers.sshKeyCreateBody,
        response: runtime.sshKeyResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new runtime.AuthorizationError();
      const body = request.body as { name: string; publicKey: string };
      return reply.code(201).send(await sshKeys.add(principal.userId, body.name, body.publicKey));
    },
  );

  app.delete(
    '/api/v1/user/ssh-keys/:keyId',
    {
      schema: routeHelpers.apiContract('credentials', {
        success: 204,
        params: routeHelpers.stringPathParameters('keyId'),
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new runtime.AuthorizationError();
      const keyId = Number.parseInt((request.params as { keyId: string }).keyId, 10);
      if (!Number.isSafeInteger(keyId) || keyId <= 0)
        throw new runtime.ValidationError('Invalid SSH key ID');
      sshKeys.remove(principal.userId, keyId);
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/users/:username',
    {
      schema: routeHelpers.apiContract('users', {
        params: routeHelpers.stringPathParameters('username'),
        response: runtime.userResponse,
      }),
    },
    async (request, reply) => {
      if (!apiPrincipal(request, 'api:read')) throw new runtime.AuthorizationError();
      const row = database
        .prepare(
          "SELECT username, display_name AS displayName, created_at AS createdAt FROM users WHERE username = ? AND status = 'active'",
        )
        .get((request.params as { username: string }).username.toLowerCase());
      if (!row) throw new runtime.NotFoundError();
      return reply.send(row);
    },
  );

  app.get(
    '/api/v1/groups',
    {
      schema: routeHelpers.apiContract('groups', {
        response: runtime.groupListResponse,
        query: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1 },
            perPage: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:read');
      if (!principal) throw new runtime.AuthorizationError();
      const query = request.query as { page?: string; perPage?: string };
      const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
      const perPage = Math.min(100, Math.max(1, Number.parseInt(query.perPage ?? '30', 10) || 30));
      const all = groups.listForUser(principal.userId);
      return reply.send({
        items: all.slice((page - 1) * perPage, page * perPage),
        pagination: { page, perPage, total: all.length, hasMore: page * perPage < all.length },
      });
    },
  );

  app.post(
    '/api/v1/groups',
    {
      schema: routeHelpers.apiContract('groups', {
        success: 201,
        body: routeHelpers.groupCreateBody,
        response: runtime.idResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new runtime.AuthorizationError();
      const body = request.body as { slug?: unknown; displayName?: unknown };
      if (typeof body.slug !== 'string' || typeof body.displayName !== 'string')
        throw new runtime.ValidationError('slug and displayName are required');
      return reply
        .code(201)
        .send({ id: groups.create(principal.userId, body.slug, body.displayName) });
    },
  );

  app.get(
    '/api/v1/groups/:group',
    {
      schema: routeHelpers.apiContract('groups', {
        params: routeHelpers.stringPathParameters('group'),
        response: runtime.groupResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:read');
      if (!principal) throw new runtime.AuthorizationError();
      return reply.send(
        groups.getBySlug((request.params as { group: string }).group, principal.userId),
      );
    },
  );

  app.put(
    '/api/v1/groups/:group/members',
    {
      schema: routeHelpers.apiContract('groups', {
        params: routeHelpers.stringPathParameters('group'),
        body: routeHelpers.groupMemberBody,
        response: runtime.okResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new runtime.AuthorizationError();
      const group = groups.getBySlug((request.params as { group: string }).group, principal.userId);
      const body = request.body as { username?: unknown; role?: unknown };
      if (
        typeof body.username !== 'string' ||
        !['member', 'manager', 'owner'].includes(typeof body.role === 'string' ? body.role : '')
      )
        throw new runtime.ValidationError('username and a valid role are required');
      groups.addMember(
        principal.userId,
        group.id,
        body.username,
        body.role as 'member' | 'manager' | 'owner',
      );
      return reply.send({ ok: true });
    },
  );

  app.delete(
    '/api/v1/groups/:group/members/:userId',
    {
      schema: routeHelpers.apiContract('groups', {
        success: 204,
        params: routeHelpers.stringPathParameters('group', 'userId'),
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new runtime.AuthorizationError();
      const parameters = request.params as { group: string; userId: string };
      const group = groups.getBySlug(parameters.group, principal.userId);
      const userId = Number.parseInt(parameters.userId, 10);
      if (!Number.isSafeInteger(userId) || userId <= 0)
        throw new runtime.ValidationError('Invalid user ID');
      groups.removeMember(principal.userId, group.id, userId);
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/administration/system',
    {
      schema: routeHelpers.apiContract('administration', {
        response: runtime.administrationSystemResponse,
      }),
    },
    async (request, reply) => {
      requireAdminPrincipal(request);
      return reply.send({
        version: runtime.product.version,
        counts: administration.counts(),
        database: { journalMode: database.pragma('journal_mode', { simple: true }) },
        git: {
          executable: config.git.executable,
          version: (await git.run(['--version'])).stdout.toString('utf8').trim(),
        },
      });
    },
  );

  app.get(
    '/api/v1/administration/users',
    {
      schema: routeHelpers.apiContract('administration', {
        response: runtime.paginatedAdminUsersResponse,
        query: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1 },
            perPage: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      }),
    },
    async (request, reply) => {
      requireAdminPrincipal(request);
      const query = request.query as { page?: string; perPage?: string };
      const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
      const perPage = Math.min(100, Math.max(1, Number.parseInt(query.perPage ?? '30', 10) || 30));
      const all = administration.users();
      return reply.send({
        items: all.slice((page - 1) * perPage, page * perPage),
        pagination: { page, perPage, total: all.length, hasMore: page * perPage < all.length },
      });
    },
  );

  app.patch(
    '/api/v1/administration/users/:userId',
    {
      schema: routeHelpers.apiContract('administration', {
        params: routeHelpers.stringPathParameters('userId'),
        body: routeHelpers.administrationUserBody,
        response: runtime.okResponse,
      }),
    },
    async (request, reply) => {
      const principal = requireAdminPrincipal(request);
      const userId = Number.parseInt((request.params as { userId: string }).userId, 10);
      if (!Number.isSafeInteger(userId) || userId <= 0)
        throw new runtime.ValidationError('Invalid user ID');
      const body = request.body as { status?: unknown; administrator?: unknown };
      if (body.status !== undefined) {
        if (body.status !== 'active' && body.status !== 'disabled')
          throw new runtime.ValidationError('Invalid account status');
        administration.setUserStatus(principal.userId, userId, body.status);
      }
      if (body.administrator !== undefined) {
        if (typeof body.administrator !== 'boolean')
          throw new runtime.ValidationError('administrator must be boolean');
        administration.setAdministrator(principal.userId, userId, body.administrator);
      }
      return reply.send({ ok: true });
    },
  );

  app.get(
    '/api/v1/administration/repositories',
    {
      schema: routeHelpers.apiContract('administration', {
        response: runtime.paginatedAdminRepositoriesResponse,
        query: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1 },
            perPage: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      }),
    },
    async (request, reply) => {
      requireAdminPrincipal(request);
      const query = request.query as { page?: string; perPage?: string };
      const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
      const perPage = Math.min(100, Math.max(1, Number.parseInt(query.perPage ?? '30', 10) || 30));
      const all = administration.repositories();
      return reply.send({
        items: all.slice((page - 1) * perPage, page * perPage),
        pagination: { page, perPage, total: all.length, hasMore: page * perPage < all.length },
      });
    },
  );

  app.get(
    '/api/v1/administration/audit-events',
    {
      schema: routeHelpers.apiContract('administration', {
        response: runtime.paginatedAuditResponse,
        query: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1 },
            perPage: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
      }),
    },
    async (request, reply) => {
      requireAdminPrincipal(request);
      const query = request.query as { page?: string; perPage?: string };
      const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
      const perPage = Math.min(
        200,
        Math.max(1, Number.parseInt(query.perPage ?? '100', 10) || 100),
      );
      const items = administration.auditEvents(perPage, (page - 1) * perPage);
      return reply.send({
        items,
        pagination: { page, perPage, hasMore: items.length === perPage },
      });
    },
  );

  const pluginJson = (plugin: ReturnType<runtime.PluginManager['get']>) => ({
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    runtime: plugin.runtime,
    sourceType: plugin.sourceType,
    sourceValue: plugin.sourceValue,
    packageDigest: plugin.packageDigest,
    enabled: plugin.enabled,
    error: plugin.error,
    permissions: plugin.permissions,
  });

  app.get(
    '/api/v1/administration/plugins',
    {
      schema: routeHelpers.apiContract('administration', { response: runtime.pluginListResponse }),
    },
    async (request, reply) => {
      requireAdminPrincipal(request);
      return reply.send({ items: pluginManager.list().map(pluginJson) });
    },
  );

  app.get(
    '/api/v1/administration/search',
    {
      schema: routeHelpers.apiContract('administration', {
        response: runtime.searchStatusResponse,
      }),
    },
    async (request, reply) => {
      requireAdminPrincipal(request);
      return reply.send(search.status());
    },
  );

  app.post(
    '/api/v1/administration/search/rebuild',
    { schema: routeHelpers.apiContract('administration', { response: runtime.rebuildResponse }) },
    async (request, reply) => {
      requireAdminPrincipal(request);
      return reply.send({ repositories: await search.rebuildAll() });
    },
  );

  app.get(
    '/api/v1/administration/settings',
    {
      schema: routeHelpers.apiContract('administration', {
        response: runtime.runtimeSettingsResponse,
      }),
    },
    async (request, reply) => {
      requireAdminPrincipal(request);
      return reply.send(runtimeSettings.load());
    },
  );

  app.get(
    '/api/v1/administration/trusted-signers',
    {
      schema: routeHelpers.apiContract('administration', {
        response: routeHelpers.enhancementListResponse,
      }),
    },
    async (request, reply) => {
      requireAdminPrincipal(request);
      return reply.send({
        items: database
          .prepare(
            `SELECT fingerprint,identity,key_type AS keyType,created_at AS createdAt FROM trusted_signers WHERE revoked_at IS NULL ORDER BY identity`,
          )
          .all(),
      });
    },
  );

  app.post(
    '/api/v1/administration/trusted-signers',
    {
      schema: routeHelpers.apiContract('administration', {
        success: 201,
        response: routeHelpers.enhancementMutationResponse,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['fingerprint', 'identity', 'keyType'],
          properties: {
            fingerprint: { type: 'string' },
            identity: { type: 'string' },
            keyType: { type: 'string', enum: ['openpgp', 'ssh'] },
            publicKey: { type: 'string' },
          },
        },
      }),
    },
    async (request, reply) => {
      const principal = requireAdminPrincipal(request);
      enhancements.addTrustedSigner(
        principal.userId,
        request.body as {
          fingerprint: string;
          identity: string;
          keyType: 'openpgp' | 'ssh';
          publicKey?: string;
        },
      );
      return reply.code(201).send({ created: true });
    },
  );

  app.delete(
    '/api/v1/administration/trusted-signers/:fingerprint',
    {
      schema: routeHelpers.apiContract('administration', {
        success: 204,
        params: {
          type: 'object',
          required: ['fingerprint'],
          properties: { fingerprint: { type: 'string' } },
        },
      }),
    },
    async (request, reply) => {
      const principal = requireAdminPrincipal(request);
      enhancements.revokeTrustedSigner(
        principal.userId,
        (request.params as { fingerprint: string }).fingerprint,
      );
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/administration/backup-destinations',
    {
      schema: routeHelpers.apiContract('administration', {
        response: routeHelpers.enhancementListResponse,
      }),
    },
    async (request, reply) => {
      requireAdminPrincipal(request);
      return reply.send({ items: new runtime.BackupDestinationService(database, config).list() });
    },
  );

  app.post(
    '/api/v1/administration/backup-destinations',
    {
      schema: routeHelpers.apiContract('administration', {
        success: 201,
        response: routeHelpers.enhancementMutationResponse,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'endpoint', 'region', 'bucket', 'accessKey', 'secretKey'],
          properties: {
            name: { type: 'string' },
            endpoint: { type: 'string' },
            region: { type: 'string' },
            bucket: { type: 'string' },
            prefix: { type: 'string' },
            accessKey: { type: 'string' },
            secretKey: { type: 'string' },
          },
        },
      }),
    },
    async (request, reply) => {
      const principal = requireAdminPrincipal(request);
      new runtime.BackupDestinationService(database, config).save(principal.userId, {
        ...(request.body as {
          name: string;
          endpoint: string;
          region: string;
          bucket: string;
          prefix?: string;
          accessKey: string;
          secretKey: string;
        }),
        prefix: (request.body as { prefix?: string }).prefix ?? '',
      });
      return reply.code(201).send({ created: true });
    },
  );

  app.put(
    '/api/v1/administration/settings',
    {
      schema: routeHelpers.apiContract('administration', {
        body: routeHelpers.runtimeSettingsBody,
        response: runtime.runtimeSettingsResponse,
      }),
    },
    async (request, reply) => {
      const principal = requireAdminPrincipal(request);
      return reply.send(
        runtimeSettings.update(principal.userId, request.body as runtime.RuntimeSettings),
      );
    },
  );

  app.get(
    '/api/v1/administration/invites',
    {
      schema: routeHelpers.apiContract('administration', { response: runtime.inviteListResponse }),
    },
    async (request, reply) => {
      requireAdminPrincipal(request);
      return reply.send({ items: invites.list() });
    },
  );

  app.post(
    '/api/v1/administration/invites',
    {
      schema: routeHelpers.apiContract('administration', {
        success: 201,
        body: routeHelpers.inviteCreateBody,
        response: runtime.inviteCreatedResponse,
      }),
    },
    async (request, reply) => {
      const principal = requireAdminPrincipal(request);
      const body = request.body as { expiresInDays?: number };
      return reply.code(201).send({
        token: invites.create(principal.userId, body.expiresInDays ?? 7),
      });
    },
  );

  app.delete(
    '/api/v1/administration/invites/:inviteId',
    {
      schema: routeHelpers.apiContract('administration', {
        success: 204,
        params: routeHelpers.stringPathParameters('inviteId'),
      }),
    },
    async (request, reply) => {
      const principal = requireAdminPrincipal(request);
      const inviteId = Number.parseInt((request.params as { inviteId: string }).inviteId, 10);
      if (!Number.isSafeInteger(inviteId) || inviteId <= 0)
        throw new runtime.ValidationError('Invalid invite ID');
      invites.revoke(principal.userId, inviteId);
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/administration/plugins/:pluginId',
    {
      schema: routeHelpers.apiContract('administration', {
        params: routeHelpers.stringPathParameters('pluginId'),
        response: runtime.pluginResponse,
      }),
    },
    async (request, reply) => {
      requireAdminPrincipal(request);
      return reply.send(
        pluginJson(pluginManager.get((request.params as { pluginId: string }).pluginId)),
      );
    },
  );

  app.get(
    '/api/v1/administration/plugins/:pluginId/settings',
    {
      schema: routeHelpers.apiContract('administration', {
        params: routeHelpers.stringPathParameters('pluginId'),
        response: runtime.pluginSettingsResponse,
      }),
    },
    async (request, reply) => {
      requireAdminPrincipal(request);
      const pluginId = (request.params as { pluginId: string }).pluginId;
      const plugin = pluginManager.get(pluginId);
      const values = pluginManager.settingsView(pluginId);
      return reply.send({
        items: Object.entries(plugin.manifest.settings).map(([key, setting]) => ({
          key,
          type: setting.type,
          title: setting.title,
          configured: values[key]?.configured ?? false,
          value: values[key]?.value ?? null,
        })),
      });
    },
  );

  app.put(
    '/api/v1/administration/plugins/:pluginId/settings',
    {
      schema: routeHelpers.apiContract('administration', {
        params: routeHelpers.stringPathParameters('pluginId'),
        body: routeHelpers.pluginSettingsBody,
        response: runtime.pluginSettingsResponse,
      }),
    },
    async (request, reply) => {
      const principal = requireAdminPrincipal(request);
      const pluginId = (request.params as { pluginId: string }).pluginId;
      const values = (request.body as { values: { key: string; value: unknown }[] }).values;
      for (const entry of values)
        pluginManager.setSetting(principal.userId, pluginId, entry.key, entry.value);
      const plugin = pluginManager.get(pluginId);
      const current = pluginManager.settingsView(pluginId);
      return reply.send({
        items: Object.entries(plugin.manifest.settings).map(([key, setting]) => ({
          key,
          type: setting.type,
          title: setting.title,
          configured: current[key]?.configured ?? false,
          value: current[key]?.value ?? null,
        })),
      });
    },
  );

  app.patch(
    '/api/v1/administration/plugins/:pluginId',
    {
      schema: routeHelpers.apiContract('administration', {
        params: routeHelpers.stringPathParameters('pluginId'),
        body: routeHelpers.pluginStateBody,
        response: runtime.pluginResponse,
      }),
    },
    async (request, reply) => {
      const principal = requireAdminPrincipal(request);
      const pluginId = (request.params as { pluginId: string }).pluginId;
      const body = request.body as { enabled: boolean; trustedRiskAccepted?: boolean };
      pluginManager.setEnabled(
        principal.userId,
        pluginId,
        body.enabled,
        body.trustedRiskAccepted === true,
      );
      return reply.send(pluginJson(pluginManager.get(pluginId)));
    },
  );

  app.put(
    '/api/v1/administration/plugins/:pluginId/permissions/:capability',
    {
      schema: routeHelpers.apiContract('administration', {
        params: routeHelpers.stringPathParameters('pluginId', 'capability'),
        body: routeHelpers.pluginPermissionBody,
        response: runtime.pluginResponse,
      }),
    },
    async (request, reply) => {
      const principal = requireAdminPrincipal(request);
      const parameters = request.params as { pluginId: string; capability: string };
      const body = request.body as { granted: boolean };
      pluginManager.setPermission(
        principal.userId,
        parameters.pluginId,
        parameters.capability,
        body.granted,
      );
      return reply.send(pluginJson(pluginManager.get(parameters.pluginId)));
    },
  );

  app.delete(
    '/api/v1/administration/plugins/:pluginId',
    {
      schema: routeHelpers.apiContract('administration', {
        success: 204,
        params: routeHelpers.stringPathParameters('pluginId'),
        query: {
          type: 'object',
          additionalProperties: false,
          properties: { keepData: { type: 'boolean' } },
        },
      }),
    },
    async (request, reply) => {
      const principal = requireAdminPrincipal(request);
      await pluginManager.remove(
        principal.userId,
        (request.params as { pluginId: string }).pluginId,
        (request.query as { keepData?: boolean }).keepData === true,
      );
      return reply.code(204).send();
    },
  );

  app.route({
    method: ['GET', 'POST'],
    url: '/api/v1/plugins/:pluginId/:endpointId',
    schema: {
      tags: ['plugins'],
      security: [{ bearerToken: [] }],
      params: {
        type: 'object',
        required: ['pluginId', 'endpointId'],
        properties: { pluginId: { type: 'string' }, endpointId: { type: 'string' } },
      },
      response: { 200: {} },
    },
    handler: async (request, reply) => {
      const principal = apiPrincipal(request, request.method === 'GET' ? 'api:read' : 'api:write');
      if (!principal) throw new runtime.AuthorizationError();
      const account = database
        .prepare("SELECT username FROM users WHERE id = ? AND status = 'active'")
        .get(principal.userId) as { username: string } | undefined;
      if (!account) throw new runtime.AuthorizationError();
      const parameters = request.params as { pluginId: string; endpointId: string };
      const response = await pluginContributions.runRestEndpoint(
        parameters.pluginId,
        parameters.endpointId,
        request.method,
        {
          user: { id: String(principal.userId), username: account.username },
          body: request.method === 'POST' ? request.body : null,
        },
      );
      return reply.send(response);
    },
  });
}
