// The downloadable example intentionally uses only the stable, capability-based host API.
// A production plugin should import definePlugin from @bareline/plugin-sdk for types.
export default {
  apiVersion: 1,
  async activate(host) {
    let words = 0;
    let files = 0;
    for await (const file of host.readTextFiles({ maximumBytes: 1048576 })) {
      files += 1;
      words += file.content.trim() ? file.content.trim().split(/\s+/u).length : 0;
    }
    await host.storage.set(
      'last-result',
      new TextEncoder().encode(JSON.stringify({ files, words })),
    );
    host.log('info', `Counted ${words} words in ${files} files`);
  },
};

export const repositoryTabs = {
  async 'word-count'(host) {
    let words = 0;
    let files = 0;
    for await (const file of host.readTextFiles({ maximumBytes: 1048576 })) {
      files += 1;
      words += file.content.trim() ? file.content.trim().split(/\s+/u).length : 0;
    }
    await host.storage.set(
      'last-result',
      new TextEncoder().encode(JSON.stringify({ files, words })),
    );
    return {
      title: 'Repository word count',
      blocks: [
        { type: 'metric', label: 'Text files', value: files },
        { type: 'metric', label: 'Words', value: words },
        { type: 'text', text: 'Counts bounded text files from the default branch.' },
      ],
    };
  },
};

export const commands = {
  'word-count.calculate'() {
    return {
      title: 'Repository word count',
      blocks: [
        {
          type: 'text',
          text: 'Open a repository and choose the Word Count tab to calculate its bounded text-file total.',
        },
      ],
    };
  },
};

export const searchProviders = {
  'word-count.help'({ query }) {
    return /word|count/i.test(query)
      ? [{ title: 'Repository Word Count', subtitle: 'Plugin documentation', url: '/docs/plugins' }]
      : [];
  },
};

export const fileRenderers = {
  'word-count.preview'({ file }) {
    const text = Buffer.from(file.content, 'base64').toString('utf8');
    const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
    return {
      title: `Word count for ${file.path}`,
      blocks: [{ type: 'metric', label: 'Words', value: words }],
    };
  },
};

export const markdownExtensions = {
  'word-count.badge'({ document }) {
    return document.source.replaceAll(':word-count:', '**Word count enabled**');
  },
};

export const adminPages = {
  'word-count.status'() {
    return {
      title: 'Repository Word Count status',
      blocks: [
        {
          type: 'text',
          text: 'The example plugin is enabled and its checked integration is active.',
        },
      ],
    };
  },
};

export const restEndpoints = {
  async 'word-count.last-result'({ storage }) {
    const stored = await storage.get('last-result');
    return stored ? JSON.parse(new TextDecoder().decode(stored)) : { files: 0, words: 0 };
  },
};

export const events = {
  'repository-pushed'({ event }) {
    return { acknowledged: event === 'repository.pushed' };
  },
};
