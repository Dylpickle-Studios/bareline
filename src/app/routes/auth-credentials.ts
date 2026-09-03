import type { AppRouteContext } from './route-context.js';
import * as routeHelpers from './route-helpers.js';
import * as runtime from './route-runtime.js';
import { TotpError } from '../../auth/totp-service.js';

// Passkey and account credential management routes.
export function registerAuthCredentialRoutes(context: AppRouteContext): void {
  const {
    app,
    config,
    auth,
    tokens,
    passkeys,
    recovery,
    totp,
    sshKeys,
    repositories,
    repositoryAdmin,
    search,
    pluginContributions,
    render,
    requireSession,
  } = context;
  app.post(
    '/api/v1/passkeys/registration/options',
    {
      schema: {
        ...routeHelpers.apiContract('authentication', {
          authenticated: false,
          body: { type: 'object', additionalProperties: false },
          response: runtime.passkeyRegistrationOptionsResponse,
        }),
        security: [{ cookieSession: [] }],
      },
    },
    async (request, reply) => {
      const current = requireSession(request);
      auth.verifyCsrf(
        current.csrfToken,
        typeof request.headers['x-csrf-token'] === 'string'
          ? request.headers['x-csrf-token']
          : undefined,
      );
      return reply.send(await passkeys.registrationOptions(current.user.id));
    },
  );

  app.post(
    '/api/v1/passkeys/registration/verify',
    {
      schema: {
        ...routeHelpers.apiContract('authentication', {
          authenticated: false,
          success: 201,
          body: routeHelpers.passkeyRegistrationVerifyBody,
          response: runtime.okResponse,
        }),
        security: [{ cookieSession: [] }],
      },
    },
    async (request, reply) => {
      const current = requireSession(request);
      auth.verifyCsrf(
        current.csrfToken,
        typeof request.headers['x-csrf-token'] === 'string'
          ? request.headers['x-csrf-token']
          : undefined,
      );
      const body = request.body as { challenge?: unknown; name?: unknown; response?: unknown };
      if (typeof body.challenge !== 'string' || typeof body.name !== 'string' || !body.response)
        throw new runtime.ValidationError('Invalid passkey response');
      await passkeys.register(
        current.user.id,
        body.challenge,
        body.name,
        body.response as runtime.RegistrationResponseJSON,
      );
      auth.revokeUserSessions(current.user.id, request.cookies.session);
      return reply.code(201).send({ ok: true });
    },
  );

  app.post(
    '/api/v1/passkeys/authentication/options',
    {
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
      schema: routeHelpers.apiContract('authentication', {
        authenticated: false,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { username: { type: 'string', maxLength: 39 } },
        },
        response: runtime.passkeyAuthenticationOptionsResponse,
      }),
    },
    async (request, reply) => {
      const body = request.body as { username?: unknown } | undefined;
      return reply.send(
        await passkeys.authenticationOptions(
          typeof body?.username === 'string' ? body.username : undefined,
        ),
      );
    },
  );

  app.post(
    '/api/v1/passkeys/authentication/verify',
    {
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
      schema: routeHelpers.apiContract('authentication', {
        authenticated: false,
        body: routeHelpers.passkeyAuthenticationVerifyBody,
        response: runtime.passkeyAuthenticationResultResponse,
      }),
    },
    async (request, reply) => {
      const body = request.body as { challenge?: unknown; response?: unknown };
      if (typeof body.challenge !== 'string' || !body.response)
        throw new runtime.ValidationError('Invalid passkey response');
      const userId = await passkeys.authenticate(
        body.challenge,
        body.response as runtime.AuthenticationResponseJSON,
      );
      const created = auth.createSession(userId, request.headers['user-agent']);
      reply.setCookie('session', created.token, {
        ...runtime.cookieOptions(config, true),
        expires: created.expiresAt,
      });
      return reply.send({ ok: true, redirect: '/' });
    },
  );

  const credentialsPage = async (
    current: ReturnType<typeof requireSession>,
    createdToken?: string,
    createdRecoveryCodes?: string[],
    createdTotpBackupCodes?: string[],
  ) =>
    await render('credentials', {
      user: current.user,
      csrf: current.csrfToken,
      tokens: tokens.list(current.user.id),
      repositories: repositories.listAccessible(current.user.id, 1, 100),
      sshKeys: sshKeys.list(current.user.id),
      createdToken: createdToken ?? null,
      createdRecoveryCodes: createdRecoveryCodes ?? null,
      recoveryCodeCount: recovery.count(current.user.id),
      passkeyList: passkeys.list(current.user.id),
      pendingTransfers: repositoryAdmin.pendingTransfers(current.user.id),
      totp: {
        enabled: totp.isEnabled(current.user.id),
        backupCodeCount: totp.backupCodeCount(current.user.id),
      },
      createdTotpBackupCodes: createdTotpBackupCodes ?? null,
    });

  app.get('/settings/credentials', async (request, reply) => {
    const current = requireSession(request);
    return reply.type('text/html').send(await credentialsPage(current));
  });

  app.get('/settings/two-factor/setup', async (request, reply) => {
    const current = requireSession(request);
    if (totp.isEnabled(current.user.id)) return await reply.redirect('/settings/credentials');
    const enrollment = await totp.beginEnrollment(current.user.id, current.user.username);
    return reply.type('text/html').send(
      await render('totp-setup', {
        user: current.user,
        csrf: current.csrfToken,
        secret: enrollment.secret,
        qrCodeDataUrl: enrollment.qrCodeDataUrl,
      }),
    );
  });

  app.post('/settings/two-factor/setup', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    try {
      const backupCodes = totp.confirmEnrollment(current.user.id, body.code ?? '');
      auth.revokeUserSessions(current.user.id, request.cookies.session);
      return await reply
        .type('text/html')
        .send(await credentialsPage(current, undefined, undefined, backupCodes));
    } catch (error) {
      if (!(error instanceof TotpError)) throw error;
      const enrollment = await totp.pendingEnrollment(current.user.id, current.user.username);
      if (!enrollment) return await reply.redirect('/settings/two-factor/setup');
      return reply
        .code(error.statusCode)
        .type('text/html')
        .send(
          await render('totp-setup', {
            user: current.user,
            csrf: current.csrfToken,
            secret: enrollment.secret,
            qrCodeDataUrl: enrollment.qrCodeDataUrl,
            error: 'The authentication code was not accepted.',
          }),
        );
    }
  });

  app.post('/settings/two-factor/disable', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    totp.disable(current.user.id, current.user.id);
    auth.revokeUserSessions(current.user.id, request.cookies.session);
    return await reply.redirect('/settings/credentials');
  });

  app.post('/settings/two-factor/backup-codes', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const backupCodes = totp.regenerateBackupCodes(current.user.id);
    return reply
      .type('text/html')
      .send(await credentialsPage(current, undefined, undefined, backupCodes));
  });

  app.get('/settings/appearance', async (request, reply) => {
    const current = requireSession(request);
    return reply.type('text/html').send(
      await render('appearance', {
        user: current.user,
        csrf: current.csrfToken,
        preferences: auth.appearance(current.user.id),
        pluginThemes: pluginContributions.themes(),
      }),
    );
  });

  app.post('/settings/repository-transfers/:repositoryId', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const repositoryId = Number.parseInt(
      (request.params as { repositoryId: string }).repositoryId,
      10,
    );
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0)
      throw new runtime.ValidationError('Invalid repository transfer');
    const updated = repositoryAdmin.resolveTransfer(
      repositoryId,
      current.user.id,
      body.action === 'accept',
    );
    if (updated) {
      search.enqueue(updated.id);
      return await reply.redirect(`/${updated.ownerSlug}/${updated.slug}`);
    }
    return await reply.redirect('/settings/credentials');
  });

  app.post('/settings/appearance', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    let pluginTheme = body.pluginTheme ?? null;
    if (pluginTheme === '') pluginTheme = null;
    if (pluginTheme && !pluginContributions.theme(pluginTheme))
      throw new runtime.ValidationError('Selected plugin theme is unavailable');
    auth.setAppearance(current.user.id, {
      theme: body.theme ?? '',
      accent: body.accent ?? '',
      uiFont: body.uiFont ?? '',
      codeFont: body.codeFont ?? '',
      reducedMotion: body.reducedMotion === 'yes',
      pluginTheme,
    });
    return await reply.redirect('/settings/appearance');
  });

  app.get('/plugin-themes/:pluginId/:themeId.css', async (request, reply) => {
    const parameters = request.params as { pluginId: string; themeId: string };
    const theme = pluginContributions.theme(
      `${parameters.pluginId}:${parameters.themeId.replace(/\.css$/, '')}`,
    );
    if (!theme) throw new runtime.NotFoundError();
    const colors = theme.colors;
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'public, max-age=300')
      .type('text/css; charset=utf-8')
      .send(
        `:root{color-scheme:${theme.colorScheme};--bg:${colors.background};--surface:${colors.surface};--surface-subtle:${colors.surfaceSubtle};--text:${colors.text};--muted:${colors.muted};--border:${colors.border};--accent:${colors.accent};--accent-strong:${colors.accentStrong}}`,
      );
  });

  app.get('/settings/sessions', async (request, reply) => {
    const current = requireSession(request);
    return reply.type('text/html').send(
      await render('sessions', {
        user: current.user,
        csrf: current.csrfToken,
        sessions: auth.sessions(current.user.id),
      }),
    );
  });

  app.post('/settings/sessions', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    auth.revokeUserSessions(current.user.id, request.cookies.session);
    return await reply.redirect('/settings/sessions');
  });

  app.post('/settings/tokens', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const days = ['30', '90', '365'].includes(body.expires ?? '') ? Number(body.expires) : 30;
    const scopes =
      body.access === 'api-write'
        ? [
            'api:read',
            'api:write',
            'repository:read',
            'repository:write',
            ...(current.user.isAdmin ? ['api:admin'] : []),
          ]
        : body.access === 'write'
          ? ['repository:read', 'repository:write']
          : body.access === 'api'
            ? ['api:read']
            : ['repository:read'];
    // Binding is only offered for repositories the account can already read, so a scoped token
    // can never widen access; it only ever narrows it.
    const repositoryId = body.repository ? Number.parseInt(body.repository, 10) : null;
    if (repositoryId !== null) {
      if (!Number.isSafeInteger(repositoryId))
        throw new runtime.ValidationError('Invalid repository');
      repositories.require(repositories.getById(repositoryId), current.user.id, 'read');
    }
    const createdToken = tokens.create({
      userId: current.user.id,
      name: body.name ?? '',
      scopes: repositoryId === null ? scopes : scopes.filter((scope) => scope !== 'api:admin'),
      expiresAt: new Date(Date.now() + days * 86_400_000),
      ...(repositoryId === null ? {} : { repositoryId }),
    });
    return reply.type('text/html').send(await credentialsPage(current, createdToken));
  });

  app.post('/settings/recovery-codes', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    return reply
      .type('text/html')
      .send(await credentialsPage(current, undefined, recovery.generate(current.user.id)));
  });

  app.post('/settings/passkeys/:passkeyId', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as runtime.FormBody;
    const parameters = request.params as { passkeyId: string };
    auth.verifyCsrf(current.csrfToken, body.csrf);
    if (body.action === 'rename')
      passkeys.rename(current.user.id, parameters.passkeyId, body.name ?? '');
    else if (body.action === 'remove') {
      passkeys.remove(current.user.id, parameters.passkeyId);
      auth.revokeUserSessions(current.user.id, request.cookies.session);
    } else throw new runtime.ValidationError('Invalid passkey action');
    return await reply.redirect('/settings/credentials');
  });

  app.post('/settings/tokens/:tokenId/revoke', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as runtime.FormBody;
    const parameters = request.params as { tokenId: string };
    auth.verifyCsrf(current.csrfToken, body.csrf);
    tokens.revoke(current.user.id, Number.parseInt(parameters.tokenId, 10));
    return await reply.redirect('/settings/credentials');
  });

  app.post('/settings/ssh-keys', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    await sshKeys.add(current.user.id, body.name ?? '', body.publicKey ?? '');
    return await reply.redirect('/settings/credentials');
  });

  app.post('/settings/ssh-keys/:keyId/remove', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as runtime.FormBody;
    const parameters = request.params as { keyId: string };
    auth.verifyCsrf(current.csrfToken, body.csrf);
    sshKeys.remove(current.user.id, Number.parseInt(parameters.keyId, 10));
    return await reply.redirect('/settings/credentials');
  });
}
