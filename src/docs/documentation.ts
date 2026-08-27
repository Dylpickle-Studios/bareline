import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headingAnchor, renderMarkdown } from '../web/markdown.js';

export const documentation = [
  { slug: 'getting-started', title: 'Getting Started', file: 'getting-started.md' },
  { slug: 'deployment', title: 'Deployment and TLS', file: 'deployment.md' },
  { slug: 'git-guide', title: 'Git guide', file: 'git-guide.md' },
  { slug: 'administration', title: 'Administration', file: 'administration.md' },
  { slug: 'operations', title: 'Operations and backups', file: 'operations.md' },
  { slug: 'api', title: 'REST API', file: 'api.md' },
  { slug: 'plugins', title: 'Plugins', file: 'plugins.md' },
  {
    slug: 'themes-accessibility',
    title: 'Themes and accessibility',
    file: 'themes-accessibility.md',
  },
  { slug: 'ssh', title: 'SSH setup', file: 'ssh.md' },
  { slug: 'security', title: 'Security and threat model', file: 'threat-model.md' },
  { slug: 'assurance', title: 'Security assurance', file: 'security-assurance.md' },
  { slug: 'readiness', title: 'Production readiness', file: 'production-readiness.md' },
] as const;

export async function documentationPage(slug: string): Promise<{ title: string; html: string }> {
  const document = documentation.find((entry) => entry.slug === slug);
  if (!document) throw new DocumentationNotFoundError();
  return { title: document.title, html: renderMarkdown(await documentationSource(document.file)) };
}

export async function documentationSearch(
  queryInput: string,
  limit = 12,
): Promise<{ title: string; subtitle: string; url: string }[]> {
  const query = queryInput.trim().toLocaleLowerCase();
  if (!query) return [];
  const results: { title: string; subtitle: string; url: string }[] = [];
  for (const document of documentation) {
    const source = await documentationSource(document.file);
    if (!`${document.title} ${source}`.toLocaleLowerCase().includes(query)) continue;
    const matchingHeadings = [...source.matchAll(/^#{1,6}\s+(.+)$/gm)]
      .map((match) => match[1]?.trim() ?? '')
      .filter((heading) => heading.toLocaleLowerCase().includes(query));
    if (matchingHeadings.length === 0) {
      results.push({
        title: document.title,
        subtitle: 'Documentation',
        url: `/docs/${document.slug}`,
      });
    } else {
      for (const heading of matchingHeadings)
        results.push({
          title: heading,
          subtitle: document.title,
          url: `/docs/${document.slug}#${headingAnchor(heading)}`,
        });
    }
    if (results.length >= limit) break;
  }
  return results.slice(0, limit);
}

async function documentationSource(fileName: string): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, fileName), join(here, '..', '..', 'docs', fileName)];
  for (const file of candidates) {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if (file === candidates.at(-1)) throw error;
    }
  }
  throw new DocumentationNotFoundError();
}

export class DocumentationNotFoundError extends Error {
  readonly statusCode = 404;
}
