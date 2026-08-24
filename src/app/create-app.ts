import { randomBytes, timingSafeEqual } from 'node:crypto';
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
import {
  administrationSystemResponse,
  collaboratorListResponse,
  commitDetailResponse,
  commitListResponse,
  comparisonResponse,
  groupListResponse,
  groupResponse,
  idResponse,
  objectIdResponse,
  okResponse,
  paginatedAdminRepositoriesResponse,
  paginatedAdminUsersResponse,
  paginatedAuditResponse,
  pluginListResponse,
  pluginResponse,
  pluginSettingsResponse,
  inviteListResponse,
  inviteCreatedResponse,
  profileResponse,
  appearanceResponse,
  sessionListResponse,
  searchStatusResponse,
  runtimeSettingsResponse,
  rebuildResponse,
  passkeyRegistrationOptionsResponse,
  passkeyAuthenticationOptionsResponse,
  passkeyAuthenticationResultResponse,
  passkeyListResponse,
  paletteResponse,
  progressiveDiffResponse,
  refListResponse,
  repositoryListResponse,
  repositoryResponse,
  repositoryTransferListResponse,
  searchResponse,
  treeResponse,
  blobResponse,
  blameResponse,
  sshKeyListResponse,
  sshKeyResponse,
  tokenCreatedResponse,
  tokenListResponse,
  userResponse,
} from '../api/openapi-schemas.js';
import { AdminService } from '../admin/admin-service.js';
import { RuntimeSettingsService, type RuntimeSettings } from '../admin/runtime-settings-service.js';
import { product } from './metadata.js';
import { AuthService, CsrfError } from '../auth/auth-service.js';
import { TokenService } from '../auth/token-service.js';
import { PasskeyService } from '../auth/passkey-service.js';
import { ExternalAuthService } from '../auth/external-auth-service.js';
import { RecoveryService } from '../auth/recovery-service.js';
import { InviteService } from '../auth/invite-service.js';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { AppConfig } from '../config/config.js';
import { openDatabase } from '../database/database.js';
import { documentation, documentationPage, documentationSearch } from '../docs/documentation.js';
import { GitRunner } from '../git/git-runner.js';
import { GitError } from '../git/errors.js';
import { ArchiveService } from '../git/archive-service.js';
import { GitBrowser } from '../git/git-browser.js';
import { GroupService } from '../groups/group-service.js';
import { atomFeed } from '../feeds/atom.js';
import { LfsService, type LfsBatchObject } from '../lfs/lfs-service.js';
import { parseLfsPointer } from '../lfs/lfs-pointer.js';
import { PluginManager } from '../plugins/plugin-manager.js';
import { PluginContributionService } from '../plugins/contribution-service.js';
import { PluginEventService } from '../plugins/event-service.js';
import { SandboxRuntime } from '../plugins/sandbox-runtime.js';
import { examplePluginArchive } from '../plugins/example-download.js';
import { serveSmartHttp } from '../http-git/smart-http.js';
import { SshKeyService } from '../ssh/ssh-key-service.js';
import {
  AuthorizationError,
  NotFoundError,
  PayloadTooLargeError,
  RepositoryService,
} from '../repositories/repository-service.js';
import { RepositoryMutationService } from '../repositories/repository-mutation-service.js';
import { RepositoryAdminService } from '../repositories/repository-admin-service.js';
import type { Visibility } from '../repositories/repository-types.js';
import { ValidationError } from '../security/validation.js';
import { SearchService } from '../search/search-service.js';
import { render as renderView } from '../web/render.js';
import {
  breadcrumbs,
  imageMetadata,
  isBinary,
  isMarkdown,
  isSafeImage,
  safeInlineMime,
} from '../web/file-presentation.js';
import { renderMarkdown } from '../web/markdown.js';
import { highlightSource } from '../web/syntax.js';

type FormBody = Record<string, string | undefined>;

function imageDiffSide(path: string, ref: string, content: Buffer) {
  return {
    path,
    encodedPath: path.split('/').map(encodeURIComponent).join('/'),
    ref,
    size: content.length,
    metadata: imageMetadata(content, path),
  };
}

function presentTreeEntry(
  entry: Awaited<ReturnType<RepositoryService['listTree']>>[number],
  submodules: Map<string, string>,
) {
  const submoduleUrl = entry.type === 'commit' ? submodules.get(entry.name) : undefined;
  return {
    ...entry,
    encodedName: entry.name.split('/').map(encodeURIComponent).join('/'),
    ...(submoduleUrl ? { submoduleUrl } : {}),
    ...(submoduleUrl && /^(?:https?|ssh):\/\//i.test(submoduleUrl)
      ? { submoduleLink: submoduleUrl }
      : {}),
  };
}

function repositoryJson(repository: ReturnType<RepositoryService['getById']>) {
  return {
    id: repository.id,
    owner: repository.ownerSlug,
    ownerType: repository.ownerType,
    name: repository.slug,
    description: repository.description,
    visibility: repository.visibility,
    defaultBranch: repository.defaultBranch,
    storageKind: repository.storageKind,
  };
}

const openApiError = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'requestId'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        requestId: { type: 'string' },
      },
    },
  },
} as const;

function apiContract(
  tag: string,
  options: {
    authenticated?: boolean;
    success?: number;
    params?: Record<string, unknown>;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
    response?: Record<string, unknown>;
  } = {},
) {
  return {
    tags: [tag],
    ...(options.authenticated === false ? {} : { security: [{ bearerToken: [] }] }),
    ...(options.params ? { params: options.params } : {}),
    ...(options.query ? { querystring: options.query } : {}),
    ...(options.body ? { body: options.body } : {}),
    response: {
      [options.success ?? 200]:
        options.success === 204
          ? { type: 'null' }
          : (options.response ?? { type: 'object', additionalProperties: true }),
      400: openApiError,
      401: openApiError,
      403: openApiError,
      404: openApiError,
      409: openApiError,
      413: openApiError,
      429: openApiError,
      500: openApiError,
      503: openApiError,
    },
  };
}

const repositoryParameters = {
  type: 'object',
  required: ['owner', 'repository'],
  properties: { owner: { type: 'string' }, repository: { type: 'string' } },
};

const repositoryWildcardParameters = {
  type: 'object',
  required: ['owner', 'repository', '*'],
  properties: {
    owner: { type: 'string' },
    repository: { type: 'string' },
    '*': { type: 'string' },
  },
};

const repositoryCreateBody = {
  type: 'object',
  additionalProperties: false,
  required: ['owner', 'name', 'visibility'],
  properties: {
    owner: { type: 'string', minLength: 1, maxLength: 64 },
    ownerType: { type: 'string', enum: ['user', 'group'] },
    name: { type: 'string', minLength: 1, maxLength: 64 },
    description: { type: 'string', maxLength: 500 },
    visibility: { type: 'string', enum: ['public', 'private'] },
    initializeReadme: { type: 'boolean' },
    gitignore: { type: 'string', enum: ['', 'node', 'python', 'rust'] },
    license: { type: 'string', enum: ['', 'mit', 'apache-2.0', 'agpl-3.0'] },
  },
} as const;

const repositoryUpdateBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 64 },
    description: { type: 'string', maxLength: 500 },
    visibility: { type: 'string', enum: ['public', 'private'] },
    defaultBranch: { type: 'string', minLength: 1, maxLength: 255 },
    owner: { type: 'string', minLength: 1, maxLength: 64 },
    ownerType: { type: 'string', enum: ['user', 'group'] },
  },
} as const;

const collaboratorBody = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'name', 'permission'],
  properties: {
    type: { type: 'string', enum: ['user', 'group'] },
    name: { type: 'string', minLength: 1, maxLength: 64 },
    permission: { type: 'string', enum: ['read', 'write', 'admin'] },
  },
} as const;

const refCreateBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'source'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    source: { type: 'string', minLength: 1, maxLength: 255 },
  },
} as const;

const fileWriteBody = {
  type: 'object',
  additionalProperties: false,
  required: ['branch', 'message', 'content', 'encoding'],
  properties: {
    branch: { type: 'string', minLength: 1, maxLength: 255 },
    message: { type: 'string', minLength: 1, maxLength: 10_000 },
    content: { type: 'string', maxLength: 100_000_000 },
    encoding: { type: 'string', const: 'base64' },
  },
} as const;

const fileDeleteBody = {
  type: 'object',
  additionalProperties: false,
  required: ['branch', 'message'],
  properties: {
    branch: { type: 'string', minLength: 1, maxLength: 255 },
    message: { type: 'string', minLength: 1, maxLength: 10_000 },
  },
} as const;

const groupCreateBody = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'displayName'],
  properties: {
    slug: { type: 'string', minLength: 1, maxLength: 64 },
    displayName: { type: 'string', minLength: 1, maxLength: 100 },
  },
} as const;

const groupMemberBody = {
  type: 'object',
  additionalProperties: false,
  required: ['username', 'role'],
  properties: {
    username: { type: 'string', minLength: 1, maxLength: 64 },
    role: { type: 'string', enum: ['member', 'manager', 'owner'] },
  },
} as const;

const administrationUserBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    status: { type: 'string', enum: ['active', 'disabled'] },
    administrator: { type: 'boolean' },
  },
} as const;

const pluginStateBody = {
  type: 'object',
  additionalProperties: false,
  required: ['enabled'],
  properties: {
    enabled: { type: 'boolean' },
    trustedRiskAccepted: { type: 'boolean' },
  },
} as const;

const pluginPermissionBody = {
  type: 'object',
  additionalProperties: false,
  required: ['granted'],
  properties: { granted: { type: 'boolean' } },
} as const;

const pluginSettingsBody = {
  type: 'object',
  additionalProperties: false,
  required: ['values'],
  properties: {
    values: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value'],
        properties: {
          key: { type: 'string', minLength: 1, maxLength: 64 },
          value: {
            anyOf: [
              { type: 'string' },
              { type: 'number' },
              { type: 'boolean' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
        },
      },
    },
  },
} as const;

const passkeyRenameBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
} as const;

const repositoryTransferDecisionBody = {
  type: 'object',
  additionalProperties: false,
  required: ['accept'],
  properties: { accept: { type: 'boolean' } },
} as const;

const inviteCreateBody = {
  type: 'object',
  additionalProperties: false,
  properties: { expiresInDays: { type: 'integer', minimum: 1, maximum: 30 } },
} as const;

const runtimeSettingsBody = {
  ...runtimeSettingsResponse,
} as const;

const tokenCreateBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'scopes'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    scopes: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        enum: ['repository:read', 'repository:write', 'api:read', 'api:write', 'api:admin', '*'],
      },
    },
    expiresAt: { type: 'string', format: 'date-time' },
  },
} as const;

const sshKeyCreateBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'publicKey'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    publicKey: { type: 'string', minLength: 1, maxLength: 16_384 },
  },
} as const;

const profileUpdateBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    displayName: { type: 'string', minLength: 1, maxLength: 100 },
    email: { type: 'string', maxLength: 400 },
    emailPublic: { type: 'boolean' },
  },
} as const;

const appearanceUpdateBody = {
  type: 'object',
  additionalProperties: false,
  required: ['theme', 'accent', 'uiFont', 'codeFont', 'reducedMotion'],
  properties: {
    theme: { type: 'string', enum: ['light', 'dark', 'system'] },
    accent: { type: 'string', enum: ['violet', 'green', 'amber'] },
    uiFont: { type: 'string', enum: ['system', 'humanist'] },
    codeFont: { type: 'string', enum: ['system', 'mono'] },
    reducedMotion: { type: 'boolean' },
    pluginTheme: { anyOf: [{ type: 'string', maxLength: 201 }, { type: 'null' }] },
  },
} as const;

const passkeyClientExtensions = {
  type: 'object',
  additionalProperties: false,
  properties: {
    appid: { type: 'boolean' },
    credProps: {
      type: 'object',
      additionalProperties: false,
      properties: { rk: { type: 'boolean' } },
    },
    hmacCreateSecret: { type: 'boolean' },
  },
} as const;
const passkeyCredentialProperties = {
  id: { type: 'string', minLength: 1, maxLength: 4096 },
  rawId: { type: 'string', minLength: 1, maxLength: 4096 },
  type: { type: 'string', const: 'public-key' },
  authenticatorAttachment: {
    anyOf: [{ type: 'string', enum: ['platform', 'cross-platform'] }, { type: 'null' }],
  },
  clientExtensionResults: passkeyClientExtensions,
} as const;
const passkeyRegistrationVerifyBody = {
  type: 'object',
  additionalProperties: false,
  required: ['challenge', 'name', 'response'],
  properties: {
    challenge: { type: 'string', minLength: 1, maxLength: 4096 },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    response: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'rawId', 'type', 'clientExtensionResults', 'response'],
      properties: {
        ...passkeyCredentialProperties,
        response: {
          type: 'object',
          additionalProperties: false,
          required: ['clientDataJSON', 'attestationObject'],
          properties: {
            clientDataJSON: { type: 'string' },
            attestationObject: { type: 'string' },
            authenticatorData: { type: 'string' },
            transports: { type: 'array', items: { type: 'string' } },
            publicKeyAlgorithm: { type: 'integer' },
            publicKey: { type: 'string' },
          },
        },
      },
    },
  },
} as const;
const passkeyAuthenticationVerifyBody = {
  type: 'object',
  additionalProperties: false,
  required: ['challenge', 'response'],
  properties: {
    challenge: { type: 'string', minLength: 1, maxLength: 4096 },
    response: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'rawId', 'type', 'clientExtensionResults', 'response'],
      properties: {
        ...passkeyCredentialProperties,
        response: {
          type: 'object',
          additionalProperties: false,
          required: ['clientDataJSON', 'authenticatorData', 'signature'],
          properties: {
            clientDataJSON: { type: 'string' },
            authenticatorData: { type: 'string' },
            signature: { type: 'string' },
            userHandle: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
        },
      },
    },
  },
} as const;

function stringPathParameters(...names: string[]) {
  return {
    type: 'object',
    required: names,
    properties: Object.fromEntries(names.map((name) => [name, { type: 'string' }])),
  };
}

function relativeDate(input: string, now = Date.now()): string {
  const milliseconds = now - new Date(input).getTime();
  if (!Number.isFinite(milliseconds)) return input;
  const future = milliseconds < 0;
  const seconds = Math.max(0, Math.round(Math.abs(milliseconds) / 1000));
  const units: [number, string][] = [
    [365 * 24 * 60 * 60, 'year'],
    [30 * 24 * 60 * 60, 'month'],
    [7 * 24 * 60 * 60, 'week'],
    [24 * 60 * 60, 'day'],
    [60 * 60, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, label] of units) {
    if (seconds >= size) {
      const amount = Math.floor(seconds / size);
      return future
        ? `in ${String(amount)} ${label}${amount === 1 ? '' : 's'}`
        : `${String(amount)} ${label}${amount === 1 ? '' : 's'} ago`;
    }
  }
  return future ? 'in a moment' : 'just now';
}

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
  );
  const repositories = new RepositoryService(database, git, config, audit);
  const browser = new GitBrowser(git, repositories, config);
  const referenceOptions = async (repository: ReturnType<RepositoryService['getById']>) => ({
    branches: await browser.branches(repository),
    tags: await browser.tags(repository),
  });
  const archives = new ArchiveService(config, repositories);
  const mutations = new RepositoryMutationService(database, git, repositories, config, audit);
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
    requestIdHeader: 'x-request-id',
    trustProxy: config.server.tls.mode === 'proxy' ? ['127.0.0.1', '::1'] : false,
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
      info: { title: `${product.name} API`, version: '1.0.0' },
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
  await repositoryAdmin.purgeExpiredTrash();
  app.addHook('onClose', () => {
    clearInterval(searchTimer);
    clearInterval(pluginEventTimer);
    clearInterval(trashTimer);
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

  app.get('/', async (request, reply) => {
    const current = session(request);
    return reply.type('text/html').send(await render('home', { user: current?.user ?? null }));
  });

  app.get('/explore', async (request, reply) => {
    const current = session(request);
    const repositoriesPage = repositories.listAccessible(current?.user.id ?? null, 1, 100);
    return reply.type('text/html').send(
      await render('explore', {
        user: current?.user ?? null,
        repositories: repositoriesPage,
      }),
    );
  });

  app.get('/health', async (_request, reply) => {
    const gitVersion = await git.run(['--version'], { timeoutMs: 2000, maxOutputBytes: 1024 });
    return reply.send({ status: 'ok', git: gitVersion.stdout.toString('utf8').trim() });
  });

  app.get('/login', async (request, reply) => {
    return reply.type('text/html').send(
      await render('auth', {
        mode: 'login',
        csrf: formCsrf(request, reply),
        user: null,
        oidcProviders: externalAuth.providers(),
        ldapEnabled: config.authentication?.ldap?.enabled === true,
        pluginAuthProviders: pluginContributions.authenticationProviders(),
      }),
    );
  });
  app.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = request.body as FormBody;
      verifyFormCsrf(request, body.csrf);
      try {
        const user = await auth.login(
          body.username ?? '',
          body.password ?? '',
          request.id,
          request.ip,
        );
        const created = auth.createSession(user.id, request.headers['user-agent']);
        reply.setCookie('session', created.token, {
          ...cookieOptions(config, true),
          expires: created.expiresAt,
        });
        reply.clearCookie('form_csrf', cookieOptions(config, false));
        return await reply.redirect('/');
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 401) throw error;
        return reply
          .code(401)
          .type('text/html')
          .send(
            await render('auth', {
              mode: 'login',
              csrf: formCsrf(request, reply),
              error: 'The username or password was not accepted.',
              user: null,
              oidcProviders: externalAuth.providers(),
              ldapEnabled: config.authentication?.ldap?.enabled === true,
              pluginAuthProviders: pluginContributions.authenticationProviders(),
            }),
          );
      }
    },
  );

  app.get('/register', async (request, reply) => {
    const inviteToken = (request.query as { invite?: string }).invite;
    return reply.type('text/html').send(
      await render('auth', {
        mode: 'register',
        csrf: formCsrf(request, reply),
        user: null,
        oidcProviders: [],
        ldapEnabled: false,
        pluginAuthProviders: [],
        inviteToken: inviteToken?.slice(0, 128) ?? '',
      }),
    );
  });
  app.post(
    '/register',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const body = request.body as FormBody;
      verifyFormCsrf(request, body.csrf);
      try {
        const user = await auth.register({
          username: body.username ?? '',
          displayName: body.displayName ?? '',
          password: body.password ?? '',
          ...(body.email ? { email: body.email } : {}),
          ...(body.invite ? { inviteToken: body.invite } : {}),
          requestId: request.id,
          ip: request.ip,
        });
        const created = auth.createSession(user.id, request.headers['user-agent']);
        reply.setCookie('session', created.token, {
          ...cookieOptions(config, true),
          expires: created.expiresAt,
        });
        return await reply.redirect('/');
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode ?? 400;
        return reply
          .code(status)
          .type('text/html')
          .send(
            await render('auth', {
              mode: 'register',
              csrf: formCsrf(request, reply),
              error: safeErrorMessage(error),
              user: null,
              oidcProviders: [],
              ldapEnabled: false,
              pluginAuthProviders: [],
              inviteToken: body.invite ?? '',
            }),
          );
      }
    },
  );

  app.post('/logout', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    auth.revokeSession(request.cookies.session);
    reply.clearCookie('session', cookieOptions(config, true));
    return reply.redirect('/');
  });

  app.get('/avatars/:username', async (request, reply) => {
    const row = database
      .prepare(
        "SELECT avatar, avatar_mime AS mime FROM users WHERE username = ? AND status = 'active' AND avatar IS NOT NULL",
      )
      .get((request.params as { username: string }).username.toLowerCase()) as
      { avatar: Buffer; mime: string } | undefined;
    if (!row) throw new NotFoundError();
    return reply
      .header('Cache-Control', 'public, max-age=300')
      .header('X-Content-Type-Options', 'nosniff')
      .type(row.mime)
      .send(row.avatar);
  });

  app.get('/users/:username', async (request, reply) => {
    const current = session(request);
    const username = (request.params as { username: string }).username.toLowerCase();
    const account = database
      .prepare(
        `SELECT id, username, display_name AS displayName,
          CASE WHEN email_public = 1 THEN email ELSE NULL END AS email,
          avatar IS NOT NULL AS hasAvatar
         FROM users WHERE username = ? AND status = 'active'`,
      )
      .get(username) as
      | {
          id: number;
          username: string;
          displayName: string;
          email: string | null;
          hasAvatar: number;
        }
      | undefined;
    if (!account) throw new NotFoundError();
    return reply.type('text/html').send(
      await render('user', {
        user: current?.user ?? null,
        account: { ...account, hasAvatar: account.hasAvatar === 1 },
        repositories: repositories
          .listAccessible(current?.user.id ?? null, 1, 100, { owner: account.username })
          .filter(
            (repository) => repository.ownerType === 'user' && repository.ownerId === account.id,
          ),
      }),
    );
  });

  app.get('/settings/profile', async (request, reply) => {
    const current = requireSession(request);
    return reply.type('text/html').send(
      await render('profile', {
        user: current.user,
        csrf: current.csrfToken,
        profile: auth.profile(current.user.id),
      }),
    );
  });

  app.post('/settings/profile', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    auth.updateProfile(current.user.id, {
      displayName: body.displayName ?? '',
      email: body.email ?? '',
      emailPublic: body.emailPublic === 'yes',
    });
    return await reply.redirect('/settings/profile');
  });

  app.post('/settings/avatar', async (request, reply) => {
    const current = requireSession(request);
    let csrf: string | undefined;
    let avatar: Buffer | undefined;
    let mime = '';
    for await (const part of request.parts()) {
      if (part.type === 'field' && part.fieldname === 'csrf') csrf = String(part.value);
      if (part.type === 'file' && part.fieldname === 'avatar') {
        mime = part.mimetype;
        avatar = await part.toBuffer();
      }
    }
    auth.verifyCsrf(current.csrfToken, csrf);
    if (!avatar) throw new ValidationError('Avatar image is required');
    auth.setAvatar(current.user.id, avatar, mime);
    return await reply.redirect('/settings/profile');
  });

  app.post('/settings/avatar/remove', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    auth.removeAvatar(current.user.id);
    return await reply.redirect('/settings/profile');
  });

  app.get('/auth/proxy', async (request, reply) => {
    const proxy = config.authentication?.reverseProxy;
    if (!proxy?.enabled || !proxy.allowedAddresses.includes(request.ip))
      throw new AuthorizationError();
    const identityValue = request.headers[proxy.identityHeader];
    const displayValue = request.headers[proxy.displayNameHeader];
    if (typeof identityValue !== 'string') throw new AuthorizationError();
    const user = auth.loginReverseProxy(
      identityValue,
      typeof displayValue === 'string' ? displayValue : undefined,
      proxy.autoCreate,
      request.id,
      request.ip,
    );
    const created = auth.createSession(user.id, request.headers['user-agent']);
    reply.setCookie('session', created.token, {
      ...cookieOptions(config, true),
      expires: created.expiresAt,
    });
    return await reply.redirect('/');
  });

  app.get('/auth/oidc/:providerId', async (request, reply) => {
    const providerId = (request.params as { providerId: string }).providerId;
    const returnPath = (request.query as { return?: string }).return ?? '/';
    return await reply.redirect((await externalAuth.beginOidc(providerId, returnPath)).href);
  });

  app.get('/auth/oidc/:providerId/callback', async (request, reply) => {
    const providerId = (request.params as { providerId: string }).providerId;
    const result = await externalAuth.completeOidc(
      providerId,
      new URL(request.url, config.server.publicUrl),
      request.id,
      request.ip,
    );
    const created = auth.createSession(result.user.id, request.headers['user-agent']);
    reply.setCookie('session', created.token, {
      ...cookieOptions(config, true),
      expires: created.expiresAt,
    });
    return await reply.redirect(result.returnPath);
  });

  app.post(
    '/auth/ldap',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = request.body as FormBody;
      verifyFormCsrf(request, body.csrf);
      try {
        const user = await externalAuth.loginLdap(
          body.username ?? '',
          body.password ?? '',
          request.id,
          request.ip,
        );
        const created = auth.createSession(user.id, request.headers['user-agent']);
        reply.setCookie('session', created.token, {
          ...cookieOptions(config, true),
          expires: created.expiresAt,
        });
        reply.clearCookie('form_csrf', cookieOptions(config, false));
        return await reply.redirect('/');
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 401) throw error;
        return reply
          .code(401)
          .type('text/html')
          .send(
            await render('auth', {
              mode: 'login',
              csrf: formCsrf(request, reply),
              error: 'The directory credentials were not accepted.',
              user: null,
              oidcProviders: externalAuth.providers(),
              ldapEnabled: true,
              pluginAuthProviders: pluginContributions.authenticationProviders(),
            }),
          );
      }
    },
  );

  app.post(
    '/auth/plugins/:pluginId/:providerId',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = request.body as FormBody;
      verifyFormCsrf(request, body.csrf);
      const { pluginId, providerId } = request.params as {
        pluginId: string;
        providerId: string;
      };
      try {
        const result = await pluginContributions.authenticate(pluginId, providerId, {
          username: body.username ?? '',
          password: body.password ?? '',
        });
        const user = auth.loginExternal({
          providerId: `plugin:${pluginId}:${providerId}`,
          subject: result.identity.subject,
          username: result.identity.username,
          displayName: result.identity.displayName,
          ...(result.identity.email ? { email: result.identity.email } : {}),
          profile: { source: 'plugin' },
          autoCreate: result.provider.autoCreate,
          requestId: request.id,
          ip: request.ip,
        });
        const created = auth.createSession(user.id, request.headers['user-agent']);
        reply.setCookie('session', created.token, {
          ...cookieOptions(config, true),
          expires: created.expiresAt,
        });
        reply.clearCookie('form_csrf', cookieOptions(config, false));
        return await reply.redirect('/');
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode ?? 401;
        if (![400, 401, 403].includes(status)) throw error;
        return reply
          .code(401)
          .type('text/html')
          .send(
            await render('auth', {
              mode: 'login',
              csrf: formCsrf(request, reply),
              error: 'The external credentials were not accepted.',
              user: null,
              oidcProviders: externalAuth.providers(),
              ldapEnabled: config.authentication?.ldap?.enabled === true,
              pluginAuthProviders: pluginContributions.authenticationProviders(),
            }),
          );
      }
    },
  );

  app.get('/recover', async (request, reply) => {
    return reply
      .type('text/html')
      .send(await render('recover', { user: null, csrf: formCsrf(request, reply) }));
  });

  app.post(
    '/recover',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const body = request.body as FormBody;
      verifyFormCsrf(request, body.csrf);
      try {
        await recovery.resetPassword(
          body.username ?? '',
          body.code ?? '',
          body.password ?? '',
          request.id,
          request.ip,
        );
        reply.clearCookie('form_csrf', cookieOptions(config, false));
        return await reply.redirect('/login');
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode ?? 0;
        if (![400, 401, 409].includes(status)) throw error;
        return reply
          .code(status)
          .type('text/html')
          .send(
            await render('recover', {
              user: null,
              csrf: formCsrf(request, reply),
              error: 'The recovery details were not accepted.',
            }),
          );
      }
    },
  );

  app.post(
    '/api/v1/passkeys/registration/options',
    {
      schema: {
        ...apiContract('authentication', {
          authenticated: false,
          body: { type: 'object', additionalProperties: false },
          response: passkeyRegistrationOptionsResponse,
        }),
        security: [{ cookieSession: [] }],
      },
    },
    async (request, reply) => {
      const current = requireSession(request);
      auth.verifyCsrf(
        current.csrfToken,
        typeof request.headers['x-csrf-token'] === 'string'
          ? request.headers['x-csrf-token']
          : undefined,
      );
      return reply.send(await passkeys.registrationOptions(current.user.id));
    },
  );

  app.post(
    '/api/v1/passkeys/registration/verify',
    {
      schema: {
        ...apiContract('authentication', {
          authenticated: false,
          success: 201,
          body: passkeyRegistrationVerifyBody,
          response: okResponse,
        }),
        security: [{ cookieSession: [] }],
      },
    },
    async (request, reply) => {
      const current = requireSession(request);
      auth.verifyCsrf(
        current.csrfToken,
        typeof request.headers['x-csrf-token'] === 'string'
          ? request.headers['x-csrf-token']
          : undefined,
      );
      const body = request.body as { challenge?: unknown; name?: unknown; response?: unknown };
      if (typeof body.challenge !== 'string' || typeof body.name !== 'string' || !body.response)
        throw new ValidationError('Invalid passkey response');
      await passkeys.register(
        current.user.id,
        body.challenge,
        body.name,
        body.response as RegistrationResponseJSON,
      );
      auth.revokeUserSessions(current.user.id, request.cookies.session);
      return reply.code(201).send({ ok: true });
    },
  );

  app.post(
    '/api/v1/passkeys/authentication/options',
    {
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
      schema: apiContract('authentication', {
        authenticated: false,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { username: { type: 'string', maxLength: 39 } },
        },
        response: passkeyAuthenticationOptionsResponse,
      }),
    },
    async (request, reply) => {
      const body = request.body as { username?: unknown } | undefined;
      return reply.send(
        await passkeys.authenticationOptions(
          typeof body?.username === 'string' ? body.username : undefined,
        ),
      );
    },
  );

  app.post(
    '/api/v1/passkeys/authentication/verify',
    {
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
      schema: apiContract('authentication', {
        authenticated: false,
        body: passkeyAuthenticationVerifyBody,
        response: passkeyAuthenticationResultResponse,
      }),
    },
    async (request, reply) => {
      const body = request.body as { challenge?: unknown; response?: unknown };
      if (typeof body.challenge !== 'string' || !body.response)
        throw new ValidationError('Invalid passkey response');
      const userId = await passkeys.authenticate(
        body.challenge,
        body.response as AuthenticationResponseJSON,
      );
      const created = auth.createSession(userId, request.headers['user-agent']);
      reply.setCookie('session', created.token, {
        ...cookieOptions(config, true),
        expires: created.expiresAt,
      });
      return reply.send({ ok: true, redirect: '/' });
    },
  );

  const credentialsPage = async (
    current: ReturnType<typeof requireSession>,
    createdToken?: string,
    createdRecoveryCodes?: string[],
  ) =>
    await render('credentials', {
      user: current.user,
      csrf: current.csrfToken,
      tokens: tokens.list(current.user.id),
      sshKeys: sshKeys.list(current.user.id),
      createdToken: createdToken ?? null,
      createdRecoveryCodes: createdRecoveryCodes ?? null,
      recoveryCodeCount: recovery.count(current.user.id),
      passkeyList: passkeys.list(current.user.id),
      pendingTransfers: repositoryAdmin.pendingTransfers(current.user.id),
    });

  app.get('/settings/credentials', async (request, reply) => {
    const current = requireSession(request);
    return reply.type('text/html').send(await credentialsPage(current));
  });

  app.get('/settings/appearance', async (request, reply) => {
    const current = requireSession(request);
    return reply.type('text/html').send(
      await render('appearance', {
        user: current.user,
        csrf: current.csrfToken,
        preferences: auth.appearance(current.user.id),
        pluginThemes: pluginContributions.themes(),
      }),
    );
  });

  app.post('/settings/repository-transfers/:repositoryId', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const repositoryId = Number.parseInt(
      (request.params as { repositoryId: string }).repositoryId,
      10,
    );
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0)
      throw new ValidationError('Invalid repository transfer');
    const updated = repositoryAdmin.resolveTransfer(
      repositoryId,
      current.user.id,
      body.action === 'accept',
    );
    if (updated) {
      search.enqueue(updated.id);
      return await reply.redirect(`/${updated.ownerSlug}/${updated.slug}`);
    }
    return await reply.redirect('/settings/credentials');
  });

  app.post('/settings/appearance', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    let pluginTheme = body.pluginTheme ?? null;
    if (pluginTheme === '') pluginTheme = null;
    if (pluginTheme && !pluginContributions.theme(pluginTheme))
      throw new ValidationError('Selected plugin theme is unavailable');
    auth.setAppearance(current.user.id, {
      theme: body.theme ?? '',
      accent: body.accent ?? '',
      uiFont: body.uiFont ?? '',
      codeFont: body.codeFont ?? '',
      reducedMotion: body.reducedMotion === 'yes',
      pluginTheme,
    });
    return await reply.redirect('/settings/appearance');
  });

  app.get('/plugin-themes/:pluginId/:themeId.css', async (request, reply) => {
    const parameters = request.params as { pluginId: string; themeId: string };
    const theme = pluginContributions.theme(
      `${parameters.pluginId}:${parameters.themeId.replace(/\.css$/, '')}`,
    );
    if (!theme) throw new NotFoundError();
    const colors = theme.colors;
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'public, max-age=300')
      .type('text/css; charset=utf-8')
      .send(
        `:root{color-scheme:${theme.colorScheme};--bg:${colors.background};--surface:${colors.surface};--surface-subtle:${colors.surfaceSubtle};--text:${colors.text};--muted:${colors.muted};--border:${colors.border};--accent:${colors.accent};--accent-strong:${colors.accentStrong}}`,
      );
  });

  app.get('/settings/sessions', async (request, reply) => {
    const current = requireSession(request);
    return reply.type('text/html').send(
      await render('sessions', {
        user: current.user,
        csrf: current.csrfToken,
        sessions: auth.sessions(current.user.id),
      }),
    );
  });

  app.post('/settings/sessions', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    auth.revokeUserSessions(current.user.id, request.cookies.session);
    return await reply.redirect('/settings/sessions');
  });

  app.post('/settings/tokens', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const days = ['30', '90', '365'].includes(body.expires ?? '') ? Number(body.expires) : 30;
    const scopes =
      body.access === 'api-write'
        ? [
            'api:read',
            'api:write',
            'repository:read',
            'repository:write',
            ...(current.user.isAdmin ? ['api:admin'] : []),
          ]
        : body.access === 'write'
          ? ['repository:read', 'repository:write']
          : body.access === 'api'
            ? ['api:read']
            : ['repository:read'];
    const createdToken = tokens.create({
      userId: current.user.id,
      name: body.name ?? '',
      scopes,
      expiresAt: new Date(Date.now() + days * 86_400_000),
    });
    return reply.type('text/html').send(await credentialsPage(current, createdToken));
  });

  app.post('/settings/recovery-codes', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    return reply
      .type('text/html')
      .send(await credentialsPage(current, undefined, recovery.generate(current.user.id)));
  });

  app.post('/settings/passkeys/:passkeyId', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as FormBody;
    const parameters = request.params as { passkeyId: string };
    auth.verifyCsrf(current.csrfToken, body.csrf);
    if (body.action === 'rename')
      passkeys.rename(current.user.id, parameters.passkeyId, body.name ?? '');
    else if (body.action === 'remove') {
      passkeys.remove(current.user.id, parameters.passkeyId);
      auth.revokeUserSessions(current.user.id, request.cookies.session);
    } else throw new ValidationError('Invalid passkey action');
    return await reply.redirect('/settings/credentials');
  });

  app.post('/settings/tokens/:tokenId/revoke', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as FormBody;
    const parameters = request.params as { tokenId: string };
    auth.verifyCsrf(current.csrfToken, body.csrf);
    tokens.revoke(current.user.id, Number.parseInt(parameters.tokenId, 10));
    return await reply.redirect('/settings/credentials');
  });

  app.post('/settings/ssh-keys', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    await sshKeys.add(current.user.id, body.name ?? '', body.publicKey ?? '');
    return await reply.redirect('/settings/credentials');
  });

  app.post('/settings/ssh-keys/:keyId/remove', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as FormBody;
    const parameters = request.params as { keyId: string };
    auth.verifyCsrf(current.csrfToken, body.csrf);
    sshKeys.remove(current.user.id, Number.parseInt(parameters.keyId, 10));
    return await reply.redirect('/settings/credentials');
  });

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

  app.get('/admin/plugins', async (request, reply) => {
    const current = requireAdministrator(request);
    return reply.type('text/html').send(await pluginAdminPage(current));
  });

  app.get('/admin', async (request, reply) => {
    const current = requireAdministrator(request);
    const gitVersion = await git.run(['--version'], { timeoutMs: 2000, maxOutputBytes: 1024 });
    const sqlite = database.prepare('SELECT sqlite_version() AS version').get() as {
      version: string;
    };
    const journal = database.pragma('journal_mode', { simple: true }) as string;
    return reply.type('text/html').send(
      await render('admin', {
        user: current.user,
        counts: administration.counts(),
        system: {
          node: process.version,
          git: gitVersion.stdout.toString('utf8').trim(),
          sqlite: sqlite.version,
          journal,
          repositoryStorage: config.storage.repositories,
          ssh: config.ssh.enabled,
        },
      }),
    );
  });

  app.get('/admin/users', async (request, reply) => {
    const current = requireAdministrator(request);
    return reply.type('text/html').send(await adminUsersPage(current));
  });

  const adminUsersPage = async (
    current: ReturnType<typeof requireAdministrator>,
    createdRecovery?: { username: string; code: string },
  ) =>
    await render('admin-users', {
      user: current.user,
      csrf: current.csrfToken,
      users: administration.users(),
      createdRecovery: createdRecovery ?? null,
    });

  const adminInvitesPage = async (
    current: ReturnType<typeof requireAdministrator>,
    createdToken?: string,
  ) =>
    await render('admin-invites', {
      user: current.user,
      csrf: current.csrfToken,
      invites: invites.list(),
      createdUrl: createdToken
        ? `${config.server.publicUrl.replace(/\/$/, '')}/register?invite=${encodeURIComponent(createdToken)}`
        : null,
    });

  app.get('/admin/invites', async (request, reply) => {
    const current = requireAdministrator(request);
    return reply.type('text/html').send(await adminInvitesPage(current));
  });

  app.post('/admin/invites', async (request, reply) => {
    const current = requireAdministrator(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    if (body.action === 'create') {
      const token = invites.create(current.user.id, Number.parseInt(body.days ?? '7', 10));
      return reply.type('text/html').send(await adminInvitesPage(current, token));
    }
    if (body.action === 'revoke') {
      invites.revoke(current.user.id, Number.parseInt(body.inviteId ?? '', 10));
      return await reply.redirect('/admin/invites');
    }
    throw new ValidationError('Unknown invite action');
  });

  app.post('/admin/users/:userId', async (request, reply) => {
    const current = requireAdministrator(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const userId = Number.parseInt((request.params as { userId: string }).userId, 10);
    if (body.action === 'disable' || body.action === 'enable')
      administration.setUserStatus(
        current.user.id,
        userId,
        body.action === 'enable' ? 'active' : 'disabled',
      );
    else if (body.action === 'promote' || body.action === 'demote')
      administration.setAdministrator(current.user.id, userId, body.action === 'promote');
    else if (body.action === 'recovery') {
      const account = database.prepare('SELECT username FROM users WHERE id = ?').get(userId) as
        { username: string } | undefined;
      if (!account) throw new ValidationError('User not found');
      const code = recovery.issueAdministratorCode(current.user.id, userId);
      return reply
        .type('text/html')
        .send(await adminUsersPage(current, { username: account.username, code }));
    } else throw new ValidationError('Unknown administrative action');
    return await reply.redirect('/admin/users');
  });

  app.get('/admin/repositories', async (request, reply) => {
    const current = requireAdministrator(request);
    return reply.type('text/html').send(
      await render('admin-repositories', {
        user: current.user,
        csrf: current.csrfToken,
        repositories: administration.repositories(),
      }),
    );
  });

  app.post('/admin/repositories/import', async (request, reply) => {
    const current = requireAdministrator(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const repository = await repositories.importExistingByOwnerName({
      actorUserId: current.user.id,
      ownerType: body.ownerType === 'group' ? 'group' : 'user',
      ownerSlug: body.ownerSlug ?? '',
      slug: body.slug ?? '',
      description: body.description ?? '',
      visibility: body.visibility === 'public' ? 'public' : 'private',
      sourcePath: body.sourcePath ?? '',
    });
    search.enqueue(repository.id);
    return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}`);
  });

  app.get('/admin/audit', async (request, reply) => {
    const current = requireAdministrator(request);
    return reply
      .type('text/html')
      .send(
        await render('admin-audit', { user: current.user, events: administration.auditEvents() }),
      );
  });

  app.get('/admin/search', async (request, reply) => {
    const current = requireAdministrator(request);
    return reply
      .type('text/html')
      .send(await render('admin-search', { user: current.user, status: search.status() }));
  });

  const adminSettingsPage = async (current: ReturnType<typeof requireAdministrator>) =>
    await render('admin-settings', {
      user: current.user,
      csrf: current.csrfToken,
      settings: runtimeSettings.load(),
      providers: {
        oidc:
          config.authentication?.oidc.map((provider) => ({
            id: provider.id,
            name: provider.name,
            issuer: provider.issuer,
            autoCreate: provider.autoCreate,
          })) ?? [],
        ldap: config.authentication?.ldap
          ? {
              enabled: config.authentication.ldap.enabled,
              url: config.authentication.ldap.url,
              autoCreate: config.authentication.ldap.autoCreate,
            }
          : null,
        reverseProxy: config.authentication?.reverseProxy
          ? {
              enabled: config.authentication.reverseProxy.enabled,
              identityHeader: config.authentication.reverseProxy.identityHeader,
              autoCreate: config.authentication.reverseProxy.autoCreate,
            }
          : null,
      },
    });

  app.get('/admin/settings', async (request, reply) => {
    const current = requireAdministrator(request);
    return reply.type('text/html').send(await adminSettingsPage(current));
  });

  app.post('/admin/settings', async (request, reply) => {
    const current = requireAdministrator(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const number = (key: string) => Number(body[key]);
    runtimeSettings.update(current.user.id, {
      registrationMode:
        body.registrationMode === 'open' || body.registrationMode === 'invite'
          ? body.registrationMode
          : 'closed',
      anonymousPublicRepositories: body.anonymousPublicRepositories === 'yes',
      sessionDays: number('sessionDays'),
      repositoryTrashDays: number('repositoryTrashDays'),
      filePreviewBytes: number('filePreviewBytes'),
      diffBytes: number('diffBytes'),
      diffLines: number('diffLines'),
      diffFiles: number('diffFiles'),
      diffFileBytes: number('diffFileBytes'),
      archiveBytes: number('archiveBytes'),
      lfsObjectBytes: number('lfsObjectBytes'),
    } satisfies RuntimeSettings);
    return await reply.redirect('/admin/settings');
  });

  app.get('/admin/plugins/playground', async (request, reply) => {
    const current = requireAdministrator(request);
    return reply.type('text/html').send(await render('plugin-playground', { user: current.user }));
  });

  app.get('/admin/plugins/playground/frame', async (request, reply) => {
    requireAdministrator(request);
    reply.header(
      'content-security-policy',
      "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; sandbox allow-scripts; frame-ancestors 'self'",
    );
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
    return reply.type('text/html')
      .send(`<!doctype html><meta charset="utf-8"><title>Plugin preview</title><main id="preview">Run the plugin to preview its output.</main><script>
const preview = document.querySelector('#preview');
addEventListener('message', async (event) => {
  if (!event.data || event.data.type !== 'playground.run') return;
  const logs = [], storage = new Map();
  const host = Object.freeze({
    repository: Object.freeze({ id: 'test-repository', owner: 'sample', name: 'project', ref: 'main' }),
    log(level, message) { logs.push('[log.' + String(level) + '] ' + String(message)); },
    async readTextFiles() { logs.push('[api] repositoryContents.read'); return [{ path: 'README.md', content: '# Sample project' }, { path: 'src/index.ts', content: 'export const answer = 42;' }]; },
    storage: Object.freeze({ get(key) { logs.push('[api] storage.get ' + String(key)); return storage.get(String(key)); }, set(key, value) { logs.push('[api] storage.set ' + String(key)); storage.set(String(key), value); }, delete(key) { storage.delete(String(key)); } }),
    render(value) { preview.replaceChildren(); const box = document.createElement('div'); box.className = 'plugin-preview'; box.textContent = value && value.label ? String(value.label) + ': ' + String(value.value) : JSON.stringify(value); preview.append(box); },
  });
  try {
    const css = document.createElement('style'); css.textContent = String(event.data.css).slice(0, 50000); document.head.replaceChildren(css);
    JSON.parse(String(event.data.ui));
    const execute = new Function('host', '"use strict"; return (async () => {' + String(event.data.code).slice(0, 100000) + '\n})();');
    await Promise.race([execute(host), new Promise((_, reject) => setTimeout(() => reject(new Error('Execution timed out')), 1500))]);
    parent.postMessage({ type: 'playground.result', ok: true, logs: [...logs, '[event] playground.completed', '[permissions] mocked only'] }, '*');
  } catch (error) { parent.postMessage({ type: 'playground.result', ok: false, logs: [...logs, '[error] ' + String(error && error.message || error)] }, '*'); }
});
</script>`);
  });

  app.get('/docs/plugins/example', async (_request, reply) => {
    const archive = await examplePluginArchive();
    return reply
      .header('content-disposition', 'attachment; filename="repository-word-count-1.0.0.tar.gz"')
      .header('cache-control', 'public, max-age=3600')
      .type('application/gzip')
      .send(archive);
  });

  app.post('/admin/plugins/install', async (request, reply) => {
    const current = requireAdministrator(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    await pluginManager.installLocal(current.user.id, body.source ?? '', {
      trustedRiskAccepted: body.trustedRisk === 'accepted',
    });
    return await reply.redirect('/admin/plugins');
  });

  app.post('/admin/plugins/upload', async (request, reply) => {
    const current = requireAdministrator(request);
    let csrf: string | undefined;
    let trustedRiskAccepted = false;
    let archive: Buffer | undefined;
    let filename = 'uploaded-plugin.tar.gz';
    for await (const part of request.parts()) {
      if (part.type === 'field' && part.fieldname === 'csrf') csrf = String(part.value);
      else if (part.type === 'field' && part.fieldname === 'trustedRisk')
        trustedRiskAccepted = part.value === 'accepted';
      else if (part.type === 'file' && part.fieldname === 'archive') {
        filename = part.filename.slice(0, 200);
        archive = await part.toBuffer();
      }
    }
    auth.verifyCsrf(current.csrfToken, csrf);
    if (!archive) throw new ValidationError('Plugin archive is required');
    await pluginManager.installArchive(current.user.id, archive, filename, {
      trustedRiskAccepted,
    });
    return await reply.redirect('/admin/plugins');
  });

  app.post('/admin/plugins/remote', async (request, reply) => {
    const current = requireAdministrator(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const options = { trustedRiskAccepted: body.trustedRisk === 'accepted' };
    if (body.sourceType === 'git')
      await pluginManager.installGit(
        current.user.id,
        body.source ?? '',
        body.ref ?? 'main',
        options,
      );
    else if (body.sourceType === 'npm')
      await pluginManager.installNpm(current.user.id, body.source ?? '', options);
    else throw new ValidationError('Unknown remote plugin source type');
    return await reply.redirect('/admin/plugins');
  });

  app.post('/admin/plugins/:pluginId/permissions', async (request, reply) => {
    const current = requireAdministrator(request);
    const body = request.body as FormBody;
    const parameters = request.params as { pluginId: string };
    auth.verifyCsrf(current.csrfToken, body.csrf);
    pluginManager.setPermission(
      current.user.id,
      parameters.pluginId,
      body.capability ?? '',
      body.granted === 'yes',
    );
    return await reply.redirect('/admin/plugins');
  });

  app.post('/admin/plugins/:pluginId/enabled', async (request, reply) => {
    const current = requireAdministrator(request);
    const body = request.body as FormBody;
    const parameters = request.params as { pluginId: string };
    auth.verifyCsrf(current.csrfToken, body.csrf);
    pluginManager.setEnabled(
      current.user.id,
      parameters.pluginId,
      body.enabled === 'yes',
      body.trustedRisk === 'accepted',
    );
    return await reply.redirect('/admin/plugins');
  });

  app.post('/admin/plugins/:pluginId/settings', async (request, reply) => {
    const current = requireAdministrator(request);
    const body = request.body as FormBody;
    const parameters = request.params as { pluginId: string };
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const plugin = pluginManager.get(parameters.pluginId);
    for (const [key, schema] of Object.entries(plugin.manifest.settings)) {
      const raw = body[`setting.${key}`] as unknown;
      if (schema.type === 'secret' && !raw) continue;
      const value: unknown =
        schema.type === 'boolean'
          ? raw === 'true'
          : schema.type === 'number'
            ? Number(raw)
            : schema.type === 'multi-select'
              ? (Array.isArray(raw)
                  ? raw.filter((item): item is string => typeof item === 'string')
                  : typeof raw === 'string'
                    ? raw.split(',')
                    : []
                )
                  .map((item) => item.trim())
                  .filter(Boolean)
              : typeof raw === 'string'
                ? raw
                : '';
      pluginManager.setSetting(current.user.id, plugin.id, key, value);
    }
    return await reply.redirect('/admin/plugins');
  });

  app.post('/admin/plugins/:pluginId/remove', async (request, reply) => {
    const current = requireAdministrator(request);
    const body = request.body as FormBody;
    const parameters = request.params as { pluginId: string };
    auth.verifyCsrf(current.csrfToken, body.csrf);
    await pluginManager.remove(current.user.id, parameters.pluginId, body.keepData === 'yes');
    return await reply.redirect('/admin/plugins');
  });

  app.get('/groups', async (request, reply) => {
    const current = requireSession(request);
    return reply
      .type('text/html')
      .send(
        await render('groups', { user: current.user, groups: groups.listForUser(current.user.id) }),
      );
  });

  app.get('/groups/new', async (request, reply) => {
    const current = requireSession(request);
    return reply
      .type('text/html')
      .send(await render('group-new', { user: current.user, csrf: current.csrfToken }));
  });

  app.post('/groups/new', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    groups.create(current.user.id, body.slug ?? '', body.displayName ?? '');
    return await reply.redirect(`/groups/${body.slug?.toLowerCase() ?? ''}/settings`);
  });

  app.get('/groups/:groupSlug/settings', async (request, reply) => {
    const current = requireSession(request);
    const group = groups.getBySlug(
      (request.params as { groupSlug: string }).groupSlug,
      current.user.id,
    );
    return reply.type('text/html').send(
      await render('group-settings', {
        user: current.user,
        csrf: current.csrfToken,
        group,
        canManage: group.role === 'manager' || group.role === 'owner',
      }),
    );
  });

  app.post('/groups/:groupSlug/settings', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const group = groups.getBySlug(
      (request.params as { groupSlug: string }).groupSlug,
      current.user.id,
    );
    if (body.action === 'add')
      groups.addMember(
        current.user.id,
        group.id,
        body.username ?? '',
        body.role === 'owner' ? 'owner' : body.role === 'manager' ? 'manager' : 'member',
      );
    else if (body.action === 'remove')
      groups.removeMember(current.user.id, group.id, Number.parseInt(body.userId ?? '', 10));
    else throw new ValidationError('Invalid group action');
    return await reply.redirect(`/groups/${group.slug}/settings`);
  });

  app.get('/repositories/new', async (request, reply) => {
    const current = requireSession(request);
    return reply.type('text/html').send(
      await render('new-repository', {
        user: current.user,
        csrf: current.csrfToken,
        groups: groups
          .listForUser(current.user.id)
          .filter((group) => group.role === 'owner' || group.role === 'manager'),
      }),
    );
  });
  app.post('/repositories/new', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const visibility: Visibility = body.visibility === 'public' ? 'public' : 'private';
    try {
      const [ownerType, ownerSlug] = (body.owner ?? '').split(':', 2);
      const repository =
        ownerType === 'group' && ownerSlug
          ? await repositories.createForGroup({
              actorUserId: current.user.id,
              ownerGroupId: groups.getBySlug(ownerSlug, current.user.id).id,
              slug: body.slug ?? '',
              description: body.description ?? '',
              visibility,
              initializeReadme: body.initializeReadme === 'yes',
              gitignore: body.gitignore ?? '',
              license: body.license ?? '',
            })
          : await repositories.createForUser({
              actorUserId: current.user.id,
              ownerUserId: current.user.id,
              slug: body.slug ?? '',
              description: body.description ?? '',
              visibility,
              initializeReadme: body.initializeReadme === 'yes',
              gitignore: body.gitignore ?? '',
              license: body.license ?? '',
            });
      search.enqueue(repository.id);
      return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}`);
    } catch (error) {
      return reply
        .code((error as { statusCode?: number }).statusCode ?? 400)
        .type('text/html')
        .send(
          await render('new-repository', {
            user: current.user,
            csrf: current.csrfToken,
            error: safeErrorMessage(error),
            groups: groups
              .listForUser(current.user.id)
              .filter((group) => group.role === 'owner' || group.role === 'manager'),
          }),
        );
    }
  });

  const readableRepository = (request: FastifyRequest) => {
    const parameters = request.params as { owner: string; repository: string };
    const repository = repositories.find(parameters.owner, parameters.repository);
    if (!repository) throw new NotFoundError();
    const current = session(request);
    repositories.require(repository, current?.user.id ?? null, 'read');
    return { repository, current };
  };

  app.get('/search', async (request, reply) => {
    const current = session(request);
    const query = (request.query as { q?: string }).q ?? '';
    const results = query ? search.search(query, current?.user.id ?? null) : [];
    const directoryResults = query ? search.searchDirectory(query, current?.user.id ?? null) : [];
    const documentationResults = query ? await documentationSearch(query) : [];
    return reply.type('text/html').send(
      await render('search', {
        user: current?.user ?? null,
        query,
        results,
        directoryResults,
        documentationResults,
      }),
    );
  });

  app.get('/docs', async (request, reply) => {
    const current = session(request);
    const page = await documentationPage('getting-started');
    return reply.type('text/html').send(
      await render('docs', {
        user: current?.user ?? null,
        documents: documentation,
        slug: 'getting-started',
        html: page.html,
        title: page.title,
      }),
    );
  });

  app.get('/docs/:slug', async (request, reply) => {
    const current = session(request);
    const slug = (request.params as { slug: string }).slug;
    const page = await documentationPage(slug);
    return reply.type('text/html').send(
      await render('docs', {
        user: current?.user ?? null,
        documents: documentation,
        slug,
        html: page.html,
        title: page.title,
      }),
    );
  });

  app.get(
    '/api/v1/palette',
    {
      schema: apiContract('navigation', {
        query: {
          type: 'object',
          additionalProperties: false,
          properties: { q: { type: 'string', maxLength: 200 } },
        },
        response: paletteResponse,
      }),
    },
    async (request, reply) => {
      const current = requireSession(request);
      const query = ((request.query as { q?: string }).q ?? '').trim();
      const normalized = query.toLocaleLowerCase();
      const fixed = [
        {
          title: 'Create repository',
          subtitle: 'Action',
          url: '/repositories/new',
          keywords: 'new create repository',
        },
        {
          title: 'Profile',
          subtitle: 'Settings',
          url: '/settings/profile',
          keywords: 'avatar display name email privacy',
        },
        {
          title: 'Git credentials',
          subtitle: 'Settings',
          url: '/settings/credentials',
          keywords: 'token ssh key passkey',
        },
        {
          title: 'Appearance',
          subtitle: 'Settings',
          url: '/settings/appearance',
          keywords: 'theme light dark font accent',
        },
        {
          title: 'Getting Started',
          subtitle: 'Documentation',
          url: '/docs/getting-started',
          keywords: 'install clone push git',
        },
        {
          title: 'Plugin documentation',
          subtitle: 'Documentation',
          url: '/docs/plugins',
          keywords: 'plugin sdk manifest permissions',
        },
        ...(current.user.isAdmin
          ? [
              {
                title: 'Administration',
                subtitle: 'Settings',
                url: '/admin',
                keywords: 'users repositories security system',
              },
              {
                title: 'Application settings',
                subtitle: 'Administration',
                url: '/admin/settings',
                keywords: 'registration authentication security limits anonymous trash sessions',
              },
              {
                title: 'Manage plugins',
                subtitle: 'Administration',
                url: '/admin/plugins',
                keywords: 'install enable plugin settings',
              },
            ]
          : []),
      ].filter(
        (item) =>
          !normalized || `${item.title} ${item.keywords}`.toLocaleLowerCase().includes(normalized),
      );
      const repositoryResults = query
        ? search.search(query, current.user.id, 12).map((result) => ({
            title: result.title,
            subtitle: `${result.owner}/${result.repository} · ${result.type}`,
            url: result.url,
          }))
        : [];
      const directoryResults = query
        ? search.searchDirectory(query, current.user.id, 8).map((result) => ({
            title: result.title,
            subtitle: `${result.type} · ${result.subtitle}`,
            url: result.url,
          }))
        : [];
      const pluginResults = pluginContributions
        .commands()
        .filter((command) => !normalized || command.title.toLocaleLowerCase().includes(normalized))
        .map((command) => ({
          title: command.title,
          subtitle: command.pluginName,
          url: command.url,
        }));
      const pluginSearchResults = await pluginContributions.searchProviders(query, current.user);
      const documentationResults = query ? await documentationSearch(query, 8) : [];
      return reply.send({
        items: [
          ...fixed,
          ...directoryResults,
          ...repositoryResults,
          ...documentationResults,
          ...pluginResults,
          ...pluginSearchResults,
        ].slice(0, 30),
      });
    },
  );

  const writableRepository = (request: FastifyRequest) => {
    const { repository, current } = readableRepository(request);
    if (!current) throw new AuthorizationError();
    repositories.require(repository, current.user.id, 'write');
    return { repository, current };
  };

  app.get('/:owner/:repository/settings', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    if (!current) throw new AuthorizationError();
    repositories.require(repository, current.user.id, 'admin');
    return reply.type('text/html').send(
      await render('repository-settings', {
        user: current.user,
        csrf: current.csrfToken,
        repository,
        grants: repositoryAdmin.grants(repository, current.user.id),
      }),
    );
  });

  app.post('/:owner/:repository/settings', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    if (!current) throw new AuthorizationError();
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    let updated = repository;
    if (body.action === 'details') {
      updated = await repositoryAdmin.updateDetails(
        repository,
        current.user.id,
        body.description ?? '',
        body.defaultBranch ?? '',
      );
      updated = repositoryAdmin.changeVisibility(
        updated,
        current.user.id,
        body.visibility === 'public' ? 'public' : 'private',
      );
    } else if (body.action === 'grant') {
      const principalType = body.principalType === 'group' ? 'group' : 'user';
      const level = body.level === 'admin' ? 'admin' : body.level === 'write' ? 'write' : 'read';
      repositoryAdmin.setGrantByName(
        repository,
        current.user.id,
        principalType,
        body.principalName ?? '',
        level,
      );
    } else if (body.action === 'removeGrant') {
      repositoryAdmin.removeGrant(
        repository,
        current.user.id,
        body.principalType === 'group' ? 'group' : 'user',
        Number.parseInt(body.principalId ?? '', 10),
      );
    } else if (body.action === 'rename') {
      updated = repositoryAdmin.rename(repository, current.user.id, body.slug ?? '');
    } else if (body.action === 'transfer') {
      updated = repositoryAdmin.transfer(
        repository,
        current.user.id,
        body.ownerType === 'group' ? 'group' : 'user',
        body.ownerSlug ?? '',
      );
    } else if (body.action === 'delete') {
      if (body.confirmation !== repository.slug)
        throw new ValidationError('Repository confirmation did not match');
      await repositoryAdmin.delete(repository, current.user.id);
      return await reply.redirect('/');
    } else throw new ValidationError('Invalid repository settings action');
    search.enqueue(updated.id);
    return await reply.redirect(`/${updated.ownerSlug}/${updated.slug}/settings`);
  });

  app.get('/:owner/:repository/files/new', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const query = request.query as { ref?: string; path?: string };
    return reply.type('text/html').send(
      await render('edit-file', {
        user: current.user,
        repository,
        csrf: current.csrfToken,
        exists: false,
        path: query.path ?? '',
        ref: query.ref ?? repository.defaultBranch,
        content: '',
      }),
    );
  });

  app.get('/:owner/:repository/files/upload', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const query = request.query as { ref?: string; path?: string };
    return reply.type('text/html').send(
      await render('upload-files', {
        user: current.user,
        repository,
        csrf: current.csrfToken,
        ref: query.ref ?? repository.defaultBranch,
        path: query.path ?? '',
      }),
    );
  });

  app.post('/:owner/:repository/files/upload', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const fields = new Map<string, string>();
    const uploads: { filename: string; content: Buffer }[] = [];
    let totalBytes = 0;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (!part.filename || /[/\\\0]/.test(part.filename))
          throw new ValidationError('Invalid uploaded filename');
        const content = await part.toBuffer();
        totalBytes += content.length;
        if (totalBytes > config.limits.requestBodyBytes) throw new PayloadTooLargeError();
        uploads.push({ filename: part.filename, content });
      } else if (typeof part.value === 'string') fields.set(part.fieldname, part.value);
    }
    auth.verifyCsrf(current.csrfToken, fields.get('csrf'));
    const directory = fields.get('path')?.replace(/^\/+|\/+$/g, '') ?? '';
    await mutations.commitFiles({
      repository,
      actorUserId: current.user.id,
      branch: fields.get('ref') ?? repository.defaultBranch,
      files: uploads.map((upload) => ({
        path: directory ? `${directory}/${upload.filename}` : upload.filename,
        content: upload.content,
      })),
      message: fields.get('message') ?? '',
    });
    const destination = directory
      ? `/${repository.ownerSlug}/${repository.slug}/tree/${directory.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(fields.get('ref') ?? repository.defaultBranch)}`
      : `/${repository.ownerSlug}/${repository.slug}`;
    return await reply.redirect(destination);
  });

  app.post('/:owner/:repository/files/new', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const path = body.path ?? '';
    const branch = body.branch ?? repository.defaultBranch;
    await mutations.commitFile({
      repository,
      actorUserId: current.user.id,
      branch,
      filePath: path,
      content: Buffer.from(body.content ?? '', 'utf8'),
      message: body.message ?? '',
    });
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    return await reply.redirect(
      `/${repository.ownerSlug}/${repository.slug}/blob/${encodedPath}?ref=${encodeURIComponent(branch)}`,
    );
  });

  app.get('/:owner/:repository/edit/*', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const parameters = request.params as { '*': string };
    const query = request.query as { ref?: string };
    const ref = query.ref ?? repository.defaultBranch;
    const content = await repositories.readBlob(repository, ref, parameters['*']);
    if (isBinary(content))
      throw new ValidationError('Binary files cannot be edited in the browser');
    return reply.type('text/html').send(
      await render('edit-file', {
        user: current.user,
        repository,
        csrf: current.csrfToken,
        exists: true,
        path: parameters['*'],
        ref,
        content: content.toString('utf8'),
      }),
    );
  });

  app.post('/:owner/:repository/edit/*', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const parameters = request.params as { '*': string };
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const branch = body.branch ?? repository.defaultBranch;
    const deleting = body.action === 'delete';
    await mutations.commitFile({
      repository,
      actorUserId: current.user.id,
      branch,
      filePath: parameters['*'],
      ...(deleting ? {} : { content: Buffer.from(body.content ?? '', 'utf8') }),
      message: body.message ?? '',
    });
    if (deleting) {
      return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}`);
    }
    const encodedPath = parameters['*'].split('/').map(encodeURIComponent).join('/');
    return await reply.redirect(
      `/${repository.ownerSlug}/${repository.slug}/blob/${encodedPath}?ref=${encodeURIComponent(branch)}`,
    );
  });

  app.get('/:owner/:repository/tree/*', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const parameters = request.params as { '*': string };
    const query = request.query as { ref?: string };
    const directory = parameters['*'];
    const ref = query.ref ?? repository.defaultBranch;
    const submodules = await repositories.submoduleUrls(repository, ref);
    const entries = (await repositories.listTree(repository, ref, directory)).map((entry) =>
      presentTreeEntry(entry, submodules),
    );
    return reply.type('text/html').send(
      await render('tree', {
        user: current?.user ?? null,
        repository,
        entries,
        ref,
        ...(await referenceOptions(repository)),
        breadcrumbs: breadcrumbs(directory),
      }),
    );
  });

  app.get('/:owner/:repository/blob/*', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const parameters = request.params as { '*': string };
    const query = request.query as { ref?: string; large?: string };
    const path = parameters['*'];
    const ref = query.ref ?? repository.defaultBranch;
    let content: Buffer;
    try {
      content = await repositories.readBlob(repository, ref, path, {
        allowLarge: query.large === '1',
      });
    } catch (error) {
      if (!(error instanceof PayloadTooLargeError)) throw error;
      return reply.type('text/html').send(
        await render('blob', {
          user: current?.user ?? null,
          repository,
          ref,
          path,
          encodedPath: path.split('/').map(encodeURIComponent).join('/'),
          breadcrumbs: breadcrumbs(path),
          size: error.bytes,
          kind: 'too-large',
          canLoadLarge:
            query.large !== '1' &&
            error.bytes !== null &&
            error.bytes <= config.limits.gitOutputBytes,
          ...(await referenceOptions(repository)),
          pluginRenderers: [],
          canWrite: false,
          canAdmin: false,
        }),
      );
    }
    const binary = isBinary(content);
    const markdown = !binary && isMarkdown(path);
    const image = isSafeImage(path);
    const lfsPointer = parseLfsPointer(content);
    return reply.type('text/html').send(
      await render('blob', {
        user: current?.user ?? null,
        repository,
        ref,
        path,
        encodedPath: path.split('/').map(encodeURIComponent).join('/'),
        breadcrumbs: breadcrumbs(path),
        size: content.length,
        ...(await referenceOptions(repository)),
        imageMetadata: image ? imageMetadata(content, path) : null,
        kind: lfsPointer
          ? 'lfs'
          : markdown
            ? 'markdown'
            : image
              ? 'image'
              : binary
                ? 'binary'
                : 'text',
        lfsPointer,
        lfsAvailable: lfsPointer ? lfs.isAvailable(repository.id, lfsPointer.objectId) : false,
        rendered: markdown
          ? renderMarkdown(
              await pluginContributions.transformMarkdown(
                repository,
                current?.user.id ?? null,
                ref,
                path,
                content.toString('utf8'),
              ),
            )
          : '',
        lines: !binary && !markdown ? highlightSource(content.toString('utf8'), path) : [],
        pluginRenderers: pluginContributions.fileRenderers(
          repository,
          current?.user.id ?? null,
          path,
        ),
        canWrite:
          current !== null &&
          !['none', 'read'].includes(repositories.permission(repository, current.user.id)),
        canAdmin:
          current !== null &&
          ['admin', 'owner'].includes(repositories.permission(repository, current.user.id)),
      }),
    );
  });

  app.get('/:owner/:repository/raw/*', async (request, reply) => {
    const { repository } = readableRepository(request);
    const parameters = request.params as { '*': string };
    const query = request.query as { ref?: string; download?: string };
    const path = parameters['*'];
    const ref = query.ref ?? repository.defaultBranch;
    const content = await repositories.readBlob(repository, ref, path, { allowLarge: true });
    const filename = path.split('/').at(-1) ?? 'download';
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header(
      'Cache-Control',
      repository.visibility === 'public' ? 'public, max-age=60' : 'private, no-store',
    );
    if (query.download === '1' || (isBinary(content) && !isSafeImage(path))) {
      reply.header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
    }
    return reply.type(safeInlineMime(path)).send(content);
  });

  app.get('/:owner/:repository/commits', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const query = request.query as { page?: string; ref?: string };
    const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
    const ref = query.ref ?? repository.defaultBranch;
    const commits = (await browser.commits(repository, ref, page)).map((commit) => ({
      ...withAuthorAvatar(commit),
      relativeDate: relativeDate(commit.authoredAt),
    }));
    return reply.type('text/html').send(
      await render('commits', {
        user: current?.user ?? null,
        repository,
        commits,
        ref,
        page,
        ...(await referenceOptions(repository)),
      }),
    );
  });

  app.get('/:owner/:repository/history/*', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const parameters = request.params as { '*': string };
    const query = request.query as { page?: string; ref?: string };
    const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
    const ref = query.ref ?? repository.defaultBranch;
    const path = parameters['*'];
    const commits = (await browser.fileHistory(repository, ref, path, page)).map((commit) => ({
      ...withAuthorAvatar(commit),
      relativeDate: relativeDate(commit.authoredAt),
    }));
    return reply.type('text/html').send(
      await render('file-history', {
        user: current?.user ?? null,
        repository,
        path,
        encodedPath: path.split('/').map(encodeURIComponent).join('/'),
        commits,
        ref,
        page,
        ...(await referenceOptions(repository)),
      }),
    );
  });

  app.get('/:owner/:repository/commit/:objectId', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const parameters = request.params as { objectId: string };
    const commit = withAuthorAvatar(
      await browser.commit(repository, parameters.objectId, {
        lineLimit: Math.min(2500, config.limits.diffLines),
        byteLimit: Math.min(2 * 1024 * 1024, config.limits.diffBytes),
      }),
    );
    const diffFiles = [];
    for (const [index, file] of commit.diffFiles.entries()) {
      if (
        index >= 20 ||
        !file.binary ||
        (!isSafeImage(file.oldPath) && !isSafeImage(file.newPath))
      ) {
        diffFiles.push(file);
        continue;
      }
      const oldRef = commit.parents[0];
      const oldContent = oldRef
        ? await repositories.readBlob(repository, oldRef, file.oldPath).catch((error: unknown) => {
            if (error instanceof NotFoundError) return null;
            throw error;
          })
        : null;
      const newContent = await repositories
        .readBlob(repository, commit.objectId, file.newPath)
        .catch((error: unknown) => {
          if (error instanceof NotFoundError) return null;
          throw error;
        });
      diffFiles.push({
        ...file,
        imageDiff: {
          old: oldContent && oldRef ? imageDiffSide(file.oldPath, oldRef, oldContent) : null,
          new: newContent ? imageDiffSide(file.newPath, commit.objectId, newContent) : null,
        },
      });
    }
    return reply.type('text/html').send(
      await render('commit', {
        user: current?.user ?? null,
        repository,
        commit: { ...commit, diffFiles },
      }),
    );
  });

  app.get(
    '/api/v1/repositories/:owner/:repository/commits/:objectId/diff',
    {
      schema: apiContract('commits', {
        authenticated: false,
        params: {
          type: 'object',
          required: ['owner', 'repository', 'objectId'],
          properties: {
            owner: { type: 'string' },
            repository: { type: 'string' },
            objectId: { type: 'string' },
          },
        },
        query: {
          type: 'object',
          properties: {
            lines: { type: 'integer', minimum: 1 },
            full: { type: 'string', enum: ['1'] },
          },
        },
        response: progressiveDiffResponse,
      }),
    },
    async (request, reply) => {
      const { repository } = readableRepository(request);
      const parameters = request.params as { objectId: string };
      const query = request.query as { lines?: string; full?: string };
      const requested = Number.parseInt(query.lines ?? '5000', 10);
      const lineLimit =
        query.full === '1'
          ? config.limits.diffLines
          : Math.min(
              Math.max(Number.isFinite(requested) ? requested : 5000, 1),
              config.limits.diffLines,
            );
      const commit = await browser.commit(repository, parameters.objectId, {
        lineLimit,
        byteLimit: config.limits.diffBytes,
      });
      return reply.send({
        diff: commit.diff,
        additions: commit.additions,
        deletions: commit.deletions,
        filesChanged: commit.filesChanged,
        truncated: commit.truncated,
        shownLines: commit.diff.split('\n').length,
        hardLineLimit: config.limits.diffLines,
        hardFileLimit: config.limits.diffFiles,
        hardFileByteLimit: config.limits.diffFileBytes,
        files: commit.diffFiles,
      });
    },
  );

  app.get('/:owner/:repository/branches', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const refs = (await browser.branches(repository)).map((ref) => ({
      ...ref,
      relativeDate: relativeDate(ref.committedAt),
    }));
    const canWrite =
      current !== null &&
      !['none', 'read'].includes(repositories.permission(repository, current.user.id));
    return reply.type('text/html').send(
      await render('refs', {
        user: current?.user ?? null,
        repository,
        refs,
        kind: 'Branches',
        canWrite,
        csrf: current?.csrfToken ?? '',
      }),
    );
  });

  app.post('/:owner/:repository/branches', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    await mutations.createBranch(
      repository,
      current.user.id,
      body.name ?? '',
      body.source ?? repository.defaultBranch,
    );
    return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}/branches`);
  });

  app.post('/:owner/:repository/branches/delete', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    await mutations.deleteBranch(repository, current.user.id, body.name ?? '');
    return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}/branches`);
  });

  app.get('/:owner/:repository/tags', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const refs = (await browser.tags(repository)).map((ref) => ({
      ...ref,
      relativeDate: relativeDate(ref.committedAt),
    }));
    const canWrite =
      current !== null &&
      !['none', 'read'].includes(repositories.permission(repository, current.user.id));
    return reply.type('text/html').send(
      await render('refs', {
        user: current?.user ?? null,
        repository,
        refs,
        kind: 'Tags',
        canWrite,
        csrf: current?.csrfToken ?? '',
      }),
    );
  });

  app.post('/:owner/:repository/tags', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    await mutations.createTag(
      repository,
      current.user.id,
      body.name ?? '',
      body.source ?? repository.defaultBranch,
    );
    return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}/tags`);
  });

  app.post('/:owner/:repository/tags/delete', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const body = request.body as FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    await mutations.deleteTag(repository, current.user.id, body.name ?? '');
    return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}/tags`);
  });

  app.get('/:owner/:repository/compare', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const query = request.query as { base?: string; head?: string };
    const baseInput = query.base ?? repository.defaultBranch;
    const headInput = query.head ?? repository.defaultBranch;
    const comparison = await browser.compare(repository, baseInput, headInput);
    return reply.type('text/html').send(
      await render('compare', {
        user: current?.user ?? null,
        repository,
        comparison,
        baseInput,
        headInput,
      }),
    );
  });

  app.get('/:owner/:repository/blame/*', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const parameters = request.params as { '*': string };
    const query = request.query as { ref?: string };
    const ref = query.ref ?? repository.defaultBranch;
    const lines = await browser.blame(repository, ref, parameters['*']);
    return reply.type('text/html').send(
      await render('blame', {
        user: current?.user ?? null,
        repository,
        lines,
        ref,
        path: parameters['*'],
      }),
    );
  });

  app.get('/:owner/:repository/archive', async (request, reply) => {
    const { repository } = readableRepository(request);
    const query = request.query as { ref?: string; format?: string };
    const format = query.format === 'tar.gz' ? 'tar.gz' : query.format === 'zip' ? 'zip' : null;
    if (!format) throw new ValidationError('Archive format must be zip or tar.gz');
    const ref = query.ref ?? repository.defaultBranch;
    const archive = await archives.create(repository, ref, format);
    const filename = `${repository.slug}-${archive.objectId.slice(0, 8)}.${archive.extension}`;
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header('Cache-Control', 'private, no-store');
    return reply.type(archive.contentType).send(archive.stream);
  });

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

  app.post('/:owner/:repository.git/info/lfs/objects/batch', async (request, reply) => {
    const body = request.body as { operation?: string; objects?: unknown[] };
    const operation =
      body.operation === 'upload' ? 'upload' : body.operation === 'download' ? 'download' : null;
    if (!operation || !Array.isArray(body.objects))
      throw new ValidationError('Invalid LFS batch request');
    const { repository } = lfsRepository(request, operation === 'upload' ? 'write' : 'read');
    const objects: LfsBatchObject[] = body.objects.map((value) => {
      if (typeof value !== 'object' || value === null)
        throw new ValidationError('Invalid LFS object');
      const candidate = value as { oid?: unknown; size?: unknown };
      if (typeof candidate.oid !== 'string' || typeof candidate.size !== 'number') {
        throw new ValidationError('Invalid LFS object');
      }
      return { oid: candidate.oid, size: candidate.size };
    });
    return reply
      .type('application/vnd.git-lfs+json')
      .send({ transfer: 'basic', objects: lfs.prepareBatch(repository, operation, objects) });
  });

  app.put('/:owner/:repository.git/info/lfs/objects/:objectId', async (request, reply) => {
    const { repository } = lfsRepository(request, 'write');
    const parameters = request.params as { objectId: string };
    await lfs.upload(
      repository,
      parameters.objectId,
      request.body as NodeJS.ReadableStream as import('node:stream').Readable,
    );
    return reply.code(200).send();
  });

  app.get('/:owner/:repository.git/info/lfs/objects/:objectId', async (request, reply) => {
    const { repository } = lfsRepository(request, 'read');
    const parameters = request.params as { objectId: string };
    const object = await lfs.download(repository, parameters.objectId);
    return reply
      .header('Content-Length', String(object.size))
      .header(
        'Cache-Control',
        repository.visibility === 'public'
          ? 'public, max-age=31536000, immutable'
          : 'private, no-store',
      )
      .type('application/octet-stream')
      .send(object.stream);
  });

  app.get('/:owner/:repository/commits.atom', async (request, reply) => {
    const parameters = request.params as { owner: string; repository: string };
    const repository = repositories.find(parameters.owner, parameters.repository);
    if (!repository) throw new NotFoundError();
    const browserSession = session(request);
    const tokenPrincipal = gitPrincipal(request, 'repository:read');
    const userId = browserSession?.user.id ?? tokenPrincipal?.userId ?? null;
    repositories.require(repository, userId, 'read');
    const commits = await browser.commits(repository, repository.defaultBranch, 1, 30);
    return reply
      .type('application/atom+xml; charset=utf-8')
      .header(
        'Cache-Control',
        repository.visibility === 'public' ? 'public, max-age=60' : 'private, no-store',
      )
      .send(atomFeed({ repository, commits, publicUrl: config.server.publicUrl }));
  });

  app.get('/:owner/:repository.git/info/refs', async (request, reply) => {
    const parameters = request.params as { owner: string; repository: string };
    const query = request.query as { service?: string };
    const repository = repositories.find(parameters.owner, parameters.repository);
    if (!repository) return gitAuthenticationRequired(reply);
    const write = query.service === 'git-receive-pack';
    const principal = gitPrincipal(request, write ? 'repository:write' : 'repository:read');
    const permission = repositories.permission(repository, principal?.userId ?? null);
    const levels = { none: 0, read: 1, write: 2, admin: 3, owner: 4 };
    if (levels[permission] < (write ? 2 : 1)) return gitAuthenticationRequired(reply);
    if (write && repository.storageKind === 'working_tree')
      return reply.code(403).send('Working-tree repositories are browse-only.');
    await serveSmartHttp(
      config,
      await repositories.storagePath(repository),
      {
        method: 'GET',
        pathSuffix: 'info/refs',
        ...(query.service ? { queryService: query.service } : {}),
        ...(principal ? { authenticatedUserId: principal.userId } : {}),
      },
      reply,
    );
  });

  app.post('/:owner/:repository.git/:service', async (request, reply) => {
    const parameters = request.params as { owner: string; repository: string; service: string };
    if (!['git-upload-pack', 'git-receive-pack'].includes(parameters.service))
      throw new NotFoundError();
    const repository = repositories.find(parameters.owner, parameters.repository);
    if (!repository) return gitAuthenticationRequired(reply);
    const write = parameters.service === 'git-receive-pack';
    const principal = gitPrincipal(request, write ? 'repository:write' : 'repository:read');
    const permission = repositories.permission(repository, principal?.userId ?? null);
    const levels = { none: 0, read: 1, write: 2, admin: 3, owner: 4 };
    if (levels[permission] < (write ? 2 : 1)) return gitAuthenticationRequired(reply);
    if (write && repository.storageKind === 'working_tree')
      return reply.code(403).send('Working-tree repositories are browse-only.');
    await serveSmartHttp(
      config,
      await repositories.storagePath(repository),
      {
        method: 'POST',
        pathSuffix: parameters.service,
        ...(request.headers['content-type']
          ? { contentType: request.headers['content-type'] }
          : {}),
        ...(request.headers['content-length']
          ? { contentLength: request.headers['content-length'] }
          : {}),
        body: request.body as NodeJS.ReadableStream as import('node:stream').Readable,
        ...(principal ? { authenticatedUserId: principal.userId } : {}),
      },
      reply,
    );
    if (write) {
      search.enqueue(repository.id);
      pluginEvents.publish('repository.pushed', {
        repositoryId: repository.id,
        owner: repository.ownerSlug,
        repository: repository.slug,
        visibility: repository.visibility,
      });
    }
  });

  app.get(
    '/api/v1/search',
    {
      schema: apiContract('search', {
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
        response: searchResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'repository:read');
      const query = request.query as { q: string; limit?: number };
      const limit = query.limit ?? 30;
      return reply.send({
        items: search.search(query.q, principal?.userId ?? null, limit),
        directory: search.searchDirectory(query.q, principal?.userId ?? null, Math.min(limit, 30)),
        documentation: await documentationSearch(query.q, Math.min(limit, 30)),
      });
    },
  );

  app.get(
    '/api/v1/repositories',
    {
      schema: apiContract('repositories', {
        authenticated: false,
        response: repositoryListResponse,
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
        visibility?: Visibility;
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
        .map(repositoryJson);
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
      schema: apiContract('repositories', {
        success: 201,
        body: repositoryCreateBody,
        response: repositoryResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'repository:write');
      if (!principal) throw new AuthorizationError();
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
        throw new ValidationError('Valid owner, name, description, and visibility are required');
      let repository;
      if (body.ownerType === 'group') {
        const group = groups.getBySlug(body.owner, principal.userId);
        repository = await repositories.createForGroup({
          actorUserId: principal.userId,
          ownerGroupId: group.id,
          slug: body.name,
          description: body.description ?? '',
          visibility: body.visibility as Visibility,
          initializeReadme: body.initializeReadme === true,
          gitignore: typeof body.gitignore === 'string' ? body.gitignore : '',
          license: typeof body.license === 'string' ? body.license : '',
        });
      } else {
        const account = database
          .prepare("SELECT username FROM users WHERE id = ? AND status = 'active'")
          .get(principal.userId) as { username: string } | undefined;
        if (account?.username !== body.owner.toLowerCase()) throw new AuthorizationError();
        repository = await repositories.createForUser({
          actorUserId: principal.userId,
          ownerUserId: principal.userId,
          slug: body.name,
          description: body.description ?? '',
          visibility: body.visibility as Visibility,
          initializeReadme: body.initializeReadme === true,
          gitignore: typeof body.gitignore === 'string' ? body.gitignore : '',
          license: typeof body.license === 'string' ? body.license : '',
        });
      }
      search.enqueue(repository.id);
      return reply.code(201).send(repositoryJson(repository));
    },
  );

  app.get(
    '/api/v1/repositories/:owner/:repository',
    {
      schema: apiContract('repositories', {
        authenticated: false,
        params: repositoryParameters,
        response: repositoryResponse,
      }),
    },
    async (request, reply) => {
      const parameters = request.params as { owner: string; repository: string };
      const repository = repositories.find(parameters.owner, parameters.repository);
      if (!repository) throw new NotFoundError();
      const principal = apiPrincipal(request, 'repository:read');
      repositories.require(repository, principal?.userId ?? null, 'read');
      return reply.send(repositoryJson(repository));
    },
  );

  app.get(
    '/api/v1/repositories/:owner/:repository/commits',
    {
      schema: apiContract('commits', {
        authenticated: false,
        params: repositoryParameters,
        query: {
          type: 'object',
          properties: { ref: { type: 'string' }, page: { type: 'integer', minimum: 1 } },
        },
        response: commitListResponse,
      }),
    },
    async (request, reply) => {
      const parameters = request.params as { owner: string; repository: string };
      const query = request.query as { ref?: string; page?: number };
      const repository = repositories.find(parameters.owner, parameters.repository);
      if (!repository) throw new NotFoundError();
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
      schema: apiContract('commits', {
        authenticated: false,
        params: repositoryWildcardParameters,
        query: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ref: { type: 'string', maxLength: 255 },
            page: { type: 'integer', minimum: 1 },
          },
        },
        response: commitListResponse,
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
      schema: apiContract('repositories', {
        params: repositoryParameters,
        body: repositoryUpdateBody,
        response: repositoryResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new AuthorizationError();
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
          throw new ValidationError('Invalid repository details');
        updated = await repositoryAdmin.updateDetails(
          updated,
          principal.userId,
          body.description ?? updated.description,
          body.defaultBranch ?? updated.defaultBranch,
        );
      }
      if (body.visibility !== undefined) {
        if (body.visibility !== 'public' && body.visibility !== 'private')
          throw new ValidationError('Invalid visibility');
        updated = repositoryAdmin.changeVisibility(updated, principal.userId, body.visibility);
      }
      if (body.name !== undefined) {
        if (typeof body.name !== 'string') throw new ValidationError('Invalid repository name');
        updated = repositoryAdmin.rename(updated, principal.userId, body.name);
      }
      if (body.owner !== undefined || body.ownerType !== undefined) {
        if (
          typeof body.owner !== 'string' ||
          (body.ownerType !== 'user' && body.ownerType !== 'group')
        )
          throw new ValidationError('owner and ownerType are required for transfer');
        updated = repositoryAdmin.transfer(updated, principal.userId, body.ownerType, body.owner);
      }
      return reply.send(repositoryJson(updated));
    },
  );

  app.delete(
    '/api/v1/repositories/:owner/:repository',
    {
      schema: apiContract('repositories', {
        success: 204,
        params: repositoryParameters,
        query: {
          type: 'object',
          required: ['confirm'],
          properties: { confirm: { type: 'string' } },
        },
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new AuthorizationError();
      const confirmation = (request.query as { confirm?: string }).confirm;
      if (confirmation !== `${repository.ownerSlug}/${repository.slug}`)
        throw new ValidationError('Exact owner/repository confirmation is required');
      await repositoryAdmin.delete(repository, principal.userId);
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/repositories/:owner/:repository/collaborators',
    {
      schema: apiContract('repositories', {
        params: repositoryParameters,
        response: collaboratorListResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new AuthorizationError();
      return reply.send({ items: repositoryAdmin.grants(repository, principal.userId) });
    },
  );

  app.put(
    '/api/v1/repositories/:owner/:repository/collaborators',
    {
      schema: apiContract('repositories', {
        params: repositoryParameters,
        body: collaboratorBody,
        response: okResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new AuthorizationError();
      const body = request.body as { type?: unknown; name?: unknown; permission?: unknown };
      if (
        !['user', 'group'].includes(typeof body.type === 'string' ? body.type : '') ||
        typeof body.name !== 'string' ||
        !['read', 'write', 'admin'].includes(
          typeof body.permission === 'string' ? body.permission : '',
        )
      )
        throw new ValidationError('Valid collaborator type, name, and permission are required');
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
      schema: apiContract('repositories', {
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
      if (!principal) throw new AuthorizationError();
      const parameters = request.params as { type: string; principalId: string };
      const principalId = Number.parseInt(parameters.principalId, 10);
      if (
        !['user', 'group'].includes(parameters.type) ||
        !Number.isSafeInteger(principalId) ||
        principalId <= 0
      )
        throw new ValidationError('Invalid collaborator');
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
    '/api/v1/repositories/:owner/:repository/tree',
    {
      schema: apiContract('repositories', {
        authenticated: false,
        params: repositoryParameters,
        response: treeResponse,
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
        presentTreeEntry(entry, submodules),
      );
      return reply.send({ items, ref, path: query.path ?? '' });
    },
  );

  app.get(
    '/api/v1/repositories/:owner/:repository/blob/*',
    {
      schema: apiContract('repositories', {
        authenticated: false,
        params: repositoryWildcardParameters,
        response: blobResponse,
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
      schema: apiContract('repositories', {
        params: repositoryWildcardParameters,
        query: {
          type: 'object',
          additionalProperties: false,
          properties: { ref: { type: 'string', maxLength: 255 } },
        },
        response: blameResponse,
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
      schema: apiContract('commits', {
        authenticated: false,
        response: commitDetailResponse,
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
        schema: apiContract('refs', {
          authenticated: false,
          params: repositoryParameters,
          response: refListResponse,
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
      schema: apiContract('commits', {
        authenticated: false,
        params: repositoryParameters,
        response: comparisonResponse,
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
      if (!query.base || !query.head) throw new ValidationError('base and head are required');
      return reply.send(await browser.compare(repository, query.base, query.head));
    },
  );

  app.post(
    '/api/v1/repositories/:owner/:repository/branches',
    {
      schema: apiContract('refs', {
        success: 201,
        params: repositoryParameters,
        body: refCreateBody,
        response: okResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new AuthorizationError();
      const body = request.body as { name?: unknown; source?: unknown };
      if (typeof body.name !== 'string' || typeof body.source !== 'string')
        throw new ValidationError('name and source are required');
      await mutations.createBranch(repository, principal.userId, body.name, body.source);
      return reply.code(201).send({ ok: true });
    },
  );

  app.post(
    '/api/v1/repositories/:owner/:repository/tags',
    {
      schema: apiContract('refs', {
        success: 201,
        params: repositoryParameters,
        body: refCreateBody,
        response: okResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new AuthorizationError();
      const body = request.body as { name?: unknown; source?: unknown };
      if (typeof body.name !== 'string' || typeof body.source !== 'string')
        throw new ValidationError('name and source are required');
      await mutations.createTag(repository, principal.userId, body.name, body.source);
      return reply.code(201).send({ ok: true });
    },
  );

  app.delete(
    '/api/v1/repositories/:owner/:repository/branches/:name',
    {
      schema: apiContract('refs', {
        success: 204,
        params: stringPathParameters('owner', 'repository', 'name'),
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new AuthorizationError();
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
      schema: apiContract('refs', {
        success: 204,
        params: stringPathParameters('owner', 'repository', 'name'),
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new AuthorizationError();
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
      schema: apiContract('repositories', {
        success: 201,
        params: repositoryWildcardParameters,
        body: fileWriteBody,
        response: objectIdResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new AuthorizationError();
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
        throw new ValidationError('branch, message, and valid base64 content are required');
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
      schema: apiContract('repositories', {
        params: repositoryWildcardParameters,
        body: fileDeleteBody,
        response: objectIdResponse,
      }),
    },
    async (request, reply) => {
      const { repository, principal } = apiRepository(request, 'repository:write', 'write');
      if (!principal) throw new AuthorizationError();
      const body = request.body as { branch?: unknown; message?: unknown };
      if (typeof body.branch !== 'string' || typeof body.message !== 'string')
        throw new ValidationError('branch and message are required');
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
    { schema: apiContract('users', { response: profileResponse }) },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:read');
      if (!principal) throw new AuthorizationError();
      return reply.send(auth.profile(principal.userId));
    },
  );

  app.patch(
    '/api/v1/user/profile',
    {
      schema: apiContract('users', {
        body: profileUpdateBody,
        response: profileResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new AuthorizationError();
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
    { schema: apiContract('users', { response: appearanceResponse }) },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:read');
      if (!principal) throw new AuthorizationError();
      return reply.send(auth.appearance(principal.userId));
    },
  );

  app.put(
    '/api/v1/user/appearance',
    {
      schema: apiContract('users', {
        body: appearanceUpdateBody,
        response: appearanceResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new AuthorizationError();
      const body = request.body as {
        theme: string;
        accent: string;
        uiFont: string;
        codeFont: string;
        reducedMotion: boolean;
        pluginTheme?: string | null;
      };
      if (body.pluginTheme && !pluginContributions.theme(body.pluginTheme))
        throw new ValidationError('Selected plugin theme is unavailable');
      auth.setAppearance(principal.userId, {
        ...body,
        pluginTheme: body.pluginTheme === '' ? null : (body.pluginTheme ?? null),
      });
      return reply.send(auth.appearance(principal.userId));
    },
  );

  app.get(
    '/api/v1/user/sessions',
    { schema: apiContract('credentials', { response: sessionListResponse }) },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:read');
      if (!principal) throw new AuthorizationError();
      return reply.send({ items: auth.sessions(principal.userId) });
    },
  );

  app.delete(
    '/api/v1/user/sessions',
    { schema: apiContract('credentials', { success: 204 }) },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new AuthorizationError();
      auth.revokeUserSessions(principal.userId);
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/user/passkeys',
    { schema: apiContract('credentials', { response: passkeyListResponse }) },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:read');
      if (!principal) throw new AuthorizationError();
      return reply.send({ items: passkeys.list(principal.userId) });
    },
  );

  app.patch(
    '/api/v1/user/passkeys/:passkeyId',
    {
      schema: apiContract('credentials', {
        params: stringPathParameters('passkeyId'),
        body: passkeyRenameBody,
        response: passkeyListResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new AuthorizationError();
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
      schema: apiContract('credentials', {
        success: 204,
        params: stringPathParameters('passkeyId'),
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new AuthorizationError();
      passkeys.remove(principal.userId, (request.params as { passkeyId: string }).passkeyId);
      auth.revokeUserSessions(principal.userId);
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/user/repository-transfers',
    { schema: apiContract('repositories', { response: repositoryTransferListResponse }) },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:read');
      if (!principal) throw new AuthorizationError();
      return reply.send({ items: repositoryAdmin.pendingTransfers(principal.userId) });
    },
  );

  app.post(
    '/api/v1/user/repository-transfers/:repositoryId',
    {
      schema: apiContract('repositories', {
        params: stringPathParameters('repositoryId'),
        body: repositoryTransferDecisionBody,
        response: okResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new AuthorizationError();
      const repositoryId = Number.parseInt(
        (request.params as { repositoryId: string }).repositoryId,
        10,
      );
      if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0)
        throw new ValidationError('Invalid repository transfer');
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
    { schema: apiContract('credentials', { response: tokenListResponse }) },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:read');
      if (!principal) throw new AuthorizationError();
      return reply.send({ items: tokens.list(principal.userId) });
    },
  );

  app.post(
    '/api/v1/user/tokens',
    {
      schema: apiContract('credentials', {
        success: 201,
        body: tokenCreateBody,
        response: tokenCreatedResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new AuthorizationError();
      const body = request.body as { name: string; scopes: string[]; expiresAt?: string };
      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : undefined;
      if (expiresAt && !Number.isFinite(expiresAt.getTime()))
        throw new ValidationError('Token expiration is invalid');
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
      schema: apiContract('credentials', {
        success: 204,
        params: stringPathParameters('tokenId'),
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new AuthorizationError();
      const tokenId = Number.parseInt((request.params as { tokenId: string }).tokenId, 10);
      if (!Number.isSafeInteger(tokenId) || tokenId <= 0)
        throw new ValidationError('Invalid token ID');
      tokens.revoke(principal.userId, tokenId);
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/user/ssh-keys',
    { schema: apiContract('credentials', { response: sshKeyListResponse }) },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:read');
      if (!principal) throw new AuthorizationError();
      return reply.send({ items: sshKeys.list(principal.userId) });
    },
  );

  app.post(
    '/api/v1/user/ssh-keys',
    {
      schema: apiContract('credentials', {
        success: 201,
        body: sshKeyCreateBody,
        response: sshKeyResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new AuthorizationError();
      const body = request.body as { name: string; publicKey: string };
      return reply.code(201).send(await sshKeys.add(principal.userId, body.name, body.publicKey));
    },
  );

  app.delete(
    '/api/v1/user/ssh-keys/:keyId',
    {
      schema: apiContract('credentials', {
        success: 204,
        params: stringPathParameters('keyId'),
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new AuthorizationError();
      const keyId = Number.parseInt((request.params as { keyId: string }).keyId, 10);
      if (!Number.isSafeInteger(keyId) || keyId <= 0)
        throw new ValidationError('Invalid SSH key ID');
      sshKeys.remove(principal.userId, keyId);
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/users/:username',
    {
      schema: apiContract('users', {
        params: stringPathParameters('username'),
        response: userResponse,
      }),
    },
    async (request, reply) => {
      if (!apiPrincipal(request, 'api:read')) throw new AuthorizationError();
      const row = database
        .prepare(
          "SELECT username, display_name AS displayName, created_at AS createdAt FROM users WHERE username = ? AND status = 'active'",
        )
        .get((request.params as { username: string }).username.toLowerCase());
      if (!row) throw new NotFoundError();
      return reply.send(row);
    },
  );

  app.get(
    '/api/v1/groups',
    {
      schema: apiContract('groups', {
        response: groupListResponse,
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
      if (!principal) throw new AuthorizationError();
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
      schema: apiContract('groups', {
        success: 201,
        body: groupCreateBody,
        response: idResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new AuthorizationError();
      const body = request.body as { slug?: unknown; displayName?: unknown };
      if (typeof body.slug !== 'string' || typeof body.displayName !== 'string')
        throw new ValidationError('slug and displayName are required');
      return reply
        .code(201)
        .send({ id: groups.create(principal.userId, body.slug, body.displayName) });
    },
  );

  app.get(
    '/api/v1/groups/:group',
    {
      schema: apiContract('groups', {
        params: stringPathParameters('group'),
        response: groupResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:read');
      if (!principal) throw new AuthorizationError();
      return reply.send(
        groups.getBySlug((request.params as { group: string }).group, principal.userId),
      );
    },
  );

  app.put(
    '/api/v1/groups/:group/members',
    {
      schema: apiContract('groups', {
        params: stringPathParameters('group'),
        body: groupMemberBody,
        response: okResponse,
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new AuthorizationError();
      const group = groups.getBySlug((request.params as { group: string }).group, principal.userId);
      const body = request.body as { username?: unknown; role?: unknown };
      if (
        typeof body.username !== 'string' ||
        !['member', 'manager', 'owner'].includes(typeof body.role === 'string' ? body.role : '')
      )
        throw new ValidationError('username and a valid role are required');
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
      schema: apiContract('groups', {
        success: 204,
        params: stringPathParameters('group', 'userId'),
      }),
    },
    async (request, reply) => {
      const principal = apiPrincipal(request, 'api:write');
      if (!principal) throw new AuthorizationError();
      const parameters = request.params as { group: string; userId: string };
      const group = groups.getBySlug(parameters.group, principal.userId);
      const userId = Number.parseInt(parameters.userId, 10);
      if (!Number.isSafeInteger(userId) || userId <= 0)
        throw new ValidationError('Invalid user ID');
      groups.removeMember(principal.userId, group.id, userId);
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/administration/system',
    { schema: apiContract('administration', { response: administrationSystemResponse }) },
    async (request, reply) => {
      requireAdminPrincipal(request);
      return reply.send({
        version: product.version,
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
      schema: apiContract('administration', {
        response: paginatedAdminUsersResponse,
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
      schema: apiContract('administration', {
        params: stringPathParameters('userId'),
        body: administrationUserBody,
        response: okResponse,
      }),
    },
    async (request, reply) => {
      const principal = requireAdminPrincipal(request);
      const userId = Number.parseInt((request.params as { userId: string }).userId, 10);
      if (!Number.isSafeInteger(userId) || userId <= 0)
        throw new ValidationError('Invalid user ID');
      const body = request.body as { status?: unknown; administrator?: unknown };
      if (body.status !== undefined) {
        if (body.status !== 'active' && body.status !== 'disabled')
          throw new ValidationError('Invalid account status');
        administration.setUserStatus(principal.userId, userId, body.status);
      }
      if (body.administrator !== undefined) {
        if (typeof body.administrator !== 'boolean')
          throw new ValidationError('administrator must be boolean');
        administration.setAdministrator(principal.userId, userId, body.administrator);
      }
      return reply.send({ ok: true });
    },
  );

  app.get(
    '/api/v1/administration/repositories',
    {
      schema: apiContract('administration', {
        response: paginatedAdminRepositoriesResponse,
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
      schema: apiContract('administration', {
        response: paginatedAuditResponse,
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

  const pluginJson = (plugin: ReturnType<PluginManager['get']>) => ({
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    runtime: plugin.runtime,
    sourceType: plugin.sourceType,
    sourceValue: plugin.sourceValue,
    enabled: plugin.enabled,
    error: plugin.error,
    permissions: plugin.permissions,
  });

  app.get(
    '/api/v1/administration/plugins',
    { schema: apiContract('administration', { response: pluginListResponse }) },
    async (request, reply) => {
      requireAdminPrincipal(request);
      return reply.send({ items: pluginManager.list().map(pluginJson) });
    },
  );

  app.get(
    '/api/v1/administration/search',
    { schema: apiContract('administration', { response: searchStatusResponse }) },
    async (request, reply) => {
      requireAdminPrincipal(request);
      return reply.send(search.status());
    },
  );

  app.post(
    '/api/v1/administration/search/rebuild',
    { schema: apiContract('administration', { response: rebuildResponse }) },
    async (request, reply) => {
      requireAdminPrincipal(request);
      return reply.send({ repositories: await search.rebuildAll() });
    },
  );

  app.get(
    '/api/v1/administration/settings',
    { schema: apiContract('administration', { response: runtimeSettingsResponse }) },
    async (request, reply) => {
      requireAdminPrincipal(request);
      return reply.send(runtimeSettings.load());
    },
  );

  app.put(
    '/api/v1/administration/settings',
    {
      schema: apiContract('administration', {
        body: runtimeSettingsBody,
        response: runtimeSettingsResponse,
      }),
    },
    async (request, reply) => {
      const principal = requireAdminPrincipal(request);
      return reply.send(runtimeSettings.update(principal.userId, request.body as RuntimeSettings));
    },
  );

  app.get(
    '/api/v1/administration/invites',
    { schema: apiContract('administration', { response: inviteListResponse }) },
    async (request, reply) => {
      requireAdminPrincipal(request);
      return reply.send({ items: invites.list() });
    },
  );

  app.post(
    '/api/v1/administration/invites',
    {
      schema: apiContract('administration', {
        success: 201,
        body: inviteCreateBody,
        response: inviteCreatedResponse,
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
      schema: apiContract('administration', {
        success: 204,
        params: stringPathParameters('inviteId'),
      }),
    },
    async (request, reply) => {
      const principal = requireAdminPrincipal(request);
      const inviteId = Number.parseInt((request.params as { inviteId: string }).inviteId, 10);
      if (!Number.isSafeInteger(inviteId) || inviteId <= 0)
        throw new ValidationError('Invalid invite ID');
      invites.revoke(principal.userId, inviteId);
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/administration/plugins/:pluginId',
    {
      schema: apiContract('administration', {
        params: stringPathParameters('pluginId'),
        response: pluginResponse,
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
      schema: apiContract('administration', {
        params: stringPathParameters('pluginId'),
        response: pluginSettingsResponse,
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
      schema: apiContract('administration', {
        params: stringPathParameters('pluginId'),
        body: pluginSettingsBody,
        response: pluginSettingsResponse,
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
      schema: apiContract('administration', {
        params: stringPathParameters('pluginId'),
        body: pluginStateBody,
        response: pluginResponse,
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
      schema: apiContract('administration', {
        params: stringPathParameters('pluginId', 'capability'),
        body: pluginPermissionBody,
        response: pluginResponse,
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
      schema: apiContract('administration', {
        success: 204,
        params: stringPathParameters('pluginId'),
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
      if (!principal) throw new AuthorizationError();
      const account = database
        .prepare("SELECT username FROM users WHERE id = ? AND status = 'active'")
        .get(principal.userId) as { username: string } | undefined;
      if (!account) throw new AuthorizationError();
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

  app.get('/plugins/:pluginId/commands/:commandId', async (request, reply) => {
    const current = requireSession(request);
    const parameters = request.params as { pluginId: string; commandId: string };
    const contribution = await pluginContributions.runCommand(
      parameters.pluginId,
      parameters.commandId,
      { id: current.user.id, username: current.user.username },
    );
    return reply.type('text/html').send(
      await render('plugin-contribution', {
        user: current.user,
        contribution,
        pluginName: pluginManager.get(parameters.pluginId).name,
        repository: null,
      }),
    );
  });

  app.get('/admin/plugins/:pluginId/pages/:pageId', async (request, reply) => {
    const current = requireAdministrator(request);
    const parameters = request.params as { pluginId: string; pageId: string };
    const contribution = await pluginContributions.renderAdminPage(
      parameters.pluginId,
      parameters.pageId,
      current.user,
    );
    return reply.type('text/html').send(
      await render('plugin-contribution', {
        user: current.user,
        contribution,
        pluginName: pluginManager.get(parameters.pluginId).name,
        repository: null,
      }),
    );
  });

  app.get(
    '/:owner/:repository/plugins/:pluginId/renderers/:rendererId/*',
    async (request, reply) => {
      const parameters = request.params as {
        owner: string;
        repository: string;
        pluginId: string;
        rendererId: string;
        '*': string;
      };
      const repository = repositories.find(parameters.owner, parameters.repository);
      if (!repository) throw new NotFoundError();
      const current = session(request);
      const ref = (request.query as { ref?: string }).ref ?? repository.defaultBranch;
      const contribution = await pluginContributions.renderFile(
        repository,
        current?.user.id ?? null,
        parameters.pluginId,
        parameters.rendererId,
        ref,
        parameters['*'],
        await repositories.readBlob(repository, ref, parameters['*']),
      );
      return reply.type('text/html').send(
        await render('plugin-contribution', {
          user: current?.user ?? null,
          contribution,
          pluginName: pluginManager.get(parameters.pluginId).name,
          repository,
        }),
      );
    },
  );

  app.get('/:owner/:repository/plugins/:pluginId/:tabId', async (request, reply) => {
    const parameters = request.params as {
      owner: string;
      repository: string;
      pluginId: string;
      tabId: string;
    };
    const repository = repositories.find(parameters.owner, parameters.repository);
    if (!repository) throw new NotFoundError();
    const current = session(request);
    const contribution = await pluginContributions.renderRepositoryTab(
      repository,
      current?.user.id ?? null,
      parameters.pluginId,
      parameters.tabId,
    );
    return reply.type('text/html').send(
      await render('plugin-contribution', {
        user: current?.user ?? null,
        contribution,
        pluginName: pluginManager.get(parameters.pluginId).name,
        repository,
      }),
    );
  });

  app.get('/:owner/:repository', async (request, reply) => {
    const parameters = request.params as { owner: string; repository: string };
    const repository = repositories.find(parameters.owner, parameters.repository);
    if (!repository) throw new NotFoundError();
    const current = session(request);
    repositories.require(repository, current?.user.id ?? null, 'read');
    const query = request.query as { ref?: string };
    const ref = query.ref ?? repository.defaultBranch;
    let entries: Awaited<ReturnType<RepositoryService['listTree']>> = [];
    let readme: string | null = null;
    let renderedReadme: string | null = null;
    let readmeTooLarge = false;
    let latestCommit: (ReturnType<typeof withAuthorAvatar> & { relativeDate: string }) | null =
      null;
    let empty = false;
    try {
      entries = await repositories.listTree(repository, ref);
      const submodules = await repositories.submoduleUrls(repository, ref);
      entries = entries.map((entry) => presentTreeEntry(entry, submodules));
      const readmeEntry = entries.find(
        (entry) => /^readme(?:\.md)?$/i.test(entry.name) && entry.type === 'blob',
      );
      if (readmeEntry) {
        try {
          readme = (await repositories.readBlob(repository, ref, readmeEntry.name)).toString(
            'utf8',
          );
          if (isMarkdown(readmeEntry.name)) {
            renderedReadme = renderMarkdown(
              await pluginContributions.transformMarkdown(
                repository,
                current?.user.id ?? null,
                ref,
                readmeEntry.name,
                readme,
              ),
            );
          }
        } catch (error) {
          if (error instanceof PayloadTooLargeError) readmeTooLarge = true;
          else throw error;
        }
      }
      const newest = (await browser.commits(repository, ref, 1, 1))[0];
      if (newest)
        latestCommit = {
          ...withAuthorAvatar(newest),
          relativeDate: relativeDate(newest.authoredAt),
        };
    } catch (error) {
      if (
        error instanceof GitError &&
        /unknown revision|Needed a single revision|ambiguous argument/.test(error.message)
      )
        empty = true;
      else throw error;
    }
    const httpsCloneUrl = `${config.server.publicUrl.replace(/\/$/, '')}/${repository.ownerSlug}/${repository.slug}.git`;
    const sshCloneUrl = config.ssh.enabled
      ? `git@${config.ssh.host}:${repository.ownerSlug}/${repository.slug}.git`
      : null;
    return reply.type('text/html').send(
      await render('repository', {
        user: current?.user ?? null,
        repository,
        entries,
        ref,
        readme,
        renderedReadme,
        readmeTooLarge,
        latestCommit,
        empty,
        cloneUrl: httpsCloneUrl,
        httpsCloneUrl,
        sshCloneUrl,
        ...(await referenceOptions(repository)),
        pluginTabs: pluginContributions.repositoryTabs(repository, current?.user.id ?? null),
        canWrite:
          current !== null &&
          !['none', 'read'].includes(repositories.permission(repository, current.user.id)),
        canAdmin:
          current !== null &&
          ['admin', 'owner'].includes(repositories.permission(repository, current.user.id)),
      }),
    );
  });

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

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && (error as { statusCode?: number }).statusCode && error.message)
    return error.message;
  return 'The operation could not be completed.';
}
