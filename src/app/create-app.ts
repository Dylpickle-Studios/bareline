import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { AuditService } from '../audit/audit-service.js';
import { AdminService } from '../admin/admin-service.js';
import { RuntimeSettingsService } from '../admin/runtime-settings-service.js';
import { product } from './metadata.js';
import { AuthService, CsrfError } from '../auth/auth-service.js';
import { TokenService } from '../auth/token-service.js';
import { PasskeyService } from '../auth/passkey-service.js';
import { ExternalAuthService } from '../auth/external-auth-service.js';
import { RecoveryService } from '../auth/recovery-service.js';
import { InviteService } from '../auth/invite-service.js';
import type { AppConfig } from '../config/config.js';
import { openDatabase } from '../database/database.js';
import { GitRunner } from '../git/git-runner.js';
import { ArchiveService } from '../git/archive-service.js';
import { GitBrowser } from '../git/git-browser.js';
import { GroupService } from '../groups/group-service.js';
import { LfsService } from '../lfs/lfs-service.js';
import { PluginManager } from '../plugins/plugin-manager.js';
import { PluginContributionService } from '../plugins/contribution-service.js';
import { PluginEventService } from '../plugins/event-service.js';
import { SandboxRuntime } from '../plugins/sandbox-runtime.js';
import { SshKeyService } from '../ssh/ssh-key-service.js';
import {
  AuthorizationError,
  NotFoundError,
  PayloadTooLargeError,
  RepositoryService,
} from '../repositories/repository-service.js';
import { RepositoryMutationService } from '../repositories/repository-mutation-service.js';
import { RepositoryEnhancementService } from '../repositories/repository-enhancement-service.js';
import { RepositoryAdminService } from '../repositories/repository-admin-service.js';
import { SearchService } from '../search/search-service.js';
import { MetricsRegistry } from '../observability/metrics.js';
import { render as renderView } from '../web/render.js';
import type { AppRouteContext } from './routes/route-context.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerApiRoutes } from './routes/api.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCoreRoutes } from './routes/core.js';
import { registerGitRoutes } from './routes/git.js';
import { registerNavigationRoutes } from './routes/navigation.js';
import { registerPluginsRoutes } from './routes/plugins.js';
import { registerRepositoryHtmlRoutes } from './routes/repositoryHtml.js';
import { registerHealthRoutes } from './routes/health.js';

export async function createApp(config: AppConfig): Promise<FastifyInstance> {
  await Promise.all([
    mkdir(config.storage.data, { recursive: true, mode: 0o750 }),
    mkdir(config.storage.repositories, { recursive: true, mode: 0o750 }),
    mkdir(config.storage.trash, { recursive: true, mode: 0o750 }),
    mkdir(config.storage.lfs, { recursive: true, mode: 0o750 }),
  ]);
  const database = openDatabase(config.database.path);
  const publicAvatarByEmail = database.prepare(
    `SELECT username FROM users
     WHERE status = 'active' AND email_public = 1 AND avatar IS NOT NULL
       AND lower(email) = lower(?)
     LIMIT 1`,
  );
  const withAuthorAvatar = <T extends { authorEmail: string }>(commit: T) => {
    const account = publicAvatarByEmail.get(commit.authorEmail) as { username: string } | undefined;
    return { ...commit, avatarUrl: account ? `/avatars/${account.username}` : null };
  };
  const audit = new AuditService(database);
  const runtimeSettings = new RuntimeSettingsService(database, config, audit);
  runtimeSettings.load();
  const auth = new AuthService(database, config, audit);
  const tokens = new TokenService(database, audit);
  const passkeys = new PasskeyService(database, config, audit);
  const externalAuth = new ExternalAuthService(database, config, auth);
  const recovery = new RecoveryService(database, audit);
  const invites = new InviteService(database, audit);
  const sshKeys = new SshKeyService(database, audit);
  const git = new GitRunner(
    config.git.executable,
    config.git.timeoutMs,
    config.limits.gitOutputBytes,
    {
      maxConcurrent: config.limits.gitConcurrent,
      maxPending: config.limits.gitPending,
      maxInputBytes: config.limits.gitInputBytes,
    },
  );
  const repositories = new RepositoryService(database, git, config, audit);
  const browser = new GitBrowser(git, repositories, config);
  const referenceOptions = async (repository: ReturnType<RepositoryService['getById']>) => ({
    branches: await browser.branches(repository),
    tags: await browser.tags(repository),
  });
  const archives = new ArchiveService(config, repositories);
  const enhancements = new RepositoryEnhancementService(
    database,
    git,
    repositories,
    audit,
    config.mirrors?.allowedHosts ?? [],
  );
  const mutations = new RepositoryMutationService(
    database,
    git,
    repositories,
    config,
    audit,
    enhancements,
  );
  const repositoryAdmin = new RepositoryAdminService(database, repositories, config, audit);
  const groups = new GroupService(database, audit);
  const search = new SearchService(database, git, repositories, browser, config);
  const lfs = new LfsService(database, config);
  const pluginManager = new PluginManager(database, config, audit);
  const pluginContributions = new PluginContributionService(
    pluginManager,
    new SandboxRuntime(database),
    repositories,
  );
  const pluginEvents = new PluginEventService(database, pluginManager, pluginContributions);
  const render = (view: string, data: Record<string, unknown>) => {
    const account = data.user as { pluginTheme?: string | null } | null | undefined;
    const selectedTheme = account?.pluginTheme
      ? pluginContributions.theme(account.pluginTheme)
      : null;
    return renderView(view, {
      ...data,
      pluginNavigation: pluginContributions.navigation(),
      pluginThemeUrl: selectedTheme
        ? `/plugin-themes/${encodeURIComponent(selectedTheme.pluginId)}/${encodeURIComponent(selectedTheme.id)}.css`
        : null,
    });
  };
  const publishRepositoryEvent = (
    event: Parameters<typeof pluginEvents.publish>[0],
    payload: Readonly<Record<string, unknown>>,
  ) => {
    pluginEvents.publish(event, payload);
  };
  repositories.setEventPublisher(publishRepositoryEvent);
  repositoryAdmin.setEventPublisher(publishRepositoryEvent);
  mutations.setEventPublisher(publishRepositoryEvent);
  const administration = new AdminService(database, audit);
  const metrics = new MetricsRegistry();
  let closing = false;
  const app = Fastify({
    ...(config.server.tls.mode === 'native'
      ? {
          https: {
            cert: readFileSync(config.server.tls.certificate),
            key: readFileSync(config.server.tls.privateKey),
            minVersion: 'TLSv1.2' as const,
          },
        }
      : {}),
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.token',
        '*.secret',
      ],
    },
    bodyLimit: config.limits.requestBodyBytes,
    // Never trust a client-supplied correlation value. Generate an opaque ID at the application
    // boundary and expose only that value in logs, responses, and audit records.
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    trustProxy: config.server.tls.mode === 'proxy' ? ['127.0.0.1', '::1'] : false,
  });

  const requestStarts = new WeakMap<FastifyRequest, number>();
  app.addHook('onRequest', (request, reply, done) => {
    requestStarts.set(request, performance.now());
    reply.header('x-request-id', request.id);
    done();
  });
  app.addHook('onResponse', async (request, reply) => {
    const durationSeconds = Math.max(
      0,
      (performance.now() - (requestStarts.get(request) ?? performance.now())) / 1000,
    );
    const route = request.routeOptions.url ?? 'unknown';
    const status = String(reply.statusCode);
    metrics.increment('http_requests_total', { method: request.method, route, status });
    metrics.observe('http_request_duration_seconds', durationSeconds, {
      method: request.method,
      route,
    });
    if (status === '401' || status === '403') {
      metrics.increment('auth_failures_total', { route, status });
    }
    if (route.includes('.git/') || route.includes('/archive')) {
      metrics.increment('git_operations_total', { route, status });
      metrics.observe('git_operation_duration_seconds', durationSeconds, { route });
    }
    if (route.includes('/plugins')) {
      metrics.increment('plugin_executions_total', { route, status });
      metrics.observe('plugin_execution_duration_seconds', durationSeconds, { route });
    }
    if (route.includes('backup')) {
      metrics.increment('backup_operations_total', { route, status });
      metrics.observe('backup_operation_duration_seconds', durationSeconds, { route });
    }
  });

  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, {
    limits: {
      fileSize: Math.max(config.limits.filePreviewBytes, 16 * 1024 * 1024),
      files: 100,
      fields: 20,
      parts: 120,
    },
  });
  app.addContentTypeParser(/^application\/x-git-[a-z-]+-request$/, (request, payload, done) => {
    void request;
    done(null, payload);
  });
  app.addContentTypeParser('application/octet-stream', (request, payload, done) => {
    void request;
    done(null, payload);
  });
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
    },
  });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(swagger, {
    openapi: {
      info: { title: `${product.name} API`, version: product.version },
      components: {
        securitySchemes: {
          bearerToken: { type: 'http', scheme: 'bearer', bearerFormat: 'personal access token' },
          cookieSession: { type: 'apiKey', in: 'cookie', name: 'session' },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });
  await app.register(staticFiles, {
    root: join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'assets'),
    prefix: '/assets/',
    immutable: process.env.NODE_ENV === 'production',
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  });

  const searchTimer = setInterval(() => {
    void search.processNext().catch((error: unknown) => {
      app.log.error({ err: error }, 'search worker failed');
    });
  }, 2000);
  searchTimer.unref();
  const pluginEventTimer = setInterval(() => {
    void pluginEvents.processNext().catch((error: unknown) => {
      app.log.error({ err: error }, 'plugin event worker failed');
    });
  }, 1000);
  pluginEventTimer.unref();
  const trashTimer = setInterval(
    () => {
      void repositoryAdmin.purgeExpiredTrash().catch((error: unknown) => {
        app.log.error({ err: error }, 'repository trash purge failed');
      });
    },
    24 * 60 * 60 * 1000,
  );
  trashTimer.unref();
  const mirrorTimer = setInterval(() => {
    void enhancements
      .runDueMirrors()
      .then((result) => {
        if (result.failed) app.log.warn(result, 'one or more repository mirrors failed');
      })
      .catch((error: unknown) => {
        app.log.error({ err: error }, 'repository mirror worker failed');
      });
  }, 60_000);
  mirrorTimer.unref();
  await repositoryAdmin.purgeExpiredTrash();
  app.addHook('onClose', () => {
    closing = true;
    clearInterval(searchTimer);
    clearInterval(pluginEventTimer);
    clearInterval(trashTimer);
    clearInterval(mirrorTimer);
    database.close();
  });

  const session = (request: FastifyRequest) => auth.resolveSession(request.cookies.session);
  const requireSession = (request: FastifyRequest) => {
    const result = session(request);
    if (!result) throw new AuthorizationError();
    return result;
  };
  const formCsrf = (request: FastifyRequest, reply: FastifyReply): string => {
    const existing = request.cookies.form_csrf;
    if (existing && existing.length >= 32 && existing.length <= 128) return existing;
    const value = randomBytes(32).toString('base64url');
    reply.setCookie('form_csrf', value, cookieOptions(config, false));
    return value;
  };
  const verifyFormCsrf = (request: FastifyRequest, supplied: string | undefined): void => {
    const expected = request.cookies.form_csrf;
    if (!expected || !supplied) throw new CsrfError();
    const left = Buffer.from(expected);
    const right = Buffer.from(supplied);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new CsrfError();
  };

  const requireAdministrator = (request: FastifyRequest) => {
    const current = requireSession(request);
    if (!current.user.isAdmin) throw new AuthorizationError();
    return current;
  };

  const pluginAdminPage = async (current: ReturnType<typeof requireAdministrator>) => {
    const plugins = pluginManager.list().map((plugin) => ({
      ...plugin,
      settings: pluginManager.settingsView(plugin.id),
    }));
    return await render('admin-plugins', {
      user: current.user,
      csrf: current.csrfToken,
      plugins,
    });
  };

  const readableRepository = (request: FastifyRequest) => {
    const parameters = request.params as { owner: string; repository: string };
    const repository = repositories.find(parameters.owner, parameters.repository);
    if (!repository) throw new NotFoundError();
    const current = session(request);
    repositories.require(repository, current?.user.id ?? null, 'read');
    if (current) enhancements.touchRecent(current.user.id, repository.id);
    return { repository, current };
  };

  const writableRepository = (request: FastifyRequest) => {
    const { repository, current } = readableRepository(request);
    if (!current) throw new AuthorizationError();
    repositories.require(repository, current.user.id, 'write');
    return { repository, current };
  };

  const gitPrincipal = (request: FastifyRequest, scope: 'repository:read' | 'repository:write') => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Basic ')) return null;
    let decoded: string;
    try {
      decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    } catch {
      return null;
    }
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    return tokens.verify(decoded.slice(separator + 1), scope);
  };

  const apiPrincipal = (request: FastifyRequest, scope: string) => {
    const authorization = request.headers.authorization;
    return authorization?.startsWith('Bearer ')
      ? tokens.verify(authorization.slice(7), scope)
      : null;
  };

  const requireAdminPrincipal = (request: FastifyRequest) => {
    const principal = apiPrincipal(request, 'api:admin');
    if (!principal) throw new AuthorizationError();
    const account = database
      .prepare("SELECT is_admin AS isAdmin FROM users WHERE id = ? AND status = 'active'")
      .get(principal.userId) as { isAdmin: number } | undefined;
    if (account?.isAdmin !== 1) throw new AuthorizationError();
    return principal;
  };

  const apiRepository = (
    request: FastifyRequest,
    scope: 'repository:read' | 'repository:write',
    minimum: 'read' | 'write',
  ) => {
    const parameters = request.params as { owner: string; repository: string };
    const repository = repositories.find(parameters.owner, parameters.repository);
    if (!repository) throw new NotFoundError();
    const principal = apiPrincipal(request, scope);
    repositories.require(repository, principal?.userId ?? null, minimum);
    return { repository, principal };
  };

  const gitAuthenticationRequired = (reply: FastifyReply) => {
    reply.header('WWW-Authenticate', 'Basic realm="Git", charset="UTF-8"');
    return reply.code(401).send('Authentication required\n');
  };

  const lfsRepository = (
    request: FastifyRequest,
    minimum: 'read' | 'write',
  ): { repository: ReturnType<RepositoryService['getById']>; userId: number | null } => {
    const parameters = request.params as { owner: string; repository: string };
    const repository = repositories.find(parameters.owner, parameters.repository);
    if (!repository) throw new NotFoundError();
    const principal = gitPrincipal(
      request,
      minimum === 'write' ? 'repository:write' : 'repository:read',
    );
    const userId = principal?.userId ?? null;
    repositories.require(repository, userId, minimum);
    return { repository, userId };
  };

  const routeContext: AppRouteContext = {
    app,
    config,
    database,
    audit,
    runtimeSettings,
    auth,
    tokens,
    passkeys,
    externalAuth,
    recovery,
    invites,
    sshKeys,
    git,
    repositories,
    browser,
    referenceOptions,
    archives,
    enhancements,
    mutations,
    repositoryAdmin,
    groups,
    search,
    lfs,
    pluginManager,
    pluginContributions,
    pluginEvents,
    administration,
    metrics,
    render,
    session,
    requireSession,
    formCsrf,
    verifyFormCsrf,
    requireAdministrator,
    pluginAdminPage,
    readableRepository,
    writableRepository,
    gitPrincipal,
    apiPrincipal,
    requireAdminPrincipal,
    apiRepository,
    gitAuthenticationRequired,
    lfsRepository,
    withAuthorAvatar,
    isClosing: () => closing,
  };
  registerCoreRoutes(routeContext);
  registerHealthRoutes(routeContext);
  registerAuthRoutes(routeContext);
  registerAdminRoutes(routeContext);
  registerNavigationRoutes(routeContext);
  registerRepositoryHtmlRoutes(routeContext);
  registerGitRoutes(routeContext);
  registerApiRoutes(routeContext);
  registerPluginsRoutes(routeContext);

  app.setNotFoundHandler(async (request, reply) => {
    return reply
      .code(404)
      .type('text/html')
      .send(
        await render('error', {
          user: session(request)?.user ?? null,
          statusCode: 404,
          heading: 'Not found',
          message: 'That page does not exist or is not available to you.',
          requestId: request.id,
        }),
      );
  });
  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error }, 'request failed');
    const statusCode = normalizeStatus(error);
    const messages: Record<number, [string, string]> = {
      400: ['Invalid request', 'The request could not be understood.'],
      401: ['Sign in required', 'Sign in to continue.'],
      403: ['Action not allowed', 'You do not have permission to perform that action.'],
      404: ['Not found', 'That page does not exist or is not available to you.'],
      409: ['Conflict', 'The resource changed or this action conflicts with its current state.'],
      413: ['Too much data', 'The requested content exceeds a configured safety limit.'],
      429: ['Slow down', 'Too many requests were received. Please try again shortly.'],
      500: ['Something went wrong', 'The request could not be completed.'],
      503: ['Temporarily unavailable', 'The service is not ready to complete this request.'],
    };
    const fallback: [string, string] = [
      'Something went wrong',
      'The request could not be completed.',
    ];
    const [heading, message] = messages[statusCode] ?? fallback;
    if (request.url.startsWith('/api/')) {
      return reply.code(statusCode).send({
        error: {
          code: apiErrorCode(statusCode),
          message,
          requestId: request.id,
        },
      });
    }
    return reply
      .code(statusCode)
      .type('text/html')
      .send(
        await render('error', {
          user: session(request)?.user ?? null,
          statusCode,
          heading,
          message,
          requestId: request.id,
        }),
      );
  });

  return app;
}

function cookieOptions(config: AppConfig, httpOnly: boolean) {
  return {
    path: '/',
    httpOnly,
    sameSite: 'lax' as const,
    secure: config.server.publicUrl.startsWith('https://'),
  };
}

function normalizeStatus(error: unknown): number {
  if (error instanceof NotFoundError) return 404;
  if (error instanceof AuthorizationError) return 403;
  if (error instanceof PayloadTooLargeError) return 413;
  const status = (error as { statusCode?: number }).statusCode;
  return status && [400, 401, 403, 404, 409, 413, 429, 500, 503].includes(status) ? status : 500;
}

function apiErrorCode(status: number): string {
  const codes: Record<number, string> = {
    400: 'invalid_request',
    401: 'authentication_required',
    403: 'forbidden',
    404: 'not_found',
    409: 'conflict',
    413: 'payload_too_large',
    429: 'rate_limited',
    500: 'internal_error',
    503: 'unavailable',
  };
  return codes[status] ?? 'request_failed';
}
