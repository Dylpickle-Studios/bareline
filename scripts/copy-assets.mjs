import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist/web', { recursive: true });
await cp('src/web/assets', 'dist/web/assets', { recursive: true });
await cp('src/web/views', 'dist/web/views', { recursive: true });
await mkdir('dist/plugins', { recursive: true });
await cp('src/plugins/sandbox-worker-process.mjs', 'dist/plugins/sandbox-worker-process.mjs');
await mkdir('dist/plugin-sdk', { recursive: true });
await cp('plugins/example', 'dist/plugins/example', { recursive: true });
await cp('docs', 'dist/docs', { recursive: true });
