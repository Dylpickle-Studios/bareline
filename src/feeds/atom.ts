import type { Repository } from '../repositories/repository-types.js';
import type { CommitSummary } from '../git/git-browser.js';

export function atomFeed(input: {
  repository: Repository;
  commits: readonly CommitSummary[];
  publicUrl: string;
}): string {
  const repositoryUrl = `${input.publicUrl.replace(/\/$/, '')}/${input.repository.ownerSlug}/${input.repository.slug}`;
  const updated = input.commits[0]?.authoredAt ?? new Date(0).toISOString();
  const entries = input.commits
    .map((commit) => {
      const url = `${repositoryUrl}/commit/${commit.objectId}`;
      return `<entry>
  <id>urn:git:${commit.objectId}</id>
  <title>${xml(commit.subject)}</title>
  <link href="${xml(url)}"/>
  <updated>${xml(commit.authoredAt)}</updated>
  <author><name>${xml(commit.authorName)}</name></author>
</entry>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${xml(repositoryUrl)}</id>
  <title>${xml(`${input.repository.ownerSlug}/${input.repository.slug} commits`)}</title>
  <link href="${xml(repositoryUrl)}"/>
  <link rel="self" href="${xml(`${repositoryUrl}/commits.atom`)}"/>
  <updated>${xml(updated)}</updated>
${entries}
</feed>\n`;
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
