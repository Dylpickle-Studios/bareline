import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exampleFiles = ['plugin.yml', 'package.json', 'index.mjs', 'README.md'] as const;

export async function examplePluginArchive(): Promise<Buffer> {
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [join(here, 'example'), join(here, '..', '..', 'plugins', 'example')];
  for (const root of roots) {
    try {
      const entries = await Promise.all(
        exampleFiles.map(async (name) => ({ name, content: await readFile(join(root, name)) })),
      );
      return gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]), { level: 9 });
    } catch (error) {
      if (root === roots.at(-1)) throw error;
    }
  }
  throw new Error('Example plugin package is unavailable');
}

function tarEntry(entry: { name: string; content: Buffer }): Buffer {
  const header = Buffer.alloc(512);
  write(header, 0, 100, `repository-word-count/${entry.name}`);
  write(header, 100, 8, '0000644\0');
  write(header, 108, 8, '0000000\0');
  write(header, 116, 8, '0000000\0');
  write(header, 124, 12, `${entry.content.length.toString(8).padStart(11, '0')}\0`);
  write(header, 136, 12, '00000000000\0');
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  write(header, 257, 8, 'ustar\x00');
  write(header, 265, 32, 'bareline');
  write(header, 297, 32, 'bareline');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  write(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  const padding = Buffer.alloc((512 - (entry.content.length % 512)) % 512);
  return Buffer.concat([header, entry.content, padding]);
}

function write(target: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value, 'ascii');
  if (encoded.length > length) throw new Error('Archive field is too long');
  encoded.copy(target, offset);
}
