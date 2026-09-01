import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, readdir } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

const packageData = JSON.parse(await readFile('package.json', 'utf8'));
const defaultBundle = resolve(
  'release',
  `${packageData.name}-${packageData.version}-${platform()}-${arch()}`,
);
const root = resolve(process.argv[2] ?? defaultBundle);
const checksumFile = join(root, 'SHA256SUMS');
const checksums = parseChecksums(await readFile(checksumFile, 'utf8'));
verifySbom(JSON.parse(await readFile(join(root, 'SBOM.spdx.json'), 'utf8')));
const actual = await filesUnder(root);

const expectedPaths = [...checksums.keys()].sort();
const actualPaths = [...actual.keys()].sort();
if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
  const missing = expectedPaths.filter((path) => !actual.has(path));
  const unexpected = actualPaths.filter((path) => !checksums.has(path));
  throw new Error(
    `Release file list differs from SHA256SUMS; missing=${missing.join(',') || 'none'}, unexpected=${unexpected.join(',') || 'none'}`,
  );
}

for (const path of expectedPaths) {
  const expected = checksums.get(path);
  const found = actual.get(path);
  if (!expected || !found || expected !== found)
    throw new Error(`Release checksum mismatch: ${path}`);
}
process.stdout.write(`Release checksums verified: ${root}\n`);

function verifySbom(sbom) {
  if (
    !sbom ||
    typeof sbom !== 'object' ||
    sbom.spdxVersion !== 'SPDX-2.3' ||
    !Array.isArray(sbom.packages) ||
    sbom.packages.length === 0
  )
    throw new Error('Release SBOM is missing or is not a non-empty SPDX 2.3 document');
}

function parseChecksums(source) {
  const values = new Map();
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line) continue;
    const match = /^([a-f0-9]{64})  (.+)$/i.exec(line);
    if (!match) throw new Error(`Invalid SHA256SUMS line ${String(index + 1)}`);
    const digest = match[1]?.toLowerCase();
    const path = match[2];
    if (!digest || !path || !isSafeRelativePath(path) || path === 'SHA256SUMS')
      throw new Error(`Invalid release checksum path on line ${String(index + 1)}`);
    if (values.has(path)) throw new Error(`Duplicate release checksum path: ${path}`);
    values.set(path, digest);
  }
  if (values.size === 0) throw new Error('SHA256SUMS is empty');
  return values;
}

async function filesUnder(directory) {
  const result = new Map();
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      const logical = relative(root, path).split(sep).join('/');
      if (logical === 'SHA256SUMS') continue;
      if (entry.isSymbolicLink()) throw new Error(`Release contains a symbolic link: ${logical}`);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Release contains an unsupported entry: ${logical}`);
      // Verify and read through the same open file descriptor rather than re-resolving
      // `path` a second time, so a symlink swapped in after the readdir/isSymbolicLink
      // check above can't be silently followed into the checksum.
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error(`Release entry is not a regular file: ${logical}`);
        result.set(
          logical,
          createHash('sha256')
            .update(await handle.readFile())
            .digest('hex'),
        );
      } finally {
        await handle.close();
      }
    }
  }
  await walk(directory);
  return result;
}

function isSafeRelativePath(path) {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}
