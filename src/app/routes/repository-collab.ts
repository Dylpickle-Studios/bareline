import type { AppRouteContext } from './route-context.js';
import * as runtime from './route-runtime.js';

// Fork, cherry-pick, revert, and merge routes: git-native alternatives to a pull-request system.
export function registerRepositoryCollabRoutes(context: AppRouteContext): void {
  const {
    app,
    auth,
    repositories,
    mutations,
    groups,
    search,
    render,
    readableRepository,
    writableRepository,
    referenceOptions,
  } = context;

  app.get('/:owner/:repository/fork', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    if (!current) throw new runtime.AuthorizationError();
    return reply.type('text/html').send(
      await render('fork', {
        user: current.user,
        csrf: current.csrfToken,
        repository,
        slug: repository.slug,
        groups: groups
          .listForUser(current.user.id)
          .filter((group) => group.role === 'owner' || group.role === 'manager'),
      }),
    );
  });

  app.post('/:owner/:repository/fork', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    if (!current) throw new runtime.AuthorizationError();
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const visibility: runtime.Visibility = body.visibility === 'private' ? 'private' : 'public';
    const [ownerType, ownerSlug] = (body.owner ?? '').split(':', 2);
    const ownerId =
      ownerType === 'group' && ownerSlug
        ? groups.getBySlug(ownerSlug, current.user.id).id
        : current.user.id;
    try {
      const fork = await repositories.fork({
        actorUserId: current.user.id,
        source: repository,
        ownerType: ownerType === 'group' ? 'group' : 'user',
        ownerId,
        slug: body.slug ?? repository.slug,
        visibility,
      });
      search.enqueue(fork.id);
      return await reply.redirect(`/${fork.ownerSlug}/${fork.slug}`);
    } catch (error) {
      return reply
        .code((error as { statusCode?: number }).statusCode ?? 400)
        .type('text/html')
        .send(
          await render('fork', {
            user: current.user,
            csrf: current.csrfToken,
            repository,
            slug: body.slug ?? repository.slug,
            error: runtime.safeErrorMessage(error),
            groups: groups
              .listForUser(current.user.id)
              .filter((group) => group.role === 'owner' || group.role === 'manager'),
          }),
        );
    }
  });

  app.post('/:owner/:repository/commit/:objectId/cherry-pick', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const parameters = request.params as { objectId: string };
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const commitId = await mutations.cherryPick({
      repository,
      actorUserId: current.user.id,
      objectId: parameters.objectId,
      targetBranch: body.branch ?? repository.defaultBranch,
    });
    return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}/commit/${commitId}`);
  });

  app.post('/:owner/:repository/commit/:objectId/revert', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const parameters = request.params as { objectId: string };
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const commitId = await mutations.revertCommit({
      repository,
      actorUserId: current.user.id,
      objectId: parameters.objectId,
      targetBranch: body.branch ?? repository.defaultBranch,
    });
    return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}/commit/${commitId}`);
  });

  app.get('/:owner/:repository/merge', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const query = request.query as { source?: string; target?: string };
    const canWrite =
      current !== null &&
      !['none', 'read'].includes(repositories.permission(repository, current.user.id));
    return reply.type('text/html').send(
      await render('merge', {
        user: current?.user ?? null,
        csrf: current?.csrfToken ?? '',
        repository,
        canWrite,
        source: query.source ?? '',
        target: query.target ?? repository.defaultBranch,
        ...(await referenceOptions(repository)),
      }),
    );
  });

  app.post('/:owner/:repository/merge', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const targetBranch = body.target ?? repository.defaultBranch;
    const commitId = await mutations.mergeBranch({
      repository,
      actorUserId: current.user.id,
      sourceInput: body.source ?? '',
      targetBranch,
      ...(body.message ? { message: body.message } : {}),
    });
    return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}/commit/${commitId}`);
  });
}
