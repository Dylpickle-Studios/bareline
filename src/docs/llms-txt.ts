import { product } from '../app/metadata.js';
import { documentation } from './documentation.js';

const documentationBlurbs: Readonly<Record<string, string>> = {
  'getting-started': 'Install, sign in, create a repository, clone/push over HTTPS or SSH.',
  deployment: 'TLS termination modes and reverse-proxy deployment.',
  upgrade: 'Upgrading between versions and disaster recovery.',
  'git-guide': 'Everyday Git workflows against this server.',
  administration: 'Server administration: users, repositories, runtime settings.',
  operations: 'Operating the service: backups, restores, health checks.',
  api: 'The versioned REST API, authenticated with bearer tokens.',
  plugins: 'The plugin SDK: sandboxed extensions, contribution points, events.',
  'themes-accessibility': 'Theming and accessibility features of the web UI.',
  ssh: 'Configuring SSH access and forced-command Git transport.',
  security: 'Threat model and security architecture.',
  assurance: 'Independent security assurance evidence.',
  readiness: 'Production readiness checklist.',
};

/**
 * Renders the server's /llms.txt (see https://llmstxt.org): a plain-text, link-dense summary an
 * LLM-based tool can fetch to learn what this Git server can do without crawling the whole UI.
 */
export function llmsTxt(publicUrl: string): string {
  const origin = publicUrl.replace(/\/$/, '');
  const lines: string[] = [];
  lines.push(`# ${product.name}`, '');
  lines.push(
    `> ${product.shortDescription} A self-hosted Git server and Git web interface — repositories, browsing, diffs, and Git-native collaboration — deliberately without a pull-request system, CI/CD, or project-management boards.`,
    '',
  );
  lines.push(
    'This page follows the llms.txt convention. Every path below is relative to ' +
      `${origin} and is a real, working HTTP endpoint. Fetch the linked pages for full detail; ` +
      'the REST API (OpenAPI/Swagger) is the preferred integration surface for programmatic use.',
    '',
  );

  lines.push('## Core Git hosting', '');
  lines.push(
    '- Repositories: `GET /:owner/:repo` (tree/README), `/tree/*`, `/blob/*`, `/raw/*`, `/commits`, `/commit/:id`, `/blame/*`, `/branches`, `/tags`, `/compare?base=&head=`, `/archive?ref=&format=zip|tar.gz`.',
    '- Cloning and pushing: HTTPS Smart HTTP and SSH (forced-command) at the same repository path; see the Git guide below.',
    '- Search: `GET /search?q=` for code, commits, and repositories; `GET /api/v1/palette?q=` for the command palette.',
    '- Git LFS: standard `git-lfs` batch API is served at the repository path.',
    '',
  );

  lines.push('## Collaboration without pull requests', '');
  lines.push(
    '- Patches: `GET /:owner/:repo/patches` to view/import a patch (paste or upload; preview before applying), `GET /:owner/:repo/commit/:id/patch` and `GET /:owner/:repo/compare/patch?base=&head=` to export a `git format-patch` series.',
    '- Forking: `GET /:owner/:repo/fork` (form), `POST /:owner/:repo/fork` clones every branch and tag into a new, independently owned repository.',
    '- Cherry-pick: `POST /:owner/:repo/commit/:id/cherry-pick` applies one commit onto another branch.',
    '- Revert: `POST /:owner/:repo/commit/:id/revert` applies the inverse of one (non-merge) commit onto a branch.',
    '- Merge: `GET /:owner/:repo/merge` (form), `POST /:owner/:repo/merge` fast-forwards when possible or creates a real merge commit (a genuine three-way merge via `git merge-tree`, not a squash).',
    '',
  );

  lines.push('## Wikis and releases', '');
  lines.push(
    '- Wiki: `GET /:owner/:repo/wiki` and `/:owner/:repo/wiki/:page`; each repository wiki is itself a small Git repository of Markdown pages, edited at `/:owner/:repo/wiki/:page/edit`.',
    '- Releases: `GET /:owner/:repo/releases`; `POST /:owner/:repo/releases` publishes a tag-backed release with Markdown notes and uploadable binary assets.',
    '',
  );

  lines.push('## Insights', '');
  lines.push(
    '- `GET /:owner/:repo/insights`: per-language byte breakdown of the tree and per-author commit counts.',
    '',
  );

  lines.push('## Reference documentation', '');
  for (const entry of documentation) {
    const blurb = documentationBlurbs[entry.slug];
    lines.push(`- [${entry.title}](${origin}/docs/${entry.slug})${blurb ? `: ${blurb}` : ''}`);
  }
  lines.push('');

  lines.push('## API', '');
  lines.push(
    `- [REST API reference](${origin}/docs/api)`,
    `- OpenAPI/Swagger UI: ${origin}/api/docs`,
    '',
  );

  return lines.join('\n');
}
