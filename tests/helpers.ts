import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../src/config/config.js';

export function temporaryConfig(): AppConfig {
  const data = mkdtempSync(join(tmpdir(), 'focused-git-test-'));
  return {
    server: {
      host: '127.0.0.1',
      port: 3000,
      publicUrl: 'http://localhost:3000',
      tls: { mode: 'http' },
    },
    storage: {
      data,
      repositories: join(data, 'repositories'),
      trash: join(data, 'trash'),
      lfs: join(data, 'lfs'),
      importRoots: [],
    },
    database: { path: join(data, 'app.db') },
    git: { executable: 'git', timeoutMs: 10_000 },
    search: { indexedBranches: [], maxFilesPerBranch: 10_000, maxCommitsPerBranch: 100 },
    ssh: { enabled: true, host: 'localhost' },
    registration: { mode: 'closed' },
    anonymous: { publicRepositories: true },
    limits: {
      filePreviewBytes: 2 * 1024 * 1024,
      gitOutputBytes: 16 * 1024 * 1024,
      gitInputBytes: 64 * 1024 * 1024,
      gitConcurrent: 8,
      gitPending: 32,
      diffBytes: 10 * 1024 * 1024,
      diffLines: 20_000,
      diffFiles: 500,
      diffFileBytes: 2 * 1024 * 1024,
      archiveBytes: 1024 * 1024 * 1024,
      lfsObjectBytes: 5 * 1024 * 1024 * 1024,
      requestBodyBytes: 10 * 1024 * 1024,
    },
    security: { sessionDays: 14, repositoryTrashDays: 7 },
    plugins: {
      allowedGitHosts: [],
      allowedNpmPackages: [],
      npmExecutable: 'npm',
      installTimeoutMs: 60_000,
    },
  };
}
