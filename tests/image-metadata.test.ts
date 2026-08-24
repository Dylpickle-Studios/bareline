import { describe, expect, it } from 'vitest';
import { imageMetadata } from '../src/web/file-presentation.js';

describe('bounded image metadata', () => {
  it('reads PNG and GIF headers without decoding pixels', () => {
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(480, 20);
    expect(imageMetadata(png, 'image.png')).toEqual({ width: 640, height: 480, format: 'PNG' });

    const gif = Buffer.alloc(10);
    gif.write('GIF89a');
    gif.writeUInt16LE(32, 6);
    gif.writeUInt16LE(24, 8);
    expect(imageMetadata(gif, 'image.gif')).toEqual({ width: 32, height: 24, format: 'GIF' });
  });

  it('rejects malformed, mismatched, and unreasonable images', () => {
    expect(imageMetadata(Buffer.from('not an image'), 'image.png')).toBeNull();
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(100_001, 16);
    png.writeUInt32BE(1, 20);
    expect(imageMetadata(png, 'image.png')).toBeNull();
    expect(imageMetadata(Buffer.alloc(2_000_000, 0xff), 'image.jpg')).toBeNull();
  });
});
