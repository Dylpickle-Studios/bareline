import type { AppRouteContext } from './route-context.js';
import * as routeHelpers from './route-helpers.js';
import * as runtime from './route-runtime.js';

// User, group, credential, and transfer API routes.
export function registerApiAccountRoutes(context: AppRouteContext): void {
  const {
    app,
    database,
    auth,
    tokens,
    passkeys,
    sshKeys,
    repositoryAdmin,
    groups,
    search,
    pluginContributions,
    apiPrincipal,
  } = context;
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
}
