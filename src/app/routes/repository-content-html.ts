import type { AppRouteContext } from './route-context.js';
import * as routeHelpers from './route-helpers.js';
import * as runtime from './route-runtime.js';

// Browser file editing, browsing, history, comparison, and archive routes.
export function registerRepositoryContentHtmlRoutes(context: AppRouteContext): void {
  const {
    app,
    config,
    auth,
    repositories,
    browser,
    referenceOptions,
    archives,
    enhancements,
    mutations,
    lfs,
    pluginContributions,
    render,
    readableRepository,
    writableRepository,
    withAuthorAvatar,
  } = context;
  app.get('/:owner/:repository/files/new', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const query = request.query as { ref?: string; path?: string };
    return reply.type('text/html').send(
      await render('edit-file', {
        user: current.user,
        repository,
        csrf: current.csrfToken,
        exists: false,
        path: query.path ?? '',
        ref: query.ref ?? repository.defaultBranch,
        content: '',
      }),
    );
  });

  app.get('/:owner/:repository/files/upload', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const query = request.query as { ref?: string; path?: string };
    return reply.type('text/html').send(
      await render('upload-files', {
        user: current.user,
        repository,
        csrf: current.csrfToken,
        ref: query.ref ?? repository.defaultBranch,
        path: query.path ?? '',
      }),
    );
  });

  app.post('/:owner/:repository/files/upload', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const fields = new Map<string, string>();
    const uploads: { filename: string; content: Buffer }[] = [];
    let totalBytes = 0;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (!part.filename || /[/\\\0]/.test(part.filename))
          throw new runtime.ValidationError('Invalid uploaded filename');
        const content = await part.toBuffer();
        totalBytes += content.length;
        if (totalBytes > config.limits.requestBodyBytes) throw new runtime.PayloadTooLargeError();
        uploads.push({ filename: part.filename, content });
      } else if (typeof part.value === 'string') fields.set(part.fieldname, part.value);
    }
    auth.verifyCsrf(current.csrfToken, fields.get('csrf'));
    const directory = fields.get('path')?.replace(/^\/+|\/+$/g, '') ?? '';
    await mutations.commitFiles({
      repository,
      actorUserId: current.user.id,
      branch: fields.get('ref') ?? repository.defaultBranch,
      files: uploads.map((upload) => ({
        path: directory ? `${directory}/${upload.filename}` : upload.filename,
        content: upload.content,
      })),
      message: fields.get('message') ?? '',
    });
    const destination = directory
      ? `/${repository.ownerSlug}/${repository.slug}/tree/${directory.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(fields.get('ref') ?? repository.defaultBranch)}`
      : `/${repository.ownerSlug}/${repository.slug}`;
    return await reply.redirect(destination);
  });

  app.post('/:owner/:repository/files/new', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const path = body.path ?? '';
    const branch = body.branch ?? repository.defaultBranch;
    await mutations.commitFile({
      repository,
      actorUserId: current.user.id,
      branch,
      filePath: path,
      content: Buffer.from(body.content ?? '', 'utf8'),
      message: body.message ?? '',
    });
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    return await reply.redirect(
      `/${repository.ownerSlug}/${repository.slug}/blob/${encodedPath}?ref=${encodeURIComponent(branch)}`,
    );
  });

  app.get('/:owner/:repository/edit/*', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const parameters = request.params as { '*': string };
    const query = request.query as { ref?: string };
    const ref = query.ref ?? repository.defaultBranch;
    const content = await repositories.readBlob(repository, ref, parameters['*']);
    if (runtime.isBinary(content))
      throw new runtime.ValidationError('Binary files cannot be edited in the browser');
    return reply.type('text/html').send(
      await render('edit-file', {
        user: current.user,
        repository,
        csrf: current.csrfToken,
        exists: true,
        path: parameters['*'],
        ref,
        content: content.toString('utf8'),
      }),
    );
  });

  app.post('/:owner/:repository/edit/*', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const parameters = request.params as { '*': string };
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const branch = body.branch ?? repository.defaultBranch;
    const deleting = body.action === 'delete';
    const requestedPath = body.path ?? parameters['*'];
    if (!deleting && requestedPath !== parameters['*']) {
      await mutations.commitFiles({
        repository,
        actorUserId: current.user.id,
        branch,
        files: [
          { path: parameters['*'] },
          { path: requestedPath, content: Buffer.from(body.content ?? '', 'utf8') },
        ],
        message: body.message ?? '',
      });
    } else
      await mutations.commitFile({
        repository,
        actorUserId: current.user.id,
        branch,
        filePath: parameters['*'],
        ...(deleting ? {} : { content: Buffer.from(body.content ?? '', 'utf8') }),
        message: body.message ?? '',
      });
    if (deleting) {
      return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}`);
    }
    const encodedPath = requestedPath.split('/').map(encodeURIComponent).join('/');
    return await reply.redirect(
      `/${repository.ownerSlug}/${repository.slug}/blob/${encodedPath}?ref=${encodeURIComponent(branch)}`,
    );
  });

  app.get('/:owner/:repository/tree/*', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const parameters = request.params as { '*': string };
    const query = request.query as { ref?: string };
    const directory = parameters['*'];
    const ref = query.ref ?? repository.defaultBranch;
    const submodules = await repositories.submoduleUrls(repository, ref);
    const entries = (await repositories.listTree(repository, ref, directory)).map((entry) =>
      routeHelpers.presentTreeEntry(entry, submodules),
    );
    return reply.type('text/html').send(
      await render('tree', {
        user: current?.user ?? null,
        repository,
        entries,
        ref,
        ...(await referenceOptions(repository)),
        breadcrumbs: runtime.breadcrumbs(directory),
      }),
    );
  });

  app.get('/:owner/:repository/blob/*', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const parameters = request.params as { '*': string };
    const query = request.query as { ref?: string; large?: string };
    const path = parameters['*'];
    const ref = query.ref ?? repository.defaultBranch;
    let content: Buffer;
    try {
      content = await repositories.readBlob(repository, ref, path, {
        allowLarge: query.large === '1',
      });
    } catch (error) {
      if (!(error instanceof runtime.PayloadTooLargeError)) throw error;
      return reply.type('text/html').send(
        await render('blob', {
          user: current?.user ?? null,
          repository,
          ref,
          path,
          encodedPath: path.split('/').map(encodeURIComponent).join('/'),
          breadcrumbs: runtime.breadcrumbs(path),
          size: error.bytes,
          kind: 'too-large',
          canLoadLarge:
            query.large !== '1' &&
            error.bytes !== null &&
            error.bytes <= config.limits.gitOutputBytes,
          ...(await referenceOptions(repository)),
          pluginRenderers: [],
          canWrite: false,
          canAdmin: false,
        }),
      );
    }
    const binary = runtime.isBinary(content);
    const markdown = !binary && runtime.isMarkdown(path);
    const image = runtime.isSafeImage(path);
    const lfsPointer = runtime.parseLfsPointer(content);
    return reply.type('text/html').send(
      await render('blob', {
        user: current?.user ?? null,
        repository,
        ref,
        path,
        encodedPath: path.split('/').map(encodeURIComponent).join('/'),
        breadcrumbs: runtime.breadcrumbs(path),
        size: content.length,
        ...(await referenceOptions(repository)),
        imageMetadata: image ? runtime.imageMetadata(content, path) : null,
        kind: lfsPointer
          ? 'lfs'
          : markdown
            ? 'markdown'
            : image
              ? 'image'
              : binary
                ? 'binary'
                : 'text',
        lfsPointer,
        lfsAvailable: lfsPointer ? lfs.isAvailable(repository.id, lfsPointer.objectId) : false,
        rendered: markdown
          ? runtime.renderMarkdown(
              await pluginContributions.transformMarkdown(
                repository,
                current?.user.id ?? null,
                ref,
                path,
                content.toString('utf8'),
              ),
            )
          : '',
        lines: !binary && !markdown ? runtime.highlightSource(content.toString('utf8'), path) : [],
        pluginRenderers: pluginContributions.fileRenderers(
          repository,
          current?.user.id ?? null,
          path,
        ),
        canWrite:
          current !== null &&
          !['none', 'read'].includes(repositories.permission(repository, current.user.id)),
        canAdmin:
          current !== null &&
          ['admin', 'owner'].includes(repositories.permission(repository, current.user.id)),
        csrf: current?.csrfToken ?? '',
        pinned: current ? enhancements.pinnedIds(current.user.id).includes(repository.id) : false,
      }),
    );
  });

  app.get('/:owner/:repository/raw/*', async (request, reply) => {
    const { repository } = readableRepository(request);
    const parameters = request.params as { '*': string };
    const query = request.query as { ref?: string; download?: string };
    const path = parameters['*'];
    const ref = query.ref ?? repository.defaultBranch;
    const content = await repositories.readBlob(repository, ref, path, { allowLarge: true });
    const filename = path.split('/').at(-1) ?? 'download';
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header(
      'Cache-Control',
      repository.visibility === 'public' ? 'public, max-age=60' : 'private, no-store',
    );
    if (query.download === '1' || (runtime.isBinary(content) && !runtime.isSafeImage(path))) {
      reply.header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
    }
    return reply.type(runtime.safeInlineMime(path)).send(content);
  });

  app.get('/:owner/:repository/commits', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const query = request.query as { page?: string; ref?: string };
    const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
    const ref = query.ref ?? repository.defaultBranch;
    const commits = (await browser.commits(repository, ref, page)).map((commit) => ({
      ...withAuthorAvatar(commit),
      relativeDate: routeHelpers.relativeDate(commit.authoredAt),
    }));
    return reply.type('text/html').send(
      await render('commits', {
        user: current?.user ?? null,
        repository,
        commits,
        ref,
        page,
        ...(await referenceOptions(repository)),
      }),
    );
  });

  app.get('/:owner/:repository/history/*', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const parameters = request.params as { '*': string };
    const query = request.query as { page?: string; ref?: string };
    const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
    const ref = query.ref ?? repository.defaultBranch;
    const path = parameters['*'];
    const commits = (await browser.fileHistory(repository, ref, path, page)).map((commit) => ({
      ...withAuthorAvatar(commit),
      relativeDate: routeHelpers.relativeDate(commit.authoredAt),
    }));
    return reply.type('text/html').send(
      await render('file-history', {
        user: current?.user ?? null,
        repository,
        path,
        encodedPath: path.split('/').map(encodeURIComponent).join('/'),
        commits,
        ref,
        page,
        ...(await referenceOptions(repository)),
      }),
    );
  });

  app.get('/:owner/:repository/commit/:objectId', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const parameters = request.params as { objectId: string };
    const commit = withAuthorAvatar(
      await browser.commit(repository, parameters.objectId, {
        lineLimit: Math.min(2500, config.limits.diffLines),
        byteLimit: Math.min(2 * 1024 * 1024, config.limits.diffBytes),
      }),
    );
    const trustedIdentity = enhancements.trustedIdentity(commit.signature.fingerprint);
    if (trustedIdentity && commit.signature.state === 'valid') {
      commit.signature.identityTrusted = true;
      commit.signature.label = `Valid signature · trusted as ${trustedIdentity}`;
    }
    const diffFiles = [];
    for (const [index, file] of commit.diffFiles.entries()) {
      if (
        index >= 20 ||
        !file.binary ||
        (!runtime.isSafeImage(file.oldPath) && !runtime.isSafeImage(file.newPath))
      ) {
        diffFiles.push(file);
        continue;
      }
      const oldRef = commit.parents[0];
      const oldContent = oldRef
        ? await repositories.readBlob(repository, oldRef, file.oldPath).catch((error: unknown) => {
            if (error instanceof runtime.NotFoundError) return null;
            throw error;
          })
        : null;
      const newContent = await repositories
        .readBlob(repository, commit.objectId, file.newPath)
        .catch((error: unknown) => {
          if (error instanceof runtime.NotFoundError) return null;
          throw error;
        });
      diffFiles.push({
        ...file,
        imageDiff: {
          old:
            oldContent && oldRef
              ? routeHelpers.imageDiffSide(file.oldPath, oldRef, oldContent)
              : null,
          new: newContent
            ? routeHelpers.imageDiffSide(file.newPath, commit.objectId, newContent)
            : null,
        },
      });
    }
    const canWrite =
      current !== null &&
      !['none', 'read'].includes(repositories.permission(repository, current.user.id));
    return reply.type('text/html').send(
      await render('commit', {
        user: current?.user ?? null,
        repository,
        commit: { ...commit, diffFiles },
        csrf: current?.csrfToken ?? '',
        canWrite,
        branches: canWrite ? await browser.branches(repository) : [],
      }),
    );
  });

  app.get('/:owner/:repository/commit/:objectId/patch', async (request, reply) => {
    const { repository } = readableRepository(request);
    const parameters = request.params as { objectId: string };
    const content = await browser.commitPatch(repository, parameters.objectId);
    const filename = `${parameters.objectId.slice(0, 12)}.patch`;
    reply.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    reply.header('Cache-Control', 'private, no-store');
    return reply.type('text/plain; charset=utf-8').send(content);
  });

  app.get(
    '/api/v1/repositories/:owner/:repository/commits/:objectId/diff',
    {
      schema: routeHelpers.apiContract('commits', {
        authenticated: false,
        params: {
          type: 'object',
          required: ['owner', 'repository', 'objectId'],
          properties: {
            owner: { type: 'string' },
            repository: { type: 'string' },
            objectId: { type: 'string' },
          },
        },
        query: {
          type: 'object',
          properties: {
            lines: { type: 'integer', minimum: 1 },
            full: { type: 'string', enum: ['1'] },
          },
        },
        response: runtime.progressiveDiffResponse,
      }),
    },
    async (request, reply) => {
      const { repository } = readableRepository(request);
      const parameters = request.params as { objectId: string };
      const query = request.query as { lines?: string; full?: string };
      const requested = Number.parseInt(query.lines ?? '5000', 10);
      const lineLimit =
        query.full === '1'
          ? config.limits.diffLines
          : Math.min(
              Math.max(Number.isFinite(requested) ? requested : 5000, 1),
              config.limits.diffLines,
            );
      const commit = await browser.commit(repository, parameters.objectId, {
        lineLimit,
        byteLimit: config.limits.diffBytes,
      });
      return reply.send({
        diff: commit.diff,
        additions: commit.additions,
        deletions: commit.deletions,
        filesChanged: commit.filesChanged,
        truncated: commit.truncated,
        shownLines: commit.diff.split('\n').length,
        hardLineLimit: config.limits.diffLines,
        hardFileLimit: config.limits.diffFiles,
        hardFileByteLimit: config.limits.diffFileBytes,
        files: commit.diffFiles,
      });
    },
  );

  app.get('/:owner/:repository/branches', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const refs = (await browser.branches(repository)).map((ref) => ({
      ...ref,
      relativeDate: routeHelpers.relativeDate(ref.committedAt),
    }));
    const canWrite =
      current !== null &&
      !['none', 'read'].includes(repositories.permission(repository, current.user.id));
    return reply.type('text/html').send(
      await render('refs', {
        user: current?.user ?? null,
        repository,
        refs,
        kind: 'Branches',
        canWrite,
        csrf: current?.csrfToken ?? '',
      }),
    );
  });

  app.post('/:owner/:repository/branches', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    await mutations.createBranch(
      repository,
      current.user.id,
      body.name ?? '',
      body.source ?? repository.defaultBranch,
    );
    return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}/branches`);
  });

  app.post('/:owner/:repository/branches/delete', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    await mutations.deleteBranch(repository, current.user.id, body.name ?? '');
    return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}/branches`);
  });

  app.get('/:owner/:repository/tags', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const refs = (await browser.tags(repository)).map((ref) => {
      const trustedIdentity = enhancements.trustedIdentity(ref.signature?.fingerprint);
      return {
        ...ref,
        ...(ref.signature && trustedIdentity
          ? {
              signature: {
                ...ref.signature,
                identityTrusted: ref.signature.state === 'valid',
                label:
                  ref.signature.state === 'valid'
                    ? `Valid signature · trusted as ${trustedIdentity}`
                    : ref.signature.label,
              },
            }
          : {}),
        relativeDate: routeHelpers.relativeDate(ref.committedAt),
      };
    });
    const canWrite =
      current !== null &&
      !['none', 'read'].includes(repositories.permission(repository, current.user.id));
    return reply.type('text/html').send(
      await render('refs', {
        user: current?.user ?? null,
        repository,
        refs,
        kind: 'Tags',
        canWrite,
        csrf: current?.csrfToken ?? '',
      }),
    );
  });

  app.post('/:owner/:repository/tags', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    await mutations.createTag(
      repository,
      current.user.id,
      body.name ?? '',
      body.source ?? repository.defaultBranch,
    );
    return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}/tags`);
  });

  app.post('/:owner/:repository/tags/delete', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    await mutations.deleteTag(repository, current.user.id, body.name ?? '');
    return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}/tags`);
  });

  app.get('/:owner/:repository/compare', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const query = request.query as { base?: string; head?: string };
    const baseInput = query.base ?? repository.defaultBranch;
    const headInput = query.head ?? repository.defaultBranch;
    const comparison = await browser.compare(repository, baseInput, headInput);
    return reply.type('text/html').send(
      await render('compare', {
        user: current?.user ?? null,
        repository,
        comparison,
        baseInput,
        headInput,
        canWrite:
          current !== null &&
          !['none', 'read'].includes(repositories.permission(repository, current.user.id)),
      }),
    );
  });

  app.get('/:owner/:repository/compare/patch', async (request, reply) => {
    const { repository } = readableRepository(request);
    const query = request.query as { base?: string; head?: string };
    const baseInput = query.base ?? repository.defaultBranch;
    const headInput = query.head ?? repository.defaultBranch;
    const content = await browser.comparePatch(repository, baseInput, headInput);
    const filename = `${repository.slug}-${baseInput.replaceAll('/', '-')}-${headInput.replaceAll('/', '-')}.patch`;
    reply.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    reply.header('Cache-Control', 'private, no-store');
    return reply.type('text/plain; charset=utf-8').send(content);
  });

  app.get('/:owner/:repository/patches', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const query = request.query as { ref?: string };
    const canWrite =
      current !== null &&
      !['none', 'read'].includes(repositories.permission(repository, current.user.id));
    return reply.type('text/html').send(
      await render('patches', {
        user: current?.user ?? null,
        repository,
        csrf: current?.csrfToken ?? '',
        branch: query.ref ?? repository.defaultBranch,
        canWrite,
        ...(await referenceOptions(repository)),
      }),
    );
  });

  app.post('/:owner/:repository/patches/preview', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const fields = new Map<string, string>();
    let uploadedContent: Buffer | null = null;
    let totalBytes = 0;
    const trackBytes = (bytes: number): void => {
      totalBytes += bytes;
      if (totalBytes > config.limits.requestBodyBytes) throw new runtime.PayloadTooLargeError();
    };
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        const content = await part.toBuffer();
        trackBytes(content.length);
        if (content.length > 0) uploadedContent = content;
      } else if (typeof part.value === 'string') {
        trackBytes(Buffer.byteLength(part.value, 'utf8'));
        fields.set(part.fieldname, part.value);
      }
    }
    auth.verifyCsrf(current.csrfToken, fields.get('csrf'));
    const branch = fields.get('branch') ?? repository.defaultBranch;
    const patchContent = uploadedContent ?? Buffer.from(fields.get('patch') ?? '', 'utf8');
    if (patchContent.length < 1)
      throw new runtime.ValidationError('Provide a patch file or paste patch text to preview');
    const preview = await mutations.previewPatch({
      repository,
      actorUserId: current.user.id,
      branch,
      patchContent,
    });
    return reply.type('text/html').send(
      await render('patch-preview', {
        user: current.user,
        repository,
        csrf: current.csrfToken,
        branch,
        patch: patchContent.toString('utf8'),
        preview,
      }),
    );
  });

  app.post('/:owner/:repository/patches/import', async (request, reply) => {
    const { repository, current } = writableRepository(request);
    const body = request.body as runtime.FormBody;
    auth.verifyCsrf(current.csrfToken, body.csrf);
    const branch = body.branch ?? repository.defaultBranch;
    const commitId = await mutations.importPatch({
      repository,
      actorUserId: current.user.id,
      branch,
      patchContent: Buffer.from(body.patch ?? '', 'utf8'),
      fallbackMessage: body.message ?? '',
    });
    return await reply.redirect(`/${repository.ownerSlug}/${repository.slug}/commit/${commitId}`);
  });

  app.get('/:owner/:repository/insights', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const query = request.query as { ref?: string };
    const ref = query.ref ?? repository.defaultBranch;
    const [languages, contributors] = await Promise.all([
      browser.languageStats(repository, ref),
      browser.contributors(repository, ref),
    ]);
    return reply.type('text/html').send(
      await render('insights', {
        user: current?.user ?? null,
        repository,
        ref,
        languages,
        contributors,
        forkCount: repositories.countForks(repository.id),
        ...(await referenceOptions(repository)),
      }),
    );
  });

  app.get('/:owner/:repository/blame/*', async (request, reply) => {
    const { repository, current } = readableRepository(request);
    const parameters = request.params as { '*': string };
    const query = request.query as { ref?: string };
    const ref = query.ref ?? repository.defaultBranch;
    const lines = await browser.blame(repository, ref, parameters['*']);
    return reply.type('text/html').send(
      await render('blame', {
        user: current?.user ?? null,
        repository,
        lines,
        ref,
        path: parameters['*'],
      }),
    );
  });

  app.get('/:owner/:repository/archive', async (request, reply) => {
    const { repository } = readableRepository(request);
    const query = request.query as { ref?: string; format?: string };
    const format = query.format === 'tar.gz' ? 'tar.gz' : query.format === 'zip' ? 'zip' : null;
    if (!format) throw new runtime.ValidationError('Archive format must be zip or tar.gz');
    const ref = query.ref ?? repository.defaultBranch;
    const archive = await archives.create(repository, ref, format);
    const filename = `${repository.slug}-${archive.objectId.slice(0, 8)}.${archive.extension}`;
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header('Cache-Control', 'private, no-store');
    return reply.type(archive.contentType).send(archive.stream);
  });
}
