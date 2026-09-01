import type { AppRouteContext } from './route-context.js';
import * as runtime from './route-runtime.js';

// Repository release routes: tagged release notes with downloadable assets.
export function registerReleaseHtmlRoutes(context: AppRouteContext): void {
  const {
    app,
    config,
    auth,
    repositories,
    releases,
    render,
    readableRepository,
    writableRepository,
  } = context;

  app.get('/:owner/:repository/releases', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const canWrite =
      current !== null &&
      !['none', 'read'].includes(repositories.permission(repository, current.user.id));
    return reply.type('text/html').send(
      await render('releases', {
        user: current?.user ?? null,
        repository,
        releaseList: releases.list(repository.id),
        canWrite,
      }),
    );
  });

  app.get('/:owner/:repository/releases/new', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const query = request.query as { ref?: string };
    return reply.type('text/html').send(
      await render('release-new', {
        user: current.user,
        csrf: current.csrfToken,
        repository,
        ref: query.ref ?? repository.defaultBranch,
      }),
    );
  });

  app.post('/:owner/:repository/releases', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    try {
      const release = await releases.create({
        repository,
        actorUserId: current.user.id,
        tagName: body.tagName ?? '',
        name: body.name ?? '',
        body: body.body ?? '',
        ...(body.ref ? { ref: body.ref } : {}),
      });
      return await reply.redirect(
        `/${repository.ownerSlug}/${repository.slug}/releases/${encodeURIComponent(release.tagName)}`,
      );
    } catch (error) {
      return reply
        .code((error as { statusCode?: number }).statusCode ?? 400)
        .type('text/html')
        .send(
          await render('release-new', {
            user: current.user,
            csrf: current.csrfToken,
            repository,
            ref: body.ref ?? repository.defaultBranch,
            error: runtime.safeErrorMessage(error),
          }),
        );
    }
  });

  app.get('/:owner/:repository/releases/:tag', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const parameters = request.params as { tag: string };
    const release = releases.get(repository.id, parameters.tag);
    if (!release) throw new runtime.NotFoundError();
    const canWrite =
      current !== null &&
      !['none', 'read'].includes(repositories.permission(repository, current.user.id));
    return reply.type('text/html').send(
      await render('release', {
        user: current?.user ?? null,
        csrf: current?.csrfToken ?? '',
        repository,
        release,
        renderedBody: release.body ? runtime.renderMarkdown(release.body) : '',
        canWrite,
      }),
    );
  });

  app.post('/:owner/:repository/releases/:tag/assets', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const parameters = request.params as { tag: string };
    const fields = new Map<string, string>();
    let upload: { filename: string; content: Buffer } | null = null;
    let totalBytes = 0;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (!part.filename || /[/\\\0]/.test(part.filename))
          throw new runtime.ValidationError('Invalid uploaded filename');
        const content = await part.toBuffer();
        totalBytes += content.length;
        if (totalBytes > config.limits.requestBodyBytes) throw new runtime.PayloadTooLargeError();
        upload = { filename: part.filename, content };
      } else if (typeof part.value === 'string') fields.set(part.fieldname, part.value);
    }
    auth.verifyCsrf(current.csrfToken, fields.get('csrf'));
    if (!upload) throw new runtime.ValidationError('Choose a file to upload');
    await releases.addAsset({
      repository,
      actorUserId: current.user.id,
      tagName: parameters.tag,
      filename: upload.filename,
      contentType: 'application/octet-stream',
      content: upload.content,
    });
    return await reply.redirect(
      `/${repository.ownerSlug}/${repository.slug}/releases/${encodeURIComponent(parameters.tag)}`,
    );
  });

  app.get('/:owner/:repository/releases/:tag/assets/:assetId', async (request, reply) => {
    const { repository } = readableRepository(request);
    const parameters = request.params as { tag: string; assetId: string };
    const assetId = Number.parseInt(parameters.assetId, 10);
    if (!Number.isSafeInteger(assetId)) throw new runtime.NotFoundError();
    const asset = await releases.readAsset(repository, assetId);
    reply.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
    );
    reply.header('Cache-Control', 'private, no-store');
    return reply.type(asset.contentType).send(asset.content);
  });

  app.post('/:owner/:repository/releases/:tag/delete', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const parameters = request.params as { tag: string };
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    await releases.delete(repository, current.user.id, parameters.tag);
    return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}/releases`);
  });
}
