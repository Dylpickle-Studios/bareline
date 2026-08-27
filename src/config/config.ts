import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { canonicalHostname } from '../security/outbound-policy.js';

const pathValue = z
  .string()
  .min(1)
  .transform((value) => resolve(value));
const positiveInt = z.number().int().positive();
const configuredHostname = z
  .string()
  .min(1)
  .max(253)
  .superRefine((value, context) => {
    if (!canonicalHostname(value))
      context.addIssue({ code: 'custom', message: 'must be a hostname or IP address' });
  })
  .transform((value) => {
    const hostname = canonicalHostname(value);
    if (!hostname) throw new Error('Invalid hostname');
    return hostname;
  });
const publicUrl = z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
  message: 'must use HTTP or HTTPS',
});
const masterKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'must be an unpadded base64url-encoded 32-byte key')
  .refine((value) => {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === value;
  }, 'must decode to exactly 32 bytes');

function validProxyAddress(value: string): boolean {
  const slash = value.indexOf('/');
  const address = slash === -1 ? value : value.slice(0, slash);
  const prefix = slash === -1 ? undefined : value.slice(slash + 1);
  const family = isIP(address);
  if (family === 0 || (prefix !== undefined && !/^\d+$/.test(prefix))) return false;
  if (prefix === undefined) return true;
  const length = Number(prefix);
  return Number.isInteger(length) && length >= 0 && length <= (family === 4 ? 32 : 128);
}

function pathContains(parent: string, child: string): boolean {
  const relativePath = resolve(child).slice(resolve(parent).length);
  return relativePath.startsWith('/') && relativePath.length > 1;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || pathContains(left, right) || pathContains(right, left);
}

const configSchema = z
  .object({
    server: z
      .object({
        host: z.string().min(1).default('127.0.0.1'),
        port: z.number().int().min(1).max(65535).default(3000),
        publicUrl,
        tls: z
          .discriminatedUnion('mode', [
            z.object({ mode: z.literal('proxy') }).strict(),
            z.object({ mode: z.literal('http') }).strict(),
            z
              .object({ mode: z.literal('native'), certificate: pathValue, privateKey: pathValue })
              .strict(),
          ])
          .default({ mode: 'proxy' }),
      })
      .strict(),
    storage: z
      .object({
        data: pathValue,
        repositories: pathValue,
        trash: pathValue,
        lfs: pathValue,
        importRoots: z.array(pathValue).default([]),
      })
      .strict(),
    database: z.object({ path: pathValue }).strict(),
    git: z
      .object({
        executable: z.string().min(1).default('git'),
        timeoutMs: positiveInt.default(15_000),
      })
      .strict(),
    mirrors: z
      .object({
        allowedHosts: z.array(configuredHostname).max(100).default([]),
        timeoutMs: positiveInt.max(300_000).default(15_000),
      })
      .strict()
      .optional(),
    search: z
      .object({
        indexedBranches: z.array(z.string().min(1).max(255)).max(50).default([]),
        maxFilesPerBranch: positiveInt.max(100_000).default(10_000),
        maxCommitsPerBranch: positiveInt.max(10_000).default(100),
      })
      .strict()
      .default({ indexedBranches: [], maxFilesPerBranch: 10_000, maxCommitsPerBranch: 100 }),
    ssh: z.object({ enabled: z.boolean().default(true), host: z.string().min(1) }).strict(),
    registration: z
      .object({ mode: z.enum(['open', 'invite', 'closed']).default('closed') })
      .strict(),
    anonymous: z.object({ publicRepositories: z.boolean().default(true) }).strict(),
    limits: z
      .object({
        filePreviewBytes: positiveInt.default(2 * 1024 * 1024),
        gitOutputBytes: positiveInt.default(16 * 1024 * 1024),
        gitInputBytes: positiveInt.max(1024 * 1024 * 1024).default(64 * 1024 * 1024),
        gitConcurrent: positiveInt.max(64).default(8),
        gitPending: positiveInt.max(256).default(32),
        diffBytes: positiveInt.default(10 * 1024 * 1024),
        diffLines: positiveInt.default(20_000),
        diffFiles: positiveInt.max(10_000).default(500),
        diffFileBytes: positiveInt.default(2 * 1024 * 1024),
        archiveBytes: positiveInt.default(1024 * 1024 * 1024),
        lfsObjectBytes: positiveInt.default(5 * 1024 * 1024 * 1024),
        requestBodyBytes: positiveInt.default(10 * 1024 * 1024),
      })
      .strict(),
    security: z
      .object({
        sessionDays: z.number().int().min(1).max(365).default(14),
        repositoryTrashDays: z.number().int().min(1).max(365).default(7),
        masterKey: masterKey.optional(),
      })
      .strict(),
    plugins: z
      .object({
        allowedGitHosts: z.array(configuredHostname).default([]),
        allowedNpmPackages: z.array(z.string().min(1).max(214)).default([]),
        npmExecutable: z.string().min(1).default('npm'),
        installTimeoutMs: positiveInt.max(300_000).default(60_000),
      })
      .strict()
      .default({
        allowedGitHosts: [],
        allowedNpmPackages: [],
        npmExecutable: 'npm',
        installTimeoutMs: 60_000,
      }),
    authentication: z
      .object({
        oidc: z
          .array(
            z
              .object({
                id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
                name: z.string().min(1).max(100),
                issuer: z
                  .url()
                  .refine((value) => value.startsWith('https://'), 'OIDC issuer must use HTTPS'),
                clientId: z.string().min(1),
                clientSecret: z.string().min(1),
                scopes: z.array(z.string().min(1)).default(['openid', 'profile', 'email']),
                usernameClaim: z
                  .string()
                  .regex(/^[A-Za-z0-9_.-]+$/)
                  .default('preferred_username'),
                displayNameClaim: z
                  .string()
                  .regex(/^[A-Za-z0-9_.-]+$/)
                  .default('name'),
                autoCreate: z.boolean().default(false),
              })
              .strict(),
          )
          .default([]),
        ldap: z
          .object({
            enabled: z.boolean().default(false),
            url: z.url().refine((value) => value.startsWith('ldaps://'), 'LDAP URL must use LDAPS'),
            bindDn: z.string().min(1),
            bindPassword: z.string().min(1),
            baseDn: z.string().min(1),
            usernameAttribute: z
              .string()
              .regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/)
              .default('uid'),
            displayNameAttribute: z
              .string()
              .regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/)
              .default('displayName'),
            emailAttribute: z
              .string()
              .regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/)
              .default('mail'),
            autoCreate: z.boolean().default(false),
            connectTimeoutMs: positiveInt.max(30_000).default(5000),
            operationTimeoutMs: positiveInt.max(30_000).default(5000),
          })
          .strict()
          .optional(),
        reverseProxy: z
          .object({
            enabled: z.boolean().default(false),
            identityHeader: z
              .string()
              .regex(/^[a-z0-9-]+$/)
              .default('x-authenticated-user'),
            displayNameHeader: z
              .string()
              .regex(/^[a-z0-9-]+$/)
              .default('x-authenticated-name'),
            allowedAddresses: z
              .array(z.string().min(1).refine(validProxyAddress, 'must be an IP address or CIDR'))
              .min(1)
              .default(['127.0.0.1', '::1']),
            autoCreate: z.boolean().default(false),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.server.tls.mode === 'http' && config.server.publicUrl.startsWith('https://'))
      context.addIssue({
        code: 'custom',
        path: ['server', 'tls', 'mode'],
        message: 'HTTP mode cannot serve an HTTPS public URL',
      });
    if (config.server.tls.mode === 'native' && !config.server.publicUrl.startsWith('https://'))
      context.addIssue({
        code: 'custom',
        path: ['server', 'publicUrl'],
        message: 'Native TLS requires an HTTPS public URL',
      });
    const managedDirectories = [
      ['storage.repositories', config.storage.repositories],
      ['storage.trash', config.storage.trash],
      ['storage.lfs', config.storage.lfs],
    ] as const;
    for (const [path, value] of managedDirectories) {
      if (!pathContains(config.storage.data, value))
        context.addIssue({
          code: 'custom',
          path: path.split('.'),
          message: 'must be located below storage.data',
        });
    }
    for (let index = 0; index < managedDirectories.length; index += 1) {
      for (let other = index + 1; other < managedDirectories.length; other += 1) {
        const current = managedDirectories[index];
        const next = managedDirectories[other];
        if (!current || !next) continue;
        const [path, value] = current;
        const [otherPath, otherValue] = next;
        if (pathsOverlap(value, otherValue))
          context.addIssue({
            code: 'custom',
            path: path.split('.'),
            message: `must not overlap ${otherPath}`,
          });
      }
    }
    if (managedDirectories.some(([, directory]) => pathsOverlap(directory, config.database.path)))
      context.addIssue({
        code: 'custom',
        path: ['database', 'path'],
        message: 'must not be inside a repository, trash, or LFS directory',
      });
    for (let index = 0; index < config.storage.importRoots.length; index += 1) {
      const root = config.storage.importRoots[index];
      if (!root) continue;
      if (managedDirectories.some(([, directory]) => pathsOverlap(root, directory)))
        context.addIssue({
          code: 'custom',
          path: ['storage', 'importRoots', index],
          message: 'must not overlap a managed storage directory',
        });
      for (let other = index + 1; other < config.storage.importRoots.length; other += 1) {
        const nextRoot = config.storage.importRoots[other];
        if (nextRoot && pathsOverlap(root, nextRoot))
          context.addIssue({
            code: 'custom',
            path: ['storage', 'importRoots', index],
            message: `must not overlap importRoots[${String(other)}]`,
          });
      }
    }
    if ((config.authentication?.oidc.length ?? 0) > 0 && config.security.masterKey === undefined)
      context.addIssue({
        code: 'custom',
        path: ['security', 'masterKey'],
        message: 'is required when OIDC is configured',
      });
  });

export type AppConfig = z.infer<typeof configSchema>;

function validateEnvironmentConfig(config: AppConfig, environment: NodeJS.ProcessEnv): void {
  if (environment.NODE_ENV !== 'production') return;
  const issues: string[] = [];
  if (!config.server.publicUrl.startsWith('https://'))
    issues.push('server.publicUrl: Production deployments require an HTTPS public URL');
  if (config.server.tls.mode === 'http')
    issues.push('server.tls.mode: Production deployments cannot use plain HTTP mode');
  if (issues.length > 0) throw new Error(`Invalid configuration:\n${issues.join('\n')}`);
}

function substituteEnvironment(value: unknown, environment: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string')
    return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_match, name: string) => {
      const replacement = environment[name];
      if (replacement === undefined)
        throw new Error(`Required environment variable ${name} is not set`);
      return replacement;
    });
  if (Array.isArray(value)) return value.map((item) => substituteEnvironment(item, environment));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substituteEnvironment(item, environment)]),
    );
  return value;
}

function envOverride(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = environment[`BARELINE_${key}`] ?? environment[`GIT_HOST_${key}`];
  return value === '' ? undefined : value;
}

// Declarative allowlist of config fields that may be overridden by a `BARELINE_<SUFFIX>` (or
// legacy `GIT_HOST_<SUFFIX>`) environment variable, primarily for container deployments. Fields
// not listed here are configurable only through the YAML file (optionally using `${VAR}`
// substitution, which supports arbitrary fields but requires editing the file).
const envOverridableFields: readonly {
  path: readonly [string, string];
  suffix: string;
  parse?: (raw: string, suffix: string) => unknown;
}[] = [
  { path: ['server', 'host'], suffix: 'SERVER_HOST' },
  {
    path: ['server', 'port'],
    suffix: 'SERVER_PORT',
    parse: (raw, suffix) => parseFiniteInteger(raw, suffix),
  },
  { path: ['server', 'publicUrl'], suffix: 'SERVER_PUBLIC_URL' },
  { path: ['database', 'path'], suffix: 'DATABASE_PATH' },
  { path: ['storage', 'data'], suffix: 'STORAGE_DATA' },
  { path: ['storage', 'repositories'], suffix: 'STORAGE_REPOSITORIES' },
  { path: ['storage', 'trash'], suffix: 'STORAGE_TRASH' },
  { path: ['storage', 'lfs'], suffix: 'STORAGE_LFS' },
  { path: ['git', 'executable'], suffix: 'GIT_EXECUTABLE' },
  { path: ['ssh', 'host'], suffix: 'SSH_HOST' },
  { path: ['security', 'masterKey'], suffix: 'SECURITY_MASTER_KEY' },
];

function parseFiniteInteger(raw: string, suffix: string): number {
  if (!/^[+-]?\d+$/.test(raw)) throw new Error(`Invalid integer for ${suffix}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid finite integer for ${suffix}`);
  return value;
}

function applyEnvOverrides(
  candidate: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
): void {
  for (const field of envOverridableFields) {
    const raw = envOverride(environment, field.suffix);
    if (raw === undefined) continue;
    const [sectionKey, fieldKey] = field.path;
    const section = candidate[sectionKey];
    if (typeof section !== 'object' || section === null) continue;
    (section as Record<string, unknown>)[fieldKey] = field.parse
      ? field.parse(raw, field.suffix)
      : raw;
  }
}

export function loadConfig(file: string, environment = process.env): AppConfig {
  if (!isAbsolute(file)) file = resolve(file);
  const parsed: unknown = YAML.parse(readFileSync(file, 'utf8'));
  const value = substituteEnvironment(parsed, environment);
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Configuration must be a YAML map');

  const candidate = structuredClone(value) as Record<string, unknown>;
  applyEnvOverrides(candidate, environment);

  const result = configSchema.safeParse(candidate);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  validateEnvironmentConfig(result.data, environment);
  return result.data;
}
