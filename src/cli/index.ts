#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { product } from '../app/metadata.js';
import { createApp } from '../app/create-app.js';
import { AuditService } from '../audit/audit-service.js';
import { AdminService } from '../admin/admin-service.js';
import { AuthService } from '../auth/auth-service.js';
import { BackupService } from '../backup/backup-service.js';
import { TokenService } from '../auth/token-service.js';
import { loadConfig } from '../config/config.js';
import { openDatabase } from '../database/database.js';
import { GitRunner } from '../git/git-runner.js';
import { GitBrowser } from '../git/git-browser.js';
import { PluginManager } from '../plugins/plugin-manager.js';
import { PluginContributionService } from '../plugins/contribution-service.js';
import { PluginEventService } from '../plugins/event-service.js';
import { validatePluginManifest } from '../plugins/manifest.js';
import { SandboxRuntime } from '../plugins/sandbox-runtime.js';
import { RepositoryService } from '../repositories/repository-service.js';
import { SearchService } from '../search/search-service.js';
import { authorizeSshCommand, authorizedKeys, executeSshCommand } from '../ssh/forced-command.js';
import YAML from 'yaml';

const arguments_ = process.argv.slice(2);
const command = arguments_[0] ?? 'serve';
const configIndex = arguments_.indexOf('--config');
const configFile = resolve(configIndex >= 0 ? (arguments_[configIndex + 1] ?? '') : 'config.yml');

if (command === 'version') {
  process.stdout.write(`${product.name} ${product.version}\n`);
} else if (command === 'config' && arguments_[1] === 'check') {
  loadConfig(configFile);
  process.stdout.write(`Configuration is valid: ${configFile}\n`);
} else if (command === 'serve') {
  if (!existsSync(configFile)) throw new Error(`Configuration file not found: ${configFile}`);
  const config = loadConfig(configFile);
  const app = await createApp(config);
  await app.listen({ host: config.server.host, port: config.server.port });
} else if (command === 'doctor') {
  const config = loadConfig(configFile);
  const database = openDatabase(config.database.path);
  const git = new GitRunner(config.git.executable, config.git.timeoutMs, 4096);
  const checks: [string, boolean, string][] = [];
  const gitVersion = await git.run(['--version'], { timeoutMs: 2000, maxOutputBytes: 4096 });
  checks.push(['Git executable', true, gitVersion.stdout.toString('utf8').trim()]);
  const integrity = database.pragma('quick_check', { simple: true }) as string;
  checks.push(['SQLite integrity', integrity === 'ok', integrity]);
  for (const [label, path] of [
    ['Data directory', config.storage.data],
    ['Repository directory', config.storage.repositories],
    ['LFS directory', config.storage.lfs],
  ] as const)
    checks.push([label, existsSync(path), path]);
  for (const [label, ok, detail] of checks)
    process.stdout.write(`${ok ? 'ok' : 'FAIL'}\t${label}\t${detail}\n`);
  database.close();
  if (checks.some((check) => !check[1])) process.exitCode = 1;
} else if (command === 'user' && arguments_[1] === 'create') {
  const config = loadConfig(configFile);
  const username = requiredValue('--username');
  const password = process.env.BARELINE_INITIAL_PASSWORD ?? process.env.GIT_HOST_INITIAL_PASSWORD;
  if (!password) throw new Error('BARELINE_INITIAL_PASSWORD is required and is never logged');
  const database = openDatabase(config.database.path);
  const audit = new AuditService(database);
  const auth = new AuthService(database, { ...config, registration: { mode: 'open' } }, audit);
  const user = await auth.register({
    username,
    displayName: valueAfter('--display-name') ?? username,
    password,
  });
  if (arguments_.includes('--admin'))
    new AdminService(database, audit).setAdministrator(null, user.id, true);
  database.close();
  process.stdout.write(`Created user ${user.username}.\n`);
} else if (command === 'user' && ['promote', 'disable'].includes(arguments_[1] ?? '')) {
  const config = loadConfig(configFile);
  const username = requiredValue('--username');
  const database = openDatabase(config.database.path);
  const row = database.prepare('SELECT id FROM users WHERE username = ?').get(username) as
    { id: number } | undefined;
  if (!row) throw new Error('User not found');
  const administration = new AdminService(database, new AuditService(database));
  if (arguments_[1] === 'promote') administration.setAdministrator(null, row.id, true);
  else administration.setUserStatus(null, row.id, 'disabled');
  database.close();
  process.stdout.write(`${arguments_[1] === 'promote' ? 'Promoted' : 'Disabled'} ${username}.\n`);
} else if (command === 'repo' && arguments_[1] === 'import') {
  const config = loadConfig(configFile);
  const database = openDatabase(config.database.path);
  const actor = database
    .prepare("SELECT id FROM users WHERE username = ? AND status = 'active' AND is_admin = 1")
    .get(requiredValue('--actor')) as { id: number } | undefined;
  if (!actor) throw new Error('Active administrator actor not found');
  const git = new GitRunner(
    config.git.executable,
    config.git.timeoutMs,
    config.limits.gitOutputBytes,
  );
  const repositories = new RepositoryService(database, git, config, new AuditService(database));
  const repository = await repositories.importExistingByOwnerName({
    actorUserId: actor.id,
    ownerType: valueAfter('--owner-type') === 'group' ? 'group' : 'user',
    ownerSlug: requiredValue('--owner'),
    slug: requiredValue('--name'),
    sourcePath: requiredValue('--path'),
    visibility: arguments_.includes('--public') ? 'public' : 'private',
  });
  database.close();
  process.stdout.write(`Imported ${repository.ownerSlug}/${repository.slug}.\n`);
} else if (command === 'repo' && arguments_[1] === 'rescan') {
  const config = loadConfig(configFile);
  const database = openDatabase(config.database.path);
  const git = new GitRunner(
    config.git.executable,
    config.git.timeoutMs,
    config.limits.gitOutputBytes,
  );
  const repositories = new RepositoryService(database, git, config, new AuditService(database));
  const repository = repositories.find(requiredValue('--owner'), requiredValue('--name'));
  if (!repository) throw new Error('Repository not found');
  const search = new SearchService(
    database,
    git,
    repositories,
    new GitBrowser(git, repositories, config),
    config,
  );
  await search.rebuildRepository(repository.id);
  database.close();
  process.stdout.write(`Rescanned ${repository.ownerSlug}/${repository.slug}.\n`);
} else if (command === 'token' && arguments_[1] === 'create') {
  const config = loadConfig(configFile);
  const username = valueAfter('--user');
  const name = valueAfter('--name') ?? 'CLI token';
  if (!username) throw new Error('--user is required');
  const database = openDatabase(config.database.path);
  const user = database
    .prepare('SELECT id FROM users WHERE username = ? AND status = ?')
    .get(username, 'active') as { id: number } | undefined;
  if (!user) throw new Error('User not found');
  const token = new TokenService(database).create({
    userId: user.id,
    name,
    scopes: arguments_.includes('--write')
      ? ['repository:read', 'repository:write']
      : ['repository:read'],
  });
  database.close();
  process.stdout.write(`${token}\n`);
} else if (command === 'search' && ['status', 'rebuild'].includes(arguments_[1] ?? '')) {
  const config = loadConfig(configFile);
  const database = openDatabase(config.database.path);
  const audit = new AuditService(database);
  const git = new GitRunner(
    config.git.executable,
    config.git.timeoutMs,
    config.limits.gitOutputBytes,
  );
  const repositories = new RepositoryService(database, git, config, audit);
  const search = new SearchService(
    database,
    git,
    repositories,
    new GitBrowser(git, repositories, config),
    config,
  );
  if (arguments_[1] === 'rebuild') {
    const count = await search.rebuildAll();
    process.stdout.write(`Rebuilt search index for ${String(count)} repositories.\n`);
  } else {
    process.stdout.write(`${JSON.stringify(search.status(), null, 2)}\n`);
  }
  database.close();
} else if (command === 'plugins' && arguments_[1] === 'validate') {
  const source = resolve(arguments_[2] ?? '');
  if (!arguments_[2]) throw new Error('Plugin directory is required');
  const manifest = validatePluginManifest(
    YAML.parse(readFileSync(resolve(source, 'plugin.yml'), 'utf8')) as unknown,
  );
  if (!existsSync(resolve(source, manifest.entrypoint)))
    throw new Error('Entrypoint does not exist');
  process.stdout.write(`${manifest.id} ${manifest.version} is valid.\n`);
} else if (command === 'plugins' && arguments_[1] === 'list') {
  const config = loadConfig(configFile);
  const database = openDatabase(config.database.path);
  const plugins = new PluginManager(database, config, new AuditService(database)).list();
  for (const plugin of plugins) {
    process.stdout.write(
      `${plugin.id}\t${plugin.version}\t${plugin.runtime}\t${plugin.enabled ? 'enabled' : 'disabled'}\n`,
    );
  }
  database.close();
} else if (command === 'backup') {
  const config = loadConfig(configFile);
  const output = valueAfter('--output');
  if (!output) throw new Error('--output is required');
  const database = openDatabase(config.database.path);
  const manifest = await new BackupService(database, config, product.version).create(
    output,
    configFile,
  );
  database.close();
  process.stdout.write(
    `Backup created at ${resolve(output)} (${String(Object.keys(manifest.files).length)} files).\n`,
  );
} else if (command === 'restore') {
  const config = loadConfig(configFile);
  const input = valueAfter('--input');
  if (!input) throw new Error('--input is required');
  await BackupService.restore(input, config, arguments_.includes('--confirm-replace'));
  process.stdout.write('Restore completed. Previous data was moved to a pre-restore directory.\n');
} else if (command === 'restore-verify') {
  const input = requiredValue('--input');
  const manifest = await BackupService.verify(input);
  process.stdout.write(`Backup is valid (${String(Object.keys(manifest.files).length)} files).\n`);
} else if (command === 'ssh' && arguments_[1] === 'authorized-keys') {
  const config = loadConfig(configFile);
  if (!config.ssh.enabled) throw new Error('SSH transport is disabled');
  const executable = resolve(valueAfter('--executable') ?? process.argv[1] ?? 'bareline');
  const database = openDatabase(config.database.path);
  process.stdout.write(`${authorizedKeys(database, executable, configFile)}\n`);
  database.close();
} else if (command === 'ssh' && arguments_[1] === 'setup') {
  const config = loadConfig(configFile);
  if (!config.ssh.enabled) throw new Error('SSH transport is disabled');
  const executable = resolve(valueAfter('--executable') ?? process.argv[1] ?? 'bareline');
  const database = openDatabase(config.database.path);
  const content = `${authorizedKeys(database, executable, configFile)}\n`;
  database.close();
  const output = valueAfter('--output');
  if (output) {
    const destination = resolve(output);
    await writeFile(destination, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    process.stdout.write(
      `Wrote forced-command keys to ${destination}. Existing files are never replaced.\n`,
    );
  } else {
    process.stdout.write(content);
    process.stderr.write(
      'Install these lines as the dedicated Git service account authorized_keys file; do not append them to an interactive administrator account.\n',
    );
  }
} else if (command === 'ssh' && arguments_[1] === 'serve') {
  const config = loadConfig(configFile);
  if (!config.ssh.enabled) throw new Error('SSH transport is disabled');
  const keyId = Number.parseInt(valueAfter('--key-id') ?? '', 10);
  const originalCommand = process.env.SSH_ORIGINAL_COMMAND;
  if (!Number.isSafeInteger(keyId) || keyId <= 0 || !originalCommand) {
    throw new Error('Invalid SSH forced-command context');
  }
  const database = openDatabase(config.database.path);
  const git = new GitRunner(
    config.git.executable,
    config.git.timeoutMs,
    config.limits.gitOutputBytes,
  );
  const repositories = new RepositoryService(database, git, config, new AuditService(database));
  const authorized = await authorizeSshCommand(database, repositories, keyId, originalCommand);
  const exitCode = await executeSshCommand(config, authorized);
  if (exitCode === 0 && authorized.operation === 'git-receive-pack') {
    new SearchService(
      database,
      git,
      repositories,
      new GitBrowser(git, repositories, config),
      config,
    ).enqueue(authorized.repositoryId);
    const plugins = new PluginManager(database, config, new AuditService(database));
    const contributions = new PluginContributionService(
      plugins,
      new SandboxRuntime(database),
      repositories,
    );
    new PluginEventService(database, plugins, contributions).publish('repository.pushed', {
      repositoryId: authorized.repositoryId,
      owner: authorized.owner,
      repository: authorized.repository,
      visibility: authorized.visibility,
    });
  }
  database
    .prepare('UPDATE ssh_keys SET last_used_at = ? WHERE id = ?')
    .run(new Date().toISOString(), keyId);
  database.close();
  process.exitCode = exitCode;
} else {
  process.stderr.write(
    `Usage: bareline <serve|doctor|version|config check|user create|user promote|user disable|repo import|repo rescan|token create|search status|search rebuild|plugins validate|plugins list|backup|restore|restore-verify|ssh setup|ssh authorized-keys|ssh serve> [options]\n`,
  );
  process.exitCode = 2;
}

function valueAfter(name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

function requiredValue(name: string): string {
  const value = valueAfter(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}
