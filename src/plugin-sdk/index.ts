export const pluginApiVersion = 1 as const;

export interface RepositoryContext {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly ref: string;
}

export interface PluginStorage {
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PluginHost {
  readonly repository: RepositoryContext;
  readonly storage: PluginStorage;
  readTextFiles(options?: { readonly maximumBytes?: number }): AsyncIterable<{
    readonly path: string;
    readonly content: string;
  }>;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

export interface PluginDefinition {
  readonly apiVersion: typeof pluginApiVersion;
  activate(host: PluginHost): Promise<void> | void;
}

export type DeclarativeBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'metric'; readonly label: string; readonly value: string | number }
  | { readonly type: 'link'; readonly label: string; readonly href: `/${string}` };

export interface RepositoryTabView {
  readonly title: string;
  readonly blocks: readonly DeclarativeBlock[];
}

export interface MarkdownExtensionContext {
  readonly repository: Omit<RepositoryContext, 'ref'>;
  readonly document: { readonly ref: string; readonly path: string; readonly source: string };
}

export interface AuthenticationProviderContext {
  readonly credentials: { readonly username: string; readonly password: string };
}

export interface AuthenticationIdentity {
  readonly subject: string;
  readonly username: string;
  readonly displayName: string;
  readonly email?: string;
}

export interface SandboxedRequest<T> {
  readonly apiVersion: 1;
  readonly capabilities: readonly string[];
  readonly host: { readonly storage?: Readonly<Record<string, string>> };
  readonly input: T;
}

export type SandboxedStorageEffect =
  | { readonly operation: 'set'; readonly key: string; readonly value: string }
  | { readonly operation: 'delete'; readonly key: string };

export interface SandboxedHostResponse<T> {
  readonly gitHost: { readonly apiVersion: 1; readonly effects: readonly SandboxedStorageEffect[] };
  readonly result: T;
}

export function sandboxedResponse<T>(
  result: T,
  effects: readonly SandboxedStorageEffect[] = [],
): SandboxedHostResponse<T> {
  return { gitHost: { apiVersion: 1, effects }, result };
}

/** Provides compile-time checking without wrapping or mutating plugin code. */
export function definePlugin<T extends PluginDefinition>(definition: T): T {
  return definition;
}

export function createMockHost(
  files: Readonly<Record<string, string>> = { 'README.md': '# Example\n' },
): PluginHost {
  const values = new Map<string, Uint8Array>();
  return {
    repository: { id: 'test-repository', owner: 'sample', name: 'project', ref: 'main' },
    storage: {
      get(key) {
        return Promise.resolve(values.get(key) ?? null);
      },
      set(key, value) {
        values.set(key, value.slice());
        return Promise.resolve();
      },
      delete(key) {
        values.delete(key);
        return Promise.resolve();
      },
    },
    async *readTextFiles(options) {
      await Promise.resolve();
      let used = 0;
      const limit = options?.maximumBytes ?? 1024 * 1024;
      for (const [path, content] of Object.entries(files)) {
        used += Buffer.byteLength(content);
        if (used > limit) throw new Error('Mock repository read limit exceeded');
        yield { path, content };
      }
    },
    log(level, message) {
      void level;
      void message;
    },
  };
}
