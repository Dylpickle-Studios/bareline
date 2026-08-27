import type { AppRouteContext } from './route-context.js';
import * as routeHelpers from './route-helpers.js';
import * as runtime from './route-runtime.js';

export function registerNavigationRoutes(context: AppRouteContext): void {
  const {
    app,
    auth,
    repositories,
    enhancements,
    groups,
    search,
    pluginContributions,
    render,
    session,
    requireSession,
  } = context;
  app.get('/groups', async (request, reply) => {
    const current = requireSession(request);
    return reply
      .type('text/html')
      .send(
        await render('groups', { user: current.user, groups: groups.listForUser(current.user.id) }),
      );
  });

  app.get('/groups/new', async (request, reply) => {
    const current = requireSession(request);
    return reply
      .type('text/html')
      .send(await render('group-new', { user: current.user, csrf: current.csrfToken }));
  });

  app.post('/groups/new', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    groups.create(current.user.id, body.slug ?? '', body.displayName ?? '');
    return await reply.redirect(`/groups/${body.slug?.toLowerCase() ?? ''}/settings`);
  });

  app.get('/groups/:groupSlug/settings', async (request, reply) => {
    const current = requireSession(request);
    const group = groups.getBySlug(
      (request.params as { groupSlug: string }).groupSlug,
      current.user.id,
    );
    return reply.type('text/html').send(
      await render('group-settings', {
        user: current.user,
        csrf: current.csrfToken,
        group,
        canManage: group.role === 'manager' || group.role === 'owner',
      }),
    );
  });

  app.post('/groups/:groupSlug/settings', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const group = groups.getBySlug(
      (request.params as { groupSlug: string }).groupSlug,
      current.user.id,
    );
    if (body.action === 'add')
      groups.addMember(
        current.user.id,
        group.id,
        body.username ?? '',
        body.role === 'owner' ? 'owner' : body.role === 'manager' ? 'manager' : 'member',
      );
    else if (body.action === 'remove')
      groups.removeMember(current.user.id, group.id, Number.parseInt(body.userId ?? '', 10));
    else throw new runtime.ValidationError('Invalid group action');
    return await reply.redirect(`/groups/${group.slug}/settings`);
  });

  app.get('/repositories/new', async (request, reply) => {
    const current = requireSession(request);
    return reply.type('text/html').send(
      await render('new-repository', {
        user: current.user,
        csrf: current.csrfToken,
        groups: groups
          .listForUser(current.user.id)
          .filter((group) => group.role === 'owner' || group.role === 'manager'),
        templates: repositories
          .listAccessible(current.user.id, 1, 100)
          .filter((repository) => enhancements.isTemplate(repository.id)),
      }),
    );
  });
  app.post('/repositories/new', async (request, reply) => {
    const current = requireSession(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const visibility: runtime.Visibility = body.visibility === 'public' ? 'public' : 'private';
    let createdRepository: ReturnType<runtime.RepositoryService['getById']> | null = null;
    try {
      const [ownerType, ownerSlug] = (body.owner ?? '').split(':', 2);
      const repository =
        ownerType === 'group' && ownerSlug
          ? await repositories.createForGroup({
              actorUserId: current.user.id,
              ownerGroupId: groups.getBySlug(ownerSlug, current.user.id).id,
              slug: body.slug ?? '',
              description: body.description ?? '',
              visibility,
              initializeReadme: body.initializeReadme === 'yes',
              gitignore: body.gitignore ?? '',
              license: body.license ?? '',
            })
          : await repositories.createForUser({
              actorUserId: current.user.id,
              ownerUserId: current.user.id,
              slug: body.slug ?? '',
              description: body.description ?? '',
              visibility,
              initializeReadme: body.initializeReadme === 'yes',
              gitignore: body.gitignore ?? '',
              license: body.license ?? '',
            });
      createdRepository = repository;
      if (body.templateId) {
        const template = repositories.getById(Number.parseInt(body.templateId, 10));
        repositories.require(template, current.user.id, 'read');
        if (!enhancements.isTemplate(template.id))
          throw new runtime.ValidationError('Template repository is unavailable');
        await repositories.populateFromTemplate(repository, template);
        enhancements.recordActivity(
          repository.id,
          current.user.id,
          'repository.createdFromTemplate',
          undefined,
          { templateId: template.id },
        );
      }
      search.enqueue(repository.id);
      return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}`);
    } catch (error) {
      if (createdRepository && body.templateId)
        await repositories.discardFailedCreation(createdRepository).catch(() => undefined);
      return reply
        .code((error as { statusCode?: number }).statusCode ?? 400)
        .type('text/html')
        .send(
          await render('new-repository', {
            user: current.user,
            csrf: current.csrfToken,
            error: runtime.safeErrorMessage(error),
            groups: groups
              .listForUser(current.user.id)
              .filter((group) => group.role === 'owner' || group.role === 'manager'),
            templates: repositories
              .listAccessible(current.user.id, 1, 100)
              .filter((repository) => enhancements.isTemplate(repository.id)),
          }),
        );
    }
  });

  app.get('/search', async (request, reply) => {
    const current = session(request);
    const query = (request.query as { q?: string }).q ?? '';
    const results = query ? search.search(query, current?.user.id ?? null) : [];
    const directoryResults = query ? search.searchDirectory(query, current?.user.id ?? null) : [];
    const documentationResults = query ? await runtime.documentationSearch(query) : [];
    return reply.type('text/html').send(
      await render('search', {
        user: current?.user ?? null,
        query,
        results,
        directoryResults,
        documentationResults,
      }),
    );
  });

  app.get('/docs', async (request, reply) => {
    const current = session(request);
    const page = await runtime.documentationPage('getting-started');
    return reply.type('text/html').send(
      await render('docs', {
        user: current?.user ?? null,
        documents: runtime.documentation,
        slug: 'getting-started',
        html: page.html,
        title: page.title,
      }),
    );
  });

  app.get('/docs/:slug', async (request, reply) => {
    const current = session(request);
    const slug = (request.params as { slug: string }).slug;
    const page = await runtime.documentationPage(slug);
    return reply.type('text/html').send(
      await render('docs', {
        user: current?.user ?? null,
        documents: runtime.documentation,
        slug,
        html: page.html,
        title: page.title,
      }),
    );
  });

  app.get(
    '/api/v1/palette',
    {
      schema: routeHelpers.apiContract('navigation', {
        query: {
          type: 'object',
          additionalProperties: false,
          properties: { q: { type: 'string', maxLength: 200 } },
        },
        response: runtime.paletteResponse,
      }),
    },
    async (request, reply) => {
      const current = requireSession(request);
      const query = ((request.query as { q?: string }).q ?? '').trim();
      const normalized = query.toLocaleLowerCase();
      const fixed = [
        {
          title: 'Create repository',
          subtitle: 'Action',
          url: '/repositories/new',
          keywords: 'new create repository',
        },
        {
          title: 'Profile',
          subtitle: 'Settings',
          url: '/settings/profile',
          keywords: 'avatar display name email privacy',
        },
        {
          title: 'Git credentials',
          subtitle: 'Settings',
          url: '/settings/credentials',
          keywords: 'token ssh key passkey',
        },
        {
          title: 'Appearance',
          subtitle: 'Settings',
          url: '/settings/appearance',
          keywords: 'theme light dark font accent',
        },
        {
          title: 'Getting Started',
          subtitle: 'Documentation',
          url: '/docs/getting-started',
          keywords: 'install clone push git',
        },
        {
          title: 'Plugin runtime.documentation',
          subtitle: 'Documentation',
          url: '/docs/plugins',
          keywords: 'plugin sdk manifest permissions',
        },
        ...(current.user.isAdmin
          ? [
              {
                title: 'Administration',
                subtitle: 'Settings',
                url: '/admin',
                keywords: 'users repositories security system',
              },
              {
                title: 'Application settings',
                subtitle: 'Administration',
                url: '/admin/settings',
                keywords: 'registration authentication security limits anonymous trash sessions',
              },
              {
                title: 'Manage plugins',
                subtitle: 'Administration',
                url: '/admin/plugins',
                keywords: 'install enable plugin settings',
              },
            ]
          : []),
      ].filter(
        (item) =>
          !normalized || `${item.title} ${item.keywords}`.toLocaleLowerCase().includes(normalized),
      );
      const repositoryResults = query
        ? search.search(query, current.user.id, 12).map((result) => ({
            title: result.title,
            subtitle: `${result.owner}/${result.repository} · ${result.type}`,
            url: result.url,
          }))
        : [];
      const directoryResults = query
        ? search.searchDirectory(query, current.user.id, 8).map((result) => ({
            title: result.title,
            subtitle: `${result.type} · ${result.subtitle}`,
            url: result.url,
          }))
        : [];
      const pluginResults = pluginContributions
        .commands()
        .filter((command) => !normalized || command.title.toLocaleLowerCase().includes(normalized))
        .map((command) => ({
          title: command.title,
          subtitle: command.pluginName,
          url: command.url,
        }));
      const pluginSearchResults = await pluginContributions.searchProviders(query, current.user);
      const documentationResults = query ? await runtime.documentationSearch(query, 8) : [];
      return reply.send({
        items: [
          ...fixed,
          ...directoryResults,
          ...repositoryResults,
          ...documentationResults,
          ...pluginResults,
          ...pluginSearchResults,
        ].slice(0, 30),
      });
    },
  );
}
