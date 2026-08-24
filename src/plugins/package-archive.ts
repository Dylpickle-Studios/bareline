import { mkdir, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { gunzipSync } from 'node:zlib';
class PluginInstallError extends Error {
  readonly statusCode = 400;
}

export async function extractPluginArchive(archive: Buffer, destination: string): Promise<string> {
  if (archive.length < 32 || archive.length > 16 * 1024 * 1024)
    throw new PluginInstallError('Plugin archive must be a gzip-compressed tar up to 16 MiB');
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: 64 * 1024 * 1024 });
  } catch {
    throw new PluginInstallError('Plugin archive is invalid or expands beyond 64 MiB');
  }
  const entries: { path: string; content: Buffer; mode: number }[] = [];
  let offset = 0;
  while (offset + 512 <= tar.length && entries.length < 1000) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const expectedChecksum = parseOctal(header.subarray(148, 156));
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, value) => sum + value, 0);
    if (expectedChecksum !== actualChecksum)
      throw new PluginInstallError('Plugin archive checksum failed');
    const name = readString(header.subarray(0, 100));
    const prefix = readString(header.subarray(345, 500));
    const logical = validateArchivePath(prefix ? `${prefix}/${name}` : name);
    const size = parseOctal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] ?? 0);
    const mode = parseOctal(header.subarray(100, 108));
    offset += 512;
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > tar.length)
      throw new PluginInstallError('Plugin archive entry has an invalid size');
    if (type === '0' || type === '\0') {
      if (size > 16 * 1024 * 1024)
        throw new PluginInstallError('Plugin archive contains an oversized file');
      entries.push({
        path: logical,
        content: Buffer.from(tar.subarray(offset, offset + size)),
        mode,
      });
    } else if (type !== '5') {
      throw new PluginInstallError('Plugin archives may contain only files and directories');
    }
    offset += Math.ceil(size / 512) * 512;
  }
  if (entries.length === 0 || entries.length >= 1000)
    throw new PluginInstallError('Plugin archive has no files or too many entries');
  const firstSegments = new Set(entries.map((entry) => entry.path.split('/')[0]));
  const strip = firstSegments.size === 1 && entries.every((entry) => entry.path.includes('/'));
  await mkdir(destination, { recursive: true, mode: 0o750 });
  for (const entry of entries) {
    const relative = strip ? entry.path.slice(entry.path.indexOf('/') + 1) : entry.path;
    if (!relative) continue;
    const target = join(destination, ...relative.split('/'));
    await mkdir(join(target, '..'), { recursive: true, mode: 0o750 });
    await writeFile(target, entry.content, {
      mode: entry.mode & 0o111 ? 0o750 : 0o640,
      flag: 'wx',
    });
  }
  return destination;
}

function validateArchivePath(value: string): string {
  if (!value || value.length > 4096 || value.includes('\\') || value.includes('\0'))
    throw new PluginInstallError('Plugin archive contains an unsafe path');
  const normalized = posix.normalize(value);
  if (normalized === '.' || normalized.startsWith('../') || normalized.startsWith('/'))
    throw new PluginInstallError('Plugin archive path escapes its package');
  return normalized;
}

function parseOctal(value: Buffer): number {
  const text = readString(value).trim();
  return /^[0-7]+$/.test(text) ? Number.parseInt(text, 8) : 0;
}

function readString(value: Buffer): string {
  const end = value.indexOf(0);
  return value.subarray(0, end < 0 ? value.length : end).toString('utf8');
}
