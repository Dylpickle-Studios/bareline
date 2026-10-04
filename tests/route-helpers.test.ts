import { describe, expect, it } from 'vitest';
import { formatBytes, relativeDate } from '../src/app/routes/route-helpers.js';
import { repositoryNavigation } from '../src/app/create-app.js';

describe('route helpers', () => {
  it('formats byte counts for people', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1000)).toBe('1.0 KB');
    expect(formatBytes(15_360)).toBe('15.4 KB');
    expect(formatBytes(123_456_789)).toBe('123 MB');
    expect(formatBytes(5 * 1024 ** 4)).toBe('5.5 TB');
    expect(formatBytes(-1)).toBe('');
    expect(formatBytes(Number.NaN)).toBe('');
  });

  it('describes relative dates', () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    expect(relativeDate('2026-10-02T11:59:50Z', now)).toBe('just now');
    expect(relativeDate('2026-10-02T10:00:00Z', now)).toBe('2 hours ago');
    expect(relativeDate('2026-10-03T12:00:00Z', now)).toBe('in 1 day');
  });

  it('builds the shared repository tab bar with the active tab marked', () => {
    const repository = {
      id: 1,
      ownerType: 'user' as const,
      ownerId: 1,
      ownerSlug: 'alice',
      slug: 'example',
      description: '',
      visibility: 'public' as const,
      storageId: 'x',
      storageKind: 'hosted_bare' as const,
      storagePath: null,
      defaultBranch: 'main',
      archivedAt: null,
      forkedFromId: null,
    };
    const navigation = repositoryNavigation('refs', repository, {
      canAdmin: true,
      pluginTabs: [{ title: 'Word count', url: '/alice/example/plugins/wc/count' }],
      refsKind: 'Tags',
    });
    expect(navigation.home).toBe('/alice/example');
    expect(navigation.items.filter((item) => item.current).map((item) => item.label)).toEqual([
      'Tags',
    ]);
    expect(navigation.items.map((item) => item.label)).toEqual([
      'Code',
      'Commits',
      'Branches',
      'Tags',
      'Compare',
      'Patches',
      'Releases',
      'Wiki',
      'Insights',
      'Issues',
      'Activity',
      'Word count',
      'Settings',
    ]);
    const reader = repositoryNavigation('blob', repository, { canAdmin: false, pluginTabs: [] });
    expect(reader.items.find((item) => item.current)?.label).toBe('Code');
    expect(reader.items.some((item) => item.label === 'Settings')).toBe(false);
  });
});
