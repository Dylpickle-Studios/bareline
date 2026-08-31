import type { AppRouteContext } from './route-context.js';
import * as runtime from './route-runtime.js';

// Repository settings, activity, and pin routes.
export function registerRepositorySettingsRoutes(context: AppRouteContext): void {
  const {
    app,
    auth,
    repositories,
    enhancements,
    repositoryAdmin,
    search,
    render,
    readableRepository,
  } = context;
  app.get('/:owner/:repository/settings', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    if (!current) throw new runtime.AuthorizationError();
    repositories.require(repository, current.user.id, 'admin');
    return reply.type('text/html').send(
      await render('repository-settings', {
        user: current.user,
        csrf: current.csrfToken,
        repository,
        grants: repositoryAdmin.grants(repository, current.user.id),
        policies: enhancements.policies(repository.id),
        deployKeys: enhancements.deployKeys(repository.id),
        isTemplate: enhancements.isTemplate(repository.id),
        mirror: enhancements.mirror(repository.id),
      }),
    );
  });

  app.get('/:owner/:repository/activity', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    return reply.type('text/html').send(
      await render('repository-activity', {
        user: current?.user ?? null,
        repository,
        events: enhancements.activity(repository.id),
      }),
    );
  });

  app.get('/:owner/:repository/settings/health', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    if (!current) throw new runtime.AuthorizationError();
    repositories.require(repository, current.user.id, 'admin');
    return reply.send(await enhancements.health(repository));
  });

  app.post('/:owner/:repository/pin', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    if (!current) throw new runtime.AuthorizationError();
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    enhancements.pin(current.user.id, repository.id, body.enabled === 'yes');
    return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}`);
  });

  app.post('/:owner/:repository/settings', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    if (!current) throw new runtime.AuthorizationError();
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    let updated = repository;
    if (body.action === 'details') {
      updated = await repositoryAdmin.updateDetails(
        repository,
        current.user.id,
        body.description ?? '',
        body.defaultBranch ?? '',
      );
      updated = repositoryAdmin.changeVisibility(
        updated,
        current.user.id,
        body.visibility === 'public' ? 'public' : 'private',
      );
    } else if (body.action === 'grant') {
      const principalType = body.principalType === 'group' ? 'group' : 'user';
      const level = body.level === 'admin' ? 'admin' : body.level === 'write' ? 'write' : 'read';
      repositoryAdmin.setGrantByName(
        repository,
        current.user.id,
        principalType,
        body.principalName ?? '',
        level,
      );
    } else if (body.action === 'removeGrant') {
      repositoryAdmin.removeGrant(
        repository,
        current.user.id,
        body.principalType === 'group' ? 'group' : 'user',
        Number.parseInt(body.principalId ?? '', 10),
      );
    } else if (body.action === 'policy') {
      await enhancements.setPolicy(repository, current.user.id, {
        refPattern: body.refPattern ?? '',
        blockForcePush: body.blockForcePush === 'on',
        blockDeletion: body.blockDeletion === 'on',
        requireSignedCommits: body.requireSignedCommits === 'on',
        commitMessagePrefix: body.commitMessagePrefix ?? null,
      });
    } else if (body.action === 'removePolicy') {
      await enhancements.removePolicy(repository, current.user.id, body.refPattern ?? '');
    } else if (body.action === 'archive') {
      updated = enhancements.setArchived(repository, current.user.id, true);
    } else if (body.action === 'unarchive') {
      updated = enhancements.setArchived(repository, current.user.id, false);
    } else if (body.action === 'deployKey') {
      await enhancements.addDeployKey(
        repository,
        current.user.id,
        body.name ?? '',
        body.publicKey ?? '',
      );
    } else if (body.action === 'removeDeployKey') {
      enhancements.removeDeployKey(
        repository,
        current.user.id,
        Number.parseInt(body.keyId ?? '', 10),
      );
    } else if (body.action === 'template') {
      enhancements.setTemplate(repository, current.user.id, body.enabled === 'on');
    } else if (body.action === 'mirror') {
      enhancements.configureMirror(repository, current.user.id, {
        direction: body.direction === 'push' ? 'push' : 'pull',
        remoteUrl: body.remoteUrl ?? '',
        intervalMinutes: Number.parseInt(body.intervalMinutes ?? '60', 10),
      });
    } else if (body.action === 'runMirror') {
      await enhancements.runMirror(repository, current.user.id);
    } else if (body.action === 'removeMirror') {
      enhancements.removeMirror(repository, current.user.id);
    } else if (body.action === 'rename') {
      updated = repositoryAdmin.rename(repository, current.user.id, body.slug ?? '');
    } else if (body.action === 'transfer') {
      updated = repositoryAdmin.transfer(
        repository,
        current.user.id,
        body.ownerType === 'group' ? 'group' : 'user',
        body.ownerSlug ?? '',
      );
    } else if (body.action === 'delete') {
      if (body.confirmation !== repository.slug)
        throw new runtime.ValidationError('Repository confirmation did not match');
      await repositoryAdmin.delete(repository, current.user.id);
      return await reply.redirect('/');
    } else throw new runtime.ValidationError('Invalid repository settings action');
    search.enqueue(updated.id);
    return await reply.redirect(`/${updated.ownerSlug}/${updated.slug}/settings`);
  });
}
