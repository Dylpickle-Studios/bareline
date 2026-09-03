import type { RepositoryService } from '../../repositories/repository-service.js';
import { runtimeSettingsResponse } from '../../api/openapi-schemas.js';
import { imageMetadata } from '../../web/file-presentation.js';

export function imageDiffSide(path: string, ref: string, content: Buffer) {
  return {
    path,
    encodedPath: path.split('/').map(encodeURIComponent).join('/'),
    ref,
    size: content.length,
    metadata: imageMetadata(content, path),
  };
}

export function presentTreeEntry(
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

export function repositoryJson(repository: ReturnType<RepositoryService['getById']>) {
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

export const openApiError = {
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

export function apiContract(
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

export const repositoryParameters = {
  type: 'object',
  required: ['owner', 'repository'],
  properties: { owner: { type: 'string' }, repository: { type: 'string' } },
};

export const repositoryWildcardParameters = {
  type: 'object',
  required: ['owner', 'repository', '*'],
  properties: {
    owner: { type: 'string' },
    repository: { type: 'string' },
    '*': { type: 'string' },
  },
};

export const enhancementItem = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    fingerprint: { type: 'string' },
    identity: { type: 'string' },
    keyType: { type: 'string' },
    refPattern: { type: 'string' },
    blockForcePush: { type: 'boolean' },
    blockDeletion: { type: 'boolean' },
    requireSignedCommits: { type: 'boolean' },
    commitMessagePrefix: { type: ['string', 'null'] },
    action: { type: 'string' },
    refName: { type: ['string', 'null'] },
    metadataJson: { type: 'string' },
    createdAt: { type: 'string' },
    username: { type: ['string', 'null'] },
    direction: { type: 'string' },
    remoteUrl: { type: 'string' },
    intervalMinutes: { type: 'integer' },
    enabled: { type: 'integer' },
    lastRunAt: { type: ['string', 'null'] },
    lastSuccessAt: { type: ['string', 'null'] },
    lastError: { type: ['string', 'null'] },
    nextRunAt: { type: 'string' },
    endpoint: { type: 'string' },
    region: { type: 'string' },
    bucket: { type: 'string' },
    objectPrefix: { type: 'string' },
    lastUsedAt: { type: ['string', 'null'] },
  },
} as const;
export const enhancementListResponse = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: { items: { type: 'array', items: enhancementItem } },
} as const;
export const enhancementMutationResponse = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer' },
    created: { type: 'boolean' },
    enabled: { type: 'boolean' },
    pinned: { type: 'boolean' },
  },
} as const;
export const mirrorResponse = {
  type: 'object',
  additionalProperties: false,
  required: ['mirror'],
  properties: { mirror: { anyOf: [enhancementItem, { type: 'null' }] } },
} as const;

export const repositoryCreateBody = {
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

export const repositoryUpdateBody = {
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

export const collaboratorBody = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'name', 'permission'],
  properties: {
    type: { type: 'string', enum: ['user', 'group'] },
    name: { type: 'string', minLength: 1, maxLength: 64 },
    permission: { type: 'string', enum: ['read', 'write', 'admin'] },
  },
} as const;

export const refCreateBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'source'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    source: { type: 'string', minLength: 1, maxLength: 255 },
  },
} as const;

export const fileWriteBody = {
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

export const fileDeleteBody = {
  type: 'object',
  additionalProperties: false,
  required: ['branch', 'message'],
  properties: {
    branch: { type: 'string', minLength: 1, maxLength: 255 },
    message: { type: 'string', minLength: 1, maxLength: 10_000 },
  },
} as const;

export const groupCreateBody = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'displayName'],
  properties: {
    slug: { type: 'string', minLength: 1, maxLength: 64 },
    displayName: { type: 'string', minLength: 1, maxLength: 100 },
  },
} as const;

export const groupMemberBody = {
  type: 'object',
  additionalProperties: false,
  required: ['username', 'role'],
  properties: {
    username: { type: 'string', minLength: 1, maxLength: 64 },
    role: { type: 'string', enum: ['member', 'manager', 'owner'] },
  },
} as const;

export const administrationUserBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    status: { type: 'string', enum: ['active', 'disabled'] },
    administrator: { type: 'boolean' },
  },
} as const;

export const pluginStateBody = {
  type: 'object',
  additionalProperties: false,
  required: ['enabled'],
  properties: {
    enabled: { type: 'boolean' },
    trustedRiskAccepted: { type: 'boolean' },
  },
} as const;

export const pluginPermissionBody = {
  type: 'object',
  additionalProperties: false,
  required: ['granted'],
  properties: { granted: { type: 'boolean' } },
} as const;

export const pluginSettingsBody = {
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

export const passkeyRenameBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
} as const;

export const repositoryTransferDecisionBody = {
  type: 'object',
  additionalProperties: false,
  required: ['accept'],
  properties: { accept: { type: 'boolean' } },
} as const;

export const inviteCreateBody = {
  type: 'object',
  additionalProperties: false,
  properties: { expiresInDays: { type: 'integer', minimum: 1, maximum: 30 } },
} as const;

export const runtimeSettingsBody = {
  ...runtimeSettingsResponse,
} as const;

export const tokenCreateBody = {
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
    repository: {
      type: 'string',
      pattern: '^[a-z0-9-]{1,39}/[a-z0-9-]{1,39}$',
      description:
        'Confine the token to one repository, as owner/repository. The token is then refused on every other repository and on all account and administration endpoints.',
    },
  },
} as const;

export const sshKeyCreateBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'publicKey'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    publicKey: { type: 'string', minLength: 1, maxLength: 16_384 },
  },
} as const;

export const profileUpdateBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    displayName: { type: 'string', minLength: 1, maxLength: 100 },
    email: { type: 'string', maxLength: 400 },
    emailPublic: { type: 'boolean' },
  },
} as const;

export const appearanceUpdateBody = {
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

export const passkeyClientExtensions = {
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
export const passkeyCredentialProperties = {
  id: { type: 'string', minLength: 1, maxLength: 4096 },
  rawId: { type: 'string', minLength: 1, maxLength: 4096 },
  type: { type: 'string', const: 'public-key' },
  authenticatorAttachment: {
    anyOf: [{ type: 'string', enum: ['platform', 'cross-platform'] }, { type: 'null' }],
  },
  clientExtensionResults: passkeyClientExtensions,
} as const;
export const passkeyRegistrationVerifyBody = {
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
export const passkeyAuthenticationVerifyBody = {
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

export function stringPathParameters(...names: string[]) {
  return {
    type: 'object',
    required: names,
    properties: Object.fromEntries(names.map((name) => [name, { type: 'string' }])),
  };
}

export function relativeDate(input: string, now = Date.now()): string {
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
