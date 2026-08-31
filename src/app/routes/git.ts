import type { AppRouteContext } from './route-context.js';
import * as runtime from './route-runtime.js';

export function registerGitRoutes(context: AppRouteContext): void {
  const {
    app,
    config,
    repositories,
    browser,
    enhancements,
    search,
    lfs,
    pluginEvents,
    session,
    gitPrincipal,
    gitAuthenticationRequired,
    lfsRepository,
  } = context;
  app.post('/:owner/:repository.git/info/lfs/objects/batch', async (request, reply) => {
    const body = request.body as { operation?: string; objects?: unknown[] };
    const operation =
      body.operation === 'upload' ? 'upload' : body.operation === 'download' ? 'download' : null;
    if (!operation || !Array.isArray(body.objects))
      throw new runtime.ValidationError('Invalid LFS batch request');
    const { repository } = lfsRepository(request, operation === 'upload' ? 'write' : 'read');
    if (operation === 'upload' && repository.archivedAt)
      return reply.code(403).send({ message: 'Archived repositories are read-only.' });
    const objects: runtime.LfsBatchObject[] = body.objects.map((value) => {
      if (typeof value !== 'object' || value === null)
        throw new runtime.ValidationError('Invalid LFS object');
      const candidate = value as { oid?: unknown; size?: unknown };
      if (typeof candidate.oid !== 'string' || typeof candidate.size !== 'number') {
        throw new runtime.ValidationError('Invalid LFS object');
      }
      return { oid: candidate.oid, size: candidate.size };
    });
    return reply
      .type('application/vnd.git-lfs+json')
      .send({ transfer: 'basic', objects: lfs.prepareBatch(repository, operation, objects) });
  });

  app.put('/:owner/:repository.git/info/lfs/objects/:objectId', async (request, reply) => {
    const { repository } = lfsRepository(request, 'write');
    if (repository.archivedAt)
      return reply.code(403).send({ message: 'Archived repositories are read-only.' });
    const parameters = request.params as { objectId: string };
    await lfs.upload(
      repository,
      parameters.objectId,
      request.body as NodeJS.ReadableStream as import('node:stream').Readable,
    );
    return reply.code(200).send();
  });

  app.get('/:owner/:repository.git/info/lfs/objects/:objectId', async (request, reply) => {
    const { repository } = lfsRepository(request, 'read');
    const parameters = request.params as { objectId: string };
    const object = await lfs.download(repository, parameters.objectId);
    return reply
      .header('Content-Length', String(object.size))
      .header(
        'Cache-Control',
        repository.visibility === 'public'
          ? 'public, max-age=31536000, immutable'
          : 'private, no-store',
      )
      .type('application/octet-stream')
      .send(object.stream);
  });

  app.get('/:owner/:repository/commits.atom', async (request, reply) => {
    const parameters = request.params as { owner: string; repository: string };
    const repository = repositories.find(parameters.owner, parameters.repository);
    if (!repository) throw new runtime.NotFoundError();
    const browserSession = session(request);
    const tokenPrincipal = gitPrincipal(request, 'repository:read');
    const userId = browserSession?.user.id ?? tokenPrincipal?.userId ?? null;
    repositories.require(repository, userId, 'read');
    const commits = await browser.commits(repository, repository.defaultBranch, 1, 30);
    return reply
      .type('application/atom+xml; charset=utf-8')
      .header(
        'Cache-Control',
        repository.visibility === 'public' ? 'public, max-age=60' : 'private, no-store',
      )
      .send(runtime.atomFeed({ repository, commits, publicUrl: config.server.publicUrl }));
  });

  app.get('/:owner/:repository.git/info/refs', async (request, reply) => {
    const parameters = request.params as { owner: string; repository: string };
    const query = request.query as { service?: string };
    const repository = repositories.find(parameters.owner, parameters.repository);
    if (!repository) return gitAuthenticationRequired(reply);
    const write = query.service === 'git-receive-pack';
    const principal = gitPrincipal(request, write ? 'repository:write' : 'repository:read');
    const permission = repositories.permission(repository, principal?.userId ?? null);
    const levels = { none: 0, read: 1, write: 2, admin: 3, owner: 4 };
    if (levels[permission] < (write ? 2 : 1)) return gitAuthenticationRequired(reply);
    if (write && repository.storageKind === 'working_tree')
      return reply.code(403).send('Working-tree repositories are browse-only.');
    if (write && repository.archivedAt)
      return reply.code(403).send('Archived repositories are read-only.');
    if (write) enhancements.assertTransportWritable(repository.id);
    await runtime.serveSmartHttp(
      config,
      await repositories.storagePath(repository),
      {
        method: 'GET',
        pathSuffix: 'info/refs',
        ...(query.service ? { queryService: query.service } : {}),
        ...(principal ? { authenticatedUserId: principal.userId } : {}),
      },
      reply,
    );
  });

  app.post('/:owner/:repository.git/:service', async (request, reply) => {
    const parameters = request.params as { owner: string; repository: string; service: string };
    if (!['git-upload-pack', 'git-receive-pack'].includes(parameters.service))
      throw new runtime.NotFoundError();
    const repository = repositories.find(parameters.owner, parameters.repository);
    if (!repository) return gitAuthenticationRequired(reply);
    const write = parameters.service === 'git-receive-pack';
    const principal = gitPrincipal(request, write ? 'repository:write' : 'repository:read');
    const permission = repositories.permission(repository, principal?.userId ?? null);
    const levels = { none: 0, read: 1, write: 2, admin: 3, owner: 4 };
    if (levels[permission] < (write ? 2 : 1)) return gitAuthenticationRequired(reply);
    if (write && repository.storageKind === 'working_tree')
      return reply.code(403).send('Working-tree repositories are browse-only.');
    if (write && repository.archivedAt)
      return reply.code(403).send('Archived repositories are read-only.');
    if (write) enhancements.assertTransportWritable(repository.id);
    await runtime.serveSmartHttp(
      config,
      await repositories.storagePath(repository),
      {
        method: 'POST',
        pathSuffix: parameters.service,
        ...(request.headers['content-type']
          ? { contentType: request.headers['content-type'] }
          : {}),
        ...(request.headers['content-length']
          ? { contentLength: request.headers['content-length'] }
          : {}),
        body: request.body as NodeJS.ReadableStream as import('node:stream').Readable,
        ...(principal ? { authenticatedUserId: principal.userId } : {}),
      },
      reply,
    );
    if (write) {
      search.enqueue(repository.id);
      enhancements.recordActivity(repository.id, principal?.userId ?? null, 'repository.pushed');
      pluginEvents.publish('repository.pushed', {
        repositoryId: repository.id,
        owner: repository.ownerSlug,
        repository: repository.slug,
        visibility: repository.visibility,
      });
    }
  });
}
