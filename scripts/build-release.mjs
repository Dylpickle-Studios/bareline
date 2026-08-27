import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readdir, stat } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const packageData = JSON.parse(await readFile('package.json', 'utf8'));
const target = resolve(
  'release',
  `${packageData.name}-${packageData.version}-${platform()}-${arch()}`,
);
await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
await mkdir(target, { recursive: true });
await mkdir(join(target, 'runtime'), { recursive: true });
// Node's supported single-executable facility cannot reliably embed the native SQLite and Argon2
// addons. Ship the exact tested Node runtime beside those addons instead, so the launcher does not
// depend on a separately installed Node executable.
await cp(process.execPath, join(target, 'runtime', 'node'));
await chmod(join(target, 'runtime', 'node'), 0o755);
for (const item of ['dist', 'docs']) await cp(item, join(target, item), { recursive: true });
// Preserve the native addons built and tested on this platform. Reinstalling can silently select a
// different binary or require a compiler/network during release assembly.
await cp('node_modules', join(target, 'node_modules'), { recursive: true });
for (const item of [
  'package.json',
  'package-lock.json',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'config.example.yml',
])
  await cp(item, join(target, item));
await writeFile(
  join(target, 'bareline'),
  '#!/bin/sh\nset -eu\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$HERE/runtime/node" "$HERE/dist/cli/index.js" "$@"\n',
  { mode: 0o755 },
);
await writeFile(
  join(target, 'RELEASE.txt'),
  `Self-contained application bundle for ${platform()} ${arch()}.\nThe tested Node.js runtime and native dependencies are included for this platform; no system Node installation is required. The system Git executable remains a runtime requirement.\n`,
);
await promisify(execFile)(
  'npm',
  ['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
  {
    cwd: target,
  },
);
// npm creates development-oriented executable links in .bin. The server starts through the
// bundled Node launcher and does not need them; removing them keeps the release tree composed of
// regular files and prevents link traversal during checksum verification.
await rm(join(target, 'node_modules', '.bin'), {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 200,
});
const sbomPath = join(target, 'SBOM.spdx.json');
await promisify(execFile)(
  'sh',
  [
    '-c',
    'npm sbom --package-lock-only --omit=dev --sbom-format=spdx --sbom-type=application > SBOM.spdx.json',
  ],
  { cwd: target },
);
const sbom = await readFile(sbomPath, 'utf8');
if (!sbom.trim().startsWith('{')) throw new Error('npm sbom did not produce JSON');
await chmod(sbomPath, 0o644);
const releaseFiles = await filesUnder(target);
const checksums = [];
for (const file of releaseFiles) {
  const relative = file.slice(target.length + 1);
  if (relative === 'SHA256SUMS') continue;
  const digest = createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
  checksums.push(`${digest}  ${relative}`);
}
await writeFile(join(target, 'SHA256SUMS'), `${checksums.sort().join('\n')}\n`);
process.stdout.write(`${target}\n`);

async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesUnder(path)));
    else if ((await stat(path)).isFile()) result.push(path);
  }
  return result;
}
