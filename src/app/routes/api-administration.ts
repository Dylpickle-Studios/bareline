import type { AppRouteContext } from './route-context.js';
import * as routeHelpers from './route-helpers.js';
import * as runtime from './route-runtime.js';

// Administrative and plugin API routes.
export function registerApiAdministrationRoutes(context: AppRouteContext): void {
  const {
    app,
    config,
    database,
    runtimeSettings,
    invites,
    git,
    enhancements,
    search,
    pluginManager,
    pluginContributions,
    administration,
    apiPrincipal,
    requireAdminPrincipal,
  } = context;
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
