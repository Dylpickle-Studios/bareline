import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'bareline-docker-smoke-'));
const data = join(root, 'data');
await mkdir(data, { mode: 0o777 });
await run('docker', ['build', '--tag', 'bareline:smoke', resolve('.')]);
const { stdout } = await run('docker', [
  'run',
  '--detach',
  '--read-only',
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges',
  '--mount',
  `type=bind,src=${data},dst=/var/lib/bareline`,
  'bareline:smoke',
]);
const container = stdout.trim();
try {
  const { stdout: user } = await run('docker', ['exec', container, 'id', '-u']);
  if (user.trim() !== '10001') throw new Error('Container did not run as the non-root account');
  let healthy = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await delay(500);
    const { stdout: state } = await run('docker', [
      'inspect',
      '--format',
      '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
      container,
    ]);
    const status = state.trim();
    if (status === 'running healthy') {
      healthy = true;
      break;
    }
    if (!status.startsWith('running ')) break;
  }
  if (!healthy) {
    const [stateResult, healthResult, logsResult] = await Promise.all([
      run('docker', ['inspect', '--format', '{{json .State}}', container]),
      run('docker', [
        'inspect',
        '--format',
        '{{if .State.Health}}{{json .State.Health.Log}}{{end}}',
        container,
      ]),
      run('docker', ['logs', '--tail', '200', container]),
    ]);
    const logs = `${logsResult.stdout}${logsResult.stderr}`.trim();
    throw new Error(
      `Container did not become healthy.\nState: ${stateResult.stdout.trim()}\nHealth probes: ${healthResult.stdout.trim()}\nLogs:\n${logs}`,
    );
  }
} finally {
  await run('docker', ['rm', '--force', container]);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write('Docker non-root build and health smoke passed.\n');
