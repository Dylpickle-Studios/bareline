const storageKey = 'bareline-demo-v2';
const seed = {
  view: 'code',
  branch: 'main',
  file: null,
  directory: '',
  branches: ['main', 'feature/reading-mode'],
  tags: ['v0.1.0'],
  pinned: true,
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
      file: 'README.md',
      before: '# Paper Trail\n\nA small record.\n',
      after:
        '# Paper Trail\n\nA small, durable record of decisions.\n\n## Principles\n\n- Keep the work visible.\n- Prefer durable tools.\n',
      time: '2 hours ago',
    },
    {
      id: '8f29b90',
      subject: 'Add entry model',
      file: 'src/entries.js',
      before: '',
      after:
        'export const entries = [];\n\nexport function addEntry(entry) {\n  entries.push(entry);\n}\n',
      time: 'Yesterday',
    },
    {
      id: '21b9a0c',
      subject: 'Initial commit',
      file: 'README.md',
      before: '',
      after: '# Paper Trail\n\nA small record.\n',
      time: '3 days ago',
    },
  ],
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
function openModal(name, html) {
  title.textContent = name;
  body.innerHTML = html;
  modal.showModal();
}
function lines(text) {
  return text
    .split('\n')
    .map((line, i) => `<span class="n">${i + 1}</span>${escape(line)}\n`)
    .join('');
}
function diffs(before, after) {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  return (
    `${oldLines
      .filter((line) => !newLines.includes(line))
      .map((line) => `<li class="minus">− ${escape(line)}</li>`)
      .join('')}${newLines
      .filter((line) => !oldLines.includes(line))
      .map((line) => `<li class="plus">+ ${escape(line)}</li>`)
      .join('')}` || '<li>No textual changes</li>'
  );
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
  app.innerHTML = `${state.directory ? `<nav class="breadcrumbs" aria-label="Breadcrumb"><button data-directory="">root</button>${crumbs.map((crumb) => `<span>/</span><button data-directory="${escape(crumb.path)}">${escape(crumb.name)}</button>`).join('')}</nav>` : ''}<div class="bar"><label><select id="branch" aria-label="Branch">${state.branches.map((branch) => `<option ${branch === state.branch ? 'selected' : ''}>${escape(branch)}</option>`).join('')}</select></label><span>Switch</span><small>${folders.length + files.length} items</small><button id="new-file">New file</button><button id="upload-file">Upload</button></div><div class="latest"><span><b class="sha">${top.id}</b> ${escape(top.subject)}</span><small>Alice Nguyen · ${top.time}</small></div><ul class="list">${folders.map((folder) => `<li class="row"><span class="folder">▰</span><button class="name" data-folder="${escape(prefix + folder)}">${escape(folder)}</button><small>folder</small></li>`).join('')}${files.map((file) => fileRow(file, file.slice(prefix.length))).join('')}</ul>${state.file ? showFile(state.file) : !state.directory && state.files['README.md'] ? `<section class="card"><header>README <button id="edit-readme">Edit</button></header><article class="markdown"><h2>Paper Trail</h2><p>A small, durable record of decisions.</p><h3>Principles</h3><p>Keep the work visible. Prefer durable tools.</p></article></section>` : ''}`;
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
  app.innerHTML = `<ul class="list">${state.commits.map((commit) => `<li class="row"><button data-commit="${commit.id}"><strong>${escape(commit.subject)}</strong><br><small><b class="sha">${commit.id}</b> · Alice Nguyen · ${commit.time}</small></button><span class="stats"><b class="add">+${Math.max(1, commit.after.split('\n').length - 1)}</b> <b class="del">−${Math.max(0, commit.before.split('\n').length - 1)}</b></span></li>`).join('')}</ul>${state.file?.startsWith('commit:') ? showDiff(state.commits.find((commit) => commit.id === state.file.slice(7))) : ''}`;
  document.querySelectorAll('[data-commit]').forEach((button) => {
    button.onclick = () => {
      state.file = `commit:${button.dataset.commit}`;
      render();
    };
  });
}
function showDiff(commit) {
  return `<section class="card"><header><span>${escape(commit.file)} · ${escape(commit.subject)}</span><button id="back">Close</button></header><ul class="diff">${diffs(commit.before, commit.after)}</ul></section>`;
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
  app.innerHTML = `<div class="bar"><label>Base <select><option>main</option></select></label><label>Compare <select><option>${escape(state.branch)}</option></select></label></div><section class="card"><header><span>${escape(commit.file)} · ${commit.id}</span><span class="stats"><b class="add">+${commit.after.split('\n').length - 1}</b> <b class="del">−${commit.before.split('\n').length - 1}</b></span></header><ul class="diff">${diffs(commit.before, commit.after)}</ul></section>`;
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
  if (state.view === 'activity') showActivity();
  if (state.view === 'settings') showSettings();
  document.querySelector('#back')?.addEventListener('click', () => {
    state.file = null;
    render();
  });
  document.querySelector('#edit')?.addEventListener('click', () => editor(state.file));
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
    preview.textContent = contentsEditor.value;
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
    state.commits.unshift({
      id: Math.random().toString(16).slice(2, 9),
      subject: message,
      file: path,
      before,
      after: contents,
      time: 'just now',
    });
    state.activity.unshift({
      action: 'commit.createdViaWeb',
      detail: state.branch,
      time: 'just now',
    });
    state.file = path;
    save();
    closeModal();
    render();
  };
}
function referenceForm(type) {
  openModal(
    `New ${type === 'branches' ? 'branch' : 'tag'}`,
    `<label>Name<input id="ref" autofocus></label><div class="modal-actions"><button value="cancel">Cancel</button><button class="primary" type="button" id="create">Create</button></div>`,
  );
  document.querySelector('#create').onclick = () => {
    const ref = document.querySelector('#ref').value.trim();
    if (!ref) return;
    state[type].push(ref);
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
        render();
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
      : `<section class="hero"><p class="eyebrow">Git, without the clutter</p><h1>A focused home<br>for your repositories.</h1><p>Browse code, understand history, and move work over SSH or HTTPS—without project-management machinery getting in the way.</p><div class="hero-actions"><button class="primary" id="create-repository">Create repository</button><button id="open-repository">Open paper-trail</button></div></section>`,
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
    `<section class="page-heading"><p class="eyebrow">Explore</p><h1>Repositories you can access</h1><p>Private repositories appear only when your account has permission.</p></section><section class="directory"><button class="directory-item" id="explore-repository"><span><strong>alice/paper-trail</strong><em>A small, durable record of decisions.</em><small>Public</small></span><time>Updated ${latest().time}</time></button><button class="directory-item" data-demo-message="This private group repository is available as seeded demo data."><span><strong>paper-trail/field-guide</strong><em>Shared conventions for clear technical decisions.</em><small>Private · member access</small></span><time>Updated yesterday</time></button></section>`,
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
  git: [
    'Git guide',
    '<h2>Remotes and branches</h2><p>A remote gives a local repository a name for its server location. Fetch downloads changes; pull integrates them; push publishes your commits.</p><h2>Authentication</h2><p>HTTPS uses a personal access token. SSH requires adding your public key in account settings. Never upload your private key.</p>',
  ],
  admin: [
    'Administration',
    '<h2>Users, groups, and permissions</h2><p>Repository access is centralized into read, write, admin, and owner roles. Private repository names are excluded from responses unless the caller may view them.</p><h2>Operations</h2><p>Use the audit log, search status, storage report, and doctor command to operate an installation.</p>',
  ],
  api: [
    'REST API',
    '<h2>Versioned HTTP API</h2><p>Endpoints live under <code>/api/v1</code>. Personal access tokens are scoped, expiring, revocable, and shown only once.</p><pre>Authorization: Bearer bl_pat_...</pre><p>Interactive OpenAPI documentation is available from the server at <code>/api/docs</code>.</p>',
  ],
  plugins: [
    'Plugins',
    '<h2>Capability-based extensions</h2><p>Sandboxed WASM plugins receive only approved capabilities. Trusted Node plugins are server software and require an explicit trust decision.</p><h2>Settings and storage</h2><p>Core renders schema-defined settings and gives plugins isolated, namespaced storage.</p>',
  ],
  operations: [
    'Operations and backups',
    '<h2>Backup</h2><p>The administrative CLI creates a verified bundle containing SQLite, configuration, plugins, repositories, and LFS data.</p><pre>bareline backup --output /safe/backup</pre><h2>Restore</h2><p>Restore verifies the checksum manifest and refuses to replace existing data without explicit confirmation.</p>',
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
    `<div class="metrics"><div><strong>1</strong><span>Users</span></div><div><strong>1</strong><span>Groups</span></div><div><strong>2</strong><span>Repositories</span></div><div><strong>1</strong><span>Plugins</span></div><div><strong>1</strong><span>Sessions</span></div></div><dl class="system-list"><dt>Application</dt><dd>0.1.0</dd><dt>Node.js</dt><dd>v24 LTS</dd><dt>Git</dt><dd>git version 2.47.3</dd><dt>SQLite</dt><dd>WAL · healthy</dd><dt>Repository storage</dt><dd>Writable · 2 repositories</dd><dt>SSH</dt><dd>Enabled</dd></dl>`,
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
    '<div class="audit"><p><strong>repository.pushed</strong><span>Alice Nguyen · alice/paper-trail · 2 hours ago</span></p><p><strong>session.login_succeeded</strong><span>Alice Nguyen · today</span></p><p><strong>repository.created</strong><span>Alice Nguyen · alice/paper-trail · 3 days ago</span></p></div>',
  ],
  search: [
    'Search index',
    '<div class="panel"><p class="status">Healthy</p><p>2 repositories indexed · 14 files · last incremental update 2 hours ago.</p><button data-demo-message="A real installation schedules a bounded background rebuild.">Rebuild index</button></div>',
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
      ? '<div class="panel compact"><label>Theme<select><option>System</option><option>Light</option><option>Dark</option></select></label><label>Accent color<input value="#236b5b"></label><button class="primary" data-demo-message="Appearance preference saved for this demo.">Save appearance</button></div>'
      : selected === 'security'
        ? '<div class="panel"><h3>Current session</h3><p>Demo browser · Amsterdam · active now</p><button data-demo-message="Other sessions would be revoked on the server.">Log out everywhere else</button></div>'
        : selected === 'keys'
          ? '<div class="panel"><h3>alice-laptop</h3><p><code>SHA256:q3DemoFingerprint</code></p><button data-demo-message="The demo does not accept real credentials.">Add SSH key</button></div>'
          : selected === 'tokens'
            ? '<div class="panel"><p>Tokens are shown only once and stored hashed.</p><button data-demo-message="The static demo never generates real credentials.">Create token</button></div>'
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
  document.querySelector('#pin').textContent = state.pinned ? 'Unpin' : 'Pin';
};
document.querySelector('#pin').textContent = state.pinned ? 'Unpin' : 'Pin';
document.querySelector('#settings').onclick = () => {
  state.view = 'settings';
  state.file = null;
  render();
};
document.querySelector('#theme').onclick = () => document.documentElement.classList.toggle('dark');
document.querySelectorAll('[data-global]').forEach((button) => {
  button.onclick = () => globalAction(button.dataset.global);
});
document.querySelector('#brand-home').onclick = (event) => {
  event.preventDefault();
  showHome();
};
document.querySelector('#reset').onclick = () => {
  state = structuredClone(seed);
  save();
  render();
  document.querySelector('#pin').textContent = 'Unpin';
};
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    palette();
  }
});
render();
