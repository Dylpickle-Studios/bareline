import { z } from 'zod';

export const pluginCapabilities = [
  'repositories.read',
  'repositories.write',
  'repositoryContents.read',
  'repositoryContents.write',
  'users.read',
  'users.write',
  'groups.read',
  'settings.read',
  'settings.write',
  'auth.provider',
  'events.subscribe',
  'network.outbound',
  'filesystem.read',
  'filesystem.write',
  'process.spawn',
  'ui.global',
  'ui.repository',
  'storage.plugin',
] as const;

const setting = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('string'), title: z.string().min(1), default: z.string().optional() })
    .strict(),
  z.object({ type: z.literal('secret'), title: z.string().min(1) }).strict(),
  z
    .object({ type: z.literal('number'), title: z.string().min(1), default: z.number().optional() })
    .strict(),
  z
    .object({
      type: z.literal('boolean'),
      title: z.string().min(1),
      default: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('select'),
      title: z.string().min(1),
      options: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('multi-select'),
      title: z.string().min(1),
      options: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({ type: z.literal('url'), title: z.string().min(1), default: z.url().optional() })
    .strict(),
]);

const contribution = z
  .object({ id: z.string().regex(/^[a-z][a-z0-9.-]{1,63}$/), title: z.string().min(1).max(100) })
  .strict();
const fileRendererContribution = contribution
  .extend({
    extensions: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9+.-]{0,31}$/))
      .min(1)
      .max(50),
  })
  .strict();
const authenticationProviderContribution = contribution
  .extend({
    usernameLabel: z.string().min(1).max(100).default('Username'),
    passwordLabel: z.string().min(1).max(100).default('Password'),
    autoCreate: z.boolean().default(false),
  })
  .strict();
const themeContribution = contribution
  .extend({
    colorScheme: z.enum(['light', 'dark']),
    colors: z
      .object({
        background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        surface: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        surfaceSubtle: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        text: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        muted: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        border: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        accentStrong: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      })
      .strict(),
  })
  .strict();

export const pluginEventNames = [
  'repository.created',
  'repository.deleted',
  'repository.renamed',
  'repository.visibilityChanged',
  'repository.pushed',
  'branch.created',
  'branch.deleted',
  'tag.created',
  'tag.deleted',
  'commit.createdViaWeb',
] as const;

export const pluginManifestSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/)
      .max(100),
    name: z.string().min(1).max(100),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    apiVersion: z.literal(1),
    runtime: z.enum(['trusted', 'sandboxed']),
    author: z.string().min(1).max(200).optional(),
    entrypoint: z.string().regex(/^(?!\/)(?!.*\.\.)(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/),
    permissions: z.array(z.enum(pluginCapabilities)).max(pluginCapabilities.length).default([]),
    contributes: z
      .object({
        repositoryTabs: z.array(contribution).default([]),
        commands: z.array(contribution).default([]),
        searchProviders: z.array(contribution).default([]),
        fileRenderers: z.array(fileRendererContribution).default([]),
        markdownExtensions: z.array(contribution).default([]),
        authenticationProviders: z.array(authenticationProviderContribution).default([]),
        adminPages: z.array(contribution).default([]),
        themes: z.array(themeContribution).default([]),
        navigation: z.array(contribution.extend({ href: z.string().startsWith('/') })).default([]),
        restEndpoints: z
          .array(contribution.extend({ method: z.enum(['GET', 'POST']) }))
          .default([]),
        events: z
          .array(
            z
              .object({
                event: z.enum(pluginEventNames),
                handler: z.string().regex(/^[a-z][a-z0-9.-]{1,63}$/),
              })
              .strict(),
          )
          .default([]),
      })
      .strict()
      .default({
        repositoryTabs: [],
        commands: [],
        searchProviders: [],
        fileRenderers: [],
        markdownExtensions: [],
        authenticationProviders: [],
        adminPages: [],
        themes: [],
        navigation: [],
        restEndpoints: [],
        events: [],
      }),
    settings: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/), setting).default({}),
  })
  .strict();

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export function validatePluginManifest(value: unknown): PluginManifest {
  const result = pluginManifestSchema.safeParse(value);
  if (!result.success) {
    throw new PluginManifestError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n'),
    );
  }
  if (new Set(result.data.permissions).size !== result.data.permissions.length) {
    throw new PluginManifestError('permissions: duplicate capability');
  }
  for (const [category, contributions] of Object.entries(result.data.contributes)) {
    const identifiers = contributions.map((item) => ('id' in item ? item.id : item.handler));
    if (new Set(identifiers).size !== identifiers.length) {
      throw new PluginManifestError(`contributes.${category}: duplicate contribution identifier`);
    }
  }
  if (result.data.runtime === 'sandboxed' && result.data.entrypoint.endsWith('.js')) {
    throw new PluginManifestError('Sandboxed plugin entrypoint must be a WebAssembly module');
  }
  return result.data;
}

export class PluginManifestError extends Error {
  readonly statusCode = 400;
}
