import type { AppRouteContext } from './route-context.js';
import * as routeHelpers from './route-helpers.js';
import * as runtime from './route-runtime.js';

export function registerPluginsRoutes(context: AppRouteContext): void {
  const {
    app,
    config,
    repositories,
    enhancements,
    browser,
    referenceOptions,
    pluginManager,
    pluginContributions,
    render,
    session,
    requireSession,
    requireAdministrator,
    withAuthorAvatar,
  } = context;
  app.get('/plugins/:pluginId/commands/:commandId', async (request, reply) => {
    const current = requireSession(request);
    const parameters = request.params as { pluginId: string; commandId: string };
    const contribution = await pluginContributions.runCommand(
      parameters.pluginId,
      parameters.commandId,
      { id: current.user.id, username: current.user.username },
    );
    return reply.type('text/html').send(
      await render('plugin-contribution', {
        user: current.user,
        contribution,
        pluginName: pluginManager.get(parameters.pluginId).name,
        repository: null,
      }),
    );
  });

  app.get('/admin/plugins/:pluginId/pages/:pageId', async (request, reply) => {
    const current = requireAdministrator(request);
    const parameters = request.params as { pluginId: string; pageId: string };
    const contribution = await pluginContributions.renderAdminPage(
      parameters.pluginId,
      parameters.pageId,
      current.user,
    );
    return reply.type('text/html').send(
      await render('plugin-contribution', {
        user: current.user,
        contribution,
        pluginName: pluginManager.get(parameters.pluginId).name,
        repository: null,
      }),
    );
  });

  app.get(
    '/:owner/:repository/plugins/:pluginId/renderers/:rendererId/*',
    async (request, reply) => {
      const parameters = request.params as {
        owner: string;
        repository: string;
        pluginId: string;
        rendererId: string;
        '*': string;
      };
      const repository = repositories.find(parameters.owner, parameters.repository);
      if (!repository) throw new runtime.NotFoundError();
      const current = session(request);
      const ref = (request.query as { ref?: string }).ref ?? repository.defaultBranch;
      const contribution = await pluginContributions.renderFile(
        repository,
        current?.user.id ?? null,
        parameters.pluginId,
        parameters.rendererId,
        ref,
        parameters['*'],
        await repositories.readBlob(repository, ref, parameters['*']),
      );
      return reply.type('text/html').send(
        await render('plugin-contribution', {
          user: current?.user ?? null,
          contribution,
          pluginName: pluginManager.get(parameters.pluginId).name,
          repository,
        }),
      );
    },
  );

  app.get('/:owner/:repository/plugins/:pluginId/:tabId', async (request, reply) => {
    const parameters = request.params as {
      owner: string;
      repository: string;
      pluginId: string;
      tabId: string;
    };
    const repository = repositories.find(parameters.owner, parameters.repository);
    if (!repository) throw new runtime.NotFoundError();
    const current = session(request);
    const contribution = await pluginContributions.renderRepositoryTab(
      repository,
      current?.user.id ?? null,
      parameters.pluginId,
      parameters.tabId,
    );
    return reply.type('text/html').send(
      await render('plugin-contribution', {
        user: current?.user ?? null,
        contribution,
        pluginName: pluginManager.get(parameters.pluginId).name,
        repository,
      }),
    );
  });

  app.get('/:owner/:repository', async (request, reply) => {
    const parameters = request.params as { owner: string; repository: string };
    const repository = repositories.find(parameters.owner, parameters.repository);
    if (!repository) throw new runtime.NotFoundError();
    const current = session(request);
    repositories.require(repository, current?.user.id ?? null, 'read');
    const query = request.query as { ref?: string };
    const ref = query.ref ?? repository.defaultBranch;
    let entries: Awaited<ReturnType<runtime.RepositoryService['listTree']>> = [];
    let readme: string | null = null;
    let renderedReadme: string | null = null;
    let readmeTooLarge = false;
    let latestCommit: (ReturnType<typeof withAuthorAvatar> & { relativeDate: string }) | null =
      null;
    let empty = false;
    try {
      entries = await repositories.listTree(repository, ref);
      const submodules = await repositories.submoduleUrls(repository, ref);
      entries = entries.map((entry) => routeHelpers.presentTreeEntry(entry, submodules));
      const readmeEntry = entries.find(
        (entry) => /^readme(?:\.md)?$/i.test(entry.name) && entry.type === 'blob',
      );
      if (readmeEntry) {
        try {
          readme = (await repositories.readBlob(repository, ref, readmeEntry.name)).toString(
            'utf8',
          );
          if (runtime.isMarkdown(readmeEntry.name)) {
            renderedReadme = runtime.renderMarkdown(
              await pluginContributions.transformMarkdown(
                repository,
                current?.user.id ?? null,
                ref,
                readmeEntry.name,
                readme,
              ),
            );
          }
        } catch (error) {
          if (error instanceof runtime.PayloadTooLargeError) readmeTooLarge = true;
          else throw error;
        }
      }
      const newest = (await browser.commits(repository, ref, 1, 1))[0];
      if (newest)
        latestCommit = {
          ...withAuthorAvatar(newest),
          relativeDate: routeHelpers.relativeDate(newest.authoredAt),
        };
    } catch (error) {
      if (
        error instanceof runtime.GitError &&
        /unknown revision|Needed a single revision|ambiguous argument/.test(error.message)
      )
        empty = true;
      else throw error;
    }
    const httpsCloneUrl = `${config.server.publicUrl.replace(/\/$/, '')}/${repository.ownerSlug}/${repository.slug}.git`;
    const sshCloneUrl = config.ssh.enabled
      ? `git@${config.ssh.host}:${repository.ownerSlug}/${repository.slug}.git`
      : null;
    let forkParent: { ownerSlug: string; slug: string } | null = null;
    if (repository.forkedFromId) {
      try {
        const parent = repositories.getById(repository.forkedFromId);
        if (repositories.permission(parent, current?.user.id ?? null) !== 'none')
          forkParent = { ownerSlug: parent.ownerSlug, slug: parent.slug };
      } catch (error) {
        if (!(error instanceof runtime.NotFoundError)) throw error;
      }
    }
    return reply.type('text/html').send(
      await render('repository', {
        user: current?.user ?? null,
        repository,
        entries,
        ref,
        readme,
        renderedReadme,
        readmeTooLarge,
        latestCommit,
        empty,
        cloneUrl: httpsCloneUrl,
        httpsCloneUrl,
        sshCloneUrl,
        ...(await referenceOptions(repository)),
        pluginTabs: pluginContributions.repositoryTabs(repository, current?.user.id ?? null),
        canWrite:
          current !== null &&
          !['none', 'read'].includes(repositories.permission(repository, current.user.id)),
        canAdmin:
          current !== null &&
          ['admin', 'owner'].includes(repositories.permission(repository, current.user.id)),
        starCount: enhancements.starCount(repository.id),
        starred: current !== null && enhancements.isStarred(current.user.id, repository.id),
        forkCount: repositories.countForks(repository.id),
        forkParent,
      }),
    );
  });
}
