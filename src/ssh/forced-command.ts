import { spawn } from 'node:child_process';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../database/database.js';
import { controlledGitEnvironment, gitSafetyArguments } from '../git/git-runner.js';
import type { RepositoryService } from '../repositories/repository-service.js';

export interface AuthorizedSshCommand {
  operation: 'git-upload-pack' | 'git-receive-pack';
  repositoryPath: string;
  repositoryId: number;
  owner: string;
  repository: string;
  visibility: 'public' | 'private';
  userId: number;
}

export async function authorizeSshCommand(
  database: Database,
  repositories: RepositoryService,
  keyId: number,
  originalCommand: string,
): Promise<AuthorizedSshCommand> {
  const key = database.prepare('SELECT user_id FROM ssh_keys WHERE id = ?').get(keyId) as
    { user_id: number } | undefined;
  if (!key) throw new SshAuthorizationError();
  const match =
    /^(git-upload-pack|git-receive-pack) '(?<owner>[a-z0-9][a-z0-9-]{0,38})\/(?<repository>[a-z0-9][a-z0-9-]{0,38})\.git'$/.exec(
      originalCommand,
    );
  if (!match?.groups?.owner || !match.groups.repository || !match[1]) {
    throw new SshAuthorizationError();
  }
  const repository = repositories.find(match.groups.owner, match.groups.repository);
  if (!repository) throw new SshAuthorizationError();
  const operation = match[1] as AuthorizedSshCommand['operation'];
  if (operation === 'git-receive-pack' && repository.storageKind === 'working_tree')
    throw new SshAuthorizationError();
  if (operation === 'git-receive-pack') {
    const advancedPolicy = database
      .prepare(
        `SELECT 1 FROM repository_policies WHERE repository_id=?
      AND (require_signed_commits=1 OR commit_message_pattern IS NOT NULL) LIMIT 1`,
      )
      .get(repository.id);
    if (advancedPolicy) throw new SshAuthorizationError();
  }
  repositories.require(
    repository,
    key.user_id,
    operation === 'git-receive-pack' ? 'write' : 'read',
  );
  return {
    operation,
    repositoryPath: await repositories.storagePath(repository),
    repositoryId: repository.id,
    owner: repository.ownerSlug,
    repository: repository.slug,
    visibility: repository.visibility,
    userId: key.user_id,
  };
}

export async function authorizeDeployKeyCommand(
  database: Database,
  repositories: RepositoryService,
  keyId: number,
  originalCommand: string,
): Promise<AuthorizedSshCommand> {
  const key = database
    .prepare('SELECT repository_id FROM repository_deploy_keys WHERE id = ?')
    .get(keyId) as { repository_id: number } | undefined;
  const match =
    /^git-upload-pack '(?<owner>[a-z0-9][a-z0-9-]{0,38})\/(?<repository>[a-z0-9][a-z0-9-]{0,38})\.git'$/.exec(
      originalCommand,
    );
  if (!key || !match?.groups?.owner || !match.groups.repository) throw new SshAuthorizationError();
  const repository = repositories.find(match.groups.owner, match.groups.repository);
  if (repository?.id !== key.repository_id) throw new SshAuthorizationError();
  return {
    operation: 'git-upload-pack',
    repositoryPath: await repositories.storagePath(repository),
    repositoryId: repository.id,
    owner: repository.ownerSlug,
    repository: repository.slug,
    visibility: repository.visibility,
    userId: 0,
  };
}

export async function executeSshCommand(
  config: AppConfig,
  command: AuthorizedSshCommand,
): Promise<number> {
  if (!config.ssh.enabled) throw new SshAuthorizationError();
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(
      config.git.executable,
      [...gitSafetyArguments, command.operation.replace('git-', ''), command.repositoryPath],
      {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: controlledGitEnvironment(),
      },
    );
    const transferLimit = config.limits.archiveBytes;
    let inputBytes = 0;
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, code = 1): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('SIGTERM', cancel);
      process.removeListener('SIGINT', cancel);
      process.stdin.unpipe(child.stdin);
      if (error) reject(error);
      else resolve(code);
    };
    const terminate = (error: Error): void => {
      child.kill('SIGKILL');
      finish(error);
    };
    const cancel = (): void => {
      terminate(new Error('SSH Git transfer was cancelled'));
    };
    const timer = setTimeout(
      () => {
        terminate(new Error('SSH Git transfer exceeded its time limit'));
      },
      Math.max(config.git.timeoutMs, 120_000),
    );
    process.once('SIGTERM', cancel);
    process.once('SIGINT', cancel);
    process.stdin.on('data', (chunk: Buffer | string) => {
      inputBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (inputBytes > transferLimit) terminate(new Error('SSH Git input exceeded transfer limit'));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > transferLimit) {
        terminate(new Error('SSH Git output exceeded transfer limit'));
        return;
      }
      process.stdout.write(chunk);
    });
    child.stderr.pipe(process.stderr, { end: false });
    process.stdin.pipe(child.stdin);
    child.on('error', () => {
      finish(new Error('Unable to start SSH Git operation'));
    });
    child.on('close', (code) => {
      finish(undefined, code ?? 1);
    });
  });
}

export function authorizedKeys(database: Database, executable: string, configFile: string): string {
  const rows = database.prepare('SELECT id, public_key FROM ssh_keys ORDER BY id').all() as {
    id: number;
    public_key: string;
  }[];
  const userLines = rows.map(
    (row) =>
      `restrict,command="${escapeAuthorizedKeyValue(executable)} ssh serve --key-id ${String(row.id)} --config ${escapeAuthorizedKeyValue(configFile)}" ${row.public_key}`,
  );
  const deployRows = database
    .prepare('SELECT id, public_key FROM repository_deploy_keys ORDER BY id')
    .all() as { id: number; public_key: string }[];
  const deployLines = deployRows.map(
    (row) =>
      `restrict,command="${escapeAuthorizedKeyValue(executable)} ssh serve --deploy-key-id ${String(row.id)} --config ${escapeAuthorizedKeyValue(configFile)}" ${row.public_key}`,
  );
  return [...userLines, ...deployLines].join('\n');
}

function escapeAuthorizedKeyValue(value: string): string {
  if (!/^[A-Za-z0-9_./-]+$/.test(value))
    throw new Error('SSH command paths contain unsafe characters');
  return value;
}

export class SshAuthorizationError extends Error {
  readonly statusCode = 403;
}
