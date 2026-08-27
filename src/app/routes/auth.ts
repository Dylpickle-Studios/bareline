import type { AppRouteContext } from './route-context.js';
import { isAddressAllowed } from '../../security/ip-policy.js';
import * as routeHelpers from './route-helpers.js';
import * as runtime from './route-runtime.js';

export function registerAuthRoutes(context: AppRouteContext): void {
  const {
    app,
    config,
    database,
    auth,
    tokens,
    passkeys,
    externalAuth,
    recovery,
    sshKeys,
    repositories,
    repositoryAdmin,
    search,
    pluginContributions,
    render,
    session,
    requireSession,
    formCsrf,
    verifyFormCsrf,
  } = context;
  app.get('/login', async (request, reply) => {
    return reply.type('text/html').send(
      await render('auth', {
        mode: 'login',
        csrf: formCsrf(request, reply),
        user: null,
        oidcProviders: externalAuth.providers(),
        ldapEnabled: config.authentication?.ldap?.enabled === true,
        pluginAuthProviders: pluginContributions.authenticationProviders(),
      }),
    );
  });
  app.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = request.body as runtime.FormBody;
      verifyFormCsrf(request, body.csrf);
      try {
        const user = await auth.login(
          body.username ?? '',
          body.password ?? '',
          request.id,
          request.ip,
        );
        const created = auth.createSession(user.id, request.headers['user-agent']);
        reply.setCookie('session', created.token, {
          ...runtime.cookieOptions(config, true),
          expires: created.expiresAt,
        });
        reply.clearCookie('form_csrf', runtime.cookieOptions(config, false));
        return await reply.redirect('/');
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 401) throw error;
        return reply
          .code(401)
          .type('text/html')
          .send(
            await render('auth', {
              mode: 'login',
              csrf: formCsrf(request, reply),
              error: 'The username or password was not accepted.',
              user: null,
              oidcProviders: externalAuth.providers(),
              ldapEnabled: config.authentication?.ldap?.enabled === true,
              pluginAuthProviders: pluginContributions.authenticationProviders(),
            }),
          );
      }
    },
  );

  app.get('/register', async (request, reply) => {
    const inviteToken = (request.query as { invite?: string }).invite;
    return reply.type('text/html').send(
      await render('auth', {
        mode: 'register',
        csrf: formCsrf(request, reply),
        user: null,
        oidcProviders: [],
        ldapEnabled: false,
        pluginAuthProviders: [],
        inviteToken: inviteToken?.slice(0, 128) ?? '',
      }),
    );
  });
  app.post(
    '/register',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const body = request.body as runtime.FormBody;
      verifyFormCsrf(request, body.csrf);
      try {
        const user = await auth.register({
          username: body.username ?? '',
          displayName: body.displayName ?? '',
          password: body.password ?? '',
          ...(body.email ? { email: body.email } : {}),
          ...(body.invite ? { inviteToken: body.invite } : {}),
          requestId: request.id,
          ip: request.ip,
        });
        const created = auth.createSession(user.id, request.headers['user-agent']);
        reply.setCookie('session', created.token, {
          ...runtime.cookieOptions(config, true),
          expires: created.expiresAt,
        });
        return await reply.redirect('/');
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode ?? 400;
        return reply
          .code(status)
          .type('text/html')
          .send(
            await render('auth', {
              mode: 'register',
              csrf: formCsrf(request, reply),
              error: runtime.safeErrorMessage(error),
              user: null,
              oidcProviders: [],
              ldapEnabled: false,
              pluginAuthProviders: [],
              inviteToken: body.invite ?? '',
            }),
          );
      }
    },
  );

  app.post('/logout', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    auth.revokeSession(request.cookies.session);
    reply.clearCookie('session', runtime.cookieOptions(config, true));
    return reply.redirect('/');
  });

  app.get('/avatars/:username', async (request, reply) => {
    const row = database
      .prepare(
        "SELECT avatar, avatar_mime AS mime FROM users WHERE username = ? AND status = 'active' AND avatar IS NOT NULL",
      )
      .get((request.params as { username: string }).username.toLowerCase()) as
      { avatar: Buffer; mime: string } | undefined;
    if (!row) throw new runtime.NotFoundError();
    return reply
      .header('Cache-Control', 'public, max-age=300')
      .header('X-Content-Type-Options', 'nosniff')
      .type(row.mime)
      .send(row.avatar);
  });

  app.get('/users/:username', async (request, reply) => {
    const current = session(request);
    const username = (request.params as { username: string }).username.toLowerCase();
    const account = database
      .prepare(
        `SELECT id, username, display_name AS displayName,
          CASE WHEN email_public = 1 THEN email ELSE NULL END AS email,
          avatar IS NOT NULL AS hasAvatar
         FROM users WHERE username = ? AND status = 'active'`,
      )
      .get(username) as
      | {
          id: number;
          username: string;
          displayName: string;
          email: string | null;
          hasAvatar: number;
        }
      | undefined;
    if (!account) throw new runtime.NotFoundError();
    return reply.type('text/html').send(
      await render('user', {
        user: current?.user ?? null,
        account: { ...account, hasAvatar: account.hasAvatar === 1 },
        repositories: repositories
          .listAccessible(current?.user.id ?? null, 1, 100, { owner: account.username })
          .filter(
            (repository) => repository.ownerType === 'user' && repository.ownerId === account.id,
          ),
      }),
    );
  });

  app.get('/settings/profile', async (request, reply) => {
    const current = requireSession(request);
    return reply.type('text/html').send(
      await render('profile', {
        user: current.user,
        csrf: current.csrfToken,
        profile: auth.profile(current.user.id),
      }),
    );
  });

  app.post('/settings/profile', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    auth.updateProfile(current.user.id, {
      displayName: body.displayName ?? '',
      email: body.email ?? '',
      emailPublic: body.emailPublic === 'yes',
    });
    return await reply.redirect('/settings/profile');
  });

  app.post('/settings/avatar', async (request, reply) => {
    const current = requireSession(request);
    let csrf: string | undefined;
    let avatar: Buffer | undefined;
    let mime = '';
    for await (const part of request.parts()) {
      if (part.type === 'field' && part.fieldname === 'csrf') csrf = String(part.value);
      if (part.type === 'file' && part.fieldname === 'avatar') {
        mime = part.mimetype;
        avatar = await part.toBuffer();
      }
    }
    auth.verifyCsrf(current.csrfToken, csrf);
    if (!avatar) throw new runtime.ValidationError('Avatar image is required');
    auth.setAvatar(current.user.id, avatar, mime);
    return await reply.redirect('/settings/profile');
  });

  app.post('/settings/avatar/remove', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    auth.removeAvatar(current.user.id);
    return await reply.redirect('/settings/profile');
  });

  app.get('/auth/proxy', async (request, reply) => {
    const proxy = config.authentication?.reverseProxy;
    if (!proxy?.enabled || !isAddressAllowed(request.ip, proxy.allowedAddresses))
      throw new runtime.AuthorizationError();
    const identityValue = request.headers[proxy.identityHeader];
    const displayValue = request.headers[proxy.displayNameHeader];
    if (typeof identityValue !== 'string') throw new runtime.AuthorizationError();
    const user = auth.loginReverseProxy(
      identityValue,
      typeof displayValue === 'string' ? displayValue : undefined,
      proxy.autoCreate,
      request.id,
      request.ip,
    );
    const created = auth.createSession(user.id, request.headers['user-agent']);
    reply.setCookie('session', created.token, {
      ...runtime.cookieOptions(config, true),
      expires: created.expiresAt,
    });
    return await reply.redirect('/');
  });

  app.get('/auth/oidc/:providerId', async (request, reply) => {
    const providerId = (request.params as { providerId: string }).providerId;
    const returnPath = (request.query as { return?: string }).return ?? '/';
    return await reply.redirect((await externalAuth.beginOidc(providerId, returnPath)).href);
  });

  app.get('/auth/oidc/:providerId/callback', async (request, reply) => {
    const providerId = (request.params as { providerId: string }).providerId;
    const result = await externalAuth.completeOidc(
      providerId,
      new URL(request.url, config.server.publicUrl),
      request.id,
      request.ip,
    );
    const created = auth.createSession(result.user.id, request.headers['user-agent']);
    reply.setCookie('session', created.token, {
      ...runtime.cookieOptions(config, true),
      expires: created.expiresAt,
    });
    return await reply.redirect(result.returnPath);
  });

  app.post(
    '/auth/ldap',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = request.body as runtime.FormBody;
      verifyFormCsrf(request, body.csrf);
      try {
        const user = await externalAuth.loginLdap(
          body.username ?? '',
          body.password ?? '',
          request.id,
          request.ip,
        );
        const created = auth.createSession(user.id, request.headers['user-agent']);
        reply.setCookie('session', created.token, {
          ...runtime.cookieOptions(config, true),
          expires: created.expiresAt,
        });
        reply.clearCookie('form_csrf', runtime.cookieOptions(config, false));
        return await reply.redirect('/');
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 401) throw error;
        return reply
          .code(401)
          .type('text/html')
          .send(
            await render('auth', {
              mode: 'login',
              csrf: formCsrf(request, reply),
              error: 'The directory credentials were not accepted.',
              user: null,
              oidcProviders: externalAuth.providers(),
              ldapEnabled: true,
              pluginAuthProviders: pluginContributions.authenticationProviders(),
            }),
          );
      }
    },
  );

  app.post(
    '/auth/plugins/:pluginId/:providerId',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = request.body as runtime.FormBody;
      verifyFormCsrf(request, body.csrf);
      const { pluginId, providerId } = request.params as {
        pluginId: string;
        providerId: string;
      };
      try {
        const result = await pluginContributions.authenticate(pluginId, providerId, {
          username: body.username ?? '',
          password: body.password ?? '',
        });
        const user = auth.loginExternal({
          providerId: `plugin:${pluginId}:${providerId}`,
          subject: result.identity.subject,
          username: result.identity.username,
          displayName: result.identity.displayName,
          ...(result.identity.email ? { email: result.identity.email } : {}),
          profile: { source: 'plugin' },
          autoCreate: result.provider.autoCreate,
          requestId: request.id,
          ip: request.ip,
        });
        const created = auth.createSession(user.id, request.headers['user-agent']);
        reply.setCookie('session', created.token, {
          ...runtime.cookieOptions(config, true),
          expires: created.expiresAt,
        });
        reply.clearCookie('form_csrf', runtime.cookieOptions(config, false));
        return await reply.redirect('/');
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode ?? 401;
        if (![400, 401, 403].includes(status)) throw error;
        return reply
          .code(401)
          .type('text/html')
          .send(
            await render('auth', {
              mode: 'login',
              csrf: formCsrf(request, reply),
              error: 'The external credentials were not accepted.',
              user: null,
              oidcProviders: externalAuth.providers(),
              ldapEnabled: config.authentication?.ldap?.enabled === true,
              pluginAuthProviders: pluginContributions.authenticationProviders(),
            }),
          );
      }
    },
  );

  app.get('/recover', async (request, reply) => {
    return reply
      .type('text/html')
      .send(await render('recover', { user: null, csrf: formCsrf(request, reply) }));
  });

  app.post(
    '/recover',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const body = request.body as runtime.FormBody;
      verifyFormCsrf(request, body.csrf);
      try {
        await recovery.resetPassword(
          body.username ?? '',
          body.code ?? '',
          body.password ?? '',
          request.id,
          request.ip,
        );
        reply.clearCookie('form_csrf', runtime.cookieOptions(config, false));
        return await reply.redirect('/login');
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode ?? 0;
        if (![400, 401, 409].includes(status)) throw error;
        return reply
          .code(status)
          .type('text/html')
          .send(
            await render('recover', {
              user: null,
              csrf: formCsrf(request, reply),
              error: 'The recovery details were not accepted.',
            }),
          );
      }
    },
  );

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
  ) =>
    await render('credentials', {
      user: current.user,
      csrf: current.csrfToken,
      tokens: tokens.list(current.user.id),
      sshKeys: sshKeys.list(current.user.id),
      createdToken: createdToken ?? null,
      createdRecoveryCodes: createdRecoveryCodes ?? null,
      recoveryCodeCount: recovery.count(current.user.id),
      passkeyList: passkeys.list(current.user.id),
      pendingTransfers: repositoryAdmin.pendingTransfers(current.user.id),
    });

  app.get('/settings/credentials', async (request, reply) => {
    const current = requireSession(request);
    return reply.type('text/html').send(await credentialsPage(current));
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
    const createdToken = tokens.create({
      userId: current.user.id,
      name: body.name ?? '',
      scopes,
      expiresAt: new Date(Date.now() + days * 86_400_000),
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
