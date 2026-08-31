import { describe, expect, it } from 'vitest';
import { atomFeed } from '../src/feeds/atom.js';

describe('Atom feeds', () => {
  it('escapes hostile repository and commit metadata', () => {
    const output = atomFeed({
      publicUrl: 'https://git.example.test',
      repository: {
        id: 1,
        ownerType: 'user',
        ownerId: 1,
        ownerSlug: 'alice',
        slug: 'example',
        description: '',
        visibility: 'public',
        storageId: 'a'.repeat(64),
        storageKind: 'hosted_bare',
        storagePath: null,
        defaultBranch: 'main',
        archivedAt: null,
      },
      commits: [
        {
          objectId: 'a'.repeat(40),
          shortId: 'aaaaaaaa',
          subject: '<script>alert(1)</script>',
          authorName: 'A & B',
          authorEmail: 'hidden@example.test',
          authoredAt: '2025-01-01T00:00:00Z',
        },
      ],
    });
    expect(output).toContain('&lt;script&gt;');
    expect(output).not.toContain('<script>');
    expect(output).not.toContain('hidden@example.test');
  });
});
