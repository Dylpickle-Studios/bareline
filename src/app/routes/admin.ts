import type { AppRouteContext } from './route-context.js';
import * as runtime from './route-runtime.js';

export function registerAdminRoutes(context: AppRouteContext): void {
  const {
    app,
    config,
    database,
    runtimeSettings,
    auth,
    recovery,
    invites,
    git,
    repositories,
    enhancements,
    search,
    pluginManager,
    administration,
    render,
    requireAdministrator,
    pluginAdminPage,
  } = context;
  app.get('/admin/plugins', async (request, reply) => {
    const current = requireAdministrator(request);
    return reply.type('text/html').send(await pluginAdminPage(current));
  });

  app.get('/admin', async (request, reply) => {
    const current = requireAdministrator(request);
    const gitVersion = await git.run(['--version'], { timeoutMs: 2000, maxOutputBytes: 1024 });
    const sqlite = database.prepare('SELECT sqlite_version() AS version').get() as {
      version: string;
    };
    const journal = database.pragma('journal_mode', { simple: true }) as string;
    return reply.type('text/html').send(
      await render('admin', {
        user: current.user,
        counts: administration.counts(),
        system: {
          node: process.version,
          git: gitVersion.stdout.toString('utf8').trim(),
          sqlite: sqlite.version,
          journal,
          repositoryStorage: config.storage.repositories,
          ssh: config.ssh.enabled,
        },
      }),
    );
  });

  app.get('/admin/users', async (request, reply) => {
    const current = requireAdministrator(request);
    return reply.type('text/html').send(await adminUsersPage(current));
  });

  const adminUsersPage = async (
    current: ReturnType<typeof requireAdministrator>,
    createdRecovery?: { username: string; code: string },
  ) =>
    await render('admin-users', {
      user: current.user,
      csrf: current.csrfToken,
      users: administration.users(),
      createdRecovery: createdRecovery ?? null,
    });

  const adminInvitesPage = async (
    current: ReturnType<typeof requireAdministrator>,
    createdToken?: string,
  ) =>
    await render('admin-invites', {
      user: current.user,
      csrf: current.csrfToken,
      invites: invites.list(),
      createdUrl: createdToken
        ? `${config.server.publicUrl.replace(/\/$/, '')}/register?invite=${encodeURIComponent(createdToken)}`
        : null,
    });

  app.get('/admin/invites', async (request, reply) => {
    const current = requireAdministrator(request);
    return reply.type('text/html').send(await adminInvitesPage(current));
  });

  app.post('/admin/invites', async (request, reply) => {
    const current = requireAdministrator(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    if (body.action === 'create') {
      const token = invites.create(current.user.id, Number.parseInt(body.days ?? '7', 10));
      return reply.type('text/html').send(await adminInvitesPage(current, token));
    }
    if (body.action === 'revoke') {
      invites.revoke(current.user.id, Number.parseInt(body.inviteId ?? '', 10));
      return await reply.redirect('/admin/invites');
    }
    throw new runtime.ValidationError('Unknown invite action');
  });

  app.post('/admin/users/:userId', async (request, reply) => {
    const current = requireAdministrator(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const userId = Number.parseInt((request.params as { userId: string }).userId, 10);
    if (body.action === 'disable' || body.action === 'enable')
      administration.setUserStatus(
        current.user.id,
        userId,
        body.action === 'enable' ? 'active' : 'disabled',
      );
    else if (body.action === 'promote' || body.action === 'demote')
      administration.setAdministrator(current.user.id, userId, body.action === 'promote');
    else if (body.action === 'recovery') {
      const account = database.prepare('SELECT username FROM users WHERE id = ?').get(userId) as
        { username: string } | undefined;
      if (!account) throw new runtime.ValidationError('User not found');
      const code = recovery.issueAdministratorCode(current.user.id, userId);
      return reply
        .type('text/html')
        .send(await adminUsersPage(current, { username: account.username, code }));
    } else throw new runtime.ValidationError('Unknown administrative action');
    return await reply.redirect('/admin/users');
  });

  app.get('/admin/repositories', async (request, reply) => {
    const current = requireAdministrator(request);
    return reply.type('text/html').send(
      await render('admin-repositories', {
        user: current.user,
        csrf: current.csrfToken,
        repositories: administration.repositories(),
      }),
    );
  });

  app.post('/admin/repositories/import', async (request, reply) => {
    const current = requireAdministrator(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const repository = await repositories.importExistingByOwnerName({
      actorUserId: current.user.id,
      ownerType: body.ownerType === 'group' ? 'group' : 'user',
      ownerSlug: body.ownerSlug ?? '',
      slug: body.slug ?? '',
      description: body.description ?? '',
      visibility: body.visibility === 'public' ? 'public' : 'private',
      sourcePath: body.sourcePath ?? '',
    });
    search.enqueue(repository.id);
    return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}`);
  });

  app.get('/admin/audit', async (request, reply) => {
    const current = requireAdministrator(request);
    return reply
      .type('text/html')
      .send(
        await render('admin-audit', { user: current.user, events: administration.auditEvents() }),
      );
  });

  app.get('/admin/search', async (request, reply) => {
    const current = requireAdministrator(request);
    return reply
      .type('text/html')
      .send(await render('admin-search', { user: current.user, status: search.status() }));
  });

  const adminSettingsPage = async (current: ReturnType<typeof requireAdministrator>) =>
    await render('admin-settings', {
      user: current.user,
      csrf: current.csrfToken,
      settings: runtimeSettings.load(),
      trustedSigners: database
        .prepare(
          `SELECT fingerprint, identity, key_type AS keyType, created_at AS createdAt
        FROM trusted_signers WHERE revoked_at IS NULL ORDER BY identity`,
        )
        .all(),
      backupDestinations: database
        .prepare(
          `SELECT name,endpoint,region,bucket,
        object_prefix AS objectPrefix,last_success_at AS lastSuccessAt,last_error AS lastError
        FROM backup_destinations ORDER BY name`,
        )
        .all(),
      providers: {
        oidc:
          config.authentication?.oidc.map((provider) => ({
            id: provider.id,
            name: provider.name,
            issuer: provider.issuer,
            autoCreate: provider.autoCreate,
          })) ?? [],
        ldap: config.authentication?.ldap
          ? {
              enabled: config.authentication.ldap.enabled,
              url: config.authentication.ldap.url,
              autoCreate: config.authentication.ldap.autoCreate,
            }
          : null,
        reverseProxy: config.authentication?.reverseProxy
          ? {
              enabled: config.authentication.reverseProxy.enabled,
              identityHeader: config.authentication.reverseProxy.identityHeader,
              autoCreate: config.authentication.reverseProxy.autoCreate,
            }
          : null,
      },
    });

  app.get('/admin/settings', async (request, reply) => {
    const current = requireAdministrator(request);
    return reply.type('text/html').send(await adminSettingsPage(current));
  });

  app.post('/admin/settings', async (request, reply) => {
    const current = requireAdministrator(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    if (body.action === 'trustedSigner') {
      enhancements.addTrustedSigner(current.user.id, {
        fingerprint: body.fingerprint ?? '',
        identity: body.identity ?? '',
        keyType: body.keyType === 'ssh' ? 'ssh' : 'openpgp',
        publicKey: body.publicKey ?? '',
      });
      return await reply.redirect('/admin/settings');
    }
    if (body.action === 'revokeTrustedSigner') {
      enhancements.revokeTrustedSigner(current.user.id, body.fingerprint ?? '');
      return await reply.redirect('/admin/settings');
    }
    if (body.action === 'backupDestination') {
      new runtime.BackupDestinationService(database, config).save(current.user.id, {
        name: body.name ?? '',
        endpoint: body.endpoint ?? '',
        region: body.region ?? '',
        bucket: body.bucket ?? '',
        prefix: body.prefix ?? '',
        accessKey: body.accessKey ?? '',
        secretKey: body.secretKey ?? '',
      });
      return await reply.redirect('/admin/settings');
    }
    const number = (key: string) => Number(body[key]);
    runtimeSettings.update(current.user.id, {
      registrationMode:
        body.registrationMode === 'open' || body.registrationMode === 'invite'
          ? body.registrationMode
          : 'closed',
      anonymousPublicRepositories: body.anonymousPublicRepositories === 'yes',
      sessionDays: number('sessionDays'),
      repositoryTrashDays: number('repositoryTrashDays'),
      filePreviewBytes: number('filePreviewBytes'),
      diffBytes: number('diffBytes'),
      diffLines: number('diffLines'),
      diffFiles: number('diffFiles'),
      diffFileBytes: number('diffFileBytes'),
      archiveBytes: number('archiveBytes'),
      lfsObjectBytes: number('lfsObjectBytes'),
    } satisfies runtime.RuntimeSettings);
    return await reply.redirect('/admin/settings');
  });

  app.get('/admin/plugins/playground', async (request, reply) => {
    const current = requireAdministrator(request);
    return reply.type('text/html').send(await render('plugin-playground', { user: current.user }));
  });

  app.get('/admin/plugins/playground/frame', async (request, reply) => {
    requireAdministrator(request);
    reply.header(
      'content-security-policy',
      "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; sandbox allow-scripts; frame-ancestors 'self'",
    );
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
    return reply.type('text/html')
      .send(`<!doctype html><meta charset="utf-8"><title>Plugin preview</title><main id="preview">Run the plugin to preview its output.</main><script>
const preview = document.querySelector('#preview');
addEventListener('message', async (event) => {
  if (!event.data || event.data.type !== 'playground.run') return;
  const logs = [], storage = new Map();
  const host = Object.freeze({
    repository: Object.freeze({ id: 'test-repository', owner: 'sample', name: 'project', ref: 'main' }),
    log(level, message) { logs.push('[log.' + String(level) + '] ' + String(message)); },
    async readTextFiles() { logs.push('[api] repositoryContents.read'); return [{ path: 'README.md', content: '# Sample project' }, { path: 'src/index.ts', content: 'export const answer = 42;' }]; },
    storage: Object.freeze({ get(key) { logs.push('[api] storage.get ' + String(key)); return storage.get(String(key)); }, set(key, value) { logs.push('[api] storage.set ' + String(key)); storage.set(String(key), value); }, delete(key) { storage.delete(String(key)); } }),
    render(value) { preview.replaceChildren(); const box = document.createElement('div'); box.className = 'plugin-preview'; box.textContent = value && value.label ? String(value.label) + ': ' + String(value.value) : JSON.stringify(value); preview.append(box); },
  });
  try {
    const css = document.createElement('style'); css.textContent = String(event.data.css).slice(0, 50000); document.head.replaceChildren(css);
    JSON.parse(String(event.data.ui));
    const execute = new Function('host', '"use strict"; return (async () => {' + String(event.data.code).slice(0, 100000) + '\n})();');
    await Promise.race([execute(host), new Promise((_, reject) => setTimeout(() => reject(new Error('Execution timed out')), 1500))]);
    parent.postMessage({ type: 'playground.result', ok: true, logs: [...logs, '[event] playground.completed', '[permissions] mocked only'] }, '*');
  } catch (error) { parent.postMessage({ type: 'playground.result', ok: false, logs: [...logs, '[error] ' + String(error && error.message || error)] }, '*'); }
});
</script>`);
  });

  app.get('/docs/plugins/example', async (_request, reply) => {
    const archive = await runtime.examplePluginArchive();
    return reply
      .header('content-disposition', 'attachment; filename="repository-word-count-1.0.0.tar.gz"')
      .header('cache-control', 'public, max-age=3600')
      .type('application/gzip')
      .send(archive);
  });

  app.post('/admin/plugins/install', async (request, reply) => {
    const current = requireAdministrator(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    await pluginManager.installLocal(current.user.id, body.source ?? '', {
      trustedRiskAccepted: body.trustedRisk === 'accepted',
    });
    return await reply.redirect('/admin/plugins');
  });

  app.post('/admin/plugins/upload', async (request, reply) => {
    const current = requireAdministrator(request);
    let csrf: string | undefined;
    let trustedRiskAccepted = false;
    let archive: Buffer | undefined;
    let filename = 'uploaded-plugin.tar.gz';
    for await (const part of request.parts()) {
      if (part.type === 'field' && part.fieldname === 'csrf') csrf = String(part.value);
      else if (part.type === 'field' && part.fieldname === 'trustedRisk')
        trustedRiskAccepted = part.value === 'accepted';
      else if (part.type === 'file' && part.fieldname === 'archive') {
        filename = part.filename.slice(0, 200);
        archive = await part.toBuffer();
      }
    }
    auth.verifyCsrf(current.csrfToken, csrf);
    if (!archive) throw new runtime.ValidationError('Plugin archive is required');
    await pluginManager.installArchive(current.user.id, archive, filename, {
      trustedRiskAccepted,
    });
    return await reply.redirect('/admin/plugins');
  });

  app.post('/admin/plugins/remote', async (request, reply) => {
    const current = requireAdministrator(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const options = { trustedRiskAccepted: body.trustedRisk === 'accepted' };
    if (body.sourceType === 'git')
      await pluginManager.installGit(
        current.user.id,
        body.source ?? '',
        body.ref ?? 'main',
        options,
      );
    else if (body.sourceType === 'npm')
      await pluginManager.installNpm(current.user.id, body.source ?? '', options);
    else throw new runtime.ValidationError('Unknown remote plugin source type');
    return await reply.redirect('/admin/plugins');
  });

  app.post('/admin/plugins/:pluginId/permissions', async (request, reply) => {
    const current = requireAdministrator(request);
    const body = request.body as runtime.FormBody;
    const parameters = request.params as { pluginId: string };
    auth.verifyCsrf(current.csrfToken, body.csrf);
    pluginManager.setPermission(
      current.user.id,
      parameters.pluginId,
      body.capability ?? '',
      body.granted === 'yes',
    );
    return await reply.redirect('/admin/plugins');
  });

  app.post('/admin/plugins/:pluginId/enabled', async (request, reply) => {
    const current = requireAdministrator(request);
    const body = request.body as runtime.FormBody;
    const parameters = request.params as { pluginId: string };
    auth.verifyCsrf(current.csrfToken, body.csrf);
    pluginManager.setEnabled(
      current.user.id,
      parameters.pluginId,
      body.enabled === 'yes',
      body.trustedRisk === 'accepted',
    );
    return await reply.redirect('/admin/plugins');
  });

  app.post('/admin/plugins/:pluginId/settings', async (request, reply) => {
    const current = requireAdministrator(request);
    const body = request.body as runtime.FormBody;
    const parameters = request.params as { pluginId: string };
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const plugin = pluginManager.get(parameters.pluginId);
    for (const [key, schema] of Object.entries(plugin.manifest.settings)) {
      const raw = body[`setting.${key}`] as unknown;
      if (schema.type === 'secret' && !raw) continue;
      const value: unknown =
        schema.type === 'boolean'
          ? raw === 'true'
          : schema.type === 'number'
            ? Number(raw)
            : schema.type === 'multi-select'
              ? (Array.isArray(raw)
                  ? raw.filter((item): item is string => typeof item === 'string')
                  : typeof raw === 'string'
                    ? raw.split(',')
                    : []
                )
                  .map((item) => item.trim())
                  .filter(Boolean)
              : typeof raw === 'string'
                ? raw
                : '';
      pluginManager.setSetting(current.user.id, plugin.id, key, value);
    }
    return await reply.redirect('/admin/plugins');
  });

  app.post('/admin/plugins/:pluginId/remove', async (request, reply) => {
    const current = requireAdministrator(request);
    const body = request.body as runtime.FormBody;
    const parameters = request.params as { pluginId: string };
    auth.verifyCsrf(current.csrfToken, body.csrf);
    await pluginManager.remove(current.user.id, parameters.pluginId, body.keepData === 'yes');
    return await reply.redirect('/admin/plugins');
  });
}
