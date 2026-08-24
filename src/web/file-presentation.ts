import { extname } from 'node:path';

const imageTypes: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function isBinary(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.length, 8192));
  return sample.includes(0);
}

export function safeInlineMime(path: string): string {
  const extension = extname(path).toLowerCase();
  const image = imageTypes[extension];
  return image ?? 'text/plain; charset=utf-8';
}

export function isSafeImage(path: string): boolean {
  return imageTypes[extname(path).toLowerCase()] !== undefined;
}

export interface ImageMetadata {
  width: number;
  height: number;
  format: 'PNG' | 'JPEG' | 'GIF' | 'WebP';
}

export function imageMetadata(content: Buffer, path: string): ImageMetadata | null {
  const extension = extname(path).toLowerCase();
  if (
    extension === '.png' &&
    content.length >= 24 &&
    content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return dimensions(content.readUInt32BE(16), content.readUInt32BE(20), 'PNG');
  }
  if (
    extension === '.gif' &&
    content.length >= 10 &&
    ['GIF87a', 'GIF89a'].includes(content.toString('ascii', 0, 6))
  ) {
    return dimensions(content.readUInt16LE(6), content.readUInt16LE(8), 'GIF');
  }
  if (
    (extension === '.jpg' || extension === '.jpeg') &&
    content.length >= 4 &&
    content[0] === 0xff &&
    content[1] === 0xd8
  ) {
    let offset = 2;
    for (let segments = 0; segments < 512 && offset + 8 < content.length; segments += 1) {
      while (content[offset] === 0xff) offset += 1;
      const marker = content[offset];
      offset += 1;
      if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > content.length) break;
      const length = content.readUInt16BE(offset);
      if (length < 2 || offset + length > content.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        if (length < 7) return null;
        return dimensions(
          content.readUInt16BE(offset + 5),
          content.readUInt16BE(offset + 3),
          'JPEG',
        );
      }
      offset += length;
    }
    return null;
  }
  if (
    extension === '.webp' &&
    content.length >= 30 &&
    content.toString('ascii', 0, 4) === 'RIFF' &&
    content.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const kind = content.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      return dimensions(readUInt24LE(content, 24) + 1, readUInt24LE(content, 27) + 1, 'WebP');
    }
    if (kind === 'VP8L' && content[20] === 0x2f && content.length >= 25) {
      const bits = content.readUInt32LE(21);
      return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, 'WebP');
    }
    if (
      kind === 'VP8 ' &&
      content.length >= 30 &&
      content[23] === 0x9d &&
      content[24] === 0x01 &&
      content[25] === 0x2a
    ) {
      return dimensions(
        content.readUInt16LE(26) & 0x3fff,
        content.readUInt16LE(28) & 0x3fff,
        'WebP',
      );
    }
  }
  return null;
}

function readUInt24LE(content: Buffer, offset: number): number {
  return (
    (content[offset] ?? 0) | ((content[offset + 1] ?? 0) << 8) | ((content[offset + 2] ?? 0) << 16)
  );
}

function dimensions(
  width: number,
  height: number,
  format: ImageMetadata['format'],
): ImageMetadata | null {
  if (width < 1 || height < 1 || width > 100_000 || height > 100_000) return null;
  return { width, height, format };
}

export function isMarkdown(path: string): boolean {
  return /(?:^|\.)m(?:ark)?down$/i.test(path) || /\.md$/i.test(path);
}

export function breadcrumbs(path: string): { name: string; path: string; encodedPath: string }[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((name, index) => {
    const pathValue = parts.slice(0, index + 1).join('/');
    return {
      name,
      path: pathValue,
      encodedPath: pathValue.split('/').map(encodeURIComponent).join('/'),
    };
  });
}
