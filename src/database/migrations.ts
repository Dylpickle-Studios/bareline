export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        email TEXT COLLATE NOCASE UNIQUE,
        email_public INTEGER NOT NULL DEFAULT 0 CHECK (email_public IN (0, 1)),
        password_hash TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
        theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('light', 'dark', 'system')),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash BLOB NOT NULL UNIQUE,
        csrf_secret BLOB NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        ip_hash BLOB,
        user_agent TEXT
      ) STRICT;

      CREATE TABLE groups (
        id INTEGER PRIMARY KEY,
        slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE group_members (
        group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('member', 'manager', 'owner')),
        PRIMARY KEY (group_id, user_id)
      ) WITHOUT ROWID, STRICT;

      CREATE TABLE repositories (
        id INTEGER PRIMARY KEY,
        owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'group')),
        owner_id INTEGER NOT NULL,
        slug TEXT NOT NULL COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
        storage_id TEXT NOT NULL UNIQUE,
        storage_kind TEXT NOT NULL CHECK (storage_kind IN ('hosted_bare', 'imported_bare', 'working_tree')),
        storage_path TEXT,
        default_branch TEXT NOT NULL DEFAULT 'main',
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (owner_type, owner_id, slug)
      ) STRICT;
      CREATE INDEX repositories_storage ON repositories(storage_id);

      CREATE TABLE repository_grants (
        repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group')),
        principal_id INTEGER NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('read', 'write', 'admin')),
        PRIMARY KEY (repository_id, principal_type, principal_id)
      ) WITHOUT ROWID, STRICT;

      CREATE TABLE ssh_keys (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        public_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      ) STRICT;

      CREATE TABLE tokens (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('api', 'feed')),
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        token_hash BLOB NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      ) STRICT;

      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY,
        actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        request_id TEXT,
        ip TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX audit_events_created ON audit_events(created_at DESC, id DESC);
      CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
        BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
      CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
        BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;

      CREATE TABLE invites (
        id INTEGER PRIMARY KEY,
        token_hash BLOB NOT NULL UNIQUE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE application_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        bootstrap_complete INTEGER NOT NULL DEFAULT 0 CHECK (bootstrap_complete IN (0, 1))
      ) STRICT;
      INSERT INTO application_state(singleton, bootstrap_complete) VALUES (1, 0);
    `,
  },
  {
    version: 2,
    name: 'plugins_search_and_auth_extensions',
    sql: `
      CREATE TABLE passkeys (
        id BLOB PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        transports TEXT NOT NULL DEFAULT '[]',
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      ) STRICT;

      CREATE TABLE external_identities (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        profile_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE(provider_id, subject)
      ) STRICT;

      CREATE TABLE plugins (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        api_version INTEGER NOT NULL,
        runtime TEXT NOT NULL CHECK(runtime IN ('trusted', 'sandboxed')),
        source_type TEXT NOT NULL,
        source_value TEXT NOT NULL,
        package_path TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
        error TEXT,
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE plugin_permissions (
        plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
        capability TEXT NOT NULL,
        requested INTEGER NOT NULL CHECK(requested IN (0, 1)),
        granted INTEGER NOT NULL DEFAULT 0 CHECK(granted IN (0, 1)),
        PRIMARY KEY(plugin_id, capability)
      ) WITHOUT ROWID, STRICT;

      CREATE TABLE plugin_settings (
        plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value_json TEXT,
        encrypted_value BLOB,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(plugin_id, key),
        CHECK((value_json IS NULL) != (encrypted_value IS NULL))
      ) WITHOUT ROWID, STRICT;

      CREATE TABLE plugin_storage (
        plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(plugin_id, key)
      ) WITHOUT ROWID, STRICT;

      CREATE TABLE search_jobs (
        id INTEGER PRIMARY KEY,
        repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'running', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        lease_until TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(repository_id, kind)
      ) STRICT;

      CREATE VIRTUAL TABLE search_documents USING fts5(
        resource_type UNINDEXED,
        resource_id UNINDEXED,
        repository_id UNINDEXED,
        title,
        path,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TABLE lfs_objects (
        object_id TEXT PRIMARY KEY,
        size INTEGER NOT NULL CHECK(size >= 0),
        storage_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 3,
    name: 'lfs_repository_links',
    sql: `
      CREATE TABLE repository_lfs_objects (
        repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        object_id TEXT NOT NULL REFERENCES lfs_objects(object_id) ON DELETE RESTRICT,
        PRIMARY KEY(repository_id, object_id)
      ) WITHOUT ROWID, STRICT;

      CREATE TABLE lfs_uploads (
        repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        object_id TEXT NOT NULL,
        expected_size INTEGER NOT NULL CHECK(expected_size >= 0),
        expires_at TEXT NOT NULL,
        PRIMARY KEY(repository_id, object_id)
      ) WITHOUT ROWID, STRICT;
    `,
  },
  {
    version: 4,
    name: 'orphaned_plugin_data',
    sql: `
      CREATE TABLE orphaned_plugin_data (
        plugin_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('setting', 'storage')),
        key TEXT NOT NULL,
        value BLOB NOT NULL,
        archived_at TEXT NOT NULL,
        PRIMARY KEY(plugin_id, kind, key)
      ) WITHOUT ROWID, STRICT;
    `,
  },
  {
    version: 5,
    name: 'single_use_authentication_challenges',
    sql: `
      CREATE TABLE authentication_challenges (
        challenge TEXT PRIMARY KEY,
        purpose TEXT NOT NULL CHECK(purpose IN ('passkey-registration', 'passkey-authentication')),
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX authentication_challenges_expiry ON authentication_challenges(expires_at);
    `,
  },
  {
    version: 6,
    name: 'appearance_and_accessibility_preferences',
    sql: `
      ALTER TABLE users ADD COLUMN accent TEXT NOT NULL DEFAULT 'violet';
      ALTER TABLE users ADD COLUMN ui_font TEXT NOT NULL DEFAULT 'system';
      ALTER TABLE users ADD COLUMN code_font TEXT NOT NULL DEFAULT 'system';
      ALTER TABLE users ADD COLUMN reduced_motion INTEGER NOT NULL DEFAULT 0 CHECK(reduced_motion IN (0, 1));
    `,
  },
  {
    version: 7,
    name: 'external_authentication_flows',
    sql: `
      CREATE TABLE external_authentication_flows (
        state_hash BLOB PRIMARY KEY,
        provider_id TEXT NOT NULL,
        code_verifier_encrypted BLOB NOT NULL,
        nonce TEXT NOT NULL,
        return_path TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX external_authentication_flows_expiry ON external_authentication_flows(expires_at);
    `,
  },
  {
    version: 8,
    name: 'account_recovery_codes',
    sql: `
      CREATE TABLE recovery_codes (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash BLOB NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX recovery_codes_user ON recovery_codes(user_id);
    `,
  },
  {
    version: 9,
    name: 'queued_plugin_events',
    sql: `
      CREATE TABLE plugin_event_jobs (
        id INTEGER PRIMARY KEY,
        plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
        event_name TEXT NOT NULL,
        handler TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(length(payload_json) <= 65536),
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'running', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        lease_until TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX plugin_event_jobs_ready ON plugin_event_jobs(state, available_at, lease_until);
    `,
  },
  {
    version: 10,
    name: 'user_profile_avatars',
    sql: `
      ALTER TABLE users ADD COLUMN avatar BLOB;
      ALTER TABLE users ADD COLUMN avatar_mime TEXT CHECK(avatar_mime IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp'));
    `,
  },
  {
    version: 11,
    name: 'audited_runtime_settings',
    sql: `
      CREATE TABLE application_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL CHECK(json_valid(value_json)),
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 12,
    name: 'plugin_theme_preference',
    sql: `ALTER TABLE users ADD COLUMN plugin_theme TEXT CHECK(plugin_theme IS NULL OR length(plugin_theme) <= 201);`,
  },
  {
    version: 13,
    name: 'repository_transfer_acceptance',
    sql: `
      CREATE TABLE repository_transfers (
        repository_id INTEGER PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
        source_owner_type TEXT NOT NULL CHECK(source_owner_type IN ('user', 'group')),
        source_owner_id INTEGER NOT NULL,
        target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        CHECK(source_owner_id != target_user_id)
      ) STRICT;
      CREATE INDEX repository_transfers_target ON repository_transfers(target_user_id, expires_at);
    `,
  },
];
