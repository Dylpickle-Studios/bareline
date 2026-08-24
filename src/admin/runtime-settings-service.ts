import type { AuditService } from '../audit/audit-service.js';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../database/database.js';

export interface RuntimeSettings {
  registrationMode: 'open' | 'invite' | 'closed';
  anonymousPublicRepositories: boolean;
  sessionDays: number;
  repositoryTrashDays: number;
  filePreviewBytes: number;
  diffBytes: number;
  diffLines: number;
  diffFiles: number;
  diffFileBytes: number;
  archiveBytes: number;
  lfsObjectBytes: number;
}

const defaultPaths: { [K in keyof RuntimeSettings]: (config: AppConfig) => RuntimeSettings[K] } = {
  registrationMode: (config) => config.registration.mode,
  anonymousPublicRepositories: (config) => config.anonymous.publicRepositories,
  sessionDays: (config) => config.security.sessionDays,
  repositoryTrashDays: (config) => config.security.repositoryTrashDays,
  filePreviewBytes: (config) => config.limits.filePreviewBytes,
  diffBytes: (config) => config.limits.diffBytes,
  diffLines: (config) => config.limits.diffLines,
  diffFiles: (config) => config.limits.diffFiles,
  diffFileBytes: (config) => config.limits.diffFileBytes,
  archiveBytes: (config) => config.limits.archiveBytes,
  lfsObjectBytes: (config) => config.limits.lfsObjectBytes,
};

const keys = Object.freeze(Object.keys(defaultPaths) as (keyof RuntimeSettings)[]);

export class RuntimeSettingsService {
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  load(): RuntimeSettings {
    const values = this.defaults();
    const rows = this.database
      .prepare('SELECT key, value_json AS valueJson FROM application_settings')
      .all() as {
      key: string;
      valueJson: string;
    }[];
    for (const row of rows) {
      if (!keys.includes(row.key as keyof RuntimeSettings)) continue;
      try {
        (values as unknown as Record<string, unknown>)[row.key] = JSON.parse(
          row.valueJson,
        ) as unknown;
      } catch {
        // A malformed row cannot normally pass SQLite's JSON check; retain the safe YAML default.
      }
    }
    const validated = validateSettings(values);
    applySettings(this.config, validated);
    return validated;
  }

  update(actorUserId: number, candidate: RuntimeSettings): RuntimeSettings {
    const validated = validateSettings(candidate);
    const previous = this.load();
    this.database.transaction(() => {
      const statement = this.database.prepare(
        `INSERT INTO application_settings(key, value_json, updated_by, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      );
      for (const key of keys) statement.run(key, JSON.stringify(validated[key]), actorUserId);
      this.audit.record({
        actorUserId,
        action: 'application.settingsChanged',
        targetType: 'application',
        metadata: {
          changed: keys.filter((key) => previous[key] !== validated[key]).join(','),
        },
      });
    })();
    applySettings(this.config, validated);
    return validated;
  }

  private defaults(): RuntimeSettings {
    return Object.fromEntries(
      keys.map((key) => [key, defaultPaths[key](this.config)]),
    ) as unknown as RuntimeSettings;
  }
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum)
    throw new RuntimeSettingsError(
      `${name} must be an integer between ${String(minimum)} and ${String(maximum)}`,
    );
  return value;
}

function validateSettings(value: RuntimeSettings): RuntimeSettings {
  if (!['open', 'invite', 'closed'].includes(value.registrationMode))
    throw new RuntimeSettingsError('Unknown registration mode');
  if (typeof value.anonymousPublicRepositories !== 'boolean')
    throw new RuntimeSettingsError('Anonymous repository access must be a boolean');
  return {
    registrationMode: value.registrationMode,
    anonymousPublicRepositories: value.anonymousPublicRepositories,
    sessionDays: boundedInteger(value.sessionDays, 'Session duration', 1, 365),
    repositoryTrashDays: boundedInteger(value.repositoryTrashDays, 'Trash retention', 1, 365),
    filePreviewBytes: boundedInteger(
      value.filePreviewBytes,
      'File preview limit',
      1024,
      64 * 1024 * 1024,
    ),
    diffBytes: boundedInteger(value.diffBytes, 'Diff byte limit', 64 * 1024, 128 * 1024 * 1024),
    diffLines: boundedInteger(value.diffLines, 'Diff line limit', 100, 250_000),
    diffFiles: boundedInteger(value.diffFiles, 'Diff file limit', 1, 10_000),
    diffFileBytes: boundedInteger(
      value.diffFileBytes,
      'Per-file diff limit',
      1024,
      32 * 1024 * 1024,
    ),
    archiveBytes: boundedInteger(
      value.archiveBytes,
      'Archive limit',
      1024 * 1024,
      16 * 1024 * 1024 * 1024,
    ),
    lfsObjectBytes: boundedInteger(
      value.lfsObjectBytes,
      'LFS object limit',
      1024,
      64 * 1024 * 1024 * 1024,
    ),
  };
}

function applySettings(config: AppConfig, value: RuntimeSettings): void {
  config.registration.mode = value.registrationMode;
  config.anonymous.publicRepositories = value.anonymousPublicRepositories;
  config.security.sessionDays = value.sessionDays;
  config.security.repositoryTrashDays = value.repositoryTrashDays;
  config.limits.filePreviewBytes = value.filePreviewBytes;
  config.limits.diffBytes = value.diffBytes;
  config.limits.diffLines = value.diffLines;
  config.limits.diffFiles = value.diffFiles;
  config.limits.diffFileBytes = value.diffFileBytes;
  config.limits.archiveBytes = value.archiveBytes;
  config.limits.lfsObjectBytes = value.lfsObjectBytes;
}

export class RuntimeSettingsError extends Error {
  readonly statusCode = 400;
}
