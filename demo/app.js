const storageKey = 'bareline-demo-v3';
const seed = {
  view: 'code',
  branch: 'main',
  file: null,
  directory: '',
  branches: ['main', 'feature/reading-mode'],
  tags: ['v0.1.0'],
  pinned: true,
  starred: false,
  stars: 12,
  forks: 3,
  wikiPage: 'Home',
  issue: null,
  policies: [{ ref: 'main', forcePush: false, deletion: false, prefix: 'PT-' }],
  activity: [
    { action: 'repository.pushed', detail: 'main', time: '2 hours ago' },
    { action: 'branch.created', detail: 'feature/reading-mode', time: 'Yesterday' },
    { action: 'repository.createdFromTemplate', detail: 'minimal-docs', time: '3 days ago' },
  ],
  files: {
    'README.md':
      '# Paper Trail\n\nA small, durable record of decisions.\n\n## Principles\n\n- Keep the work visible.\n- Prefer durable tools.\n',
    'src/entries.js':
      'export const entries = [];\n\nexport function addEntry(entry) {\n  entries.push(entry);\n}\n',
    'docs/decisions.md': '# Decisions\n\nA place for context that should outlive a chat thread.\n',
  },
  commits: [
    {
      id: 'a4c31d7',
      subject: 'Refine the reading experience',
      author: 'Alice Nguyen',
      file: 'README.md',
      before: '# Paper Trail\n\nA small record.\n',
      after:
        '# Paper Trail\n\nA small, durable record of decisions.\n\n## Principles\n\n- Keep the work visible.\n- Prefer durable tools.\n',
      time: '2 hours ago',
    },
    {
      id: '8f29b90',
      subject: 'Add entry model',
      author: 'Ben Ortiz',
      file: 'src/entries.js',
      before: '',
      after:
        'export const entries = [];\n\nexport function addEntry(entry) {\n  entries.push(entry);\n}\n',
      time: 'Yesterday',
    },
    {
      id: '21b9a0c',
      subject: 'Initial commit',
      author: 'Alice Nguyen',
      file: 'README.md',
      before: '',
      after: '# Paper Trail\n\nA small record.\n',
      time: '3 days ago',
    },
  ],
  releases: [
    {
      tag: 'v0.1.0',
      name: 'First durable record',
      notes:
        '## Highlights\n\n- The first published set of decisions.\n- Principles section added to the README.\n',
      time: '3 days ago',
      assets: [{ name: 'paper-trail-0.1.0.txt', body: 'Paper Trail 0.1.0\nSeeded demo asset.\n' }],
    },
  ],
  wiki: {
    Home: '# Paper Trail wiki\n\nHow this record is kept, in prose rather than commits.\n\n- Conventions\n- Review rhythm\n',
    Conventions:
      '# Conventions\n\nOne decision per entry. Link the commit that implements it.\n\nKeep entries short enough to reread a year later.\n',
  },
  wikiHistory: [
    { page: 'Conventions', subject: 'Create Conventions', time: 'Yesterday' },
    { page: 'Home', subject: 'Create Home', time: '2 days ago' },
  ],
  issues: [
    {
      number: 2,
      title: 'Decide how entries are archived',
      status: 'open',
      labels: ['discussion'],
      author: 'Ben Ortiz',
      time: 'Yesterday',
      body: 'Entries older than a year are still useful, but they crowd the index. Do we archive by year or by project?',
      comments: [
        {
          author: 'Alice Nguyen',
          time: '4 hours ago',
          body: 'By year, and keep the index linking to each archive page.',
        },
      ],
    },
    {
      number: 1,
      title: 'README should explain the principles',
      status: 'closed',
      labels: ['documentation'],
      author: 'Alice Nguyen',
      time: '3 days ago',
      body: 'Someone arriving at this repository should learn what it is for in one screen.',
      comments: [{ author: 'Ben Ortiz', time: '2 hours ago', body: 'Done in a4c31d7.' }],
    },
  ],
  nextIssue: 3,
  forkedCopies: [],
};
const storedState = JSON.parse(localStorage.getItem(storageKey) || 'null');
let state = storedState
  ? {
      ...structuredClone(seed),
      ...storedState,
      activity: Array.isArray(storedState.activity)
        ? storedState.activity
        : structuredClone(seed.activity),
      policies: Array.isArray(storedState.policies)
        ? storedState.policies
        : structuredClone(seed.policies),
    }
  : structuredClone(seed);
let patchDraft = null;
const app = document.querySelector('#view');
const modal = document.querySelector('#modal');
const title = document.querySelector('#modal-title');
const body = document.querySelector('#modal-content');
const homeView = document.querySelector('#home-view');
const repositoryView = document.querySelector('#repository-view');
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const save = () => localStorage.setItem(storageKey, JSON.stringify(state));
const latest = () => state.commits[0];
const closeModal = () => modal.close();
const shortId = () => Math.random().toString(16).slice(2, 9);
function openModal(name, html) {
  title.textContent = name;
  body.innerHTML = html;
  modal.showModal();
}
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
function inlineMarkdown(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
function markdown(text) {
  return escape(text || '')
    .split(/\n{2,}/)
    .filter((block) => block.trim())
    .map((block) => {
      const heading = /^(#{1,4})\s+(.*)$/.exec(block.trim());
      if (heading) {
        const level = Math.min(heading[1].length + 1, 5);
        return `<h${level}>${inlineMarkdown(heading[2])}</h${level}>`;
      }
      if (/^\s*[-*]\s+/.test(block)) {
        return `<ul>${block
          .split('\n')
          .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
          .filter(Boolean)
          .map((item) => `<li>${inlineMarkdown(item)}</li>`)
          .join('')}</ul>`;
      }
      return `<p>${inlineMarkdown(block.replace(/\n/g, ' '))}</p>`;
    })
    .join('');
}
function lines(text) {
  return text
    .split('\n')
    .map((line, i) => `<span class="n">${i + 1}</span>${escape(line)}\n`)
    .join('');
}
function toLines(text) {
  return text === '' ? [] : text.replace(/\n$/, '').split('\n');
}
/** Builds real unified-diff text, the same shape the server's patch export produces. */
function unifiedDiff(path, before, after) {
  if (before === after) return '';
  const oldLines = toLines(before);
  const newLines = toLines(after);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start])
    start += 1;
  let end = 0;
  while (
    end < oldLines.length - start &&
    end < newLines.length - start &&
    oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]
  )
    end += 1;
  const leading = Math.min(3, start);
  const trailing = Math.min(3, end);
  const hunkStart = start - leading;
  const oldEnd = oldLines.length - end + trailing;
  const newEnd = newLines.length - end + trailing;
  const rows = [
    ...oldLines.slice(hunkStart, start).map((line) => ` ${line}`),
    ...oldLines.slice(start, oldLines.length - end).map((line) => `-${line}`),
    ...newLines.slice(start, newLines.length - end).map((line) => `+${line}`),
    ...oldLines.slice(oldLines.length - end, oldEnd).map((line) => ` ${line}`),
  ];
  const oldCount = oldEnd - hunkStart;
  const newCount = newEnd - hunkStart;
  const header =
    before === ''
      ? `new file mode 100644\n--- /dev/null\n+++ b/${path}`
      : after === ''
        ? `deleted file mode 100644\n--- a/${path}\n+++ /dev/null`
        : `--- a/${path}\n+++ b/${path}`;
  return `diff --git a/${path} b/${path}\n${header}\n@@ -${oldCount ? hunkStart + 1 : 0},${oldCount} +${newCount ? hunkStart + 1 : 0},${newCount} @@\n${rows.join('\n')}\n`;
}
function formatPatch(commit) {
  const identity = `${commit.author || 'Alice Nguyen'} <${(commit.author || 'alice')
    .split(' ')[0]
    .toLowerCase()}@example.test>`;
  return `From ${commit.id}${'0'.repeat(Math.max(0, 40 - commit.id.length))} Mon Sep 17 00:00:00 2001\nFrom: ${identity}\nDate: Mon, 1 Sep 2026 09:12:00 +0200\nSubject: [PATCH] ${commit.subject}\n\n---\n${unifiedDiff(commit.file, commit.before, commit.after)}-- \n2.47.3\n\n`;
}
function parsePatch(text) {
  const subject = /^Subject:\s*(?:\[[^\]]*\]\s*)?(.+)$/m.exec(text)?.[1]?.trim() ?? '';
  const author = /^From:\s*(.+?)\s*(?:<.*)?$/m.exec(text)?.[1]?.trim() ?? '';
  const files = [];
  let file = null;
  let hunk = null;
  // The final newline of the patch is a terminator, not a blank context line.
  for (const line of text.replace(/\n$/, '').split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      file = { path: header[2], hunks: [], added: 0, removed: 0 };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    const range = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (range) {
      hunk = { oldStart: Number(range[1]), lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line === '') {
      hunk.lines.push(' ');
      continue;
    }
    if (!/^[ +-]/.test(line) || line === '-- ') {
      hunk = null;
      continue;
    }
    hunk.lines.push(line);
    if (line.startsWith('+')) file.added += 1;
    if (line.startsWith('-')) file.removed += 1;
  }
  return { subject, author, files: files.filter((entry) => entry.hunks.length) };
}
/** Applies a parsed patch to the demo's file map, verifying context lines exactly like git does. */
function applyPatch(parsed) {
  const files = { ...state.files };
  for (const file of parsed.files) {
    const original = files[file.path] ?? '';
    const keepNewline = original === '' || original.endsWith('\n');
    let rows = toLines(original);
    let offset = 0;
    for (const hunk of file.hunks) {
      const at = Math.max(0, hunk.oldStart - 1 + offset);
      const expected = hunk.lines
        .filter((line) => line[0] === ' ' || line[0] === '-')
        .map((line) => line.slice(1));
      const replacement = hunk.lines
        .filter((line) => line[0] === ' ' || line[0] === '+')
        .map((line) => line.slice(1));
      if (rows.slice(at, at + expected.length).join('\n') !== expected.join('\n')) {
        return {
          ok: false,
          error: `${file.path}: hunk starting at line ${hunk.oldStart} does not apply to this branch`,
        };
      }
      rows = [...rows.slice(0, at), ...replacement, ...rows.slice(at + expected.length)];
      offset += replacement.length - expected.length;
    }
    if (rows.length === 0) delete files[file.path];
    else files[file.path] = `${rows.join('\n')}${keepNewline ? '\n' : ''}`;
  }
  return { ok: true, files };
}
function diffRows(patchText) {
  return patchText
    .split('\n')
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line))
    .map((line) => `<li class="${line.startsWith('+') ? 'plus' : 'minus'}">${escape(line)}</li>`)
    .join('');
}
function diffs(before, after) {
  return diffRows(unifiedDiff('file', before, after)) || '<li>No textual changes</li>';
}
function recordCommit({ subject, file, before, after, author = 'Alice Nguyen', action }) {
  const commit = { id: shortId(), subject, author, file, before, after, time: 'just now' };
  state.commits.unshift(commit);
  state.activity.unshift({ action, detail: state.branch, time: 'just now' });
  return commit;
}
function fileRow(file, label = file) {
  return `<li class="row"><span>·</span><button class="name" data-file="${escape(file)}">${escape(label)}</button><small>${state.files[file].length} B</small></li>`;
}
function showCode() {
  const top = latest();
  const prefix = state.directory ? `${state.directory}/` : '';
  const visiblePaths = Object.keys(state.files).filter((path) => path.startsWith(prefix));
  const folders = [
    ...new Set(
      visiblePaths
        .map((path) => path.slice(prefix.length))
        .filter((path) => path.includes('/'))
        .map((path) => path.split('/')[0]),
    ),
  ];
  const files = visiblePaths.filter((path) => !path.slice(prefix.length).includes('/')).sort();
  const crumbs = state.directory
    .split('/')
    .filter(Boolean)
    .map((part, index, parts) => ({ name: part, path: parts.slice(0, index + 1).join('/') }));
  app.innerHTML = `${state.directory ? `<nav class="breadcrumbs" aria-label="Breadcrumb"><button data-directory="">root</button>${crumbs.map((crumb) => `<span>/</span><button data-directory="${escape(crumb.path)}">${escape(crumb.name)}</button>`).join('')}</nav>` : ''}<div class="bar"><label><select id="branch" aria-label="Branch">${state.branches.map((branch) => `<option ${branch === state.branch ? 'selected' : ''}>${escape(branch)}</option>`).join('')}</select></label><span>Switch</span><small>${folders.length + files.length} items</small><button id="new-file">New file</button><button id="upload-file">Upload</button></div><div class="latest"><span><b class="sha">${top.id}</b> ${escape(top.subject)}</span><small>${escape(top.author || 'Alice Nguyen')} · ${top.time}</small></div><ul class="list">${folders.map((folder) => `<li class="row"><span class="folder">▰</span><button class="name" data-folder="${escape(prefix + folder)}">${escape(folder)}</button><small>folder</small></li>`).join('')}${files.map((file) => fileRow(file, file.slice(prefix.length))).join('')}</ul>${state.file ? showFile(state.file) : !state.directory && state.files['README.md'] ? `<section class="card"><header>README <button id="edit-readme">Edit</button></header><article class="markdown">${markdown(state.files['README.md'])}</article></section>` : ''}`;
  document.querySelector('#branch').onchange = (event) => {
    state.branch = event.target.value;
    save();
  };
  document.querySelectorAll('[data-file]').forEach((button) => {
    button.onclick = () => {
      state.file = button.dataset.file;
      render();
    };
  });
  document.querySelectorAll('[data-folder]').forEach((button) => {
    button.onclick = () => {
      state.directory = button.dataset.folder;
      state.file = null;
      render();
    };
  });
  document.querySelectorAll('[data-directory]').forEach((button) => {
    button.onclick = () => {
      state.directory = button.dataset.directory;
      state.file = null;
      render();
    };
  });
  document.querySelector('#edit-readme')?.addEventListener('click', () => editor('README.md'));
  document.querySelector('#new-file').onclick = () => editor();
  document.querySelector('#upload-file').onclick = () =>
    openModal(
      'Upload files',
      '<label>Choose files<input type="file" multiple></label><label>Commit message<input value="Upload files"></label><div class="modal-actions"><button value="cancel">Cancel</button><button class="primary" value="cancel">Commit upload</button></div>',
    );
}
function showFile(file) {
  return `<section class="card"><header><span>${escape(file)}</span><span><button id="back">Back</button> <button id="edit">Edit</button></span></header><pre>${lines(state.files[file])}</pre></section>`;
}
function showCommits() {
  app.innerHTML = `<ul class="list">${state.commits.map((commit) => `<li class="row"><button data-commit="${commit.id}"><strong>${escape(commit.subject)}</strong><br><small><b class="sha">${commit.id}</b> · ${escape(commit.author || 'Alice Nguyen')} · ${commit.time}</small></button><span class="stats"><b class="add">+${Math.max(1, commit.after.split('\n').length - 1)}</b> <b class="del">−${Math.max(0, commit.before.split('\n').length - 1)}</b></span></li>`).join('')}</ul>${state.file?.startsWith('commit:') ? showDiff(state.commits.find((commit) => commit.id === state.file.slice(7))) : ''}`;
  document.querySelectorAll('[data-commit]').forEach((button) => {
    button.onclick = () => {
      state.file = `commit:${button.dataset.commit}`;
      render();
    };
  });
  bindCommitActions();
}
function showDiff(commit) {
  if (!commit) return '';
  const branchOptions = state.branches
    .map((branch) => `<option>${escape(branch)}</option>`)
    .join('');
  return `<section class="card"><header><span>${escape(commit.file)} · ${escape(commit.subject)}</span><span><button data-patch-download="${commit.id}">Download patch</button> <button id="back">Close</button></span></header><ul class="diff">${diffs(commit.before, commit.after)}</ul><div class="commit-actions"><label>Cherry-pick onto<select data-pick-branch="${commit.id}">${branchOptions}</select></label><button data-cherry-pick="${commit.id}">Cherry-pick</button><label>Revert onto<select data-revert-branch="${commit.id}">${branchOptions}</select></label><button data-revert="${commit.id}">Revert</button></div></section>`;
}
function bindCommitActions() {
  document.querySelectorAll('[data-patch-download]').forEach((button) => {
    button.onclick = () => {
      const commit = state.commits.find((entry) => entry.id === button.dataset.patchDownload);
      download(`${commit.id}.patch`, formatPatch(commit));
    };
  });
  document.querySelectorAll('[data-cherry-pick]').forEach((button) => {
    button.onclick = () => {
      const commit = state.commits.find((entry) => entry.id === button.dataset.cherryPick);
      const target = document.querySelector(`[data-pick-branch="${commit.id}"]`).value;
      state.branch = target;
      state.files[commit.file] = commit.after;
      recordCommit({
        subject: commit.subject,
        author: commit.author,
        file: commit.file,
        before: commit.before,
        after: commit.after,
        action: 'commit.cherryPickedViaWeb',
      });
      state.file = null;
      save();
      openModal(
        'Cherry-picked',
        `<p>Applied <strong>${escape(commit.subject)}</strong> onto <code>${escape(target)}</code> as a new commit, keeping ${escape(commit.author || 'the original author')} as the author.</p>`,
      );
      render();
    };
  });
  document.querySelectorAll('[data-revert]').forEach((button) => {
    button.onclick = () => {
      const commit = state.commits.find((entry) => entry.id === button.dataset.revert);
      const target = document.querySelector(`[data-revert-branch="${commit.id}"]`).value;
      state.branch = target;
      if (commit.before === '') delete state.files[commit.file];
      else state.files[commit.file] = commit.before;
      recordCommit({
        subject: `Revert "${commit.subject}"`,
        file: commit.file,
        before: commit.after,
        after: commit.before,
        action: 'commit.revertedViaWeb',
      });
      state.file = null;
      save();
      openModal(
        'Reverted',
        `<p>Created a commit on <code>${escape(target)}</code> undoing <strong>${escape(commit.subject)}</strong>.</p>`,
      );
      render();
    };
  });
}
function showRefs(type) {
  const refs = state[type];
  const label = type === 'branches' ? 'Branches' : 'Tags';
  app.innerHTML = `<section class="view-heading"><p class="eyebrow">${label}</p><h2>alice/paper-trail</h2></section><form class="ref-create" id="ref-create"><label>Name<input id="inline-ref" required placeholder="${type === 'branches' ? 'feature/notes' : 'v0.2.0'}"></label><label>Start at<input value="main" readonly></label><button class="primary">Create ${type === 'branches' ? 'branch' : 'tag'}</button></form><ul class="ref-list">${refs.map((ref, index) => `<li><div><strong>${escape(ref)}</strong><p>${escape(latest().subject)} · ${latest().time}${index === 0 ? ' · default branch' : ''}</p>${type === 'tags' ? '<p><span class="status">Valid signature</span> · trusted as Alice Nguyen</p>' : index === 0 ? '<p><span class="status">Protected</span> · force push and deletion blocked</p>' : ''}</div><span class="ref-actions"><button data-ref="${escape(ref)}">Browse</button>${index === 0 && type === 'branches' ? '' : `<button data-delete-ref="${escape(ref)}">Delete</button>`}</span></li>`).join('')}</ul>`;
  document.querySelector('#ref-create').onsubmit = (event) => {
    event.preventDefault();
    const value = document.querySelector('#inline-ref').value.trim();
    if (!value || refs.includes(value)) return;
    refs.push(value);
    state.activity.unshift({
      action: type === 'branches' ? 'branch.created' : 'tag.created',
      detail: value,
      time: 'just now',
    });
    save();
    render();
  };
  document.querySelectorAll('[data-ref]').forEach((button) => {
    button.onclick = () => {
      state.branch = button.dataset.ref;
      state.view = 'code';
      state.file = null;
      save();
      render();
    };
  });
  document.querySelectorAll('[data-delete-ref]').forEach((button) => {
    button.onclick = () => {
      state[type] = state[type].filter((ref) => ref !== button.dataset.deleteRef);
      save();
      render();
    };
  });
}
function showCompare() {
  const commit = latest();
  const other = state.branches.find((branch) => branch !== 'main') ?? 'main';
  app.innerHTML = `<div class="bar"><label>Base <select id="compare-base"><option>main</option></select></label><label>Compare <select id="compare-head">${state.branches.map((branch) => `<option ${branch === state.branch ? 'selected' : ''}>${escape(branch)}</option>`).join('')}</select></label><button id="download-series">Download patch series</button><button class="primary" id="merge-branch">Merge into main</button></div><section class="card"><header><span>${escape(commit.file)} · ${commit.id}</span><span class="stats"><b class="add">+${commit.after.split('\n').length - 1}</b> <b class="del">−${commit.before.split('\n').length - 1}</b></span></header><ul class="diff">${diffs(commit.before, commit.after)}</ul></section>`;
  document.querySelector('#download-series').onclick = () =>
    download(
      `paper-trail-main-${(document.querySelector('#compare-head').value || other).replace(/\//g, '-')}.patch`,
      state.commits
        .slice(0, 2)
        .reverse()
        .map((entry) => formatPatch(entry))
        .join(''),
    );
  document.querySelector('#merge-branch').onclick = () => {
    const head = document.querySelector('#compare-head').value;
    if (head === 'main') {
      openModal(
        'Nothing to merge',
        '<p>Choose a branch other than <code>main</code> to merge.</p>',
      );
      return;
    }
    state.branch = 'main';
    recordCommit({
      subject: `Merge ${head} into main`,
      file: latest().file,
      before: latest().after,
      after: latest().after,
      action: 'branch.merged',
    });
    save();
    openModal(
      'Merged',
      `<p>Merged <code>${escape(head)}</code> into <code>main</code>. The server fast-forwards when it can and otherwise writes a real three-way merge commit.</p>`,
    );
    render();
  };
}
function showPatches() {
  const preview = patchDraft;
  app.innerHTML = `<section class="view-heading"><p class="eyebrow">alice/paper-trail</p><h2>Patches</h2><p>Export a commit or a comparison as <code>git format-patch</code> output, or import a patch after reviewing exactly what it would change.</p></section>
    <section class="split">
      <section class="panel-block"><h3>Export</h3><ul class="ref-list">${state.commits
        .slice(0, 4)
        .map(
          (commit) =>
            `<li><div><strong>${escape(commit.subject)}</strong><p><b class="sha">${commit.id}</b> · ${escape(commit.author || 'Alice Nguyen')} · ${commit.time}</p></div><span class="ref-actions"><button data-patch-download="${commit.id}">Download .patch</button><button data-patch-view="${commit.id}">View</button></span></li>`,
        )
        .join('')}</ul></section>
      <section class="panel-block"><h3>Import</h3><form id="patch-form"><label>Target branch<select id="patch-branch">${state.branches.map((branch) => `<option ${branch === state.branch ? 'selected' : ''}>${escape(branch)}</option>`).join('')}</select></label><label>Patch text<textarea id="patch-text" rows="10" spellcheck="false" placeholder="Paste git diff or git format-patch output">${escape(patchDraft?.text ?? '')}</textarea></label><div class="modal-actions"><button type="button" id="patch-sample">Use a sample patch</button><button class="primary" type="submit">Preview import</button></div></form></section>
    </section>
    ${
      preview
        ? `<section class="card patch-preview"><header><span>Preview · ${preview.parsed.files.length} file${preview.parsed.files.length === 1 ? '' : 's'}</span><span class="status ${preview.result.ok ? '' : 'bad'}">${preview.result.ok ? 'Applies cleanly' : 'Does not apply'}</span></header>${
            preview.result.ok ? '' : `<p class="patch-error">${escape(preview.result.error)}</p>`
          }${preview.parsed.subject ? `<p class="patch-subject"><strong>${escape(preview.parsed.subject)}</strong>${preview.parsed.author ? ` · ${escape(preview.parsed.author)}` : ''}</p>` : '<p class="patch-subject muted">No Subject header — the demo would ask for a commit message.</p>'}${preview.parsed.files
            .map(
              (file) =>
                `<div class="patch-file"><p><strong>${escape(file.path)}</strong> <span class="stats"><b class="add">+${file.added}</b> <b class="del">−${file.removed}</b></span></p><ul class="diff">${file.hunks
                  .map((hunk) =>
                    hunk.lines
                      .filter((line) => line !== ' ')
                      .map(
                        (line) =>
                          `<li class="${line.startsWith('+') ? 'plus' : line.startsWith('-') ? 'minus' : ''}">${escape(line)}</li>`,
                      )
                      .join(''),
                  )
                  .join('')}</ul></div>`,
            )
            .join(
              '',
            )}<div class="modal-actions">${preview.result.ok ? '<button class="primary" id="patch-confirm">Confirm import</button>' : ''}<button id="patch-cancel">Start over</button></div></section>`
        : ''
    }`;
  document.querySelector('#patch-sample').onclick = () => {
    document.querySelector('#patch-text').value = formatPatch({
      id: 'demo123',
      subject: 'Note the review rhythm',
      author: 'Ben Ortiz',
      file: 'docs/decisions.md',
      before: state.files['docs/decisions.md'] ?? '',
      after: `${state.files['docs/decisions.md'] ?? ''}\nReviewed every Friday.\n`,
    });
  };
  document.querySelector('#patch-form').onsubmit = (event) => {
    event.preventDefault();
    const text = document.querySelector('#patch-text').value;
    const branch = document.querySelector('#patch-branch').value;
    if (!text.trim()) return;
    const parsed = parsePatch(text);
    if (!parsed.files.length) {
      openModal(
        'No patch found',
        '<p>The text contains no <code>diff --git</code> sections, so there is nothing to apply.</p>',
      );
      return;
    }
    patchDraft = { text, branch, parsed, result: applyPatch(parsed) };
    render();
  };
  document.querySelector('#patch-cancel')?.addEventListener('click', () => {
    patchDraft = null;
    render();
  });
  document.querySelector('#patch-confirm')?.addEventListener('click', () => {
    const { parsed, result, branch } = patchDraft;
    const first = parsed.files[0];
    const before = state.files[first.path] ?? '';
    state.branch = branch;
    state.files = result.files;
    recordCommit({
      subject: parsed.subject || 'Import patch',
      author: parsed.author || 'Alice Nguyen',
      file: first.path,
      before,
      after: result.files[first.path] ?? '',
      action: 'patch.importedViaWeb',
    });
    patchDraft = null;
    save();
    openModal(
      'Patch imported',
      `<p>Created a commit on <code>${escape(branch)}</code> from the patch. The server applies patches straight to the bare repository, without a working tree.</p>`,
    );
    render();
  });
  document.querySelectorAll('[data-patch-view]').forEach((button) => {
    button.onclick = () => {
      const commit = state.commits.find((entry) => entry.id === button.dataset.patchView);
      openModal(
        `${commit.id}.patch`,
        `<pre class="patch-text">${escape(formatPatch(commit))}</pre>`,
      );
    };
  });
  bindCommitActions();
}
function showReleases() {
  app.innerHTML = `<section class="view-heading"><p class="eyebrow">alice/paper-trail</p><h2>Releases</h2><p>Tag-backed release notes with downloadable assets.</p></section><form class="ref-create" id="release-form"><label>Tag<input id="release-tag" required placeholder="v0.2.0"></label><label>Title<input id="release-name" placeholder="Second edition"></label><button class="primary">Publish release</button></form>${
    state.releases.length ? '' : '<p class="muted">No releases yet.</p>'
  }${state.releases
    .map(
      (release) =>
        `<section class="card release"><header><span><strong>${escape(release.name || release.tag)}</strong> · <code>${escape(release.tag)}</code></span><span class="muted">${escape(release.time)}</span></header><article class="markdown">${markdown(release.notes)}</article><ul class="ref-list">${release.assets
          .map(
            (asset) =>
              `<li><div><strong>${escape(asset.name)}</strong><p>${asset.body.length} B</p></div><span class="ref-actions"><button data-asset="${escape(release.tag)}|${escape(asset.name)}">Download</button></span></li>`,
          )
          .join(
            '',
          )}</ul><div class="modal-actions"><button data-release-asset="${escape(release.tag)}">Upload asset</button><button data-release-delete="${escape(release.tag)}">Delete release</button></div></section>`,
    )
    .join('')}`;
  document.querySelector('#release-form').onsubmit = (event) => {
    event.preventDefault();
    const tag = document.querySelector('#release-tag').value.trim();
    if (!tag || state.releases.some((release) => release.tag === tag)) return;
    state.releases.unshift({
      tag,
      name: document.querySelector('#release-name').value.trim(),
      notes: '## Notes\n\nDrafted in the demo.\n',
      time: 'just now',
      assets: [],
    });
    if (!state.tags.includes(tag)) state.tags.push(tag);
    state.activity.unshift({ action: 'release.created', detail: tag, time: 'just now' });
    save();
    render();
  };
  document.querySelectorAll('[data-asset]').forEach((button) => {
    button.onclick = () => {
      const [tag, name] = button.dataset.asset.split('|');
      const release = state.releases.find((entry) => entry.tag === tag);
      download(name, release.assets.find((asset) => asset.name === name).body);
    };
  });
  document.querySelectorAll('[data-release-asset]').forEach((button) => {
    button.onclick = () => {
      const release = state.releases.find((entry) => entry.tag === button.dataset.releaseAsset);
      release.assets.push({
        name: `${release.tag}-notes.txt`,
        body: `${release.name || release.tag}\n\n${release.notes}`,
      });
      save();
      render();
    };
  });
  document.querySelectorAll('[data-release-delete]').forEach((button) => {
    button.onclick = () => {
      state.releases = state.releases.filter((entry) => entry.tag !== button.dataset.releaseDelete);
      save();
      render();
    };
  });
}
function showWiki() {
  const page = state.wikiPage ?? 'Home';
  const content = state.wiki[page];
  app.innerHTML = `<section class="view-heading"><p class="eyebrow">alice/paper-trail</p><h2>Wiki</h2><p>Markdown pages kept in their own small Git repository, with history per page.</p></section><div class="wiki-layout"><aside><nav aria-label="Wiki pages">${Object.keys(
    state.wiki,
  )
    .sort()
    .map(
      (name) =>
        `<button class="${name === page ? 'selected' : ''}" data-wiki="${escape(name)}">${escape(name)}</button>`,
    )
    .join('')}</nav><button id="wiki-new">New page</button></aside><article>${
    content === undefined
      ? `<div class="empty"><p>${escape(page)} has no content yet.</p></div>`
      : `<div class="wiki-actions"><button id="wiki-edit">Edit page</button><button id="wiki-delete">Delete page</button></div><div class="markdown">${markdown(content)}</div><h3>Page history</h3><ol class="activity-list">${state.wikiHistory
          .filter((entry) => entry.page === page)
          .map(
            (entry) =>
              `<li><span class="event-mark" aria-hidden="true">●</span><div><strong>${escape(entry.subject)}</strong><p>Alice Nguyen</p></div><time>${escape(entry.time)}</time></li>`,
          )
          .join('')}</ol>`
  }</article></div>`;
  document.querySelectorAll('[data-wiki]').forEach((button) => {
    button.onclick = () => {
      state.wikiPage = button.dataset.wiki;
      save();
      render();
    };
  });
  document.querySelector('#wiki-new').onclick = () => wikiEditor('');
  document.querySelector('#wiki-edit')?.addEventListener('click', () => wikiEditor(page));
  document.querySelector('#wiki-delete')?.addEventListener('click', () => {
    delete state.wiki[page];
    state.wikiHistory.unshift({ page, subject: `Delete ${page}`, time: 'just now' });
    state.wikiPage = 'Home';
    save();
    render();
  });
}
function wikiEditor(page) {
  openModal(
    page ? `Edit ${page}` : 'Create wiki page',
    `<label>Page name<input id="wiki-name" value="${escape(page)}" placeholder="Review-rhythm"></label><label>Markdown<textarea id="wiki-content" rows="12">${escape(state.wiki[page] ?? '')}</textarea></label><label>Change summary<input id="wiki-message" value="${escape(page ? `Update ${page}` : 'Create page')}"></label><div class="modal-actions"><button value="cancel">Cancel</button><button class="primary" type="button" id="wiki-save">Save page</button></div>`,
  );
  document.querySelector('#wiki-save').onclick = () => {
    const name = document.querySelector('#wiki-name').value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return;
    if (page && page !== name) delete state.wiki[page];
    state.wiki[name] = document.querySelector('#wiki-content').value;
    state.wikiHistory.unshift({
      page: name,
      subject: document.querySelector('#wiki-message').value.trim() || `Update ${name}`,
      time: 'just now',
    });
    state.wikiPage = name;
    state.activity.unshift({ action: 'wiki.pageUpdatedViaWeb', detail: name, time: 'just now' });
    save();
    closeModal();
    render();
  };
}
const languages = {
  js: 'JavaScript',
  ts: 'TypeScript',
  md: 'Markdown',
  css: 'CSS',
  html: 'HTML',
  json: 'JSON',
  yml: 'YAML',
  py: 'Python',
};
function hue(value) {
  let total = 0;
  for (let index = 0; index < value.length; index += 1)
    total = (total * 31 + value.charCodeAt(index)) >>> 0;
  return total % 360;
}
function showInsights() {
  const totals = new Map();
  for (const [path, content] of Object.entries(state.files)) {
    const language = languages[path.split('.').pop()?.toLowerCase()];
    if (!language) continue;
    totals.set(language, (totals.get(language) ?? 0) + content.length);
  }
  const total = [...totals.values()].reduce((sum, value) => sum + value, 0) || 1;
  const stats = [...totals.entries()]
    .map(([language, bytes]) => ({ language, bytes, percent: (bytes / total) * 100 }))
    .sort((left, right) => right.bytes - left.bytes);
  const authors = new Map();
  for (const commit of state.commits) {
    const author = commit.author || 'Alice Nguyen';
    authors.set(author, (authors.get(author) ?? 0) + 1);
  }
  const contributors = [...authors.entries()].sort((left, right) => right[1] - left[1]);
  app.innerHTML = `<section class="view-heading"><p class="eyebrow">alice/paper-trail</p><h2>Insights</h2><p>${state.forks} forks · ${state.stars + (state.starred ? 1 : 0)} stars</p></section><h3>Languages</h3><div class="language-bar">${stats
    .map(
      (stat) =>
        `<span style="width:${stat.percent.toFixed(2)}%;background:hsl(${hue(stat.language)} 60% 45%)" title="${escape(stat.language)}"></span>`,
    )
    .join('')}</div><ul class="language-legend">${stats
    .map(
      (stat) =>
        `<li><span class="language-swatch" style="background:hsl(${hue(stat.language)} 60% 45%)"></span>${escape(stat.language)} <span class="muted">${stat.percent.toFixed(1)}%</span></li>`,
    )
    .join('')}</ul><h3>Contributors</h3><ul class="ref-list">${contributors
    .map(
      ([author, count]) =>
        `<li><div><strong>${escape(author)}</strong><p>${escape(author.split(' ')[0].toLowerCase())}@example.test</p></div><span>${count} commit${count === 1 ? '' : 's'}</span></li>`,
    )
    .join('')}</ul>`;
}
function showIssues() {
  const open = state.issues.filter((issue) => issue.status === 'open').length;
  const current = state.issues.find((issue) => issue.number === state.issue);
  if (current) {
    app.innerHTML = `<section class="view-heading"><p class="eyebrow">Issue #${current.number}</p><h2>${escape(current.title)}</h2><p><span class="status ${current.status === 'open' ? '' : 'bad'}">${current.status === 'open' ? 'Open' : 'Closed'}</span> · ${escape(current.author)} · ${escape(current.time)}${current.labels.map((label) => ` · <span class="label">${escape(label)}</span>`).join('')}</p></section><section class="card"><header><span>${escape(current.author)}</span><span class="muted">${escape(current.time)}</span></header><article class="markdown">${markdown(current.body)}</article></section>${current.comments
      .map(
        (comment) =>
          `<section class="card"><header><span>${escape(comment.author)}</span><span class="muted">${escape(comment.time)}</span></header><article class="markdown">${markdown(comment.body)}</article></section>`,
      )
      .join(
        '',
      )}<form class="panel compact" id="comment-form"><label>Comment<textarea id="comment-body" rows="4" placeholder="Add context that should outlive a chat thread."></textarea></label><div class="modal-actions"><button type="button" id="issue-status">${current.status === 'open' ? 'Close issue' : 'Reopen issue'}</button><button class="primary">Comment</button></div></form><button class="activity-link" id="issue-back">Back to issues</button>`;
    document.querySelector('#comment-form').onsubmit = (event) => {
      event.preventDefault();
      const text = document.querySelector('#comment-body').value.trim();
      if (!text) return;
      current.comments.push({ author: 'Alice Nguyen', body: text, time: 'just now' });
      state.activity.unshift({
        action: 'issue.commented',
        detail: `#${current.number}`,
        time: 'just now',
      });
      save();
      render();
    };
    document.querySelector('#issue-status').onclick = () => {
      current.status = current.status === 'open' ? 'closed' : 'open';
      state.activity.unshift({
        action: current.status === 'open' ? 'issue.reopened' : 'issue.closed',
        detail: `#${current.number}`,
        time: 'just now',
      });
      save();
      render();
    };
    document.querySelector('#issue-back').onclick = () => {
      state.issue = null;
      render();
    };
    return;
  }
  app.innerHTML = `<section class="view-heading"><p class="eyebrow">alice/paper-trail</p><h2>Issues</h2><p>${open} open · ${state.issues.length - open} closed</p></section><form class="ref-create" id="issue-form"><label>Title<input id="issue-title" required placeholder="Something worth writing down"></label><button class="primary">Open issue</button></form><ul class="ref-list">${state.issues
    .map(
      (issue) =>
        `<li><div><strong>#${issue.number} ${escape(issue.title)}</strong><p><span class="status ${issue.status === 'open' ? '' : 'bad'}">${issue.status === 'open' ? 'Open' : 'Closed'}</span> · ${escape(issue.author)} · ${escape(issue.time)} · ${issue.comments.length} comment${issue.comments.length === 1 ? '' : 's'}${issue.labels.map((label) => ` · <span class="label">${escape(label)}</span>`).join('')}</p></div><span class="ref-actions"><button data-issue="${issue.number}">Open</button></span></li>`,
    )
    .join('')}</ul>`;
  document.querySelector('#issue-form').onsubmit = (event) => {
    event.preventDefault();
    const value = document.querySelector('#issue-title').value.trim();
    if (!value) return;
    state.issues.unshift({
      number: state.nextIssue,
      title: value,
      status: 'open',
      labels: [],
      author: 'Alice Nguyen',
      time: 'just now',
      body: 'Opened from the interactive demo.',
      comments: [],
    });
    state.nextIssue += 1;
    state.activity.unshift({ action: 'issue.created', detail: value, time: 'just now' });
    save();
    render();
  };
  document.querySelectorAll('[data-issue]').forEach((button) => {
    button.onclick = () => {
      state.issue = Number(button.dataset.issue);
      render();
    };
  });
}
function showActivity() {
  app.innerHTML = `<section class="view-heading"><p class="eyebrow">alice/paper-trail</p><h2>Repository activity</h2><p>Git and repository changes, without notification clutter.</p></section><ol class="activity-list">${state.activity.map((event) => `<li><span class="event-mark" aria-hidden="true">●</span><div><strong>${escape(event.action)}</strong><p>Alice Nguyen · <code>${escape(event.detail)}</code></p></div><time>${escape(event.time)}</time></li>`).join('')}</ol>`;
}
function showSettings() {
  app.innerHTML = `<section class="view-heading"><p class="eyebrow">alice/paper-trail</p><h2>Repository settings</h2></section><div class="settings-grid"><section class="settings-card"><h3>Branch policies</h3><p><strong>main</strong> · protected from force pushes and deletion</p><label>Required commit prefix<input value="PT-"></label><button>Save policy</button></section><section class="settings-card"><h3>Deploy keys</h3><p><strong>docs-deploy</strong><br><code>SHA256:q3DemoFingerprint</code> · read-only</p><button>Add deploy key</button></section><section class="settings-card"><h3>Repository mirror</h3><label>Direction<select><option>Pull into Bareline</option></select></label><label>Remote URL<input value="https://git.example.test/alice/paper-trail.git"></label><p class="status">Healthy · checked 4 minutes ago</p><button>Run now</button></section><section class="settings-card"><h3>Template repository</h3><label><input class="inline-check" type="checkbox" checked> Allow use as a template</label><button>Save</button></section></div>`;
}
function render() {
  document
    .querySelectorAll('[data-view]')
    .forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
  if (state.view === 'code') showCode();
  if (state.view === 'commits') showCommits();
  if (state.view === 'branches' || state.view === 'tags') showRefs(state.view);
  if (state.view === 'compare') showCompare();
  if (state.view === 'patches') showPatches();
  if (state.view === 'releases') showReleases();
  if (state.view === 'wiki') showWiki();
  if (state.view === 'insights') showInsights();
  if (state.view === 'issues') showIssues();
  if (state.view === 'activity') showActivity();
  if (state.view === 'settings') showSettings();
  document.querySelector('#back')?.addEventListener('click', () => {
    state.file = null;
    render();
  });
  document.querySelector('#edit')?.addEventListener('click', () => editor(state.file));
  updateRepositoryActions();
}
function updateRepositoryActions() {
  const star = document.querySelector('#star');
  const fork = document.querySelector('#fork');
  star.textContent = `${state.starred ? 'Starred' : 'Star'} · ${state.stars + (state.starred ? 1 : 0)}`;
  fork.textContent = `Fork · ${state.forks}`;
  document.querySelector('#pin').textContent = state.pinned ? 'Unpin' : 'Pin';
}
function editor(file = '') {
  const current = state.files[file] || '';
  openModal(
    file ? 'Edit file' : 'Create file',
    `<label>Path<input id="path" value="${escape(file)}" placeholder="notes/today.md"></label><label>Contents<textarea id="contents">${escape(current)}</textarea></label><details open><summary>Markdown preview</summary><article class="markdown" id="editor-preview"></article></details><label>Commit message<input id="message" value="${escape(file ? `Update ${file}` : 'Add file')}"></label><div class="modal-actions"><button value="cancel">Cancel</button><button class="primary" type="button" id="commit">Commit changes</button></div>`,
  );
  const preview = document.querySelector('#editor-preview');
  const contentsEditor = document.querySelector('#contents');
  const updatePreview = () => {
    preview.innerHTML = markdown(contentsEditor.value);
  };
  contentsEditor.oninput = updatePreview;
  updatePreview();
  document.querySelector('#commit').onclick = () => {
    const path = document.querySelector('#path').value.trim();
    const contents = document.querySelector('#contents').value;
    const message = document.querySelector('#message').value.trim();
    if (!path || !message) return;
    const before = current;
    if (file && file !== path) delete state.files[file];
    state.files[path] = contents;
    recordCommit({
      subject: message,
      file: path,
      before,
      after: contents,
      action: 'commit.createdViaWeb',
    });
    state.file = path;
    save();
    closeModal();
    render();
  };
}
function palette() {
  openModal(
    'Go anywhere',
    '<input id="query" autofocus placeholder="Search files, commits, and actions"><div id="results"></div>',
  );
  const query = document.querySelector('#query');
  const results = document.querySelector('#results');
  const update = () => {
    const value = query.value.toLowerCase();
    const options = [
      ...Object.keys(state.files).map((file) => ({
        label: file,
        detail: 'Open file',
        go: () => {
          state.view = 'code';
          state.file = file;
        },
      })),
      ...state.commits.map((commit) => ({
        label: commit.subject,
        detail: `Commit ${commit.id}`,
        go: () => {
          state.view = 'commits';
          state.file = `commit:${commit.id}`;
        },
      })),
      ...state.issues.map((issue) => ({
        label: `#${issue.number} ${issue.title}`,
        detail: `Issue · ${issue.status}`,
        go: () => {
          state.view = 'issues';
          state.issue = issue.number;
        },
      })),
      ...Object.keys(state.wiki).map((page) => ({
        label: page,
        detail: 'Wiki page',
        go: () => {
          state.view = 'wiki';
          state.wikiPage = page;
        },
      })),
      { label: 'Import a patch', detail: 'Patches', go: () => (state.view = 'patches') },
      { label: 'Create file', detail: 'Commit a new file', go: () => editor() },
    ].filter((option) => option.label.toLowerCase().includes(value));
    results.innerHTML =
      options
        .map(
          (option, i) =>
            `<button class="result" data-result="${i}">${escape(option.label)}<small>${escape(option.detail)}</small></button>`,
        )
        .join('') || '<p class="muted">No demo results.</p>';
    results.querySelectorAll('[data-result]').forEach((button) => {
      button.onclick = () => {
        closeModal();
        options[Number(button.dataset.result)].go();
        showRepository();
      };
    });
  };
  query.oninput = update;
  update();
}
function showPage(html) {
  repositoryView.hidden = true;
  homeView.hidden = false;
  homeView.innerHTML = html;
}
function showHome(signedOut = false) {
  showPage(
    signedOut
      ? `<section class="hero"><p class="eyebrow">Local demonstration</p><h1>You are signed out.</h1><p>This static demo has no server session. Sign back in as Alice to continue with the seeded account.</p><button class="primary" id="sign-in">Sign in as Alice</button></section>`
      : `<section class="hero"><p class="eyebrow">Git, without the clutter</p><h1>A focused home<br>for your repositories.</h1><p>Browse code, review changes as patches, fork and merge, and keep wikis and releases beside the work—without project-management machinery getting in the way.</p><div class="hero-actions"><button class="primary" id="create-repository">Create repository</button><button id="open-repository">Open paper-trail</button></div></section>`,
  );
  document.querySelector('#open-repository')?.addEventListener('click', showRepository);
  document.querySelector('#sign-in')?.addEventListener('click', () => showHome());
  document
    .querySelector('#create-repository')
    ?.addEventListener('click', () =>
      openModal(
        'Create repository',
        '<label>Owner<select><option>alice</option><option>paper-trail</option></select></label><label>Name<input value="field-notes"></label><label>Description<input value="Small observations worth keeping."></label><label><input class="inline-check" type="checkbox" checked> Initialize with a README</label><div class="modal-actions"><button value="cancel">Cancel</button><button class="primary" value="cancel">Create repository</button></div>',
      ),
    );
}
function showExplore() {
  showPage(
    `<section class="page-heading"><p class="eyebrow">Explore</p><h1>Repositories you can access</h1><p>Private repositories appear only when your account has permission.</p></section><section class="directory"><button class="directory-item" id="explore-repository"><span><strong>alice/paper-trail</strong><em>A small, durable record of decisions.</em><small>Public · ${state.stars + (state.starred ? 1 : 0)} stars · ${state.forks} forks</small></span><time>Updated ${latest().time}</time></button>${state.forkedCopies
      .map(
        (fork) =>
          `<button class="directory-item" data-demo-message="A fork is a full copy of every branch and tag, owned by you."><span><strong>${escape(fork.slug)}</strong><em>A small, durable record of decisions.</em><small>Public · forked from alice/paper-trail</small></span><time>Updated ${escape(fork.time)}</time></button>`,
      )
      .join(
        '',
      )}<button class="directory-item" data-demo-message="This private group repository is available as seeded demo data."><span><strong>paper-trail/field-guide</strong><em>Shared conventions for clear technical decisions.</em><small>Private · member access</small></span><time>Updated yesterday</time></button></section>`,
  );
  document.querySelector('#explore-repository').onclick = showRepository;
  bindDemoMessages();
}
const docs = {
  start: [
    'Getting Started',
    '<h2>Installation</h2><p>Install Node.js 24 LTS and Git, copy <code>config.example.yml</code>, choose persistent storage paths, and start Bareline. The first account becomes the administrator through a transactional bootstrap.</p><h2>Creating and cloning a repository</h2><p>Choose <strong>Create repository</strong>, give it a lowercase name, and optionally initialize a README.</p><pre>git clone git@server:alice/project.git\ncd project\ngit add README.md\ngit commit -m "Initial commit"\ngit push -u origin main</pre><h2>Git basics</h2><p>A commit is an immutable snapshot. A branch is a movable name pointing to a commit; a tag is normally a stable release name.</p>',
  ],
  deploy: [
    'Deployment and TLS',
    '<h2>Docker</h2><p>Run the non-root container with persistent storage mounted at <code>/var/lib/bareline</code>. Put Caddy, nginx, or Traefik in front and forward the original scheme and address only from a trusted proxy.</p><h2>Backups</h2><p>Backups include an online SQLite snapshot, configuration, plugins, repositories, and LFS data with a checksum manifest.</p>',
  ],
  upgrade: [
    'Upgrade and recovery',
    '<h2>Upgrading</h2><p>Verify the signed release bundle and SBOM, take a backup, then start the new version. Migrations are applied in order and checksummed, so a tampered or reordered migration refuses to run.</p><h2>Recovery</h2><p>Restore verifies the manifest before replacing data and can roll back to the previous state if the staged restore fails.</p>',
  ],
  git: [
    'Git guide',
    '<h2>Remotes and branches</h2><p>A remote gives a local repository a name for its server location. Fetch downloads changes; pull integrates them; push publishes your commits.</p><h2>Authentication</h2><p>HTTPS uses a personal access token. SSH requires adding your public key in account settings. Never upload your private key.</p>',
  ],
  workflows: [
    'Repository workflows',
    '<h2>Issues</h2><p>Numbered issues with Markdown descriptions, comments, labels, and one assignee. Readers can open issues and comment; labelling and assignment require write access.</p><h2>Patches and branch operations</h2><p>The <strong>Patches</strong> page accepts a pasted or uploaded patch, shows a dry-run preview against the target branch, and imports it as real commits without creating a working tree. A commit or a comparison range exports as <code>git format-patch</code> output.</p><p>Signed-in users can fork any repository they can read. Writers can cherry-pick or revert a non-merge commit onto a branch, or merge one branch into another; the merge fast-forwards where possible and otherwise writes a three-way merge commit.</p><h2>Wikis and releases</h2><p>Each wiki is a separate small Git repository of Markdown pages whose visibility follows the parent. Releases record an existing tag with Markdown notes and optional downloadable assets.</p><h2>Insights and stars</h2><p>Insights report a per-language byte breakdown and per-author commit counts for the selected ref, alongside fork and star counts.</p>',
  ],
  admin: [
    'Administration',
    '<h2>Users, groups, and permissions</h2><p>Repository access is centralized into read, write, admin, and owner roles. Private repository names are excluded from responses unless the caller may view them.</p><h2>Operations</h2><p>Use the audit log, search status, storage report, and doctor command to operate an installation.</p>',
  ],
  operations: [
    'Operations and backups',
    '<h2>Backup</h2><p>The administrative CLI creates a verified bundle containing SQLite, configuration, plugins, repositories, and LFS data.</p><pre>bareline backup --output /safe/backup</pre><h2>Restore</h2><p>Restore verifies the checksum manifest and refuses to replace existing data without explicit confirmation.</p>',
  ],
  api: [
    'REST API',
    '<h2>Versioned HTTP API</h2><p>Endpoints live under <code>/api/v1</code>. Personal access tokens are scoped, expiring, revocable, and shown only once.</p><pre>Authorization: Bearer bl_pat_...</pre><p>Interactive OpenAPI documentation is available from the server at <code>/api/docs</code>. A plain-text summary for LLM-based tools is served at <code>/llms.txt</code>.</p>',
  ],
  plugins: [
    'Plugins',
    '<h2>Capability-based extensions</h2><p>Sandboxed WASM plugins receive only approved capabilities. Trusted Node plugins are server software and require an explicit trust decision.</p><h2>Settings and storage</h2><p>Core renders schema-defined settings and gives plugins isolated, namespaced storage.</p>',
  ],
  themes: [
    'Themes and accessibility',
    '<h2>Appearance</h2><p>Choose light, dark, or system mode and configure the accent, interface font, and code font from account settings.</p><h2>Accessibility</h2><p>Bareline uses semantic HTML, visible focus states, keyboard navigation, reduced-motion support, and responsive layouts.</p>',
  ],
  ssh: [
    'SSH setup',
    '<h2>Forced commands</h2><p>Bareline integrates with OpenSSH. Registered keys can invoke only approved Git operations and never receive an interactive shell.</p><pre>bareline ssh setup --config config.yml</pre>',
  ],
  security: [
    'Security and threat model',
    '<h2>Repositories are hostile input</h2><p>Git runs without a shell, paths and refs are validated, expensive output is bounded, and repository hooks, filters, and textconv are not executed while browsing.</p><h2>Plugin trust</h2><p>Sandboxed extensions use a capability boundary. Trusted Node plugins are equivalent to installing server software.</p>',
  ],
  assurance: [
    'Security assurance',
    '<h2>Evidence</h2><p>Unit, integration, fuzz, and release-smoke suites run in CI alongside CodeQL, dependency review, and supply-chain policy checks. Container images ship with an SBOM, provenance, and a Cosign signature.</p>',
  ],
  readiness: [
    'Production readiness',
    '<h2>Release checks</h2><p>Production releases require migrations, authentication and authorization, transport integration, resource limits, backup verification, packaging, and security-focused tests to pass together.</p>',
  ],
};
function showDocs(selected = 'start') {
  const [heading, content] = docs[selected] || docs.start;
  showPage(
    `<div class="docs-layout"><aside><h2>Documentation</h2>${Object.entries(docs)
      .map(
        ([id, entry]) =>
          `<button class="${id === selected ? 'selected' : ''}" data-doc="${id}">${entry[0]}</button>`,
      )
      .join('')}</aside><article class="doc-article"><h1>${heading}</h1>${content}</article></div>`,
  );
  document.querySelectorAll('[data-doc]').forEach((button) => {
    button.onclick = () => showDocs(button.dataset.doc);
  });
}
function showGroups(create = false) {
  showPage(
    `<div class="section-layout"><aside><button class="selected" data-group-view="list">Your groups</button><button data-group-view="create">Create group</button></aside><section class="section-content"><h1>${create ? 'Create group' : 'Your groups'}</h1>${create ? '<form class="panel compact" id="group-form"><label>Group name<input required value="design-notes"></label><label>Display name<input required value="Design Notes"></label><label>Description<textarea>Shared design records and references.</textarea></label><button class="primary">Create group</button></form>' : '<div class="panel-list"><button data-demo-message="Group detail pages manage members and owned repositories."><strong>Paper Trail</strong><span><code>paper-trail</code> · owner</span></button></div>'}</section></div>`,
  );
  document.querySelector('[data-group-view="list"]').onclick = () => showGroups(false);
  document.querySelector('[data-group-view="create"]').onclick = () => showGroups(true);
  document.querySelector('#group-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    openModal(
      'Group created',
      '<p>The demo created <strong>Design Notes</strong> locally. No server data was changed.</p>',
    );
  });
  bindDemoMessages();
}
const adminSections = {
  overview: [
    'System overview',
    `<div class="metrics"><div><strong>1</strong><span>Users</span></div><div><strong>1</strong><span>Groups</span></div><div><strong>2</strong><span>Repositories</span></div><div><strong>1</strong><span>Plugins</span></div><div><strong>1</strong><span>Sessions</span></div></div><dl class="system-list"><dt>Application</dt><dd>1.1.0</dd><dt>Node.js</dt><dd>v24 LTS</dd><dt>Git</dt><dd>git version 2.47.3</dd><dt>SQLite</dt><dd>WAL · healthy</dd><dt>Repository storage</dt><dd>Writable · 2 repositories</dd><dt>SSH</dt><dd>Enabled</dd></dl>`,
  ],
  users: [
    'Users',
    '<div class="panel-list"><button data-demo-message="User administration supports disable, promote, and session revocation."><strong>Alice Nguyen</strong><span><code>alice</code> · Administrator · Active</span></button></div>',
  ],
  repos: [
    'Repositories',
    '<div class="panel-list"><button id="admin-repository"><strong>alice/paper-trail</strong><span>Public · managed bare repository</span></button><button data-demo-message="Private repositories remain permission-filtered throughout Bareline."><strong>paper-trail/field-guide</strong><span>Private · managed bare repository</span></button></div>',
  ],
  plugins: [
    'Plugins',
    '<div class="plugin-row"><div><strong>Repository Word Count</strong><p>Enabled · Sandboxed WASM · v1.0.0</p><small><span class="status">✓ Repository contents: Read</span> · ✕ Network · ✕ Filesystem</small></div><div><button data-demo-message="Plugin settings are generated from its manifest schema.">Settings</button> <button data-demo-message="The demo keeps this plugin enabled.">Disable</button></div></div>',
  ],
  audit: [
    'Audit log',
    '<div class="audit"><p><strong>patch.importedViaWeb</strong><span>Alice Nguyen · alice/paper-trail · today</span></p><p><strong>repository.pushed</strong><span>Alice Nguyen · alice/paper-trail · 2 hours ago</span></p><p><strong>session.login_succeeded</strong><span>Alice Nguyen · today</span></p><p><strong>repository.created</strong><span>Alice Nguyen · alice/paper-trail · 3 days ago</span></p></div>',
  ],
  search: [
    'Search index',
    '<div class="panel"><p class="status">Healthy</p><p>2 repositories indexed · 14 files · 2 issues · last incremental update 2 hours ago.</p><button data-demo-message="A real installation schedules a bounded background rebuild.">Rebuild index</button></div>',
  ],
};
function showAdmin(selected = 'overview') {
  const [heading, content] = adminSections[selected] || adminSections.overview;
  showPage(
    `<div class="section-layout"><aside><p class="eyebrow">Administration</p>${Object.entries(
      adminSections,
    )
      .map(
        ([id, entry]) =>
          `<button class="${id === selected ? 'selected' : ''}" data-admin="${id}">${entry[0] === 'System overview' ? 'Overview' : entry[0]}</button>`,
      )
      .join(
        '',
      )}</aside><section class="section-content"><h1>${heading}</h1>${content}</section></div>`,
  );
  document.querySelectorAll('[data-admin]').forEach((button) => {
    button.onclick = () => showAdmin(button.dataset.admin);
  });
  document.querySelector('#admin-repository')?.addEventListener('click', showRepository);
  bindDemoMessages();
}
function showAccount(selected = 'profile') {
  const titles = {
    profile: 'Profile',
    appearance: 'Appearance',
    security: 'Sessions and security',
    keys: 'SSH keys',
    tokens: 'Personal access tokens',
  };
  const content =
    selected === 'appearance'
      ? '<div class="panel compact"><label>Theme<select><option>System</option><option>Light</option><option>Dark</option></select></label><label>Accent color<select><option>Violet</option><option>Green</option><option>Amber</option></select></label><button class="primary" data-demo-message="Appearance preference saved for this demo.">Save appearance</button></div>'
      : selected === 'security'
        ? '<div class="panel"><h3>Current session</h3><p>Demo browser · Amsterdam · active now</p><p class="muted">Two-factor authentication is available on the server with TOTP and single-use backup codes.</p><button data-demo-message="Other sessions would be revoked on the server.">Log out everywhere else</button></div>'
        : selected === 'keys'
          ? '<div class="panel"><h3>alice-laptop</h3><p><code>SHA256:q3DemoFingerprint</code></p><button data-demo-message="The demo does not accept real credentials.">Add SSH key</button></div>'
          : selected === 'tokens'
            ? '<div class="panel"><p>Tokens are shown only once and stored hashed.</p><label>Limit to repository<select><option>All repositories you can access</option><option>alice/paper-trail</option></select></label><p class="muted">A repository token is refused on every other repository and on all account and administration endpoints — the credential to hand an agent or a CI job.</p><button data-demo-message="The static demo never generates real credentials.">Create token</button></div>'
            : '<form class="panel compact"><label>Username<input value="alice" readonly></label><label>Display name<input value="Alice Nguyen"></label><label>Public email<input value="alice@example.test"></label><button class="primary" data-demo-message="Profile saved for this demo.">Save profile</button><hr><button type="button" data-global="logout">Log out</button></form>';
  showPage(
    `<div class="section-layout"><aside><p class="eyebrow">User settings</p>${Object.entries(titles)
      .map(
        ([id, label]) =>
          `<button class="${id === selected ? 'selected' : ''}" data-account="${id}">${label}</button>`,
      )
      .join(
        '',
      )}</aside><section class="section-content"><h1>${titles[selected]}</h1>${content}</section></div>`,
  );
  document.querySelectorAll('[data-account]').forEach((button) => {
    button.onclick = () => showAccount(button.dataset.account);
  });
  bindDemoMessages();
  homeView.querySelector('[data-global="logout"]')?.addEventListener('click', () => showHome(true));
}
function bindDemoMessages() {
  document.querySelectorAll('[data-demo-message]').forEach((button) => {
    button.onclick = (event) => {
      event.preventDefault();
      openModal('Interactive demo', `<p>${escape(button.dataset.demoMessage)}</p>`);
    };
  });
}
function showRepository() {
  homeView.hidden = true;
  repositoryView.hidden = false;
  render();
}
function globalAction(action) {
  if (action === 'home') return showHome();
  if (action === 'explore') return showExplore();
  if (action === 'docs') return showDocs();
  if (action === 'groups') return showGroups();
  if (action === 'admin') return showAdmin();
  if (action === 'account') return showAccount();
  if (action === 'logout') return showHome(true);
}
document.querySelectorAll('[data-view]').forEach((button) => {
  button.onclick = () => {
    state.view = button.dataset.view;
    state.file = null;
    state.issue = null;
    render();
  };
});
document.querySelector('#search').onclick = palette;
document.querySelector('#clone').onclick = () =>
  openModal(
    'Clone paper-trail',
    '<label>HTTPS<input readonly value="https://demo.bareline.dev/alice/paper-trail.git"></label><label>SSH<input readonly value="git@demo.bareline.dev:alice/paper-trail.git"></label>',
  );
document.querySelector('#pin').onclick = () => {
  state.pinned = !state.pinned;
  save();
  updateRepositoryActions();
};
document.querySelector('#star').onclick = () => {
  state.starred = !state.starred;
  save();
  updateRepositoryActions();
};
document.querySelector('#fork').onclick = () =>
  openModal(
    'Fork paper-trail',
    '<p>A fork copies every branch and tag into a repository you own, so you can work independently and send changes back as a patch.</p><label>Owner<select><option>alice</option><option>paper-trail</option></select></label><label>Repository name<input id="fork-slug" value="paper-trail"></label><div class="modal-actions"><button value="cancel">Cancel</button><button class="primary" type="button" id="fork-create">Create fork</button></div>',
  );
document.querySelector('#settings').onclick = () => {
  state.view = 'settings';
  state.file = null;
  render();
};
const themes = ['system', 'light', 'dark'];
document.querySelector('#theme').onclick = () => {
  const current = document.documentElement.dataset.theme ?? 'system';
  const next = themes[(themes.indexOf(current) + 1) % themes.length];
  document.documentElement.dataset.theme = next;
  localStorage.setItem('bareline-demo-theme', next);
  document.querySelector('#theme').textContent = `Theme: ${next}`;
};
document.querySelectorAll('[data-global]').forEach((button) => {
  button.onclick = () => globalAction(button.dataset.global);
});
document.querySelector('#brand-home').onclick = (event) => {
  event.preventDefault();
  showHome();
};
document.querySelector('#reset').onclick = () => {
  state = structuredClone(seed);
  patchDraft = null;
  save();
  render();
};
modal.addEventListener('click', (event) => {
  if (event.target?.id !== 'fork-create') return;
  const slug = document.querySelector('#fork-slug')?.value.trim() || 'paper-trail';
  state.forks += 1;
  state.forkedCopies.unshift({ slug: `alice/${slug}`, time: 'just now' });
  state.activity.unshift({ action: 'repository.forked', detail: slug, time: 'just now' });
  save();
  closeModal();
  updateRepositoryActions();
  openModal(
    'Fork created',
    `<p>Created <strong>alice/${escape(slug)}</strong> with every branch and tag from the original. It appears under Explore in this demo.</p>`,
  );
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    palette();
  }
});
const storedTheme = localStorage.getItem('bareline-demo-theme');
if (storedTheme && storedTheme !== 'system') document.documentElement.dataset.theme = storedTheme;
document.querySelector('#theme').textContent = `Theme: ${storedTheme ?? 'system'}`;
render();
