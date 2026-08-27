import type { AppRouteContext } from './route-context.js';
import * as runtime from './route-runtime.js';
import { isAddressAllowed } from '../../security/ip-policy.js';

// Login, registration, federation, recovery, and public profile routes.
export function registerAuthPublicRoutes(context: AppRouteContext): void {
  const {
    app,
    config,
    database,
    auth,
    externalAuth,
    recovery,
    repositories,
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
}
