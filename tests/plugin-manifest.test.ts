import { describe, expect, it } from 'vitest';
import { validatePluginManifest } from '../src/plugins/manifest.js';

describe('plugin manifest', () => {
  it('accepts an explicit least-privilege sandbox manifest', () => {
    const manifest = validatePluginManifest({
      id: 'example.word-count',
      name: 'Repository Word Count',
      version: '1.0.0',
      apiVersion: 1,
      runtime: 'sandboxed',
      entrypoint: 'dist/plugin.wasm',
      permissions: ['repositoryContents.read', 'storage.plugin'],
      contributes: {
        repositoryTabs: [{ id: 'word-count', title: 'Word Count' }],
        commands: [{ id: 'word-count.calculate', title: 'Calculate word count' }],
      },
      settings: { includeMarkdown: { type: 'boolean', title: 'Include Markdown', default: true } },
    });
    expect(manifest.runtime).toBe('sandboxed');
  });

  it.each([
    { permissions: ['network.outbound', 'network.outbound'] },
    { unknown: true },
    { runtime: 'sandboxed', entrypoint: 'index.js' },
    {
      contributes: {
        commands: [
          { id: 'duplicate.command', title: 'First' },
          { id: 'duplicate.command', title: 'Second' },
        ],
      },
    },
  ])('rejects unsafe or ambiguous fields: %o', (change) => {
    expect(() =>
      validatePluginManifest({
        id: 'example.test',
        name: 'Test',
        version: '1.0.0',
        apiVersion: 1,
        runtime: 'sandboxed',
        entrypoint: 'plugin.wasm',
        ...change,
      }),
    ).toThrow();
  });

  it('rejects ambient capabilities for sandboxed plugins', () => {
    expect(() =>
      validatePluginManifest({
        id: 'example.ambient',
        name: 'Ambient access',
        version: '1.0.0',
        apiVersion: 1,
        runtime: 'sandboxed',
        entrypoint: 'plugin.wasm',
        permissions: ['network.outbound'],
      }),
    ).toThrow(/ambient capabilities/);
  });
});
