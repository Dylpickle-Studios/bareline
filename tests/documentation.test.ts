import { describe, expect, it } from 'vitest';
import {
  documentation,
  documentationPage,
  documentationSearch,
} from '../src/docs/documentation.js';

describe('built-in documentation', () => {
  it('covers the main user, operations, API, plugin, and accessibility guides', () => {
    expect(documentation.map((entry) => entry.slug)).toEqual(
      expect.arrayContaining([
        'getting-started',
        'deployment',
        'git-guide',
        'administration',
        'operations',
        'api',
        'plugins',
        'themes-accessibility',
        'ssh',
        'security',
      ]),
    );
  });

  it('searches headings and deep-links to their rendered anchors', async () => {
    const results = await documentationSearch('restoring backups');
    expect(results).toContainEqual({
      title: 'Restoring backups',
      subtitle: 'Operations and backups',
      url: '/docs/operations#restoring-backups',
    });
    const page = await documentationPage('operations');
    expect(page.html).toContain('id="restoring-backups"');
  });
});
