import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';
import { product } from '../app/metadata.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const views = join(currentDirectory, 'views');
const eta = new Eta({ views, cache: process.env.NODE_ENV === 'production', autoEscape: true });

export async function render(view: string, data: Record<string, unknown>): Promise<string> {
  const body = await eta.renderAsync(view, { ...data, product });
  return await eta.renderAsync('layout', { ...data, product, body });
}

export async function loadAsset(name: string): Promise<Buffer> {
  return await readFile(join(currentDirectory, 'assets', name));
}
