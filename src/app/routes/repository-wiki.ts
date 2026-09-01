import type { AppRouteContext } from './route-context.js';
import * as runtime from './route-runtime.js';

// Repository wiki routes: each repository's wiki is a small bare Git repo of Markdown pages.
export function registerWikiHtmlRoutes(context: AppRouteContext): void {
  const { app, auth, repositories, wikis, render, readableRepository, writableRepository } =
    context;

  const canWriteWiki = (
    repository: ReturnType<AppRouteContext['readableRepository']>['repository'],
    current: ReturnType<AppRouteContext['readableRepository']>['current'],
  ) =>
    current !== null &&
    !['none', 'read'].includes(repositories.permission(repository, current.user.id));

  app.get('/:owner/:repository/wiki', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const pages = await wikis.listPages(repository);
    const home = await wikis.readPage(repository, 'Home');
    return reply.type('text/html').send(
      await render('wiki', {
        user: current?.user ?? null,
        repository,
        pages,
        page: 'Home',
        content: home,
        rendered: home !== null ? runtime.renderMarkdown(home) : null,
        canWrite: canWriteWiki(repository, current),
      }),
    );
  });

  app.get('/:owner/:repository/wiki/:page', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const parameters = request.params as { page: string };
    const pages = await wikis.listPages(repository);
    const content = await wikis.readPage(repository, parameters.page);
    return reply.type('text/html').send(
      await render('wiki', {
        user: current?.user ?? null,
        repository,
        pages,
        page: parameters.page,
        content,
        rendered: content !== null ? runtime.renderMarkdown(content) : null,
        canWrite: canWriteWiki(repository, current),
      }),
    );
  });

  app.get('/:owner/:repository/wiki/:page/edit', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const parameters = request.params as { page: string };
    const content = await wikis.readPage(repository, parameters.page);
    return reply.type('text/html').send(
      await render('wiki-edit', {
        user: current.user,
        csrf: current.csrfToken,
        repository,
        page: parameters.page,
        content: content ?? '',
        exists: content !== null,
      }),
    );
  });

  app.post('/:owner/:repository/wiki/:page/edit', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const parameters = request.params as { page: string };
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    await wikis.writePage({
      repository,
      actorUserId: current.user.id,
      page: parameters.page,
      content: body.content ?? '',
      message: body.message ?? `Update ${parameters.page}`,
    });
    return await reply.redirect(
      `/${repository.ownerSlug}/${repository.slug}/wiki/${encodeURIComponent(parameters.page)}`,
    );
  });

  app.get('/:owner/:repository/wiki/:page/history', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const parameters = request.params as { page: string };
    const history = await wikis.history(repository, parameters.page);
    return reply.type('text/html').send(
      await render('wiki-history', {
        user: current?.user ?? null,
        repository,
        page: parameters.page,
        history,
      }),
    );
  });

  app.post('/:owner/:repository/wiki/:page/delete', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const parameters = request.params as { page: string };
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    await wikis.deletePage({
      repository,
      actorUserId: current.user.id,
      page: parameters.page,
      message: `Delete ${parameters.page}`,
    });
    return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}/wiki`);
  });
}
