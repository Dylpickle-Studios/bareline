import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

const pathValue = z
  .string()
  .min(1)
  .transform((value) => resolve(value));
const positiveInt = z.number().int().positive();

const configSchema = z.object({
  server: z.object({
    host: z.string().min(1).default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(3000),
    publicUrl: z.url(),
    tls: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('proxy') }),
        z.object({ mode: z.literal('http') }),
        z.object({ mode: z.literal('native'), certificate: pathValue, privateKey: pathValue }),
      ])
      .default({ mode: 'proxy' }),
  }),
  storage: z.object({
    data: pathValue,
    repositories: pathValue,
    trash: pathValue,
    lfs: pathValue,
    importRoots: z.array(pathValue).default([]),
  }),
  database: z.object({ path: pathValue }),
  git: z.object({
    executable: z.string().min(1).default('git'),
    timeoutMs: positiveInt.default(15_000),
  }),
  search: z
    .object({
      indexedBranches: z.array(z.string().min(1).max(255)).max(50).default([]),
      maxFilesPerBranch: positiveInt.max(100_000).default(10_000),
      maxCommitsPerBranch: positiveInt.max(10_000).default(100),
    })
    .default({ indexedBranches: [], maxFilesPerBranch: 10_000, maxCommitsPerBranch: 100 }),
  ssh: z.object({ enabled: z.boolean().default(true), host: z.string().min(1) }),
  registration: z.object({ mode: z.enum(['open', 'invite', 'closed']).default('closed') }),
  anonymous: z.object({ publicRepositories: z.boolean().default(true) }),
  limits: z.object({
    filePreviewBytes: positiveInt.default(2 * 1024 * 1024),
    gitOutputBytes: positiveInt.default(16 * 1024 * 1024),
    diffBytes: positiveInt.default(10 * 1024 * 1024),
    diffLines: positiveInt.default(20_000),
    diffFiles: positiveInt.max(10_000).default(500),
    diffFileBytes: positiveInt.default(2 * 1024 * 1024),
    archiveBytes: positiveInt.default(1024 * 1024 * 1024),
    lfsObjectBytes: positiveInt.default(5 * 1024 * 1024 * 1024),
    requestBodyBytes: positiveInt.default(10 * 1024 * 1024),
  }),
  security: z.object({
    sessionDays: z.number().int().min(1).max(365).default(14),
    repositoryTrashDays: z.number().int().min(1).max(365).default(7),
    masterKey: z.string().min(43).max(44).optional(),
  }),
  plugins: z
    .object({
      allowedGitHosts: z.array(z.string().min(1).max(253)).default([]),
      allowedNpmPackages: z.array(z.string().min(1).max(214)).default([]),
      npmExecutable: z.string().min(1).default('npm'),
      installTimeoutMs: positiveInt.max(300_000).default(60_000),
    })
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
          z.object({
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
          }),
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
          allowedAddresses: z.array(z.string().min(1)).min(1).default(['127.0.0.1', '::1']),
          autoCreate: z.boolean().default(false),
        })
        .optional(),
    })
    .optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

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

export function loadConfig(file: string, environment = process.env): AppConfig {
  if (!isAbsolute(file)) file = resolve(file);
  const parsed: unknown = YAML.parse(readFileSync(file, 'utf8'));
  const value = substituteEnvironment(parsed, environment);
  if (typeof value !== 'object' || value === null)
    throw new Error('Configuration must be a YAML map');

  const candidate = structuredClone(value) as Record<string, unknown>;
  const server = candidate.server as Record<string, unknown> | undefined;
  const database = candidate.database as Record<string, unknown> | undefined;
  if (server) {
    const port = envOverride(environment, 'SERVER_PORT');
    const publicUrl = envOverride(environment, 'SERVER_PUBLIC_URL');
    if (port) server.port = Number(port);
    if (publicUrl) server.publicUrl = publicUrl;
  }
  if (database) {
    const path = envOverride(environment, 'DATABASE_PATH');
    if (path) database.path = path;
  }

  const result = configSchema.safeParse(candidate);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  return result.data;
}
