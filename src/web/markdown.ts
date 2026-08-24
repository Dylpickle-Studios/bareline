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

export function renderMarkdown(source: string): string {
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
      a: (_tagName, attributes) => ({
        tagName: 'a',
        attribs: {
          ...attributes,
          ...(attributes.href?.startsWith('http') ? { rel: 'nofollow noreferrer noopener' } : {}),
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
