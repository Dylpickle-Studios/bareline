import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
});

markdown.core.ruler.after('inline', 'task-list-items', (state) => {
  for (const token of state.tokens) {
    if (token.type !== 'inline' || !token.children?.length) continue;
    const first = token.children[0];
    const task = first?.type === 'text' ? /^\[([ xX])\]\s+/.exec(first.content) : null;
    if (!task || !first) continue;
    first.content = first.content.slice(task[0].length);
    const checkbox = new state.Token('html_inline', '', 0);
    checkbox.content = `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'} aria-label="Task status"> `;
    token.children.unshift(checkbox);
  }
});

markdown.renderer.rules.heading_open = (tokens, index, _options, environment) => {
  const token = tokens[index];
  const inline = tokens[index + 1];
  if (!token) return '';
  const base = headingAnchor(inline?.content ?? 'section');
  const env = environment as { headingCounts?: Map<string, number> };
  env.headingCounts ??= new Map();
  const count = env.headingCounts.get(base) ?? 0;
  env.headingCounts.set(base, count + 1);
  const anchor = count === 0 ? base : `${base}-${String(count + 1)}`;
  return `<${token.tag} id="${markdown.utils.escapeHtml(anchor)}"><a href="#${markdown.utils.escapeHtml(anchor)}" class="heading-anchor" aria-label="Link to this heading">#</a> `;
};

export interface MarkdownLinkContext {
  /** URL prefix for repository files, e.g. `/alice/example/blob`. */
  blobBase: string;
  /** URL prefix for raw file content, e.g. `/alice/example/raw`. */
  rawBase: string;
  /** Query string appended to rewritten links, e.g. `?ref=main`. */
  query: string;
  /** Directory (no leading or trailing slash) that relative paths are resolved against. */
  directory: string;
}

/**
 * Resolves a Markdown link target that is relative to a file in the repository into a Bareline
 * URL. Absolute URLs, fragments, and site-absolute paths are returned unchanged.
 */
export function resolveRepositoryLink(
  target: string,
  context: MarkdownLinkContext,
  kind: 'blob' | 'raw',
): string {
  if (
    target === '' ||
    target.startsWith('#') ||
    target.startsWith('/') ||
    /^[a-z][a-z0-9+.-]*:/i.test(target)
  )
    return target;
  let resolved: URL;
  try {
    resolved = new URL(
      target,
      `http://repository.invalid/${context.directory ? `${context.directory}/` : ''}`,
    );
  } catch {
    return target;
  }
  const path = resolved.pathname.replace(/^\/+/, '');
  if (!path) return target;
  const base = kind === 'raw' ? context.rawBase : context.blobBase;
  return `${base}/${path}${context.query}${resolved.hash}`;
}

export function renderMarkdown(source: string, links?: MarkdownLinkContext): string {
  const rendered = markdown.render(source, {});
  return sanitizeHtml(rendered, {
    allowedTags: [
      'p',
      'br',
      'hr',
      'blockquote',
      'pre',
      'code',
      'strong',
      'em',
      'del',
      'ul',
      'ol',
      'li',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'a',
      'img',
      'input',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'class', 'aria-label'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      th: ['align'],
      td: ['align'],
      input: ['type', 'checked', 'disabled', 'aria-label'],
      h1: ['id'],
      h2: ['id'],
      h3: ['id'],
      h4: ['id'],
      h5: ['id'],
      h6: ['id'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowProtocolRelative: false,
    transformTags: {
      a: (_tagName, attributes) => {
        const href =
          links && attributes.href !== undefined
            ? resolveRepositoryLink(attributes.href, links, 'blob')
            : attributes.href;
        return {
          tagName: 'a',
          attribs: {
            ...attributes,
            ...(href === undefined ? {} : { href }),
            ...(href?.startsWith('http') ? { rel: 'nofollow noreferrer noopener' } : {}),
          },
        };
      },
      img: (_tagName, attributes) => ({
        tagName: 'img',
        attribs: {
          ...attributes,
          ...(links && attributes.src !== undefined
            ? { src: resolveRepositoryLink(attributes.src, links, 'raw') }
            : {}),
        },
      }),
    },
    exclusiveFilter(frame) {
      return frame.tag === 'img' && /\.svg(?:$|[?#])/i.test(frame.attribs.src ?? '');
    },
  });
}

export function headingAnchor(value: string): string {
  const anchor = value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return anchor || 'section';
}
