import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { RepositoryService } from '../repositories/repository-service.js';
import type { Repository } from '../repositories/repository-types.js';
import type { PluginHost } from '../plugin-sdk/index.js';
import { PluginManager, PluginPermissionError } from './plugin-manager.js';
import { SandboxRuntime } from './sandbox-runtime.js';

const contributionViewSchema = z
  .object({
    title: z.string().min(1).max(200),
    blocks: z
      .array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('text'), text: z.string().max(20_000) }).strict(),
          z
            .object({
              type: z.literal('metric'),
              label: z.string().min(1).max(100),
              value: z.union([z.string().max(200), z.number()]),
            })
            .strict(),
          z
            .object({
              type: z.literal('link'),
              label: z.string().min(1).max(100),
              href: z.string().startsWith('/').max(1000),
            })
            .strict(),
        ]),
      )
      .max(100),
  })
  .strict();

const searchResultsSchema = z
  .array(
    z
      .object({
        title: z.string().min(1).max(200),
        subtitle: z.string().max(200),
        url: z.string().startsWith('/').max(1000),
      })
      .strict(),
  )
  .max(30);

const authenticationIdentitySchema = z
  .object({
    subject: z.string().min(1).max(500),
    username: z.string().min(1).max(39),
    displayName: z.string().min(1).max(100),
    email: z.email().max(400).optional(),
  })
  .strict();

export type ContributionView = z.infer<typeof contributionViewSchema>;

export class PluginContributionService {
  constructor(
    private readonly plugins: PluginManager,
    private readonly sandbox: SandboxRuntime,
    private readonly repositories: RepositoryService,
  ) {}

  commands(): { pluginId: string; pluginName: string; id: string; title: string; url: string }[] {
    return this.plugins
      .list()
      .filter((plugin) => plugin.enabled && this.plugins.hasCapability(plugin.id, 'ui.global'))
      .flatMap((plugin) =>
        plugin.manifest.contributes.commands.map((command) => ({
          pluginId: plugin.id,
          pluginName: plugin.name,
          id: command.id,
          title: command.title,
          url: `/plugins/${encodeURIComponent(plugin.id)}/commands/${encodeURIComponent(command.id)}`,
        })),
      );
  }

  navigation(): {
    pluginId: string;
    pluginName: string;
    id: string;
    title: string;
    href: string;
  }[] {
    return this.plugins
      .list()
      .filter((plugin) => plugin.enabled && this.plugins.hasCapability(plugin.id, 'ui.global'))
      .flatMap((plugin) =>
        plugin.manifest.contributes.navigation.map((item) => ({
          pluginId: plugin.id,
          pluginName: plugin.name,
          id: item.id,
          title: item.title,
          href: item.href,
        })),
      );
  }

  async searchProviders(
    query: string,
    user: { id: number; username: string },
  ): Promise<{ title: string; subtitle: string; url: string }[]> {
    if (!query.trim()) return [];
    const results: { title: string; subtitle: string; url: string }[] = [];
    const plugins = this.plugins
      .list()
      .filter((plugin) => plugin.enabled && this.plugins.hasCapability(plugin.id, 'ui.global'));
    for (const plugin of plugins) {
      for (const provider of plugin.manifest.contributes.searchProviders) {
        try {
          const context = {
            query: query.slice(0, 200),
            user: { id: String(user.id), username: user.username },
          };
          const value =
            plugin.runtime === 'sandboxed'
              ? await this.sandbox.invokeJson(
                  plugin.id,
                  handlerName('search_provider', provider.id),
                  context,
                )
              : await this.runTrustedSearchProvider(
                  plugin.id,
                  plugin.version,
                  provider.id,
                  context,
                );
          results.push(
            ...searchResultsSchema.parse(value).map((result) => ({
              ...result,
              subtitle: `${plugin.name} · ${result.subtitle}`,
            })),
          );
        } catch {
          // An extension failure must not take down the global command palette.
        }
        if (results.length >= 30) return results.slice(0, 30);
      }
    }
    return results;
  }

  fileRenderers(repository: Repository, userId: number | null, path: string) {
    this.repositories.require(repository, userId, 'read');
    const extension = path.includes('.') ? (path.split('.').at(-1) ?? '').toLowerCase() : '';
    if (!extension) return [];
    return this.plugins
      .list()
      .filter(
        (plugin) =>
          plugin.enabled &&
          this.plugins.hasCapability(plugin.id, 'ui.repository') &&
          this.plugins.hasCapability(plugin.id, 'repositoryContents.read'),
      )
      .flatMap((plugin) =>
        plugin.manifest.contributes.fileRenderers
          .filter((renderer) => renderer.extensions.includes(extension))
          .map((renderer) => ({
            pluginId: plugin.id,
            pluginName: plugin.name,
            id: renderer.id,
            title: renderer.title,
          })),
      );
  }

  async renderFile(
    repository: Repository,
    userId: number | null,
    pluginId: string,
    rendererId: string,
    ref: string,
    path: string,
    content: Buffer,
  ): Promise<ContributionView> {
    const renderer = this.fileRenderers(repository, userId, path).find(
      (candidate) => candidate.pluginId === pluginId && candidate.id === rendererId,
    );
    if (!renderer) throw new PluginPermissionError();
    if (content.length > 1024 * 1024)
      throw new PluginContributionError('Plugin file rendering is limited to 1 MiB', 413);
    const plugin = this.plugins.get(pluginId);
    const context = {
      repository: { id: String(repository.id), owner: repository.ownerSlug, name: repository.slug },
      file: {
        ref,
        path,
        encoding: 'base64' as const,
        content: content.toString('base64'),
      },
    };
    if (plugin.runtime === 'sandboxed')
      return contributionViewSchema.parse(
        await this.sandbox.invokeJson(pluginId, handlerName('file_renderer', rendererId), context),
      );
    this.requireExplicitTrustedEnablement(plugin);
    const module = (await import(
      `${pathToFileURL(await this.plugins.entrypoint(pluginId)).href}?v=${encodeURIComponent(plugin.version)}`
    )) as { fileRenderers?: Record<string, (value: unknown) => unknown> };
    const handler = module.fileRenderers?.[rendererId];
    if (typeof handler !== 'function')
      throw new PluginContributionError('Trusted file renderer is unavailable');
    return contributionViewSchema.parse(await handler(context));
  }

  async transformMarkdown(
    repository: Repository,
    userId: number | null,
    ref: string,
    path: string,
    source: string,
  ): Promise<string> {
    this.repositories.require(repository, userId, 'read');
    if (Buffer.byteLength(source) > 1024 * 1024) return source;
    let value = source;
    const plugins = this.plugins
      .list()
      .filter(
        (plugin) =>
          plugin.enabled &&
          this.plugins.hasCapability(plugin.id, 'ui.repository') &&
          this.plugins.hasCapability(plugin.id, 'repositoryContents.read'),
      );
    for (const plugin of plugins) {
      for (const extension of plugin.manifest.contributes.markdownExtensions) {
        const context = {
          repository: {
            id: String(repository.id),
            owner: repository.ownerSlug,
            name: repository.slug,
          },
          document: { ref, path, source: value },
        };
        const transformed =
          plugin.runtime === 'sandboxed'
            ? await this.sandbox.invokeJson(
                plugin.id,
                handlerName('markdown_extension', extension.id),
                context,
              )
            : await this.runTrustedMarkdownExtension(
                plugin.id,
                plugin.version,
                extension.id,
                context,
              );
        if (typeof transformed !== 'string' || Buffer.byteLength(transformed) > 1024 * 1024)
          throw new PluginContributionError(
            'Markdown extension returned invalid or oversized text',
          );
        value = transformed;
      }
    }
    return value;
  }

  authenticationProviders() {
    return this.plugins
      .list()
      .filter((plugin) => plugin.enabled && this.plugins.hasCapability(plugin.id, 'auth.provider'))
      .flatMap((plugin) =>
        plugin.manifest.contributes.authenticationProviders.map((provider) => ({
          pluginId: plugin.id,
          pluginName: plugin.name,
          ...provider,
        })),
      );
  }

  async authenticate(
    pluginId: string,
    providerId: string,
    credentials: { username: string; password: string },
  ) {
    const provider = this.authenticationProviders().find(
      (candidate) => candidate.pluginId === pluginId && candidate.id === providerId,
    );
    if (!provider) throw new PluginPermissionError();
    const plugin = this.plugins.get(pluginId);
    const context = {
      credentials: {
        username: credentials.username.slice(0, 500),
        password: credentials.password.slice(0, 4096),
      },
    };
    const value =
      plugin.runtime === 'sandboxed'
        ? await this.sandbox.invokeJson(
            pluginId,
            handlerName('authentication_provider', providerId),
            context,
          )
        : await this.runTrustedAuthenticationProvider(
            pluginId,
            plugin.version,
            providerId,
            context,
          );
    return { provider, identity: authenticationIdentitySchema.parse(value) };
  }

  adminPages(): { pluginId: string; pluginName: string; id: string; title: string }[] {
    return this.plugins
      .list()
      .filter(
        (plugin) =>
          plugin.enabled &&
          this.plugins.hasCapability(plugin.id, 'ui.global') &&
          this.plugins.hasCapability(plugin.id, 'settings.read'),
      )
      .flatMap((plugin) =>
        plugin.manifest.contributes.adminPages.map((page) => ({
          pluginId: plugin.id,
          pluginName: plugin.name,
          id: page.id,
          title: page.title,
        })),
      );
  }

  themes() {
    return this.plugins
      .list()
      .filter((plugin) => plugin.enabled && this.plugins.hasCapability(plugin.id, 'ui.global'))
      .flatMap((plugin) =>
        plugin.manifest.contributes.themes.map((theme) => ({
          pluginId: plugin.id,
          pluginName: plugin.name,
          key: `${plugin.id}:${theme.id}`,
          ...theme,
        })),
      );
  }

  theme(key: string) {
    return this.themes().find((theme) => theme.key === key) ?? null;
  }

  async renderAdminPage(
    pluginId: string,
    pageId: string,
    user: { id: number; username: string },
  ): Promise<ContributionView> {
    const page = this.adminPages().find(
      (candidate) => candidate.pluginId === pluginId && candidate.id === pageId,
    );
    if (!page) throw new PluginPermissionError();
    const plugin = this.plugins.get(pluginId);
    const context = { user: { id: String(user.id), username: user.username } };
    if (plugin.runtime === 'sandboxed')
      return contributionViewSchema.parse(
        await this.sandbox.invokeJson(pluginId, handlerName('admin_page', pageId), context),
      );
    this.requireExplicitTrustedEnablement(plugin);
    const module = (await import(
      `${pathToFileURL(await this.plugins.entrypoint(pluginId)).href}?v=${encodeURIComponent(plugin.version)}`
    )) as { adminPages?: Record<string, (value: unknown) => unknown> };
    const handler = module.adminPages?.[pageId];
    if (typeof handler !== 'function')
      throw new PluginContributionError('Trusted administrator page is unavailable');
    return contributionViewSchema.parse(await handler(context));
  }

  async runCommand(
    pluginId: string,
    commandId: string,
    user: { id: number; username: string },
  ): Promise<ContributionView> {
    const command = this.commands().find(
      (candidate) => candidate.pluginId === pluginId && candidate.id === commandId,
    );
    if (!command) throw new PluginPermissionError();
    const plugin = this.plugins.get(pluginId);
    if (plugin.runtime === 'sandboxed') {
      return contributionViewSchema.parse(
        await this.sandbox.invokeJson(pluginId, handlerName('command', commandId), {
          user: { id: String(user.id), username: user.username },
        }),
      );
    }
    this.requireExplicitTrustedEnablement(plugin);
    const module = (await import(
      `${pathToFileURL(await this.plugins.entrypoint(pluginId)).href}?v=${encodeURIComponent(plugin.version)}`
    )) as {
      commands?: Record<string, (context: { user: { id: string; username: string } }) => unknown>;
    };
    const handler = module.commands?.[commandId];
    if (typeof handler !== 'function')
      throw new PluginContributionError('Trusted command handler is unavailable');
    return contributionViewSchema.parse(
      await handler({ user: { id: String(user.id), username: user.username } }),
    );
  }

  restEndpoint(pluginId: string, endpointId: string, method: string) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin.enabled) throw new PluginPermissionError();
    const endpoint = plugin.manifest.contributes.restEndpoints.find(
      (candidate) => candidate.id === endpointId && candidate.method === method,
    );
    if (!endpoint) throw new PluginPermissionError();
    return { plugin, endpoint };
  }

  async runRestEndpoint(
    pluginId: string,
    endpointId: string,
    method: string,
    context: { user: { id: string; username: string }; body: unknown },
  ): Promise<unknown> {
    const { plugin } = this.restEndpoint(pluginId, endpointId, method);
    if (plugin.runtime === 'sandboxed')
      return await this.sandbox.invokeJson(pluginId, handlerName('rest', endpointId), context);
    this.requireExplicitTrustedEnablement(plugin);
    const module = (await import(
      `${pathToFileURL(await this.plugins.entrypoint(pluginId)).href}?v=${encodeURIComponent(plugin.version)}`
    )) as { restEndpoints?: Record<string, (value: unknown) => unknown> };
    const handler = module.restEndpoints?.[endpointId];
    if (typeof handler !== 'function')
      throw new PluginContributionError('Trusted REST handler is unavailable');
    return safeJson(
      await handler({
        ...context,
        storage: this.storageFacade(pluginId),
      }),
    );
  }

  async dispatchEvent(
    pluginId: string,
    handlerId: string,
    event: string,
    payload: unknown,
  ): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin.enabled || !this.plugins.hasCapability(pluginId, 'events.subscribe'))
      throw new PluginPermissionError();
    if (plugin.runtime === 'sandboxed') {
      await this.sandbox.invokeJson(pluginId, handlerName('event', handlerId), { event, payload });
      return;
    }
    this.requireExplicitTrustedEnablement(plugin);
    const module = (await import(
      `${pathToFileURL(await this.plugins.entrypoint(pluginId)).href}?v=${encodeURIComponent(plugin.version)}`
    )) as { events?: Record<string, (value: unknown) => unknown> };
    const handler = module.events?.[handlerId];
    if (typeof handler !== 'function')
      throw new PluginContributionError('Trusted event handler is unavailable');
    await handler({ event, payload, storage: this.storageFacade(pluginId) });
  }

  repositoryTabs(repository: Repository, userId: number | null) {
    this.repositories.require(repository, userId, 'read');
    return this.plugins
      .list()
      .filter(
        (plugin) =>
          plugin.enabled &&
          this.plugins.hasCapability(plugin.id, 'ui.repository') &&
          (this.plugins.hasCapability(plugin.id, 'repositories.read') ||
            this.plugins.hasCapability(plugin.id, 'repositoryContents.read')),
      )
      .flatMap((plugin) =>
        plugin.manifest.contributes.repositoryTabs.map((tab) => ({
          pluginId: plugin.id,
          pluginName: plugin.name,
          id: tab.id,
          title: tab.title,
          url: `/${repository.ownerSlug}/${repository.slug}/plugins/${encodeURIComponent(plugin.id)}/${encodeURIComponent(tab.id)}`,
        })),
      );
  }

  async renderRepositoryTab(
    repository: Repository,
    userId: number | null,
    pluginId: string,
    tabId: string,
  ): Promise<ContributionView> {
    const tab = this.repositoryTabs(repository, userId).find(
      (candidate) => candidate.pluginId === pluginId && candidate.id === tabId,
    );
    if (!tab) throw new PluginPermissionError();
    const plugin = this.plugins.get(pluginId);
    if (plugin.runtime === 'sandboxed') {
      const response = await this.sandbox.invokeJson(
        pluginId,
        handlerName('repository_tab', tabId),
        {
          repository: {
            id: String(repository.id),
            owner: repository.ownerSlug,
            name: repository.slug,
            ref: repository.defaultBranch,
          },
        },
      );
      return contributionViewSchema.parse(response);
    }
    this.requireExplicitTrustedEnablement(plugin);
    const module = (await import(
      `${pathToFileURL(await this.plugins.entrypoint(pluginId)).href}?v=${encodeURIComponent(plugin.version)}`
    )) as {
      repositoryTabs?: Record<string, (host: PluginHost) => unknown>;
    };
    const handler = module.repositoryTabs?.[tabId];
    if (typeof handler !== 'function')
      throw new PluginContributionError('Trusted tab handler is unavailable');
    return contributionViewSchema.parse(await handler(this.trustedHost(pluginId, repository)));
  }

  private trustedHost(pluginId: string, repository: Repository): PluginHost {
    const mayRead = this.plugins.hasCapability(pluginId, 'repositoryContents.read');
    return {
      repository: {
        id: String(repository.id),
        owner: repository.ownerSlug,
        name: repository.slug,
        ref: repository.defaultBranch,
      },
      storage: this.storageFacade(pluginId),
      readTextFiles: (options) => this.readTextFiles(repository, mayRead, options?.maximumBytes),
      log: (level, message) => {
        void level;
        void message;
      },
    };
  }

  /**
   * PluginManager installs every plugin disabled and only allows trusted code
   * to be enabled after an explicit risk acknowledgement. Keep that policy at
   * the execution boundary too, so resolving a contribution cannot import
   * trusted Node code while the plugin is disabled.
   */
  private requireExplicitTrustedEnablement(plugin: {
    runtime: 'trusted' | 'sandboxed';
    enabled: boolean;
  }): void {
    if (plugin.runtime === 'trusted' && !plugin.enabled)
      throw new PluginPermissionError('Trusted plugin requires explicit enablement');
  }

  private async runTrustedSearchProvider(
    pluginId: string,
    version: string,
    providerId: string,
    context: { query: string; user: { id: string; username: string } },
  ): Promise<unknown> {
    this.requireExplicitTrustedEnablement(this.plugins.get(pluginId));
    const module = (await import(
      `${pathToFileURL(await this.plugins.entrypoint(pluginId)).href}?v=${encodeURIComponent(version)}`
    )) as { searchProviders?: Record<string, (value: unknown) => unknown> };
    const handler = module.searchProviders?.[providerId];
    if (typeof handler !== 'function')
      throw new PluginContributionError('Trusted search provider is unavailable');
    return await handler(context);
  }

  private async runTrustedMarkdownExtension(
    pluginId: string,
    version: string,
    extensionId: string,
    context: unknown,
  ): Promise<unknown> {
    this.requireExplicitTrustedEnablement(this.plugins.get(pluginId));
    const module = (await import(
      `${pathToFileURL(await this.plugins.entrypoint(pluginId)).href}?v=${encodeURIComponent(version)}`
    )) as { markdownExtensions?: Record<string, (value: unknown) => unknown> };
    const handler = module.markdownExtensions?.[extensionId];
    if (typeof handler !== 'function')
      throw new PluginContributionError('Trusted Markdown extension is unavailable');
    return await handler(context);
  }

  private async runTrustedAuthenticationProvider(
    pluginId: string,
    version: string,
    providerId: string,
    context: unknown,
  ): Promise<unknown> {
    this.requireExplicitTrustedEnablement(this.plugins.get(pluginId));
    const module = (await import(
      `${pathToFileURL(await this.plugins.entrypoint(pluginId)).href}?v=${encodeURIComponent(version)}`
    )) as { authenticationProviders?: Record<string, (value: unknown) => unknown> };
    const handler = module.authenticationProviders?.[providerId];
    if (typeof handler !== 'function')
      throw new PluginContributionError('Trusted authentication provider is unavailable');
    return await handler(context);
  }

  private storageFacade(pluginId: string): PluginHost['storage'] {
    return {
      get: (key) => Promise.resolve(this.plugins.storageGet(pluginId, key)),
      set: (key, value) => {
        this.plugins.storageSet(pluginId, key, Buffer.from(value));
        return Promise.resolve();
      },
      delete: (key) => {
        this.plugins.storageDelete(pluginId, key);
        return Promise.resolve();
      },
    };
  }

  private async *readTextFiles(
    repository: Repository,
    allowed: boolean,
    requestedLimit = 1024 * 1024,
  ): AsyncIterable<{ path: string; content: string }> {
    if (!allowed) throw new PluginPermissionError();
    const byteLimit = Math.min(Math.max(requestedLimit, 1), 4 * 1024 * 1024);
    let bytes = 0;
    let files = 0;
    const directories = [''];
    while (directories.length > 0 && files < 1000) {
      const directory = directories.shift() ?? '';
      for (const entry of await this.repositories.listTree(
        repository,
        repository.defaultBranch,
        directory,
      )) {
        if (entry.type === 'tree') directories.push(entry.name);
        else if (entry.type === 'blob' && entry.size !== null && entry.size <= byteLimit - bytes) {
          const content = await this.repositories.readBlob(
            repository,
            repository.defaultBranch,
            entry.name,
          );
          if (content.subarray(0, 8192).includes(0)) continue;
          bytes += content.length;
          files += 1;
          if (bytes > byteLimit) return;
          yield { path: entry.name, content: content.toString('utf8') };
        }
      }
    }
  }
}

function safeJson(value: unknown): unknown {
  const encoded: unknown = JSON.stringify(value);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 1024 * 1024)
    throw new PluginContributionError('Plugin response is not bounded JSON');
  return JSON.parse(encoded) as unknown;
}

function handlerName(prefix: string, contributionId: string): string {
  return `${prefix}_${contributionId.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

export class PluginContributionError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
  ) {
    super(message);
  }
}
