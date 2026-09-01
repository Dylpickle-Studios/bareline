const extensionLanguages: Readonly<Record<string, string>> = {
  js: 'JavaScript',
  cjs: 'JavaScript',
  mjs: 'JavaScript',
  jsx: 'JavaScript',
  ts: 'TypeScript',
  tsx: 'TypeScript',
  py: 'Python',
  rb: 'Ruby',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  swift: 'Swift',
  c: 'C',
  h: 'C',
  cc: 'C++',
  cpp: 'C++',
  hpp: 'C++',
  cs: 'C#',
  php: 'PHP',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  ps1: 'PowerShell',
  sql: 'SQL',
  html: 'HTML',
  htm: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  md: 'Markdown',
  markdown: 'Markdown',
  eta: 'Eta',
  vue: 'Vue',
  svelte: 'Svelte',
  dart: 'Dart',
  lua: 'Lua',
  ex: 'Elixir',
  exs: 'Elixir',
  erl: 'Erlang',
  hs: 'Haskell',
  scala: 'Scala',
  clj: 'Clojure',
  r: 'R',
  m: 'Objective-C',
  pl: 'Perl',
  proto: 'Protocol Buffers',
  dockerfile: 'Dockerfile',
  tf: 'Terraform',
  graphql: 'GraphQL',
};

export function languageForPath(path: string): string | null {
  const base = path.split('/').at(-1) ?? path;
  if (base.toLowerCase() === 'dockerfile') return 'Dockerfile';
  if (base.toLowerCase() === 'makefile') return 'Makefile';
  const extension = base.includes('.') ? (base.split('.').at(-1)?.toLowerCase() ?? '') : '';
  return extensionLanguages[extension] ?? null;
}

export interface LanguageStat {
  language: string;
  bytes: number;
  percent: number;
}

export function computeLanguageStats(
  entries: readonly { path: string; size: number }[],
): LanguageStat[] {
  const byLanguage = new Map<string, number>();
  let total = 0;
  for (const entry of entries) {
    const language = languageForPath(entry.path);
    if (!language) continue;
    byLanguage.set(language, (byLanguage.get(language) ?? 0) + entry.size);
    total += entry.size;
  }
  const stats = [...byLanguage.entries()]
    .map(([language, bytes]) => ({
      language,
      bytes,
      percent: total > 0 ? (bytes / total) * 100 : 0,
    }))
    .sort((left, right) => right.bytes - left.bytes);
  return stats;
}
