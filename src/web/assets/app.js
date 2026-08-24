const palette = document.querySelector('#command-palette');
const paletteInput = document.querySelector('#palette-search');

document.querySelectorAll('[data-dialog-open]').forEach((button) => {
  button.addEventListener('click', () => {
    if (!(button instanceof HTMLButtonElement)) return;
    const dialog = document.getElementById(button.dataset.dialogOpen ?? '');
    if (dialog instanceof HTMLDialogElement) dialog.showModal();
  });
});

function openPalette() {
  if (!(palette instanceof HTMLDialogElement)) return;
  palette.showModal();
  if (paletteInput instanceof HTMLInputElement) paletteInput.focus();
}

let paletteRequest;
paletteInput?.addEventListener('input', () => {
  clearTimeout(paletteRequest);
  paletteRequest = setTimeout(async () => {
    const response = await fetch(`/api/v1/palette?q=${encodeURIComponent(paletteInput.value)}`);
    const results = document.querySelector('#palette-results');
    if (!response.ok || !results) return;
    const body = await response.json();
    results.replaceChildren(
      ...body.items.map((item) => {
        const link = document.createElement('a');
        link.href = item.url;
        link.setAttribute('role', 'option');
        const title = document.createElement('strong');
        title.textContent = item.title;
        const subtitle = document.createElement('span');
        subtitle.textContent = item.subtitle;
        link.append(title, subtitle);
        return link;
      }),
    );
  }, 120);
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openPalette();
  }
});

const playgroundRun = document.querySelector('#playground-run');
const playgroundFrame = document.querySelector('#playground-frame');
const playgroundLogs = document.querySelector('#playground-logs');
if (playgroundRun instanceof HTMLButtonElement && playgroundFrame instanceof HTMLIFrameElement) {
  const runPlayground = () => {
    const read = (selector) => {
      const element = document.querySelector(selector);
      return element instanceof HTMLTextAreaElement ? element.value : '';
    };
    playgroundFrame.contentWindow?.postMessage(
      {
        type: 'playground.run',
        manifest: read('#playground-manifest'),
        code: read('#playground-code'),
        ui: read('#playground-ui'),
        css: read('#playground-css'),
      },
      '*',
    );
    const status = document.querySelector('#playground-status');
    if (status) status.textContent = 'Running…';
  };
  playgroundRun.addEventListener('click', runPlayground);
  let playgroundReload;
  document
    .querySelectorAll('#playground-manifest, #playground-code, #playground-ui, #playground-css')
    .forEach((editor) => {
      editor.addEventListener('input', () => {
        clearTimeout(playgroundReload);
        playgroundReload = setTimeout(runPlayground, 350);
      });
    });
  window.addEventListener('message', (event) => {
    if (
      event.source !== playgroundFrame.contentWindow ||
      !event.data ||
      event.data.type !== 'playground.result'
    )
      return;
    if (playgroundLogs) playgroundLogs.textContent = event.data.logs.join('\n');
    const status = document.querySelector('#playground-status');
    if (status) status.textContent = event.data.ok ? 'Completed' : 'Failed safely';
  });
}

const fromBase64url = (value) =>
  Uint8Array.from(
    atob(
      value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4),
    ),
    (character) => character.charCodeAt(0),
  );
const toBase64url = (value) =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
const publicKeyOptions = (options) => ({
  ...options,
  challenge: fromBase64url(options.challenge),
  ...(options.user ? { user: { ...options.user, id: fromBase64url(options.user.id) } } : {}),
  ...(options.excludeCredentials
    ? {
        excludeCredentials: options.excludeCredentials.map((item) => ({
          ...item,
          id: fromBase64url(item.id),
        })),
      }
    : {}),
  ...(options.allowCredentials
    ? {
        allowCredentials: options.allowCredentials.map((item) => ({
          ...item,
          id: fromBase64url(item.id),
        })),
      }
    : {}),
});
const credentialJSON = (credential) => ({
  id: credential.id,
  rawId: toBase64url(credential.rawId),
  type: credential.type,
  authenticatorAttachment: credential.authenticatorAttachment,
  clientExtensionResults: credential.getClientExtensionResults(),
  response:
    credential.response instanceof AuthenticatorAttestationResponse
      ? {
          clientDataJSON: toBase64url(credential.response.clientDataJSON),
          attestationObject: toBase64url(credential.response.attestationObject),
          transports: credential.response.getTransports(),
        }
      : {
          clientDataJSON: toBase64url(credential.response.clientDataJSON),
          authenticatorData: toBase64url(credential.response.authenticatorData),
          signature: toBase64url(credential.response.signature),
          userHandle: credential.response.userHandle
            ? toBase64url(credential.response.userHandle)
            : null,
        },
});
const passkeyStatus = (message) => {
  const status = document.querySelector('[data-passkey-status]');
  if (status) status.textContent = message;
};

document.querySelector('[data-passkey-register]')?.addEventListener('click', async (event) => {
  try {
    if (!(event.currentTarget instanceof HTMLElement) || !window.PublicKeyCredential)
      throw new Error('Passkeys are unavailable in this browser');
    const headers = {
      'content-type': 'application/json',
      'x-csrf-token': event.currentTarget.dataset.csrf ?? '',
    };
    const optionsResponse = await fetch('/api/v1/passkeys/registration/options', {
      method: 'POST',
      headers,
      body: '{}',
    });
    if (!optionsResponse.ok) throw new Error('Could not begin passkey enrollment');
    const options = await optionsResponse.json();
    const credential = await navigator.credentials.create({ publicKey: publicKeyOptions(options) });
    if (!(credential instanceof PublicKeyCredential))
      throw new Error('Passkey enrollment was cancelled');
    const name = document.querySelector('#passkey-name');
    const result = await fetch('/api/v1/passkeys/registration/verify', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        challenge: options.challenge,
        name: name instanceof HTMLInputElement ? name.value : 'Passkey',
        response: credentialJSON(credential),
      }),
    });
    if (!result.ok) throw new Error('Passkey verification failed');
    passkeyStatus('Passkey added.');
  } catch (error) {
    passkeyStatus(error instanceof Error ? error.message : 'Passkey enrollment failed');
  }
});

document.querySelector('[data-passkey-login]')?.addEventListener('click', async () => {
  try {
    if (!window.PublicKeyCredential) throw new Error('Passkeys are unavailable in this browser');
    const username = document.querySelector('input[name="username"]');
    const headers = { 'content-type': 'application/json' };
    const optionsResponse = await fetch('/api/v1/passkeys/authentication/options', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        username: username instanceof HTMLInputElement ? username.value : '',
      }),
    });
    const options = await optionsResponse.json();
    const credential = await navigator.credentials.get({ publicKey: publicKeyOptions(options) });
    if (!(credential instanceof PublicKeyCredential))
      throw new Error('Passkey sign-in was cancelled');
    const result = await fetch('/api/v1/passkeys/authentication/verify', {
      method: 'POST',
      headers,
      body: JSON.stringify({ challenge: options.challenge, response: credentialJSON(credential) }),
    });
    if (!result.ok) throw new Error('Passkey sign-in failed');
    location.assign('/');
  } catch (error) {
    passkeyStatus(error instanceof Error ? error.message : 'Passkey sign-in failed');
  }
});

const renderSplitDiff = (splitDiff) => {
  if (!(splitDiff instanceof HTMLElement)) return;
  const lines = splitDiff.dataset.lines?.split('\n') ?? [];
  const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(splitDiff.dataset.header ?? '');
  let oldLine = Number(range?.[1] ?? 1);
  let newLine = Number(range?.[2] ?? 1);
  const table = document.createElement('table');
  const appendChangedText = (cell, content, other) => {
    if (content.length > 20_000 || other.length > 20_000) {
      cell.textContent = content;
      return;
    }
    let prefix = 0;
    while (prefix < content.length && prefix < other.length && content[prefix] === other[prefix])
      prefix += 1;
    let suffix = 0;
    while (
      suffix < content.length - prefix &&
      suffix < other.length - prefix &&
      content[content.length - suffix - 1] === other[other.length - suffix - 1]
    )
      suffix += 1;
    cell.append(document.createTextNode(content.slice(0, prefix)));
    const changed = document.createElement('span');
    changed.className = 'intraline';
    changed.textContent = content.slice(prefix, suffix === 0 ? undefined : -suffix);
    cell.append(changed);
    if (suffix > 0) cell.append(document.createTextNode(content.slice(-suffix)));
  };
  const appendRow = (
    oldNumber,
    oldContent,
    newNumber,
    newContent,
    className = '',
    changedPair = false,
  ) => {
    const row = document.createElement('tr');
    if (className) row.className = className;
    const oldNumberCell = document.createElement('td');
    const oldCell = document.createElement('td');
    const newNumberCell = document.createElement('td');
    const newCell = document.createElement('td');
    oldNumberCell.className = 'line-number';
    newNumberCell.className = 'line-number';
    oldNumberCell.textContent = oldNumber === null ? '' : String(oldNumber);
    newNumberCell.textContent = newNumber === null ? '' : String(newNumber);
    if (changedPair && oldContent !== null && newContent !== null) {
      appendChangedText(oldCell, oldContent, newContent);
      appendChangedText(newCell, newContent, oldContent);
    } else {
      oldCell.textContent = oldContent ?? '';
      newCell.textContent = newContent ?? '';
    }
    if (oldContent !== null && (changedPair || newContent === null)) oldCell.className = 'deletion';
    if (newContent !== null && (changedPair || oldContent === null)) newCell.className = 'addition';
    row.append(oldNumberCell, oldCell, newNumberCell, newCell);
    table.append(row);
  };
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? '';
    if (line.startsWith('-') || line.startsWith('+')) {
      const deletions = [];
      const additions = [];
      while (index < lines.length && (lines[index]?.startsWith('-') ?? false)) {
        deletions.push((lines[index] ?? '').slice(1));
        index += 1;
      }
      while (index < lines.length && (lines[index]?.startsWith('+') ?? false)) {
        additions.push((lines[index] ?? '').slice(1));
        index += 1;
      }
      for (let changed = 0; changed < Math.max(deletions.length, additions.length); changed += 1) {
        const deletion = deletions[changed];
        const addition = additions[changed];
        appendRow(
          deletion === undefined ? null : oldLine++,
          deletion ?? null,
          addition === undefined ? null : newLine++,
          addition ?? null,
          '',
          deletion !== undefined && addition !== undefined,
        );
      }
      continue;
    }
    if (line.startsWith(' ')) appendRow(oldLine++, line.slice(1), newLine++, line.slice(1));
    else appendRow(null, line, null, line, 'diff-meta');
    index += 1;
  }
  splitDiff.replaceChildren(table);
};
const setDiffMode = (split) => {
  document.querySelectorAll('[data-diff-unified]').forEach((element) => {
    if (element instanceof HTMLElement) element.hidden = split;
  });
  document.querySelectorAll('[data-diff-split]').forEach((element) => {
    if (!(element instanceof HTMLElement)) return;
    element.hidden = !split;
    if (split && !element.firstChild) renderSplitDiff(element);
  });
  localStorage.setItem('diff-mode', split ? 'split' : 'unified');
};
document.querySelectorAll('[data-diff-mode]').forEach((button) =>
  button.addEventListener('click', () => {
    const split = button.getAttribute('data-diff-mode') === 'split';
    setDiffMode(split);
  }),
);
if (localStorage.getItem('diff-mode') === 'split') setDiffMode(true);

document.querySelectorAll('[data-image-slider]').forEach((slider) => {
  slider.addEventListener('input', () => {
    if (!(slider instanceof HTMLInputElement)) return;
    const after = slider.closest('[data-image-overlay]')?.querySelector('.image-overlay-after');
    if (after instanceof HTMLElement) after.style.clipPath = `inset(0 0 0 ${slider.value}%)`;
  });
});

const appendDiffFiles = (container, files) => {
  container.replaceChildren();
  for (const file of files) {
    const details = document.createElement('details');
    details.className = 'diff-file';
    details.id = file.anchor;
    details.open = true;
    const summary = document.createElement('summary');
    const path = document.createElement('strong');
    path.textContent = file.newPath;
    const stats = document.createElement('span');
    stats.textContent = `${file.status} · +${String(file.additions)} −${String(file.deletions)}`;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'quiet';
    copy.dataset.copy = file.newPath;
    copy.textContent = 'Copy path';
    summary.append(path, stats, copy);
    details.append(summary);
    if (file.binary) {
      const binary = document.createElement('p');
      binary.className = 'binary-state';
      binary.textContent = 'Binary file changed. Inline decoding is disabled.';
      details.append(binary);
    }
    if (file.truncated) {
      const notice = document.createElement('p');
      notice.className = 'notice';
      notice.textContent = 'This individual file diff reached the configured per-file byte limit.';
      details.append(notice);
    }
    for (const hunk of file.hunks) {
      const section = document.createElement('section');
      section.className = 'diff-hunk';
      section.id = hunk.anchor;
      const anchor = document.createElement('a');
      anchor.className = 'hunk-anchor';
      anchor.href = `#${hunk.anchor}`;
      anchor.textContent = hunk.header;
      const pre = document.createElement('pre');
      pre.className = 'diff';
      pre.dataset.diffUnified = '';
      const code = document.createElement('code');
      code.textContent = hunk.lines.join('\n');
      pre.append(code);
      const split = document.createElement('div');
      split.className = 'split-diff';
      split.dataset.diffSplit = '';
      split.dataset.lines = hunk.lines.join('\n');
      split.dataset.header = hunk.header;
      split.hidden = true;
      section.append(anchor, pre, split);
      details.append(section);
    }
    container.append(details);
  }
};

document.querySelector('[data-diff-more]')?.addEventListener('click', async (event) => {
  if (!(event.currentTarget instanceof HTMLElement)) return;
  const current = Number(document.querySelector('[data-diff-lines]')?.textContent ?? '0');
  const response = await fetch(
    `${event.currentTarget.dataset.endpoint}?lines=${String(Math.max(current * 2, 1))}`,
  );
  if (!response.ok) return;
  const body = await response.json();
  const container = document.querySelector('[data-diff-files]');
  if (container instanceof HTMLElement && Array.isArray(body.files))
    appendDiffFiles(container, body.files);
  const lines = document.querySelector('[data-diff-lines]');
  if (lines) lines.textContent = String(body.shownLines);
  if (!body.truncated) event.currentTarget.remove();
  setDiffMode(localStorage.getItem('diff-mode') === 'split');
});

document.querySelector('[data-diff-full]')?.addEventListener('click', async (event) => {
  if (!(event.currentTarget instanceof HTMLElement)) return;
  const response = await fetch(`${event.currentTarget.dataset.endpoint}?full=1`);
  if (!response.ok) return;
  const body = await response.json();
  const container = document.querySelector('[data-diff-files]');
  if (container instanceof HTMLElement && Array.isArray(body.files))
    appendDiffFiles(container, body.files);
  const lines = document.querySelector('[data-diff-lines]');
  if (lines) lines.textContent = String(body.shownLines);
  event.currentTarget.remove();
  if (!body.truncated) document.querySelector('[data-diff-more]')?.remove();
  setDiffMode(localStorage.getItem('diff-mode') === 'split');
});

document.addEventListener('click', async (event) => {
  const confirmation =
    event.target instanceof Element ? event.target.closest('[data-confirm]') : null;
  if (
    confirmation instanceof HTMLElement &&
    !window.confirm(confirmation.dataset.confirm ?? 'Continue?')
  ) {
    event.preventDefault();
    return;
  }
  const target = event.target instanceof Element ? event.target.closest('[data-copy]') : null;
  if (target instanceof HTMLElement) {
    const value = target.dataset.copy;
    if (!value) return;
    await navigator.clipboard.writeText(value);
    const previous = target.textContent;
    target.textContent = 'Copied';
    setTimeout(() => {
      target.textContent = previous;
    }, 1200);
    return;
  }
  if (event.target instanceof Element && event.target.closest('[data-palette-open]')) openPalette();
});
