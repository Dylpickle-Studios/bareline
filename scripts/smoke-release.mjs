import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { arch, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const packageData = JSON.parse(await readFile('package.json', 'utf8'));
const defaultBundle = resolve(
  'release',
  `${packageData.name}-${packageData.version}-${platform()}-${arch()}`,
);
const bundle = resolve(process.argv[2] ?? defaultBundle);
const root = await mkdtemp(join(tmpdir(), 'bareline-release-smoke-'));
const data = join(root, 'data');
const config = join(root, 'config.yml');
const backup = join(root, 'backup');
const port = 31_987;
const masterKey = randomBytes(32).toString('base64url');
await writeFile(
  config,
  `server:\n  host: 127.0.0.1\n  port: ${port}\n  publicUrl: http://127.0.0.1:${port}\n  tls: { mode: http }\nstorage:\n  data: ${data}\n  repositories: ${data}/repositories\n  trash: ${data}/trash\n  lfs: ${data}/lfs\n  importRoots: []\ndatabase: { path: ${data}/app.db }\ngit: { executable: git, timeoutMs: 15000 }\nssh: { enabled: false, host: localhost }\nregistration: { mode: closed }\nanonymous: { publicRepositories: true }\nlimits:\n  filePreviewBytes: 2097152\n  gitOutputBytes: 16777216\n  diffBytes: 10485760\n  diffLines: 20000\n  diffFiles: 500\n  diffFileBytes: 2097152\n  archiveBytes: 1073741824\n  lfsObjectBytes: 5368709120\n  requestBodyBytes: 10485760\nsecurity: { sessionDays: 14, repositoryTrashDays: 7, masterKey: ${masterKey} }\nauthentication: { oidc: [] }\n`,
  { mode: 0o600 },
);

const executable = join(bundle, 'bareline');
if (!existsSync(executable))
  throw new Error(`Release launcher not found: ${executable}. Run npm run release:bundle first.`);
const child = spawn(executable, ['serve', '--config', config], { stdio: 'inherit' });
let spawnError;
child.once('error', (error) => {
  spawnError = error;
});
try {
  let healthy = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await delay(100);
    if (spawnError) throw spawnError;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {
      // Startup is still in progress.
    }
  }
  if (!healthy) throw new Error('Release bundle did not become healthy');
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), delay(5000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

await run(executable, ['backup', '--config', config, '--output', backup]);
await run(executable, ['restore-verify', '--config', config, '--input', backup]);
await run(executable, ['restore', '--config', config, '--input', backup, '--confirm-replace']);
await run(executable, ['doctor', '--config', config]);
process.stdout.write('Release startup, health, backup, restore, and doctor smoke passed.\n');
