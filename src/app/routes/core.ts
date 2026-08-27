import type { AppRouteContext } from './route-context.js';
import * as routeHelpers from './route-helpers.js';
import * as runtime from './route-runtime.js';

export function registerCoreRoutes(context: AppRouteContext): void {
  const { app, auth, repositories, enhancements, render, session, requireSession } = context;
  app.get('/', async (request, reply) => {
    const current = session(request);
    const accessible = current ? repositories.listAccessible(current.user.id, 1, 100) : [];
    const pinned = current ? new Set(enhancements.pinnedIds(current.user.id)) : new Set<number>();
    const recentOrder = current ? enhancements.recentIds(current.user.id) : [];
    return reply.type('text/html').send(
      await render('home', {
        user: current?.user ?? null,
        pinnedRepositories: accessible.filter((repository) => pinned.has(repository.id)),
        recentRepositories: recentOrder
          .map((id) => accessible.find((repository) => repository.id === id))
          .filter(Boolean),
      }),
    );
  });

  app.get('/explore', async (request, reply) => {
    const current = session(request);
    const repositoriesPage = repositories.listAccessible(current?.user.id ?? null, 1, 100);
    return reply.type('text/html').send(
      await render('explore', {
        user: current?.user ?? null,
        repositories: repositoriesPage,
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
