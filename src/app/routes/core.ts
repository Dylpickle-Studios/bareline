import type { AppRouteContext } from './route-context.js';
import * as routeHelpers from './route-helpers.js';
import * as runtime from './route-runtime.js';

export function registerCoreRoutes(context: AppRouteContext): void {
  const { app, config, auth, repositories, enhancements, render, session, requireSession } =
    context;

  app.get('/llms.txt', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=3600');
    return reply.type('text/plain; charset=utf-8').send(runtime.llmsTxt(config.server.publicUrl));
  });

  app.get('/', async (request, reply) => {
    const current = session(request);
    const accessible = current ? repositories.listAccessible(current.user.id, 1, 100) : [];
    const pinned = current ? new Set(enhancements.pinnedIds(current.user.id)) : new Set<number>();
    const recentOrder = current ? enhancements.recentIds(current.user.id) : [];
    const own = current
      ? accessible.filter(
          (repository) => repository.ownerType === 'user' && repository.ownerId === current.user.id,
        )
      : [];
    return reply.type('text/html').send(
      await render('home', {
        user: current?.user ?? null,
        pinnedRepositories: accessible.filter((repository) => pinned.has(repository.id)),
        recentRepositories: recentOrder
          .map((id) => accessible.find((repository) => repository.id === id))
          .filter(Boolean),
        ownRepositories: own,
        accessibleCount: accessible.length,
      }),
    );
  });

  app.get('/explore', async (request, reply) => {
    const current = session(request);
    const query = request.query as { q?: string; page?: string };
    const search = (query.q ?? '').trim().slice(0, 100);
    const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
    const pageSize = 50;
    // Ask for one extra row so the page knows whether a next page exists.
    const listed = repositories.listAccessible(current?.user.id ?? null, page, pageSize + 1, {
      ...(search ? { query: search } : {}),
    });
    return reply.type('text/html').send(
      await render('explore', {
        title: 'Explore',
        user: current?.user ?? null,
        repositories: listed.slice(0, pageSize),
        query: search,
        page,
        hasNext: listed.length > pageSize,
      }),
    );
  });

  app.post(
    '/api/v1/markdown-preview',
    {
      schema: routeHelpers.apiContract('markdown', {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['markdown'],
          properties: { markdown: { type: 'string', maxLength: 2_000_000 } },
        },
        response: {
          type: 'object',
          additionalProperties: false,
          required: ['html'],
          properties: { html: { type: 'string' } },
        },
      }),
    },
    async (request, reply) => {
      const current = requireSession(request);
      const csrfHeader = request.headers['x-csrf-token'];
      auth.verifyCsrf(current.csrfToken, Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader);
      const body = request.body as { markdown: string };
      return reply.send({ html: runtime.renderMarkdown(body.markdown) });
    },
  );
}
