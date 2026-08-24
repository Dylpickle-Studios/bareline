const storageKey = 'bareline-demo-v1';
const seed = {
  view: 'code',
  branch: 'main',
  file: null,
  branches: ['main', 'feature/reading-mode'],
  tags: ['v0.1.0'],
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
let state = JSON.parse(localStorage.getItem(storageKey) || 'null') || structuredClone(seed);
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
function fileRow(file) {
  return `<li class="row"><span>·</span><button class="name" data-file="${escape(file)}">${escape(file)}</button><small>${state.files[file].length} B</small></li>`;
}
function showCode() {
  const top = latest();
  const roots = [
    ...new Set(
      Object.keys(state.files)
        .filter((path) => path.includes('/'))
        .map((path) => path.split('/')[0]),
    ),
  ];
  const rootFiles = Object.keys(state.files)
    .filter((path) => !path.includes('/'))
    .sort();
  app.innerHTML = `<div class="bar"><label>Branch <select id="branch">${state.branches.map((branch) => `<option ${branch === state.branch ? 'selected' : ''}>${escape(branch)}</option>`).join('')}</select></label><small>${Object.keys(state.files).length} files</small></div><div class="latest"><span><b class="sha">${top.id}</b> ${escape(top.subject)}</span><small>Alice Nguyen · ${top.time}</small></div><ul class="list">${roots.map((folder) => `<li class="row"><span class="folder">▰</span><button class="name" data-folder="${folder}">${folder}</button><small>folder</small></li>`).join('')}${rootFiles.map(fileRow).join('')}</ul>${state.file ? showFile(state.file) : `<section class="card"><header>README.md <button id="edit-readme">Edit</button></header><article class="markdown"><h2>Paper Trail</h2><p>A small, durable record of decisions.</p><h3>Principles</h3><p>Keep the work visible. Prefer durable tools.</p></article></section>`}`;
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
      state.file = Object.keys(state.files).find((file) =>
        file.startsWith(`${button.dataset.folder}/`),
      );
      render();
    };
  });
  document.querySelector('#edit-readme')?.addEventListener('click', () => editor('README.md'));
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
  app.innerHTML = `<div class="bar"><strong>${type === 'branches' ? 'Branches' : 'Tags'}</strong><button class="primary" id="new-ref">New ${type === 'branches' ? 'branch' : 'tag'}</button></div><ul class="list">${refs.map((ref, index) => `<li class="row"><span><strong>${escape(ref)}</strong><br><small>${index === 0 ? 'default reference · ' : ''}${latest().id} · ${latest().time}</small></span><button data-ref="${escape(ref)}">Browse</button></li>`).join('')}</ul>`;
  document.querySelector('#new-ref').onclick = () => referenceForm(type);
  document.querySelectorAll('[data-ref]').forEach((button) => {
    button.onclick = () => {
      state.branch = button.dataset.ref;
      state.view = 'code';
      state.file = null;
      save();
      render();
    };
  });
}
function showCompare() {
  const commit = latest();
  app.innerHTML = `<div class="bar"><label>Base <select><option>main</option></select></label><label>Compare <select><option>${escape(state.branch)}</option></select></label></div><section class="card"><header><span>${escape(commit.file)} · ${commit.id}</span><span class="stats"><b class="add">+${commit.after.split('\n').length - 1}</b> <b class="del">−${commit.before.split('\n').length - 1}</b></span></header><ul class="diff">${diffs(commit.before, commit.after)}</ul></section>`;
}
function render() {
  document
    .querySelectorAll('[data-view]')
    .forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
  if (state.view === 'code') showCode();
  if (state.view === 'commits') showCommits();
  if (state.view === 'branches' || state.view === 'tags') showRefs(state.view);
  if (state.view === 'compare') showCompare();
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
    `<label>Path<input id="path" value="${escape(file)}" placeholder="notes/today.md"></label><label>Contents<textarea id="contents">${escape(current)}</textarea></label><label>Commit message<input id="message" value="${escape(file ? `Update ${file}` : 'Add file')}"></label><div class="modal-actions"><button value="cancel">Cancel</button><button class="primary" type="button" id="commit">Commit changes</button></div>`,
  );
  document.querySelector('#commit').onclick = () => {
    const path = document.querySelector('#path').value.trim();
    const contents = document.querySelector('#contents').value;
    const message = document.querySelector('#message').value.trim();
    if (!path || !message) return;
    const before = state.files[path] || '';
    state.files[path] = contents;
    state.commits.unshift({
      id: Math.random().toString(16).slice(2, 9),
      subject: message,
      file: path,
      before,
      after: contents,
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
function showHome(signedOut = false) {
  repositoryView.hidden = true;
  homeView.hidden = false;
  homeView.innerHTML = signedOut
    ? `<section class="card home-card"><div class="markdown"><h2>You are signed out</h2><p>This demo does not use a server session. Sign back in as Alice to continue exploring its local sample data.</p><button class="primary" id="sign-in">Sign in as Alice</button></div></section>`
    : `<section class="card home-card"><div class="markdown"><p class="eyebrow">Your home</p><h2>Welcome back, Alice.</h2><p>One repository is ready to browse in this interactive demo.</p></div><ul class="list"><li class="row"><span class="folder">▰</span><button class="name" id="open-repository"><strong>alice / paper-trail</strong><br><small>A small, durable record of decisions.</small></button><small>Public · updated ${latest().time}</small></li></ul></section>`;
  document.querySelector('#open-repository')?.addEventListener('click', showRepository);
  document.querySelector('#sign-in')?.addEventListener('click', () => showHome());
}
function showRepository() {
  homeView.hidden = true;
  repositoryView.hidden = false;
  render();
}
function globalAction(action) {
  if (action === 'home') return showHome();
  if (action === 'explore') return showHome();
  if (action === 'docs')
    return openModal(
      'Documentation',
      '<p class="muted">Getting Started, Git Basics, SSH keys, HTTPS authentication, backups, and plugins are available in the full Bareline documentation.</p>',
    );
  if (action === 'groups')
    return openModal(
      'Groups',
      '<p class="muted">Alice belongs to the demo group <strong>paper-trail</strong>. Group management is represented here because this static demo has no multi-user backend.</p>',
    );
  if (action === 'admin')
    return openModal(
      'Administration',
      '<p class="muted">In Bareline, administrators manage users, repositories, plugins, audit logs, search, and authentication. The full administration interface requires the server.</p>',
    );
  if (action === 'account')
    return openModal(
      'Alice Nguyen',
      '<p class="muted">Account settings include profile, appearance, sessions, SSH keys, passkeys, and personal access tokens.</p>',
    );
  if (action === 'logout') return showHome(true);
}
document.querySelectorAll('[data-view]').forEach((button) => {
  button.onclick = () => {
    state.view = button.dataset.view;
    state.file = null;
    render();
  };
});
document.querySelector('#new-file').onclick = () => editor();
document.querySelector('#search').onclick = palette;
document.querySelector('#clone').onclick = () =>
  openModal(
    'Clone paper-trail',
    '<label>HTTPS<input readonly value="https://demo.bareline.dev/alice/paper-trail.git"></label><label>SSH<input readonly value="git@demo.bareline.dev:alice/paper-trail.git"></label>',
  );
document.querySelector('#theme').onclick = () => document.documentElement.classList.toggle('dark');
document.querySelectorAll('[data-global]').forEach((button) => {
  button.onclick = () => globalAction(button.dataset.global);
});
document.querySelector('#reset').onclick = () => {
  state = structuredClone(seed);
  save();
  render();
};
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    palette();
  }
});
render();
