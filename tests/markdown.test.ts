import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/web/markdown.js';

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

  it('adds stable heading anchors and disabled task-list controls', () => {
    const output = renderMarkdown('# Release plan\n\n- [x] Ship\n- [ ] Document');
    expect(output).toContain('id="release-plan"');
    expect(output).toContain('href="#release-plan"');
    expect(output).toMatch(/<input[^>]+type="checkbox"[^>]+disabled[^>]+checked/);
    expect(output).toContain('aria-label="Task status"');
  });
});
