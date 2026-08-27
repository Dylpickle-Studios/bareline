import { readdir, readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const lockfile = JSON.parse(await readFile('package-lock.json', 'utf8'));

if (lockfile.lockfileVersion !== 3) {
  throw new Error(
    `package-lock.json must use lockfileVersion 3 (found ${lockfile.lockfileVersion})`,
  );
}

const allowedInstallScripts = new Set(['argon2', 'better-sqlite3', 'esbuild', 'fsevents']);
const entries = Object.entries(lockfile.packages ?? {});
for (const [path, entry] of entries) {
  if (!path || path === '') continue;
  if (entry.resolved && /^(?:git|git\+|file:|link:|workspace:)/i.test(entry.resolved)) {
    throw new Error(`Unpinned package source is not allowed: ${path} -> ${entry.resolved}`);
  }
  if (entry.resolved && !entry.integrity) {
    throw new Error(`Registry package is missing an integrity hash: ${path}`);
  }
  if (entry.hasInstallScript) {
    const packageName = entry.name ?? path.split('/').at(-1);
    if (!packageName || !allowedInstallScripts.has(packageName)) {
      throw new Error(`Unexpected package install script: ${packageName ?? path}`);
    }
  }
}

const declaredAllowlist = Object.keys(packageJson.allowScripts ?? {}).map(
  (value) => value.split('@')[0],
);
for (const packageName of ['argon2', 'better-sqlite3', 'esbuild']) {
  if (!declaredAllowlist.includes(packageName)) {
    throw new Error(
      `Native build package ${packageName} is missing from package.json allowScripts`,
    );
  }
}

const workflowFiles = (await readdir('.github/workflows')).filter((name) => /\.ya?ml$/.test(name));
for (const file of workflowFiles) {
  const source = await readFile(`.github/workflows/${file}`, 'utf8');
  for (const match of source.matchAll(/\buses:\s*([^\s#]+)@([^\s#]+)/g)) {
    const reference = match[2];
    if (!reference || !/^[a-f0-9]{40}$/i.test(reference))
      throw new Error(`GitHub Action must be pinned to a commit SHA: ${file}: ${match[1]}`);
  }
}

const dockerfile = await readFile('Dockerfile', 'utf8');
for (const line of dockerfile.split('\n')) {
  if (!/^\s*FROM\s+\S+/i.test(line)) continue;
  const image = line.trim().split(/\s+/)[1];
  if (!image || !/@sha256:[a-f0-9]{64}(?:$|\s)/i.test(image))
    throw new Error(`Docker base image must be pinned by digest: ${line.trim()}`);
}

console.log(
  `Supply-chain policy OK: ${entries.length - 1} locked packages, explicit native-script allowlist`,
);
