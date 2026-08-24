const languageKeywords: Readonly<Record<string, ReadonlySet<string>>> = {
  js: new Set([
    'async',
    'await',
    'break',
    'case',
    'class',
    'const',
    'continue',
    'default',
    'else',
    'export',
    'extends',
    'false',
    'for',
    'from',
    'function',
    'if',
    'import',
    'in',
    'instanceof',
    'let',
    'new',
    'null',
    'return',
    'static',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'typeof',
    'undefined',
    'while',
    'yield',
  ]),
  py: new Set([
    'and',
    'as',
    'async',
    'await',
    'break',
    'class',
    'continue',
    'def',
    'del',
    'elif',
    'else',
    'except',
    'False',
    'finally',
    'for',
    'from',
    'if',
    'import',
    'in',
    'is',
    'lambda',
    'None',
    'not',
    'or',
    'pass',
    'raise',
    'return',
    'True',
    'try',
    'while',
    'with',
    'yield',
  ]),
  sh: new Set([
    'case',
    'do',
    'done',
    'elif',
    'else',
    'esac',
    'fi',
    'for',
    'function',
    'if',
    'in',
    'then',
    'while',
  ]),
};

const aliases: Readonly<Record<string, keyof typeof languageKeywords>> = {
  cjs: 'js',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  ts: 'js',
  tsx: 'js',
  py: 'py',
  bash: 'sh',
  sh: 'sh',
  zsh: 'sh',
};

export function highlightSource(source: string, path: string): string[] {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? '';
  const language = aliases[extension];
  const keywords = language ? languageKeywords[language] : undefined;
  return source.split('\n').map((line) => highlightLine(line, language, keywords));
}

function highlightLine(
  line: string,
  language: keyof typeof languageKeywords | undefined,
  keywords: ReadonlySet<string> | undefined,
): string {
  const commentMarker =
    language === 'py' || language === 'sh' ? '#' : language === 'js' ? '//' : '';
  const commentAt = commentMarker ? line.indexOf(commentMarker) : -1;
  const source = commentAt >= 0 ? line.slice(0, commentAt) : line;
  const comment = commentAt >= 0 ? line.slice(commentAt) : '';
  const highlighted = keywords
    ? escapeHtml(source).replace(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g, (word) =>
        keywords.has(word) ? `<span class="syntax-keyword">${word}</span>` : word,
      )
    : escapeHtml(source);
  return comment
    ? `${highlighted}<span class="syntax-comment">${escapeHtml(comment)}</span>`
    : highlighted;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
