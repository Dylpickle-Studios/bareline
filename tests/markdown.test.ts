import { describe, expect, it } from 'vitest';
import { renderMarkdown, resolveRepositoryLink } from '../src/web/markdown.js';

describe('hostile Markdown rendering', () => {
  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[click](javascript:alert(1))',
    '<svg><script>alert(1)</script></svg>',
    '![active](https://example.test/image.svg)',
  ])('removes active content from %j', (payload) => {
    const output = renderMarkdown(payload);
    expect(output).not.toMatch(
      /<script|<img[^>]+onerror|href=["']javascript:|<svg|src=["'][^"']*\.svg/i,
    );
  });

  it('renders ordinary Markdown structure', () => {
    const output = renderMarkdown('# Heading\n\n| A | B |\n| - | - |\n| 1 | 2 |');
    expect(output).toContain('<h1 id="heading">');
    expect(output).toContain('<table>');
  });

  it('rewrites relative links and images to repository URLs when a file context is given', () => {
    const links = {
      blobBase: '/alice/example/blob',
      rawBase: '/alice/example/raw',
      query: '?ref=main',
      directory: 'docs',
    };
    const output = renderMarkdown(
      [
        '[guide](guides/install.md#setup)',
        '[up](../CHANGELOG.md)',
        '[site](/explore)',
        '[ext](https://example.test/)',
        '[anchor](#top)',
        '![shot](./images/shot.png)',
        '![remote](https://example.test/shot.png)',
      ].join('\n\n'),
      links,
    );
    expect(output).toContain('href="/alice/example/blob/docs/guides/install.md?ref=main#setup"');
    expect(output).toContain('href="/alice/example/blob/CHANGELOG.md?ref=main"');
    expect(output).toContain('href="/explore"');
    expect(output).toContain('href="https://example.test/"');
    expect(output).toContain('href="#top"');
    expect(output).toContain('src="/alice/example/raw/docs/images/shot.png?ref=main"');
    expect(output).toContain('src="https://example.test/shot.png"');
    expect(renderMarkdown('[x](README.md)')).toContain('href="README.md"');
  });

  it('never lets a rewritten link escape the repository or smuggle a scheme', () => {
    const links = {
      blobBase: '/alice/example/blob',
      rawBase: '/alice/example/raw',
      query: '?ref=main',
      directory: '',
    };
    expect(resolveRepositoryLink('../../../etc/passwd', links, 'blob')).toBe(
      '/alice/example/blob/etc/passwd?ref=main',
    );
    expect(resolveRepositoryLink('javascript:alert(1)', links, 'blob')).toBe('javascript:alert(1)');
    expect(resolveRepositoryLink('//evil.test/x', links, 'blob')).toBe('//evil.test/x');
    expect(renderMarkdown('[x](javascript:alert(1))', links)).not.toMatch(/href=["']javascript:/);
    expect(renderMarkdown('[x](//evil.test/x)', links)).not.toMatch(/href=["'][^"']*evil\.test/);
  });

  it('adds stable heading anchors and disabled task-list controls', () => {
    const output = renderMarkdown('# Release plan\n\n- [x] Ship\n- [ ] Document');
    expect(output).toContain('id="release-plan"');
    expect(output).toContain('href="#release-plan"');
    expect(output).toMatch(/<input[^>]+type="checkbox"[^>]+disabled[^>]+checked/);
    expect(output).toContain('aria-label="Task status"');
  });
});
