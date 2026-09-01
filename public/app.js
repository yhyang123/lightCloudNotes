/* nasCloudNote 前端逻辑（零依赖原生 JS） */
'use strict';

/* ================= 工具 ================= */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = msg;
  $('#toastBox').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2200);
  setTimeout(() => el.remove(), 2600);
}

/* ================= 状态 ================= */
const state = {
  expanded: new Set(),       // 已展开的文件夹 id
  activeFolder: null,        // 当前选中文件夹（null = 根）
  notes: [],                 // 当前文件夹的笔记列表
  currentNoteId: null,       // 当前打开的笔记
  dirty: false,              // 正文是否有未保存改动
  titleDirty: false,         // 标题是否有未保存改动
  saveTimer: null,
  suppressSave: false,
  editMode: false,           // 只读/编辑模式
  noteLocked: false,         // 当前笔记是否处于加密锁定态
};

/* 解锁令牌：会话级（sessionStorage）。
   一次解锁后在本会话内始终有效，不会因切换文件夹、切换笔记或页面切走而失效；
   只有用户点击「🔒 重新上锁」、修改该文件夹/笔记的密码，或关闭浏览器标签页时才失效。
   存储结构：{ folder: { <folderId>: token }, note: { <noteId>: token } }
   采用 id→令牌映射（而非纯令牌数组），手动上锁时才能精准撤销指定文件夹，不误伤其他已解锁文件夹。 */
const TOKEN_KEY = 'ncn_unlock_tokens';
function getTokens() {
  let box;
  try { box = JSON.parse(sessionStorage.getItem(TOKEN_KEY)) || {}; } catch (e) { box = {}; }
  /* 兼容旧版数组结构：旧令牌无法反查所属 id，直接丢弃重新解锁 */
  if (Array.isArray(box.folder) || Array.isArray(box.note)) box = {};
  if (!box.folder || typeof box.folder !== 'object') box.folder = {};
  if (!box.note || typeof box.note !== 'object') box.note = {};
  return box;
}
function saveTokens(box) {
  try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify(box)); } catch (e) { /* 忽略存储异常 */ }
}
function addToken(kind, id, t) {
  if (!id || !t) return;
  const box = getTokens();
  box[kind][id] = t;
  saveTokens(box);
}
function removeToken(kind, id) {
  const box = getTokens();
  if (box[kind][id]) { delete box[kind][id]; saveTokens(box); }
}
function clearAllTokens() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(OWNER_KEY);
}
function tokenHeader() {
  const box = getTokens();
  const folder = Object.keys(box.folder).map((k) => box.folder[k]);
  const note = Object.keys(box.note).map((k) => box.note[k]);
  return folder.concat(note).join(',');
}

/* 笔记归属登记表：noteId → folderId（根目录记为 '__root__'）。
   与会话令牌同生命周期持久化，不能只依赖 noteCache —— 缓存被清空后
   就反查不到归属，会导致上锁时漏撤该笔记的令牌（表现为上锁后笔记仍是已解锁态）。 */
const OWNER_KEY = 'ncn_note_owner';
function getOwners() {
  try {
    const o = JSON.parse(sessionStorage.getItem(OWNER_KEY));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch (e) { return {}; }
}
function saveOwners(o) {
  try { sessionStorage.setItem(OWNER_KEY, JSON.stringify(o)); } catch (e) { /* 忽略存储异常 */ }
}
/* 登记（或更新）一批笔记的归属 */
function rememberOwners(folderId, notes) {
  const o = getOwners();
  let changed = false;
  (notes || []).forEach((n) => {
    const key = folderId || '__root__';
    if (o[n.id] !== key) { o[n.id] = key; changed = true; }
  });
  if (changed) saveOwners(o);
}
function rememberOwner(noteId, folderId) {
  if (!noteId) return;
  const o = getOwners();
  const key = folderId || '__root__';
  if (o[noteId] !== key) { o[noteId] = key; saveOwners(o); }
}
function forgetOwner(noteId) {
  const o = getOwners();
  if (o[noteId]) { delete o[noteId]; saveOwners(o); }
}

/* ================= API ================= */
async function api(path, opts) {
  opts = opts || {};
  const headers = { 'X-Unlock': tokenHeader() };
  if (opts.body && typeof opts.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  if (opts.body && typeof opts.body === 'string') headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ================= 布局：侧栏拖拽 + 折叠（两栏） ================= */
const LAYOUT_KEY = 'ncn_layout';
function getLayout() {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; } catch (e) { return {}; }
}
function setLayout(patch) {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(Object.assign(getLayout(), patch)));
}
const sidebarEl = $('#sidebar');
const resizerSidebar = $('#resizerSidebar');

function applyLayout() {
  const L = getLayout();
  if (L.sidebarW) { sidebarEl.style.width = L.sidebarW + 'px'; sidebarEl.style.flex = 'none'; }
  if (L.sidebarHidden) collapsePane('sidebar');
}

function collapsePane(which) {
  sidebarEl.classList.add('collapsed');
  resizerSidebar.classList.add('hidden-resizer');
  $('#btnExpandSidebar').classList.remove('hidden');
  setLayout({ sidebarHidden: true });
}
function expandPane(which) {
  sidebarEl.classList.remove('collapsed');
  resizerSidebar.classList.remove('hidden-resizer');
  $('#btnExpandSidebar').classList.add('hidden');
  setLayout({ sidebarHidden: false });
}

/* 拖拽逻辑 */
function bindResizer(handle, pane, minW, maxW, saveKey) {
  let startX = 0, startW = 0;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = pane.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    const onMove = (ev) => {
      let w = startW + (ev.clientX - startX);
      w = Math.max(minW, Math.min(maxW, w));
      pane.style.width = w + 'px';
      pane.style.flex = 'none';
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const finalW = Math.round(pane.getBoundingClientRect().width);
      if (finalW >= minW) setLayout({ [saveKey]: finalW });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
bindResizer(resizerSidebar, sidebarEl, 200, 520, 'sidebarW');
applyLayout();

$('#btnCollapseSidebar').addEventListener('click', () => collapsePane('sidebar'));
$('#btnExpandSidebar').addEventListener('click', () => expandPane('sidebar'));

/* ================= 文件夹树 ================= */
let treeData = [];
const noteCache = {}; // folderId → notes 数组（null 表示未加载）

async function loadTree() {
  const data = await api('/api/tree');
  treeData = data.tree;
  renderTree();
}

/* 获取文件夹内笔记（带缓存）。
   403 表示需要解锁，与真正的加载失败区分开，避免把「已上锁」误报成「加载失败」 */
async function loadFolderNotes(folderId) {
  const key = folderId || '__root__';
  try {
    const url = folderId ? `/api/notes?folderId=${encodeURIComponent(folderId)}` : '/api/notes';
    const data = await api(url);
    noteCache[key] = data.notes;
    rememberOwners(folderId, data.notes);
  } catch (e) {
    noteCache[key] = e.status === 403 ? 'locked' : null;
  }
  renderTree();
}

function renderTree() {
  const container = $('#folderTree');
  container.innerHTML = '';

  /* 「全部笔记」（根级） */
  const allExpanded = state.expanded.has('__root__');
  const allRow = document.createElement('div');
  allRow.className = 'tree-node';
  allRow.innerHTML = `<div class="tree-row ${state.activeFolder === null ? 'active' : ''}">
    <span class="tree-caret ${allExpanded ? 'open' : ''}">▶</span>
    <span class="tree-folder-icon">🗂️</span>
    <span class="tree-name">全部笔记</span>
    <span class="tree-actions">
      <button class="tree-action" data-act="newnote" title="在根目录新建笔记">📝</button>
    </span>
  </div>`;
  allRow.querySelector('.tree-row').addEventListener('click', (e) => {
    if (e.target.closest('.tree-action')) return;
    toggleExpand('__root__');
    selectFolder(null, false);
  });
  allRow.querySelector('[data-act=newnote]').addEventListener('click', (e) => {
    e.stopPropagation();
    state.activeFolder = null;
    createNote(null);
  });
  container.appendChild(allRow);
  if (allExpanded) renderNotesBlock(container, null);

  const build = (nodes, parentEl) => {
    nodes.forEach((node) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'tree-node';
      const expanded = state.expanded.has(node.id);
      const isLocked = node.locked;
      const isUnlocked = !!node.unlocked;
      /* 已解锁的加密文件夹同样可以展开子级 */
      const showChildren = expanded && (!isLocked || isUnlocked) && node.children;
      const lockBtn = isLocked
        ? (isUnlocked
          ? `<button class="tree-action" data-act="lock" title="重新上锁">🔒</button>`
          : `<button class="tree-action" data-act="unlock" title="解锁">🔓</button>`)
        : '';

      /* 文件夹图标四态：加密未解锁 / 加密已解锁 / 普通展开 / 普通折叠
         同时用 data-lock 标记锁定状态，配合 CSS 做颜色与描边区分 */
      let folderIcon;
      let lockState;
      let iconTitle;
      if (isLocked && !isUnlocked) {
        folderIcon = '🔐';
        lockState = 'locked';
        iconTitle = '已加密（未解锁），点击输入密码';
      } else if (isLocked && isUnlocked) {
        folderIcon = expanded ? '📂' : '📁';
        lockState = 'unlocked';
        iconTitle = '已加密（本会话已解锁），点击 🔒 可重新上锁';
      } else {
        folderIcon = expanded ? '📂' : '📁';
        lockState = 'none';
        iconTitle = '普通文件夹';
      }

      const row = document.createElement('div');
      row.className = 'tree-row' + (state.activeFolder === node.id ? ' active' : '');
      row.dataset.lock = lockState;
      row.innerHTML = `
        <span class="tree-caret ${expanded ? 'open' : ''}">▶</span>
        <span class="tree-folder-icon" data-lock="${lockState}" title="${iconTitle}">${folderIcon}${lockState === 'unlocked' ? '<span class="lock-badge" aria-label="已解锁">🔓</span>' : ''}</span>
        <span class="tree-name" title="${esc(node.name)}">${esc(node.name)}</span>
        ${lockBtn}
        <span class="tree-actions">
          <button class="tree-action" data-act="newnote" title="在此文件夹新建笔记">📝</button>
          <button class="tree-action" data-act="new" title="新建子文件夹">＋</button>
          <button class="tree-action" data-act="del" title="删除">🗑</button>
        </span>`;

      row.addEventListener('click', (e) => {
        if (e.target.closest('.tree-action')) return;
        if (isLocked && !isUnlocked) {
          promptUnlock(node);
        } else {
          /* 先切换展开态，再以该状态选中（不强制展开），否则折叠会被立即撤销 */
          toggleExpand(node.id);
          selectFolder(node.id, false);
        }
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, { type: 'folder', id: node.id });
      });
      const unlockBtn = row.querySelector('[data-act=unlock]');
      if (unlockBtn) unlockBtn.addEventListener('click', (e) => { e.stopPropagation(); promptUnlock(node); });
      const lockBtnEl = row.querySelector('[data-act=lock]');
      if (lockBtnEl) lockBtnEl.addEventListener('click', (e) => { e.stopPropagation(); lockFolderNow(node); });
      row.querySelector('[data-act=newnote]').addEventListener('click', (e) => { e.stopPropagation(); createNote(node.id); });
      row.querySelector('[data-act=new]').addEventListener('click', () => promptNewFolder(node.id));
      row.querySelector('[data-act=del]').addEventListener('click', () => promptDeleteFolder(node));

      wrapper.appendChild(row);

      /* 子文件夹 */
      if (showChildren) {
        const childrenBox = document.createElement('div');
        childrenBox.className = 'tree-children';
        build(node.children || [], childrenBox);
        wrapper.appendChild(childrenBox);
      }
      /* 笔记列表 */
      if (expanded) {
        if (isLocked && !isUnlocked) {
          const lockRow = document.createElement('div');
          lockRow.className = 'tree-lock-row';
          lockRow.innerHTML = `🔒 已加密 <button class="flp-btn">解锁</button>${node.hint ? `<span style="color:var(--primary);font-size:11px">💡${esc(node.hint)}</span>` : ''}`;
          lockRow.querySelector('.flp-btn').addEventListener('click', () => promptUnlock(node));
          wrapper.appendChild(lockRow);
        } else {
          renderNotesBlock(wrapper, node.id);
        }
      }
      parentEl.appendChild(wrapper);
    });
  };
  build(treeData, container);
}

/* 渲染文件夹下的笔记列表块 */
function renderNotesBlock(parentEl, folderId) {
  const key = folderId || '__root__';
  const notes = noteCache[key];
  const block = document.createElement('div');
  block.className = 'tree-notes';

  if (notes === undefined) {
    block.innerHTML = '<div class="tree-note-row" style="color:var(--text2);font-size:12px">加载中…</div>';
    loadFolderNotes(folderId);
  } else if (notes === 'locked') {
    block.innerHTML = '<div class="tree-note-row" style="color:var(--text2);font-size:12px">🔐 需先解锁该文件夹</div>';
  } else if (!Array.isArray(notes)) {
    block.innerHTML = '<div class="tree-note-row" style="color:var(--danger);font-size:12px">加载失败</div>';
  } else {
    notes.forEach((n) => {
      const row = document.createElement('div');
      row.className = 'tree-note-row' + (n.id === state.currentNoteId ? ' active' : '');
      /* 笔记图标三态：加密未解锁 🔐 / 加密已解锁 📄+🔓 / 普通 📄 */
      let noteLockState = 'none';
      let noteIcon = '📄';
      let noteIconTitle = '普通笔记';
      if (n.locked && !n.unlocked) {
        noteLockState = 'locked';
        noteIcon = '🔐';
        noteIconTitle = '已加密（未解锁），点击输入密码';
      } else if (n.locked && n.unlocked) {
        noteLockState = 'unlocked';
        noteIcon = '📄';
        noteIconTitle = '已加密（本会话已解锁）';
      }
      row.dataset.lock = noteLockState;
      row.innerHTML = `
        <span class="tree-note-icon" data-lock="${noteLockState}" title="${noteIconTitle}">${noteIcon}${noteLockState === 'unlocked' ? '<span class="lock-badge" aria-label="已解锁">🔓</span>' : ''}</span>
        <span class="tree-note-name" title="${esc(n.title || '无标题笔记')}">${esc(n.title || '无标题笔记')}</span>
        <span class="tree-note-time">${fmtTime(n.updatedAt)}</span>
        <span class="tree-note-actions"></span>`;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.tree-action')) return;
        openNote(n.id);
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, { type: 'note', id: n.id, note: n });
      });
      block.appendChild(row);
    });
    if (!notes.length) {
      block.innerHTML = '<div class="tree-note-row" style="color:var(--text2);font-size:12px">（暂无笔记）</div>';
    }
  }
  parentEl.appendChild(block);
}

/* 纯切换展开态，不负责渲染 —— 调用方随后的 selectFolder 会统一渲染，
   避免同一次点击渲染两遍 */
function toggleExpand(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
}

/* 手动重新上锁：撤销该文件夹（含其全部子孙文件夹/笔记）的令牌，其他已解锁文件夹不受影响。
   注意子孙 id 不能只走 node.children —— 未解锁的加密子文件夹 children 为 null 会漏收，
   导致其令牌残留（下次解锁父文件夹时子文件夹会直接敞开），故由 folderSubtreeIds 兜底。 */
async function lockFolderNow(node) {
  const curOwner = state.currentNoteId ? noteFolderOf(state.currentNoteId) : null;
  const ids = purgeFolderSubtree(node.id);

  if (ids.has(state.activeFolder)) {
    closeEditor();
    state.activeFolder = null;
  } else if (curOwner && ids.has(curOwner)) {
    /* 当前打开的笔记位于被上锁的子树内，同样必须关闭编辑器 */
    closeEditor();
  }

  await loadTree();
  toast(`「${node.name}」已重新上锁`, 'success');
}

/* 在本地 treeData 上判断 folderId 是否为 ancestorId 的子孙 */
function isDescendantOf(folderId, ancestorId) {
  const anc = findNode(ancestorId);
  if (!anc) return false;
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (n.id === folderId) { found = true; return; }
    (n.children || []).forEach(walk);
  };
  (anc.children || []).forEach(walk);
  return found;
}

/* 收集某文件夹自身 + 全部子孙的 id（含令牌表兜底，避免未解锁子树漏收） */
function folderSubtreeIds(folderId) {
  const ids = new Set([folderId]);
  const node = findNode(folderId);
  const collect = (n) => {
    if (!n || ids.has(n.id)) return;
    ids.add(n.id);
    (n.children || []).forEach(collect);
  };
  if (node) (node.children || []).forEach(collect);
  Object.keys(getTokens().folder).forEach((fid) => {
    if (isDescendantOf(fid, folderId)) ids.add(fid);
  });
  return ids;
}

/* 彻底清理某文件夹子树的所有本地状态：令牌、归属登记、笔记缓存、展开态 */
function purgeFolderSubtree(folderId) {
  const ids = folderSubtreeIds(folderId);
  ids.forEach((id) => {
    removeToken('folder', id);
    state.expanded.delete(id);
    delete noteCache[id];
  });
  const owners = getOwners();
  Object.keys(owners).forEach((noteId) => {
    if (ids.has(owners[noteId])) {
      removeToken('note', noteId);
      forgetOwner(noteId);
    }
  });
  return ids;
}

/* 反查某笔记所属文件夹 id：先查持久化的归属登记表，再退回当前缓存 */
function noteFolderOf(noteId) {
  const owners = getOwners();
  if (owners[noteId]) return owners[noteId] === '__root__' ? null : owners[noteId];
  for (const key of Object.keys(noteCache)) {
    const list = noteCache[key];
    if (Array.isArray(list) && list.some((n) => n.id === noteId)) {
      return key === '__root__' ? null : key;
    }
  }
  return null;
}

/* 解锁后加载被锁文件夹的子树 */
async function loadChildren(nodeId) {
  try {
    const data = await api(`/api/folders/${nodeId}/children`);
    // 递归插入到 treeData
    const insertInto = (nodes, parentId) => {
      for (const n of nodes) {
        if (n.id === parentId) {
          /* 服务端已确认解锁成功；同步本地节点状态，否则 selectFolder 会误以为仍锁定，
             直接返回并只显示「需先解锁」，导致文件夹内列表不可见。 */
          n.unlocked = true;
          n.children = data.folders;
          return true;
        }
        if (n.children && insertInto(n.children, parentId)) return true;
      }
      return false;
    };
    if (!insertInto(treeData, nodeId)) return;
    state.expanded.add(nodeId);
    renderTree();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function findNode(id, nodes) {
  nodes = nodes || treeData;
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) { const r = findNode(id, n.children); if (r) return r; }
  }
  return null;
}

/* ================= 笔记列表 ================= */
/* forceExpand：非树点击的调用方（解锁后、删除后、搜索跳转）需要确保目标文件夹展开；
   树上点击则传 false —— 展开态已由 toggleExpand 决定，这里若再强制展开，
   用户点击折叠会被同一次点击立刻重新展开（表现为「文件夹展开后没法折叠」）。 */
async function selectFolder(folderId, forceExpand = true) {
  /* 已解锁的文件夹在本会话内保持解锁，切换文件夹不再撤销令牌（只有手动「🔒 重新上锁」才失效） */
  state.activeFolder = folderId;
  const node = folderId ? findNode(folderId) : null;
  $('#currentFolderName').textContent = node ? `📂 ${node.name}` : '🗂️ 全部笔记';

  /* 加锁且未解锁：关闭编辑器，树内占位由 renderTree 处理 */
  if (node && node.locked && !node.unlocked) {
    closeEditor();
    renderTree();
    return;
  }
  const key = folderId || '__root__';
  if (forceExpand) state.expanded.add(key);
  /* 处于折叠态就不必拉取笔记列表（列表不渲染），只刷新选中态即可 */
  if (!state.expanded.has(key)) {
    renderTree();
    return;
  }
  delete noteCache[key]; // 强制刷新
  await loadFolderNotes(folderId);
}

async function createNote(folderId) {
  try {
    if (folderId) {
      const node = findNode(folderId);
      if (node && node.locked && !node.unlocked) { promptUnlock(node); return; }
    }
    const data = await api('/api/notes', {
      method: 'POST',
      body: { folderId: folderId || null, title: '无标题笔记', content: '<p><br></p>' },
    });
    /* 立刻登记归属，避免后续上锁/移动时反查不到所属文件夹 */
    rememberOwner(data.id, folderId);
    state.expanded.add(folderId || '__root__');
    delete noteCache[folderId || '__root__'];
    await loadFolderNotes(folderId);
    await openNote(data.id);
    /* 新建后自动聚焦标题并全选，方便直接输入笔记名称 */
    setTimeout(() => { titleEl.focus(); titleEl.select(); }, 80);
  } catch (e) { toast(e.message, 'error'); }
}

async function promptRenameNote(n) {
  openModal('重命名笔记', `
    <label>笔记名称</label>
    <input type="text" id="dlgNoteName" value="${esc(n.title || '')}" placeholder="无标题笔记">
  `, async () => {
    const name = $('#dlgNoteName').value.trim() || '无标题笔记';
    if (name === n.title) { closeModal(); return; }
    try {
      await api(`/api/notes/${n.id}`, { method: 'PATCH', body: { title: name } });
      if (state.currentNoteId === n.id) {
        titleEl.value = name;
        state.titleDirty = false;
      }
      /* 在所有已加载缓存中同步该笔记标题，避免只刷新当前文件夹 */
      Object.keys(noteCache).forEach((key) => {
        const cached = noteCache[key];
        if (!Array.isArray(cached)) return;
        const item = cached.find((x) => x.id === n.id);
        if (item) { item.title = name; item.updatedAt = Date.now(); }
      });
      renderTree();
      closeModal();
      toast('已重命名', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });
}

function closeEditor() {
  state.currentNoteId = null;
  state.editMode = false;
  state.noteLocked = false;
  state.dirty = false;
  state.titleDirty = false;
  clearTimeout(state.saveTimer);
  hideNoteLockScreen();
  $('#editorMain').classList.add('hidden');
  $('#editorEmpty').classList.remove('hidden');
}

/* ================= 编辑器 ================= */
const editorEl = $('#editor');
const titleEl = $('#noteTitle');

async function openNote(id) {
  if ((state.dirty || state.titleDirty) && state.currentNoteId && state.currentNoteId !== id) {
    await ensureSaved();
  }
  /* 已解锁的加密笔记在本会话内保持解锁，切换笔记不再撤销令牌 */
  try {
    const data = await api(`/api/notes/${id}`);
    const note = data.note;
    state.currentNoteId = id;
    state.suppressSave = true;
    /* 以服务端返回的 folderId 为准刷新归属登记 */
    rememberOwner(id, note.folderId);

    /* 加密笔记且未解锁 → 显示锁定界面 */
    if (note.noteLocked) {
      state.noteLocked = true;
      state.editMode = false;
      titleEl.value = note.title || '';
      editorEl.innerHTML = '<p><br></p>';
      showNoteLockScreen(note);
    } else {
      state.noteLocked = false;
      titleEl.value = note.title || '';
      editorEl.innerHTML = note.content || '<p><br></p>';
      hideNoteLockScreen();
      /* 默认只读模式 */
      setEditMode(false);
    }
    syncReadonlyBadge();
    $('#noteMeta').textContent = `创建于 ${fmtTime(note.createdAt)} · 更新于 ${fmtTime(note.updatedAt)}`;
    $('#editorEmpty').classList.add('hidden');
    $('#editorMain').classList.remove('hidden');
    renderTree();
    setTimeout(() => { state.suppressSave = false; }, 50);
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ---------- 只读 / 编辑模式（单按钮切换） ---------- */
const btnToggleEdit = $('#btnToggleEdit');

function setEditMode(on) {
  state.editMode = on;
  editorEl.contentEditable = on ? 'true' : 'false';
  editorEl.classList.toggle('readonly', !on);
  /* 标题始终可修改（只读模式也可重命名） */
  titleEl.readOnly = false;
  $('#toolbar').classList.toggle('disabled-toolbar', !on);
  /* 按钮文案与样式随模式切换：只读 → 「✏️ 编辑」；编辑中 → 「✓ 完成」 */
  btnToggleEdit.textContent = on ? '✓ 完成' : '✏️ 编辑';
  btnToggleEdit.title = on ? '点击完成编辑，回到只读模式' : '点击进入编辑模式';
  btnToggleEdit.classList.toggle('success', on);
  btnToggleEdit.classList.toggle('primary', !on);
  syncReadonlyBadge();
  if (!on && (state.dirty || state.titleDirty)) saveNow();
}

btnToggleEdit.addEventListener('click', async () => {
  if (state.noteLocked) { toast('请先解锁笔记', 'error'); return; }
  if (!state.currentNoteId) return;
  if (state.editMode) {
    /* 编辑中 → 完成 */
    await saveNow();
    setEditMode(false);
    toast('已完成编辑，切换为只读', 'success');
  } else {
    /* 只读 → 编辑 */
    setEditMode(true);
    editorEl.focus();
  }
});
function syncReadonlyBadge() {
  $('#readonlyBadge').classList.toggle('hidden', state.editMode || state.noteLocked || !state.currentNoteId);
}

/* ---------- 加密笔记锁定界面 ---------- */
function showNoteLockScreen(note) {
  hideNoteLockScreen();
  const wrap = document.createElement('div');
  wrap.id = 'noteLockScreen';
  wrap.className = 'note-lock-screen';
  wrap.innerHTML = `
    <div class="lock-card">
      <div class="lock-icon">🔒</div>
      <div class="lock-title">此笔记已加密</div>
      <div class="lock-sub">输入密码查看内容</div>
      <div class="lock-input-row">
        <input type="password" id="noteLockPass" placeholder="笔记密码" autocomplete="current-password">
        <button class="btn primary" id="noteLockBtn">解锁</button>
      </div>
      <button class="btn ghost sm lock-hint-btn" id="noteLockHintBtn">查看密码提示</button>
      <div class="lock-hint hidden" id="noteLockHint"></div>
    </div>`;
  $('.editor-scroll').prepend(wrap);
  $('#noteLockBtn').addEventListener('click', () => unlockCurrentNote());
  $('#noteLockPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlockCurrentNote(); });
  $('#noteLockHintBtn').addEventListener('click', async () => {
    try {
      const data = await api(`/api/notes/${state.currentNoteId}/hint`);
      const hintBox = $('#noteLockHint');
      hintBox.textContent = data.hint ? `提示：${data.hint}` : '（未设置密码提示）';
      hintBox.classList.remove('hidden');
    } catch (e) { toast(e.message, 'error'); }
  });
  setTimeout(() => $('#noteLockPass') && $('#noteLockPass').focus(), 60);
}
function hideNoteLockScreen() {
  const el = document.getElementById('noteLockScreen');
  if (el) el.remove();
}
async function unlockCurrentNote() {
  const pw = $('#noteLockPass').value;
  try {
    const data = await api(`/api/notes/${state.currentNoteId}/unlock`, { method: 'POST', body: { password: pw } });
    addToken('note', state.currentNoteId, data.token);
    state.noteLocked = false;
    hideNoteLockScreen();
    /* 刷新所属文件夹的笔记列表，让左侧图标由「🔐 未解锁」变为「📄 + 🔓 已解锁」 */
    const ownerFolder = noteFolderOf(state.currentNoteId);
    const cacheKey = ownerFolder || (state.activeFolder || null);
    delete noteCache[cacheKey || '__root__'];
    await loadFolderNotes(cacheKey);
    await openNote(state.currentNoteId);
    toast('笔记已解锁', 'success');
  } catch (e) {
    toast(e.message, 'error');
    $('#noteLockPass').focus();
    $('#noteLockPass').select();
  }
}

function markDirty() {
  if (state.suppressSave) return;
  if (!state.editMode) return; /* 只读模式不产生脏数据 */
  state.dirty = true;
  scheduleSave();
}

/* 标题修改：只读模式下也允许（重命名笔记不需要进入编辑模式） */
function markTitleDirty() {
  if (state.suppressSave) return;
  if (!state.currentNoteId || state.noteLocked) return;
  state.titleDirty = true;
  scheduleSave();
}

function scheduleSave() {
  setSaveStatus('● 未保存', 'saving');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, 1000);
}

function setSaveStatus(text, cls) {
  const el = $('#saveStatus');
  el.textContent = text;
  el.className = 'save-status ' + (cls || '');
}

async function saveNow() {
  clearTimeout(state.saveTimer);
  if ((!state.dirty && !state.titleDirty) || !state.currentNoteId) return;
  const noteId = state.currentNoteId;
  const savingTitle = state.titleDirty;
  const savingContent = state.dirty;
  setSaveStatus('保存中…', 'saving');
  try {
    const body = {};
    if (savingTitle) body.title = titleEl.value.trim() || '无标题笔记';
    if (savingContent) body.content = editorEl.innerHTML;
    await api(`/api/notes/${noteId}`, { method: 'PATCH', body });
    state.dirty = false;
    state.titleDirty = false;
    setSaveStatus('✓ 已自动保存', 'saved');
    /* 更新树内笔记行的标题与时间（在任一已加载的文件夹缓存中查找） */
    let touched = false;
    Object.keys(noteCache).forEach((key) => {
      const cached = noteCache[key];
      if (!Array.isArray(cached)) return;
      const item = cached.find((n) => n.id === noteId);
      if (item) {
        if (savingTitle) item.title = body.title;
        item.updatedAt = Date.now();
        touched = true;
      }
    });
    if (touched) renderTree();
    setTimeout(() => setSaveStatus('就绪'), 2000);
  } catch (e) {
    setSaveStatus('保存失败！', 'error');
    toast('保存失败：' + e.message, 'error');
  }
}

/* 离开页面前用 sendBeacon 兜底保存（即使窗口被关闭也能送达） */
window.addEventListener('beforeunload', (e) => {
  if ((state.dirty || state.titleDirty) && state.currentNoteId) {
    try {
      const payload = JSON.stringify({
        title: titleEl.value.trim() || '无标题笔记',
        content: editorEl.innerHTML,
      });
      navigator.sendBeacon(
        `/api/notes/${state.currentNoteId}/beacon`,
        new Blob([payload], { type: 'application/json' })
      );
      state.dirty = false;
      state.titleDirty = false;
    } catch (err) { /* ignore */ }
    e.preventDefault();
    e.returnValue = '';
  }
});

/* 切换/关闭笔记前确保保存完成 */
async function ensureSaved() {
  if ((state.dirty || state.titleDirty) && state.currentNoteId) await saveNow();
}

/* 输入监听 */
editorEl.addEventListener('input', markDirty);
titleEl.addEventListener('input', markTitleDirty);
/* 标题失焦 / 回车立即保存 */
titleEl.addEventListener('blur', () => { if (state.titleDirty) saveNow(); });
titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    titleEl.blur();
  }
});
/* 窗口失焦立即保存 */
window.addEventListener('blur', () => { if (state.dirty || state.titleDirty) saveNow(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && (state.dirty || state.titleDirty)) saveNow();
});

/* Ctrl+S */
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveNow();
  }
});

/* ================= 富文本命令基础设施 ================= */

/* ---------- 选区保存与恢复 ----------
   原生 <input type="color"> 取色面板会抢走焦点，contenteditable 里的选区随之丢失，
   之后再 execCommand 就作用在一个空折叠选区上 —— 表现就是「点了颜色没反应」。
   因此在控件按下的瞬间先记住选区，执行命令前再恢复。 */
let savedRange = null;
function saveRange() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  if (r.collapsed) return; /* 折叠选区无意义，不覆盖已保存的有效选区 */
  const node = r.commonAncestorContainer;
  const el = node.nodeType === 3 ? node.parentNode : node;
  if (!el || !editorEl.contains(el)) return;
  savedRange = r.cloneRange();
}
function restoreRange() {
  editorEl.focus();
  if (!savedRange) return false;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(savedRange);
  return !savedRange.collapsed;
}

/* ---------- 只读模式保护 ----------
   只读模式下改样式只会改动 DOM，而 markDirty() 有 editMode 守卫会直接返回，
   于是内容永远不会 PATCH 到服务端 —— 看起来变了，切走再回来就没了。
   所以格式化前先自动切入编辑模式。 */
function ensureEditableForFormat() {
  if (!state.currentNoteId || state.noteLocked) return false;
  if (state.editMode) return true;
  saveRange();
  setEditMode(true);
  toast('已自动进入编辑模式', 'success');
  return true;
}

/* ---------- 通用格式命令 ---------- */
function execFormat(cmd, value) {
  if (!ensureEditableForFormat()) return;
  restoreRange();
  document.execCommand(cmd, false, value === undefined ? null : value);
  saveRange();
  markDirty();
}

/* ---------- 着色命令 ----------
   必须先开启 styleWithCSS：否则 Chrome / Edge 下 hiliteColor 完全无效，
   foreColor 也只会产出早已废弃的 <font color> 标签。开启后生成
   <span style="color|background-color:…">，显示与保存都稳定。 */
function execColor(cmd, value) {
  if (!ensureEditableForFormat()) return;
  if (!restoreRange()) { toast('请先选中要变色的文字', 'error'); return; }
  try { document.execCommand('styleWithCSS', false, true); } catch (_) {}
  let ok = document.execCommand(cmd, false, value);
  /* hiliteColor 在部分内核不被支持，退回 backColor */
  if (!ok && cmd === 'hiliteColor') ok = document.execCommand('backColor', false, value);
  try { document.execCommand('styleWithCSS', false, false); } catch (_) {}
  if (!ok) { toast('当前浏览器不支持该着色操作', 'error'); return; }
  saveRange();
  markDirty();
}

/* 把「取色 input」接到着色命令上：input 与 change 都监听（不同内核触发时机不同），
   用时间窗去重，避免同一次取色被套用两遍、产生嵌套 span。 */
function bindColorInput(input, cmd) {
  let lastTs = 0;
  const control = input.closest('.color-control');
  const bar = control ? control.querySelector('.color-bar') : null;
  const run = () => {
    const now = Date.now();
    if (now - lastTs < 400) return;
    lastTs = now;
    if (bar) bar.style.setProperty('--picked-color', input.value);
    execColor(cmd, input.value);
  };
  input.addEventListener('pointerdown', saveRange);
  input.addEventListener('input', run);
  input.addEventListener('change', run);
}

/* 下拉按钮只负责打开取色器，左侧 A 按钮负责直接应用当前颜色。 */
document.querySelectorAll('.color-control .color-menu-btn').forEach((menuBtn) => {
  menuBtn.addEventListener('mousedown', (e) => { e.preventDefault(); saveRange(); });
  menuBtn.addEventListener('click', () => {
    const input = menuBtn.parentElement.querySelector('input[type=color]');
    if (input) input.click();
  });
});

/* ================= 工具栏 ================= */
/* 点击工具栏按钮时阻止默认行为，避免焦点转移导致选区丢失；
   取色器与下拉框需要正常获得焦点，所以要排除。 */
$('#toolbar').addEventListener('mousedown', (e) => {
  if (e.target.closest('input, select')) { saveRange(); return; }
  e.preventDefault();
});

$('#toolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('.tb[data-cmd]');
  if (!btn) return;
  execFormat(btn.dataset.cmd);
});

$('#blockType').addEventListener('change', (e) => {
  execFormat('formatBlock', e.target.value);
  e.target.value = 'p';
});

$('#btnUndo').addEventListener('click', () => { execFormat('undo'); });
$('#btnRedo').addEventListener('click', () => { execFormat('redo'); });

/* ---------- 字体大小与颜色（工具栏） ---------- */
$('#fontSize').addEventListener('change', (e) => {
  if (!e.target.value) return;
  execFormat('fontSize', e.target.value);
  e.target.selectedIndex = 0;
});

bindColorInput($('#colorFore'), 'foreColor');
bindColorInput($('#colorBack'), 'hiliteColor');

/* 直接点按钮（而非取色块）时，用当前已选颜色应用。
   隐形 input 覆盖在按钮上方，此分支主要覆盖键盘触发等场景。 */
$('#btnForeColor').addEventListener('click', (e) => {
  if (e.target === $('#colorFore')) return;
  e.preventDefault();
  execColor('foreColor', $('#colorFore').value);
});
$('#btnBackColor').addEventListener('click', (e) => {
  if (e.target === $('#colorBack')) return;
  e.preventDefault();
  execColor('hiliteColor', $('#colorBack').value);
});

/* ---------- 选中文字浮动气泡 ---------- */
const selBubble = $('#selBubble');
let bubbleTimer = null;

function hideBubble() { selBubble.classList.add('hidden'); }

document.addEventListener('selectionchange', () => {
  clearTimeout(bubbleTimer);
  saveRange(); /* 随选区变化持续记录，供工具栏 / 气泡命令恢复使用 */
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) { hideBubble(); return; }
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node.nodeType === 3 ? node.parentNode : node;
  if (!el || !editorEl.contains(el)) { hideBubble(); return; }
  /* 等拖拽选择结束再显示 */
  bubbleTimer = setTimeout(() => {
    const sel2 = window.getSelection();
    if (sel2.isCollapsed) return;
    const rect = sel2.getRangeAt(0).getBoundingClientRect();
    selBubble.classList.remove('hidden');
    const bw = selBubble.offsetWidth;
    const bh = selBubble.offsetHeight;
    let top = rect.top - bh - 8;
    if (top < 60) top = rect.bottom + 8;
    let left = rect.left + rect.width / 2 - bw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
    selBubble.style.top = top + 'px';
    selBubble.style.left = left + 'px';
  }, 220);
});

selBubble.addEventListener('mousedown', (e) => {
  /* 防止点击气泡丢失选区；取色 input / 下拉框需要焦点，先把选区存下来再放行 */
  if (e.target.closest('input, select, label')) { saveRange(); return; }
  e.preventDefault();
});
selBubble.addEventListener('click', (e) => {
  const btn = e.target.closest('.sb-btn[data-cmd]');
  if (btn) execFormat(btn.dataset.cmd);
});
$('#sbFont').addEventListener('change', (e) => {
  if (!e.target.value) return;
  execFormat('fontSize', e.target.value);
  e.target.selectedIndex = 0;
});
bindColorInput($('#sbFore'), 'foreColor');
bindColorInput($('#sbBack'), 'hiliteColor');
/* 点击编辑区空白处隐藏气泡 */
document.addEventListener('mousedown', (e) => {
  if (!selBubble.contains(e.target)) hideBubble();
}, true);

$('#btnHr').addEventListener('click', () => {
  editorEl.focus();
  document.execCommand('insertHorizontalRule');
  markDirty();
});

$('#btnLink').addEventListener('click', () => {
  const sel = window.getSelection();
  const text = sel && !sel.isCollapsed ? sel.toString() : '';
  const url = prompt('请输入链接地址（URL）：', 'https://');
  if (!url) return;
  editorEl.focus();
  if (text) document.execCommand('createLink', false, url);
  else document.execCommand('insertHTML', false, `<a href="${esc(url)}" target="_blank">${esc(url)}</a>&nbsp;`);
  markDirty();
});

/* ---------- 代码块 ---------- */
$('#btnCode').addEventListener('click', () => {
  const lang = prompt('编程语言（可留空，如 javascript / python / bash）：', '') || '';
  insertCodeBlock(lang);
});
function insertCodeBlock(lang) {
  const sel = window.getSelection();
  const selected = sel && !sel.isCollapsed ? sel.toString() : '';
  const html = `<pre data-lang="${esc(lang)}">${selected ? esc(selected) : ''}</pre><p><br></p>`;
  editorEl.focus();
  document.execCommand('insertHTML', false, html);
  markDirty();
}

/* 代码块语言标记渲染：每次保存前无需处理，显示时通过 CSS ::before 不方便，
   直接在插入时写入语言行 */
function decorateCodeBlocks(root) {
  root.querySelectorAll('pre').forEach((pre) => {
    const lang = pre.getAttribute('data-lang') || '';
    if (lang && !pre.querySelector('.code-lang')) {
      const tag = document.createElement('span');
      tag.className = 'code-lang';
      tag.textContent = lang;
      pre.insertBefore(tag, pre.firstChild);
    }
  });
}
new MutationObserver(() => decorateCodeBlocks(editorEl)).observe(editorEl, { childList: true, subtree: true });

/* 在代码块内回车不产生 div 污染 */
editorEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    let node = sel.anchorNode;
    while (node && node !== editorEl) {
      if (node.nodeName === 'PRE') {
        e.preventDefault();
        document.execCommand('insertText', false, '\n');
        return;
      }
      node = node.parentNode;
    }
  }
  /* Tab 缩进（代码块内） */
  if (e.key === 'Tab') {
    let node = window.getSelection().anchorNode;
    while (node && node !== editorEl) {
      if (node.nodeName === 'PRE') { e.preventDefault(); document.execCommand('insertText', false, '  '); return; }
      node = node.parentNode;
    }
  }
});

/* ---------- 表格 ---------- */
$('#btnTable').addEventListener('click', () => showTableDialog());

function showTableDialog() {
  openModal('插入表格', `
    <label>行数（含表头）</label>
    <input type="text" id="dlgRows" value="3">
    <label>列数</label>
    <input type="text" id="dlgCols" value="3">
    <div class="modal-hint">插入后可直接在单元格中输入内容；Tab / 点击切换单元格。</div>
  `, async () => {
    const rows = Math.min(30, Math.max(1, parseInt($('#dlgRows').value, 10) || 3));
    const cols = Math.min(20, Math.max(1, parseInt($('#dlgCols').value, 10) || 3));
    let html = '<table><tbody><tr>';
    for (let c = 0; c < cols; c++) html += '<th>表头' + (c + 1) + '</th>';
    html += '</tr>';
    for (let r = 1; r < rows; r++) {
      html += '<tr>';
      for (let c = 0; c < cols; c++) html += '<td><br></td>';
      html += '</tr>';
    }
    html += '</tbody></table><p><br></p>';
    editorEl.focus();
    document.execCommand('insertHTML', false, html);
    markDirty();
    closeModal();
  });
}

/* ---------- 图片 ---------- */
const fileInput = $('#fileInput');
$('#btnImage').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const files = Array.from(fileInput.files);
  fileInput.value = '';
  for (const file of files) {
    await uploadImage(file);
  }
});

async function uploadImage(file) {
  if (!file.type.startsWith('image/')) { toast('仅支持图片文件', 'error'); return; }
  if (file.size > 20 * 1024 * 1024) { toast('图片不能超过 20MB', 'error'); return; }
  const fd = new FormData();
  fd.append('file', file);
  setSaveStatus('上传图片中…', 'saving');
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '上传失败');
    editorEl.focus();
    document.execCommand('insertHTML', false, `<img src="${esc(data.url)}" alt="${esc(file.name)}"><p><br></p>`);
    markDirty();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    setSaveStatus('就绪');
  }
}

/* 编辑区粘贴图片 / 拖拽图片 */
editorEl.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) uploadImage(file);
      return;
    }
  }
});
editorEl.addEventListener('drop', (e) => {
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  const imgs = Array.from(files).filter((f) => f.type.startsWith('image/'));
  if (!imgs.length) return;
  e.preventDefault();
  imgs.forEach(uploadImage);
});

/* ================= 模态框 ================= */
function openModal(title, bodyHTML, onOk, okText) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHTML;
  $('#modalOk').textContent = okText || '确定';
  modalOnOk = onOk;
  $('#modalMask').classList.remove('hidden');
  const firstInput = $('#modalBody').querySelector('input,select');
  if (firstInput) setTimeout(() => { firstInput.focus(); firstInput.select && firstInput.select(); }, 60);
}
let modalOnOk = null;
function closeModal() {
  $('#modalMask').classList.add('hidden');
  modalOnOk = null;
}
$('#modalCancel').addEventListener('click', closeModal);
$('#modalMask').addEventListener('click', (e) => { if (e.target === $('#modalMask')) closeModal(); });
$('#modalOk').addEventListener('click', () => { if (modalOnOk) modalOnOk(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && !$('#modalMask').classList.contains('hidden')) {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'textarea') {
      e.preventDefault();
      if (modalOnOk) modalOnOk();
    }
  }
});

/* ================= 文件夹操作 ================= */
$('#btnNewRootFolder').addEventListener('click', () => promptNewFolder(null));

async function promptNewFolder(parentId) {
  openModal('新建文件夹', `
    <label>文件夹名称</label>
    <input type="text" id="dlgFolderName" placeholder="例如：工作资料">
    ${parentId ? '' : '<div class="modal-hint">将在根目录下创建。</div>'}
  `, async () => {
    const name = $('#dlgFolderName').value.trim();
    if (!name) { toast('名称不能为空', 'error'); return; }
    try {
      const data = await api('/api/folders', { method: 'POST', body: { name, parentId: parentId || null } });
      if (parentId) state.expanded.add(parentId);
      await loadTree();
      if (parentId) {
        const node = findNode(parentId);
        if (node && node.locked) await loadChildren(parentId);
      }
      closeModal();
      toast('文件夹已创建', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });
}

async function promptRenameFolder(node) {
  openModal('重命名文件夹', `
    <label>新名称</label>
    <input type="text" id="dlgFolderName" value="${esc(node.name)}">
  `, async () => {
    const name = $('#dlgFolderName').value.trim();
    if (!name || name === node.name) { closeModal(); return; }
    try {
      await api(`/api/folders/${node.id}`, { method: 'PATCH', body: { name } });
      await loadTree();
      if (state.activeFolder === node.id) $('#currentFolderName').textContent = name;
      closeModal();
      toast('已重命名', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });
}

async function promptPassword(node) {
  const isLocked = node.locked;
  openModal(isLocked ? '修改文件夹密码' : '设置文件夹密码', `
    <label>${isLocked ? '新密码（留空并勾选下方选项可移除密码）' : '密码'}</label>
    <input type="password" id="dlgPass1" placeholder="输入密码" autocomplete="new-password">
    <label>确认密码</label>
    <input type="password" id="dlgPass2" placeholder="再次输入密码" autocomplete="new-password">
    <label>密码提示（可选）</label>
    <input type="text" id="dlgHint" placeholder="例如：我的生日" maxlength="100">
    ${isLocked ? '<label style="display:flex;align-items:center;gap:6px;margin-top:12px"><input type="checkbox" id="dlgRemovePass" style="width:auto"> 移除密码保护</label>' : ''}
    <div class="modal-warn">⚠️ 密码无法找回，忘记密码将无法查看该文件夹内笔记（可删除文件夹后重建）。</div>
  `, async () => {
    const remove = $('#dlgRemovePass') && $('#dlgRemovePass').checked;
    const p1 = $('#dlgPass1').value;
    const p2 = $('#dlgPass2').value;
    const hint = $('#dlgHint').value.trim();
    if (!remove) {
      if (!p1) { toast('密码不能为空', 'error'); return; }
      if (p1 !== p2) { toast('两次输入的密码不一致', 'error'); return; }
    }
    try {
      await api(`/api/folders/${node.id}/password`, {
        method: 'POST',
        body: { password: remove ? null : p1, hint: remove ? null : (hint || null) },
      });
      /* 密码变更后仅该文件夹需重新解锁，其他已解锁文件夹保持解锁 */
      removeToken('folder', node.id);
      await loadTree();
      closeModal();
      toast(remove ? '已移除密码保护' : '密码已设置', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });
}

async function promptDeleteFolder(node) {
  openModal('删除文件夹', `
    <p>确定删除文件夹 <b>${esc(node.name)}</b> 吗？</p>
    <div class="modal-warn">⚠️ 其所有子文件夹及其中全部笔记将被永久删除，且无法恢复。</div>
  `, async () => {
    try {
      /* 先在删除前快照子树（删除后树上就查不到子孙了），再清理本地残留状态 */
      const ids = folderSubtreeIds(node.id);
      const curOwner = state.currentNoteId ? noteFolderOf(state.currentNoteId) : null;
      await api(`/api/folders/${node.id}`, { method: 'DELETE' });
      /* 清理已删除子树的全部残留令牌、归属登记与缓存 */
      purgeFolderSubtree(node.id);
      if (ids.has(state.activeFolder)) state.activeFolder = null;
      /* 当前笔记随文件夹一起被删，关闭编辑器 */
      if (curOwner && ids.has(curOwner)) closeEditor();
      await loadTree();
      await selectFolder(state.activeFolder);
      closeModal();
      toast('文件夹已删除', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }, '删除');
}

function showContextMenu(x, y, target) {
  const menu = $('#contextMenu');
  menu._target = target;
  $('#contextPass').querySelector('span:last-child').textContent = target.type === 'folder'
    ? ((findNode(target.id) || {}).locked ? '修改/移除密码' : '设置密码')
    : '设置/修改密码';
  menu.classList.remove('hidden');
  const maxX = window.innerWidth - menu.offsetWidth - 8;
  const maxY = window.innerHeight - menu.offsetHeight - 8;
  menu.style.left = Math.max(8, Math.min(x, maxX)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, maxY)) + 'px';
  $('#contextMove').focus();
}
function hideContextMenu() { $('#contextMenu').classList.add('hidden'); }
const contextMenu = $('#contextMenu');
$('#contextRename').addEventListener('click', () => {
  const target = contextMenu._target;
  hideContextMenu();
  if (!target) return;
  if (target.type === 'folder') {
    const node = findNode(target.id);
    if (node) promptRenameFolder(node);
  } else if (target.type === 'note' && target.note) {
    promptRenameNote(target.note);
  }
});
$('#contextPass').addEventListener('click', async () => {
  const target = contextMenu._target;
  hideContextMenu();
  if (!target) return;
  if (target.type === 'folder') {
    const node = findNode(target.id);
    if (node) promptPassword(node);
  } else if (target.type === 'note') {
    await promptNotePassword(target.id);
  }
});
$('#contextMove').addEventListener('click', () => {
  const target = contextMenu._target;
  hideContextMenu();
  if (!target) return;
  if (target.type === 'folder') {
    const node = findNode(target.id);
    if (node) promptMoveFolder(node);
  } else if (target.type === 'note') {
    openMoveNote(target.id);
  }
});
document.addEventListener('mousedown', (e) => {
  if (!contextMenu.contains(e.target)) hideContextMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });
window.addEventListener('resize', hideContextMenu);

async function promptMoveFolder(node) {
  // 构建可选目标列表：根 + 所有文件夹（排除自身与子孙）
  const targets = [{ id: null, name: '根目录', depth: 0 }];
  const walk = (nodes, depth, skipId) => {
    nodes.forEach((n) => {
      if (n.id === skipId) return;
      targets.push({ id: n.id, name: n.name, depth: depth + 1 });
      if (n.children) walk(n.children, depth + 1, skipId);
    });
  };
  walk(treeData, 0, node.id);

  const listHTML = targets.map((t, i) =>
    `<div class="move-target" data-idx="${i}" style="padding-left:${12 + t.depth * 18}px">${t.id === null ? '🗂️' : '📁'} ${esc(t.name)}</div>`
  ).join('');

  $('#modalTitle').textContent = `移动文件夹「${node.name}」到…`;
  $('#modalBody').innerHTML = listHTML + '<div class="modal-hint">注意：不能移动到自身或其子文件夹内。</div>';
  $('#modalOk').textContent = '移动';
  let chosen = 0;
  const items = Array.from($('#modalBody').querySelectorAll('.move-target'));
  const highlight = () => items.forEach((el, i) => el.classList.toggle('active', i === chosen));
  items.forEach((el) => el.addEventListener('click', () => {
    chosen = parseInt(el.dataset.idx, 10);
    highlight();
  }));
  highlight();
  modalOnOk = async () => {
    const target = targets[chosen];
    try {
      await api(`/api/folders/${node.id}`, { method: 'PATCH', body: { parentId: target.id } });
      /* 移动会改变该子树的锁链（祖先集合变了），旧的本地解锁状态语义已失效：
         撤销子树令牌与缓存，让用户在新位置按新锁链重新解锁 */
      purgeFolderSubtree(node.id);
      if (target.id) state.expanded.add(target.id);
      await loadTree();
      closeModal();
      toast('已移动', 'success');
    } catch (e) { toast(e.message, 'error'); }
  };
}

/* ================= 解锁 ================= */
async function promptUnlock(node) {
  const hintHTML = node.hint
    ? `<div class="modal-hint">💡 密码提示：<b>${esc(node.hint)}</b></div>`
    : '<button class="btn ghost sm" id="dlgHintBtn" style="margin-top:8px">查看密码提示</button><div class="modal-hint hidden" id="dlgHintBox"></div>';
  openModal(`解锁文件夹「${node.name}」`, `
    <label>密码</label>
    <input type="password" id="dlgPass" placeholder="输入该文件夹的密码" autocomplete="current-password">
    ${hintHTML}
  `, async () => {
    const pw = $('#dlgPass').value;
    try {
      const data = await api(`/api/folders/${node.id}/unlock`, { method: 'POST', body: { password: pw } });
      addToken('folder', node.id, data.token);
      closeModal();
      await loadChildren(node.id);
      await selectFolder(node.id);
      toast('已解锁', 'success');
    } catch (e) {
      toast(e.message, 'error');
      $('#dlgPass').focus();
      $('#dlgPass').select();
    }
  }, '解锁');
  const hintBtn = document.getElementById('dlgHintBtn');
  if (hintBtn) hintBtn.addEventListener('click', async () => {
    try {
      const data = await api(`/api/folders/${node.id}/hint`);
      const box = document.getElementById('dlgHintBox');
      box.textContent = data.hint ? `提示：${data.hint}` : '（未设置密码提示）';
      box.classList.remove('hidden');
    } catch (e) { toast(e.message, 'error'); }
  });
}

/* ================= 笔记操作 ================= */
$('#btnNewNote').addEventListener('click', () => createNote(state.activeFolder));

$('#btnDeleteNote').addEventListener('click', () => {
  if (!state.currentNoteId) return;
  openModal('删除笔记', `
    <p>确定删除笔记 <b>${esc(titleEl.value || '无标题笔记')}</b> 吗？</p>
    <div class="modal-warn">⚠️ 删除后无法恢复。</div>
  `, async () => {
    try {
      await saveNow();
      const delId = state.currentNoteId;
      await api(`/api/notes/${delId}`, { method: 'DELETE' });
      /* 笔记已不存在，撤销其令牌与归属登记，避免 id 复用或残留状态 */
      removeToken('note', delId);
      forgetOwner(delId);
      state.currentNoteId = null;
      state.dirty = false;
      state.titleDirty = false;
      clearTimeout(state.saveTimer);
      $('#editorMain').classList.add('hidden');
      $('#editorEmpty').classList.remove('hidden');
      delete noteCache[state.activeFolder || '__root__'];
      await loadFolderNotes(state.activeFolder);
      closeModal();
      toast('笔记已删除', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }, '删除');
});

/* ---------- 笔记密码 ---------- */
async function promptNotePassword(noteId) {
  if (!noteId) return;
  let isLocked = false;
  try {
    const data = await api(`/api/notes/${noteId}`);
    isLocked = !!data.note.noteLocked;
  } catch (e) { toast(e.message, 'error'); return; }
  if (isLocked && state.currentNoteId === noteId && state.noteLocked) { toast('请先解锁笔记再修改密码', 'error'); return; }

  openModal(isLocked ? '修改笔记密码' : '设置笔记密码', `
    <label>密码</label>
    <input type="password" id="dlgPass1" placeholder="输入密码" autocomplete="new-password">
    <label>确认密码</label>
    <input type="password" id="dlgPass2" placeholder="再次输入密码" autocomplete="new-password">
    <label>密码提示（可选）</label>
    <input type="text" id="dlgHint" placeholder="例如：我的生日" maxlength="100">
    ${isLocked ? '<label style="display:flex;align-items:center;gap:6px;margin-top:12px"><input type="checkbox" id="dlgRemovePass" style="width:auto"> 移除密码保护</label>' : ''}
    <div class="modal-warn">⚠️ 密码无法找回，请牢记。忘记密码将无法查看此笔记。</div>
  `, async () => {
    const remove = $('#dlgRemovePass') && $('#dlgRemovePass').checked;
    const p1 = $('#dlgPass1').value;
    const p2 = $('#dlgPass2').value;
    const hint = $('#dlgHint').value.trim();
    if (!remove) {
      if (!p1) { toast('密码不能为空', 'error'); return; }
      if (p1 !== p2) { toast('两次输入的密码不一致', 'error'); return; }
    }
    try {
      await api(`/api/notes/${noteId}/password`, {
        method: 'POST',
        body: { password: remove ? null : p1, hint: remove ? null : (hint || null) },
      });
      /* 笔记密码变更后仅该笔记需重新解锁 */
      removeToken('note', noteId);
      const ownerFolder = noteFolderOf(noteId);
      delete noteCache[ownerFolder || '__root__'];
      if (state.currentNoteId === noteId) await openNote(noteId);
      await loadFolderNotes(ownerFolder);
      closeModal();
      toast(remove ? '已移除笔记密码' : '笔记密码已设置', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });
}

function openMoveNote(noteId) {
  if (!noteId) return;
  const sourceFolderId = noteFolderOf(noteId);
  const targets = [{ id: null, name: '根目录（未分组）', depth: 0 }];
  const walk = (nodes, depth) => {
    nodes.forEach((n) => {
      targets.push({ id: n.id, name: n.name, depth: depth + 1 });
      if (n.children) walk(n.children, depth + 1);
    });
  };
  walk(treeData, 0);

  const listHTML = targets.map((t, i) =>
    `<div class="move-target" data-idx="${i}" style="padding-left:${12 + t.depth * 18}px">${t.id === null ? '🗂️' : '📁'} ${esc(t.name)}</div>`
  ).join('');

  openModal('移动笔记到…', listHTML + '<div class="modal-hint">带 🔒 的加密文件夹需先解锁才能移入。</div>', null, '移动');
  let chosen = 0;
  const items = Array.from($('#modalBody').querySelectorAll('.move-target'));
  const highlight = () => items.forEach((el, i) => el.classList.toggle('active', i === chosen));
  items.forEach((el) => el.addEventListener('click', () => {
    chosen = parseInt(el.dataset.idx, 10);
    highlight();
  }));
  highlight();
  modalOnOk = async () => {
    const target = targets[chosen];
    try {
      if (state.currentNoteId === noteId) await saveNow();
      await api(`/api/notes/${noteId}`, { method: 'PATCH', body: { folderId: target.id } });
      /* 归属变了必须同步登记表，否则上锁新文件夹时会漏撤该笔记令牌 */
      rememberOwner(noteId, target.id);
      /* 源与目标文件夹的缓存都要刷新 */
      delete noteCache[sourceFolderId || '__root__'];
      delete noteCache[target.id || '__root__'];
      state.expanded.add(target.id || '__root__');
      await loadFolderNotes(sourceFolderId);
      if (target.id !== sourceFolderId) await loadFolderNotes(target.id);
      closeModal();
      toast('笔记已移动', 'success');
    } catch (e) { toast(e.message, 'error'); }
  };
}

/* ================= 搜索（标题过滤，范围为当前可访问文件夹） ================= */
$('#btnSearch').addEventListener('click', async () => {
  const kw = prompt('按标题搜索笔记（加密未解锁的文件夹不参与搜索）：');
  if (!kw) return;
  const k = kw.trim().toLowerCase();
  if (!k) return;

  /* 收集可搜索范围：根目录 + 所有未加锁（或已解锁）的文件夹 */
  const scopes = [{ id: null, name: '根目录' }];
  const walk = (nodes) => {
    (nodes || []).forEach((n) => {
      if (!n.locked || n.unlocked) {
        scopes.push({ id: n.id, name: n.name });
        walk(n.children);
      }
    });
  };
  walk(treeData);

  const results = [];
  for (const s of scopes) {
    try {
      const url = s.id ? `/api/notes?folderId=${encodeURIComponent(s.id)}` : '/api/notes';
      const data = await api(url);
      data.notes.forEach((n) => {
        if ((n.title || '').toLowerCase().includes(k)) results.push({ ...n, folderId: s.id, folderName: s.name });
      });
    } catch (e) { /* 无权限的文件夹跳过 */ }
  }

  if (!results.length) {
    openModal('搜索结果', `<p style="color:var(--text2)">未找到标题包含「${esc(kw)}」的笔记。</p>`, () => closeModal(), '关闭');
    return;
  }
  const listHTML = results.map((r, i) =>
    `<div class="move-target" data-idx="${i}">${r.locked ? '🔒' : '📄'} ${esc(r.title || '无标题笔记')} <span style="color:var(--text2);font-size:12px">— ${esc(r.folderName)}</span></div>`
  ).join('');
  openModal(`搜索结果（${results.length} 条）`, listHTML, () => closeModal(), '关闭');
  Array.from($('#modalBody').querySelectorAll('.move-target')).forEach((el) => {
    el.addEventListener('click', async () => {
      const r = results[parseInt(el.dataset.idx, 10)];
      closeModal();
      await selectFolder(r.folderId);
      openNote(r.id);
    });
  });
});

/* ================= 初始化 ================= */
(async function init() {
  try {
    await loadTree();
    state.expanded.add('__root__');
    await loadFolderNotes(null);
  } catch (e) {
    toast('加载失败：' + e.message, 'error');
  }
})();
