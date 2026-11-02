const api = window.claudeSwitcher;
const PALETTE = ['#9ca3af', '#6366f1', '#22c55e', '#ec4899', '#f59e0b', '#06b6d4', '#a855f7'];

let state = { claudeFound: true, instances: [] };
let editingId = null;
let editColor = null;
let loginTargetId = null;

const listEl = document.getElementById('list');

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function render() {
  document.getElementById('notFound').classList.toggle('hidden', state.claudeFound);
  if (!state.instances.length) {
    listEl.innerHTML = '<div class="empty">No instances yet. Click “+ New instance” to create one.</div>';
    return;
  }
  listEl.innerHTML = state.instances.map(i => {
    const run = i.status === 'Running';
    const meta = [i.isDefault ? 'default profile' : null, i.account].filter(Boolean).join(' · ');
    // A non-default instance that has never been seeded needs the login flow first.
    const needsLogin = !i.isDefault && !i.seeded;
    let primaryBtn;
    if (run) {
      primaryBtn = `<button class="icon-btn stop" data-act="stop" title="Stop">■</button>`;
    } else if (needsLogin) {
      primaryBtn = `<button class="btn-login" data-act="login" title="First-time login">Log in</button>`;
    } else {
      primaryBtn = `<button class="icon-btn play" data-act="launch" title="Launch">▶</button>`;
    }
    return `
    <div class="row" data-id="${i.id}">
      <div class="name-cell">
        <span class="dot" style="background:${esc(i.color)}"></span>
        <div class="name-text">
          <div class="name-line">${esc(i.name)}</div>
          ${meta ? `<div class="account">${esc(meta)}</div>` : ''}
        </div>
      </div>
      <div class="col-status ${run ? 'status-running' : ''}">${run ? 'Running' : 'Stopped'}</div>
      <div class="col-actions">
        ${primaryBtn}
        <button class="icon-btn" data-act="menu" title="Edit">⋮</button>
      </div>
    </div>`;
  }).join('');
}

async function refresh() { state = await api.getState(); render(); }

listEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  const row = e.target.closest('.row');
  if (!row) return;
  const id = row.dataset.id;
  if (!btn) { openEdit(id); return; }
  const act = btn.dataset.act;
  if (act === 'launch') {
    const res = await api.launch(id);
    if (!res.ok) alert(res.error || 'Could not launch.');
  } else if (act === 'stop') {
    await api.stop(id);
  } else if (act === 'login') {
    openLogin(id);
  } else if (act === 'menu') {
    openEdit(id);
  }
});

api.onStatus(({ id, status }) => {
  const inst = state.instances.find(i => i.id === id);
  if (inst) { inst.status = status; render(); }
  if (status === 'Stopped') setTimeout(refresh, 400); // refresh seeded flag after a login
});

// Footer --------------------------------------------------------------------
document.getElementById('newBtn').addEventListener('click', async () => { await api.newInstance(); await refresh(); });
document.getElementById('sessionBtn').addEventListener('click', () => {
  const lines = state.instances.map(i =>
    `• ${i.name}${i.account ? ' — ' + i.account : ''} — ${i.status || 'Stopped'}${(!i.isDefault && !i.seeded) ? ' (needs first login)' : ''}`
  ).join('\n');
  alert('Session Manager\n\n' + (lines || 'No instances.'));
});

// Help modal ----------------------------------------------------------------
const settingsModal = document.getElementById('settingsModal');
document.getElementById('settingsBtn').addEventListener('click', () => settingsModal.classList.remove('hidden'));
document.getElementById('settingsClose').addEventListener('click', () => settingsModal.classList.add('hidden'));

// Login modal (quiet-login: two steps around the manual sign-in) -------------
const loginModal = document.getElementById('loginModal');
const loginGo = document.getElementById('loginGo');
const loginCancel = document.getElementById('loginCancel');
const loginWarn = document.getElementById('loginWarn');
let loginPhase = 'begin'; // 'begin' -> 'finish'

function setLoginWarn(msg) {
  if (msg) { loginWarn.textContent = msg; loginWarn.style.display = ''; }
  else { loginWarn.style.display = 'none'; }
}

function openLogin(id) {
  const inst = state.instances.find(i => i.id === id);
  if (!inst) return;
  loginTargetId = id;
  loginPhase = 'begin';
  setLoginWarn('');
  document.getElementById('loginMsg').textContent =
    `Sign in to "${inst.name}"${inst.account ? ` (${inst.account})` : ''}. This closes Claude briefly — do it once per account.`;
  loginGo.textContent = 'Close Claude & open sign-in';
  loginGo.disabled = false;
  loginCancel.textContent = 'Cancel';
  loginModal.classList.remove('hidden');
}

function closeLogin() { loginModal.classList.add('hidden'); loginPhase = 'begin'; }

loginCancel.addEventListener('click', async () => {
  if (loginPhase === 'finish') {
    // A swap is live — undo it so profiles are restored.
    loginGo.disabled = true;
    await api.loginCancel(loginTargetId);
  }
  closeLogin();
  await refresh();
});

loginGo.addEventListener('click', async () => {
  if (loginPhase === 'begin') {
    loginGo.disabled = true;
    loginGo.textContent = 'Closing Claude…';
    const res = await api.loginBegin(loginTargetId);
    if (!res.ok) { setLoginWarn(res.error || 'Could not start sign-in.'); loginGo.disabled = false; loginGo.textContent = 'Close Claude & open sign-in'; return; }
    loginPhase = 'finish';
    setLoginWarn('A fresh Claude window is open. Sign in there, then click below. (Don\'t close it yourself — ClaudeSwitcher will.)');
    loginGo.textContent = "Done — I'm signed in";
    loginGo.disabled = false;
    loginCancel.textContent = 'Cancel sign-in';
  } else {
    loginGo.disabled = true;
    loginGo.textContent = 'Saving…';
    const res = await api.loginFinish(loginTargetId);
    if (!res.ok) { setLoginWarn(res.error || 'Could not save the sign-in.'); loginGo.disabled = false; loginGo.textContent = "Done — I'm signed in"; return; }
    closeLogin();
    await refresh();
  }
});

// Edit modal ----------------------------------------------------------------
const editModal = document.getElementById('editModal');
const swatchesEl = document.getElementById('swatches');
const acctInput = document.getElementById('editAccount');
const acctWarn = document.getElementById('acctWarn');

function openEdit(id) {
  const inst = state.instances.find(i => i.id === id);
  if (!inst) return;
  editingId = id;
  editColor = inst.color;
  document.getElementById('editName').value = inst.name || '';
  acctInput.value = inst.account || '';
  acctWarn.classList.add('hidden');
  document.getElementById('editDelete').style.display = inst.isDefault ? 'none' : '';
  document.getElementById('editLoginRow').style.display = inst.isDefault ? 'none' : '';
  swatchesEl.innerHTML = PALETTE.map(c =>
    `<div class="swatch ${c === editColor ? 'selected' : ''}" data-c="${c}" style="background:${c}"></div>`
  ).join('');
  editModal.classList.remove('hidden');
}

swatchesEl.addEventListener('click', (e) => {
  const sw = e.target.closest('.swatch');
  if (!sw) return;
  editColor = sw.dataset.c;
  [...swatchesEl.children].forEach(s => s.classList.toggle('selected', s.dataset.c === editColor));
});

acctInput.addEventListener('input', async () => {
  const res = await api.accountConflict({ id: editingId, account: acctInput.value });
  if (res.conflict) {
    acctWarn.textContent = `⚠ "${res.name}" already uses this account. The same account can't run in two instances.`;
    acctWarn.classList.remove('hidden');
  } else acctWarn.classList.add('hidden');
});

document.getElementById('editLogin').addEventListener('click', () => {
  const id = editingId;
  editModal.classList.add('hidden');
  openLogin(id);
});
document.getElementById('editCancel').addEventListener('click', () => editModal.classList.add('hidden'));
document.getElementById('editSave').addEventListener('click', async () => {
  const res = await api.accountConflict({ id: editingId, account: acctInput.value });
  if (res.conflict) {
    alert(`Account "${acctInput.value.trim()}" is already assigned to "${res.name}".\nUse a different account.`);
    return;
  }
  const inst = state.instances.find(i => i.id === editingId);
  if (inst) {
    inst.name = document.getElementById('editName').value.trim() || inst.name;
    inst.account = acctInput.value.trim();
    inst.color = editColor;
    await api.saveInstances(state.instances.map(({ status, seeded, ...rest }) => rest));
  }
  editModal.classList.add('hidden');
  await refresh();
});
document.getElementById('editDelete').addEventListener('click', async () => {
  if (!confirm('Delete this instance and its isolated profile data?')) return;
  await api.deleteInstance(editingId);
  editModal.classList.add('hidden');
  await refresh();
});

// Tray menu → "Log in / switch account…" opens the login dialog here.
api.onOpenLogin(async (id) => { await refresh(); openLogin(id); });

refresh();
