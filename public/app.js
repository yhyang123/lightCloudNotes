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
    /* 换笔记时旧选区与浮动条都失效了，必须清干净再渲染新内容 */
    savedRange = null;
    savedCaret = null;
    hideAllFloatBars();
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
      stripLegacyCodeLang(editorEl); /* 剥离旧版写入正文的语言标签 */
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
  if (!on) hideAllFloatBars(); /* 退出编辑态收起所有上下文工具条 */
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

/* 取待保存的正文：编辑期间的临时装饰类（如单元格高亮）不应落库，
   在克隆副本上清理，避免影响用户当前正在编辑的 DOM 与光标。 */
function editorContentHTML() {
  if (!editorEl.querySelector('.cell-active, pre .code-lang')) return editorEl.innerHTML;
  const clone = editorEl.cloneNode(true);
  clone.querySelectorAll('.cell-active').forEach((el) => {
    el.classList.remove('cell-active');
    if (!el.classList.length) el.removeAttribute('class');
  });
  stripLegacyCodeLang(clone);
  return clone.innerHTML;
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
    if (savingContent) body.content = editorContentHTML();
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
        content: editorContentHTML(),
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
/* 插入类操作（表格 / 代码块 / 链接）需要的是「光标落点」，折叠选区同样有意义，
   单独记一份，避免被 savedRange 的「非折叠才记录」规则丢掉。 */
let savedCaret = null;

function rangeInEditor(r) {
  const node = r.commonAncestorContainer;
  const el = node.nodeType === 3 ? node.parentNode : node;
  return !!el && editorEl.contains(el);
}

function saveRange() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  if (!rangeInEditor(r)) return;
  savedCaret = r.cloneRange(); /* 折叠与否都记录，供插入定位 */
  if (r.collapsed) return; /* 折叠选区无意义，不覆盖已保存的有效选区 */
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
/* 恢复到插入落点：优先用最近一次光标位置，没有就退回编辑区末尾 */
function restoreCaret() {
  editorEl.focus();
  const sel = window.getSelection();
  if (savedCaret && editorEl.contains(savedCaret.commonAncestorContainer.nodeType === 3
    ? savedCaret.commonAncestorContainer.parentNode
    : savedCaret.commonAncestorContainer)) {
    sel.removeAllRanges();
    sel.addRange(savedCaret);
    return true;
  }
  const r = document.createRange();
  r.selectNodeContents(editorEl);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
  return false;
}
/* 插入 HTML 的统一入口：守卫只读态 + 定位光标 + 标脏 */
function insertHTMLAtCaret(html) {
  if (!ensureEditableForFormat()) return false;
  restoreCaret();
  document.execCommand('insertHTML', false, html);
  saveRange();
  markDirty();
  return true;
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
  syncContextBars(); /* 同步代码块 / 表格上下文工具条 */
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

/* ---------- 链接 ---------- */
/* 用户往往只输 example.com，直接写进 href 会被当成相对路径；
   这里统一补协议，同时放行 mailto: / tel: / 锚点等特殊形式。 */
function normalizeUrl(raw) {
  const url = (raw || '').trim();
  if (!url) return '';
  if (/^(https?:|mailto:|tel:|ftp:|#|\/)/i.test(url)) return url;
  if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(url)) return 'mailto:' + url;
  return 'https://' + url;
}

function currentLinkEl() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let node = sel.getRangeAt(0).commonAncestorContainer;
  if (node.nodeType === 3) node = node.parentNode;
  const a = node && node.closest ? node.closest('a') : null;
  return a && editorEl.contains(a) ? a : null;
}

/* target 为编辑已有链接时传入的 <a>，为空则是新建 */
function showLinkDialog(target) {
  if (!ensureEditableForFormat()) return;
  const sel = window.getSelection();
  const selectedText = sel && !sel.isCollapsed ? sel.toString() : '';
  const initUrl = target ? target.getAttribute('href') || '' : '';
  const initText = target ? target.textContent : selectedText;
  /* 有选区时文字由选区决定，不让用户改，避免所见与所得不一致 */
  const textLocked = !target && !!selectedText;

  openModal(target ? '编辑链接' : '插入链接', `
    <label>链接地址</label>
    <input type="text" id="dlgUrl" placeholder="example.com 或 https://example.com" value="${esc(initUrl)}">
    <label>显示文字</label>
    <input type="text" id="dlgText" placeholder="留空则显示链接地址" value="${esc(initText)}"${textLocked ? ' disabled' : ''}>
    <div class="modal-hint">${textLocked ? '已选中文字，将直接作为链接文字。' : '可省略 https://，会自动补全。'}</div>
  `, () => {
    const url = normalizeUrl($('#dlgUrl').value);
    if (!url) { toast('请输入链接地址', 'error'); return; }
    const text = (textLocked ? selectedText : $('#dlgText').value.trim()) || url;

    if (target) {
      target.setAttribute('href', url);
      target.setAttribute('target', '_blank');
      target.setAttribute('rel', 'noopener noreferrer');
      target.textContent = text;
      markDirty();
    } else {
      insertHTMLAtCaret(
        `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>&nbsp;`
      );
    }
    closeModal();
    hideLinkBubble();
  }, target ? '保存' : '插入');
}

$('#btnLink').addEventListener('click', () => showLinkDialog(currentLinkEl()));

/* ---------- 链接浮动气泡 ---------- */
const linkBubble = $('#linkBubble');
let activeLink = null;

function hideLinkBubble() {
  linkBubble.classList.add('hidden');
  activeLink = null;
}
function showLinkBubble(a) {
  activeLink = a;
  const url = a.getAttribute('href') || '';
  const urlEl = $('#lbUrl');
  urlEl.textContent = url;
  urlEl.title = url;
  linkBubble.classList.remove('hidden');
  placeFloatBar(linkBubble, a.getBoundingClientRect());
}

/* 三个浮动条共用的定位逻辑：优先浮在目标上方，顶部空间不够就翻到下方 */
function placeFloatBar(bar, rect) {
  const bw = bar.offsetWidth;
  const bh = bar.offsetHeight;
  let top = rect.top - bh - 8;
  if (top < 60) top = rect.bottom + 8;
  let left = rect.left + rect.width / 2 - bw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
  bar.style.top = top + 'px';
  bar.style.left = left + 'px';
}

/* 编辑态下点击链接不跳转，改为弹出操作气泡；只读态保持直接跳转 */
editorEl.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a || !editorEl.contains(a)) { hideLinkBubble(); return; }
  if (!state.editMode) return;
  e.preventDefault();
  showLinkBubble(a);
});

linkBubble.addEventListener('mousedown', (e) => e.preventDefault());
linkBubble.addEventListener('click', async (e) => {
  const btn = e.target.closest('.sb-btn[data-act]');
  if (!btn || !activeLink) return;
  const a = activeLink;
  const url = a.getAttribute('href') || '';
  switch (btn.dataset.act) {
    case 'open':
      window.open(url, '_blank', 'noopener');
      break;
    case 'copy':
      await copyText(url);
      break;
    case 'edit': {
      /* 先把选区落到链接上，Modal 保存时才能定位到它 */
      const r = document.createRange();
      r.selectNodeContents(a);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      saveRange();
      hideLinkBubble();
      showLinkDialog(a);
      return;
    }
    case 'unlink': {
      const parent = a.parentNode;
      while (a.firstChild) parent.insertBefore(a.firstChild, a);
      parent.removeChild(a);
      markDirty();
      toast('已移除链接', 'success');
      break;
    }
  }
  hideLinkBubble();
});

/* 剪贴板：navigator.clipboard 在非 HTTPS 环境不可用，退回 execCommand */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制', 'success');
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制', 'success'); }
    catch (__) { toast('复制失败，请手动选择', 'error'); }
    document.body.removeChild(ta);
  }
}

/* ---------- 代码块 ---------- */
const CODE_LANGS = ['javascript', 'typescript', 'python', 'java', 'go', 'rust', 'c++', 'php', 'sql', 'bash', 'html', 'css', 'json', 'yaml', 'markdown'];

$('#btnCode').addEventListener('click', () => showCodeDialog(currentPreEl()));

function currentPreEl() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let node = sel.getRangeAt(0).commonAncestorContainer;
  if (node.nodeType === 3) node = node.parentNode;
  const pre = node && node.closest ? node.closest('pre') : null;
  return pre && editorEl.contains(pre) ? pre : null;
}

/* target 有值时是修改已有代码块的语言，否则是新建 */
function showCodeDialog(target) {
  if (!ensureEditableForFormat()) return;
  const sel = window.getSelection();
  const selected = !target && sel && !sel.isCollapsed ? sel.toString() : '';
  const initLang = target ? target.getAttribute('data-lang') || '' : '';

  openModal(target ? '修改代码语言' : '插入代码块', `
    <label>编程语言（可留空）</label>
    <input type="text" id="dlgLang" placeholder="如 javascript" value="${esc(initLang)}">
    <div class="lang-chips" id="langChips">
      ${CODE_LANGS.map((l) => `<button type="button" class="lang-chip${l === initLang ? ' on' : ''}" data-lang="${l}">${l}</button>`).join('')}
    </div>
    <div class="modal-hint">代码块内回车换行、Tab 缩进；语言标签仅用于展示，不会写入正文。</div>
  `, () => {
    const lang = $('#dlgLang').value.trim();
    if (target) {
      target.setAttribute('data-lang', lang);
      markDirty();
    } else {
      /* selected 已由 esc 转义，保证 <div> 这类内容按字面量显示 */
      insertHTMLAtCaret(`<pre data-lang="${esc(lang)}">${esc(selected)}</pre><p><br></p>`);
    }
    closeModal();
    hideCodeBar();
  }, target ? '保存' : '插入');

  /* 芯片与输入框双向联动：再点一次已选中的芯片可取消 */
  $('#langChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.lang-chip');
    if (!chip) return;
    const input = $('#dlgLang');
    const picked = input.value.trim() === chip.dataset.lang;
    input.value = picked ? '' : chip.dataset.lang;
    $('#langChips').querySelectorAll('.lang-chip').forEach((c) => c.classList.toggle('on', !picked && c === chip));
  });
}

/* 清理历史数据：早期版本把语言标签写进了 DOM，现在改由 CSS ::before 渲染，
   载入时剥掉这些 span，避免它们被当成代码正文保存下来。 */
function stripLegacyCodeLang(root) {
  root.querySelectorAll('pre .code-lang').forEach((el) => el.remove());
}

/* ---------- 代码块浮动工具条 ---------- */
const codeBar = $('#codeBar');
let activePre = null;

function hideCodeBar() {
  codeBar.classList.add('hidden');
  activePre = null;
}
function showCodeBar(pre) {
  activePre = pre;
  $('#cbLang').textContent = pre.getAttribute('data-lang') || '纯文本';
  codeBar.classList.remove('hidden');
  placeFloatBar(codeBar, pre.getBoundingClientRect());
}
/* 光标移进 / 移出代码块时同步显隐工具条 */
function syncCodeBar() {
  const pre = currentPreEl();
  if (!pre || !state.editMode) { hideCodeBar(); return; }
  if (pre !== activePre) showCodeBar(pre);
}

codeBar.addEventListener('mousedown', (e) => e.preventDefault());
codeBar.addEventListener('click', async (e) => {
  const btn = e.target.closest('.sb-btn[data-act]');
  if (!btn || !activePre) return;
  const pre = activePre;
  switch (btn.dataset.act) {
    case 'lang':
      hideCodeBar();
      showCodeDialog(pre);
      return;
    case 'copy':
      await copyText(pre.textContent);
      break;
    case 'exit': {
      /* 代码块是最后一个节点时无处落脚，先补一个空段落 */
      let next = pre.nextElementSibling;
      if (!next || next.nodeName === 'PRE') {
        next = document.createElement('p');
        next.innerHTML = '<br>';
        pre.parentNode.insertBefore(next, pre.nextSibling);
      }
      const r = document.createRange();
      r.selectNodeContents(next);
      r.collapse(true);
      const sel = window.getSelection();
      editorEl.focus();
      sel.removeAllRanges();
      sel.addRange(r);
      saveRange();
      markDirty();
      break;
    }
    case 'del':
      pre.remove();
      markDirty();
      toast('已删除代码块', 'success');
      break;
  }
  hideCodeBar();
});

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
const GRID_MAX_ROWS = 8;
const GRID_MAX_COLS = 8;

$('#btnTable').addEventListener('click', () => showTableDialog());

function showTableDialog() {
  if (!ensureEditableForFormat()) return;
  let rows = 3;
  let cols = 3;

  let cellsHTML = '';
  for (let r = 1; r <= GRID_MAX_ROWS; r++) {
    cellsHTML += '<div class="grid-row">';
    for (let c = 1; c <= GRID_MAX_COLS; c++) {
      cellsHTML += `<div class="grid-cell" data-r="${r}" data-c="${c}"></div>`;
    }
    cellsHTML += '</div>';
  }

  openModal('插入表格', `
    <div class="grid-picker">
      <div class="grid-rows" id="gridRows">${cellsHTML}</div>
      <div class="grid-label">已选 <b id="gridLabel">3 × 3</b>（行 × 列，首行为表头）</div>
    </div>
    <div class="modal-hint">在网格上滑动选择尺寸，点击即插入；表格内 Tab / Shift+Tab 可切换单元格。</div>
  `, () => { insertTable(rows, cols); closeModal(); }, '插入');

  const grid = $('#gridRows');
  const label = $('#gridLabel');
  const paint = (r, c) => {
    rows = r; cols = c;
    label.textContent = `${r} × ${c}`;
    grid.querySelectorAll('.grid-cell').forEach((cell) => {
      cell.classList.toggle('on', +cell.dataset.r <= r && +cell.dataset.c <= c);
    });
  };
  grid.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('.grid-cell');
    if (cell) paint(+cell.dataset.r, +cell.dataset.c);
  });
  grid.addEventListener('click', (e) => {
    const cell = e.target.closest('.grid-cell');
    if (!cell) return;
    insertTable(+cell.dataset.r, +cell.dataset.c);
    closeModal();
  });
  paint(rows, cols);
}

function insertTable(rows, cols) {
  let html = '<table><tbody><tr>';
  for (let c = 0; c < cols; c++) html += '<th>表头' + (c + 1) + '</th>';
  html += '</tr>';
  for (let r = 1; r < rows; r++) {
    html += '<tr>';
    for (let c = 0; c < cols; c++) html += '<td><br></td>';
    html += '</tr>';
  }
  html += '</tbody></table><p><br></p>';
  insertHTMLAtCaret(html);
}

/* ---------- 表格单元格导航与工具条 ---------- */
function currentCellEl() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let node = sel.getRangeAt(0).commonAncestorContainer;
  if (node.nodeType === 3) node = node.parentNode;
  const cell = node && node.closest ? node.closest('td, th') : null;
  return cell && editorEl.contains(cell) ? cell : null;
}

function focusCell(cell) {
  const r = document.createRange();
  r.selectNodeContents(cell);
  r.collapse(false); /* 落到末尾，便于接着输入 */
  const sel = window.getSelection();
  editorEl.focus();
  sel.removeAllRanges();
  sel.addRange(r);
  saveRange();
}

/* Tab / Shift+Tab 在单元格间移动；最后一格按 Tab 自动追加一行 */
editorEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const cell = currentCellEl();
  if (!cell) return;
  e.preventDefault();
  const table = cell.closest('table');
  const cells = Array.from(table.querySelectorAll('td, th'));
  const idx = cells.indexOf(cell);
  if (e.shiftKey) {
    if (idx > 0) focusCell(cells[idx - 1]);
    return;
  }
  if (idx < cells.length - 1) { focusCell(cells[idx + 1]); return; }
  const newRow = appendRow(table);
  if (newRow) { focusCell(newRow.cells[0]); markDirty(); }
});

function appendRow(table) {
  const last = table.rows[table.rows.length - 1];
  if (!last) return null;
  const row = last.parentNode.insertRow(-1);
  for (let i = 0; i < last.cells.length; i++) {
    row.insertCell(-1).innerHTML = '<br>';
  }
  return row;
}

const tableBar = $('#tableBar');
let activeCell = null;

function hideTableBar() {
  if (activeCell) activeCell.classList.remove('cell-active');
  tableBar.classList.add('hidden');
  activeCell = null;
}
function showTableBar(cell) {
  if (activeCell) activeCell.classList.remove('cell-active');
  activeCell = cell;
  cell.classList.add('cell-active');
  tableBar.classList.remove('hidden');
  placeFloatBar(tableBar, cell.closest('table').getBoundingClientRect());
}
/* 光标进出表格时同步显隐工具条 */
function syncTableBar() {
  const cell = currentCellEl();
  if (!cell || !state.editMode) { hideTableBar(); return; }
  if (cell !== activeCell) showTableBar(cell);
}

/* 复制一行结构（保持列数一致），单元格内容清空 */
function insertRowAt(table, refRow, before) {
  /* insertRow 作用于所属分组，索引要用 sectionRowIndex 而非全表的 rowIndex */
  const row = refRow.parentNode.insertRow(refRow.sectionRowIndex + (before ? 0 : 1));
  for (let i = 0; i < refRow.cells.length; i++) {
    row.insertCell(-1).innerHTML = '<br>';
  }
  return row;
}

tableBar.addEventListener('mousedown', (e) => e.preventDefault());
tableBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.sb-btn[data-act]');
  if (!btn || !activeCell) return;
  const cell = activeCell;
  const row = cell.parentNode;
  const table = cell.closest('table');
  const colIdx = cell.cellIndex;

  switch (btn.dataset.act) {
    case 'rowAbove': focusCell(insertRowAt(table, row, true).cells[colIdx]); break;
    case 'rowBelow': focusCell(insertRowAt(table, row, false).cells[colIdx]); break;
    case 'rowDel':
      if (table.rows.length <= 1) { toast('至少保留一行', 'error'); return; }
      hideTableBar();
      row.remove();
      break;
    case 'colLeft':
    case 'colRight': {
      const at = colIdx + (btn.dataset.act === 'colLeft' ? 0 : 1);
      Array.from(table.rows).forEach((r) => {
        const ref = r.cells[at] || null;
        /* 表头行沿用 th，数据行用 td，保持结构一致 */
        const tag = r.cells[0] && r.cells[0].tagName === 'TH' ? 'th' : 'td';
        const nc = document.createElement(tag);
        nc.innerHTML = tag === 'th' ? '表头' : '<br>';
        r.insertBefore(nc, ref);
      });
      focusCell(row.cells[at]);
      break;
    }
    case 'colDel': {
      if (table.rows[0].cells.length <= 1) { toast('至少保留一列', 'error'); return; }
      hideTableBar();
      Array.from(table.rows).forEach((r) => { if (r.cells[colIdx]) r.deleteCell(colIdx); });
      break;
    }
    case 'tableDel': {
      hideTableBar();
      /* 表格删掉后光标要有落点，否则编辑区可能变空且无法输入 */
      if (!table.nextElementSibling) {
        const p = document.createElement('p');
        p.innerHTML = '<br>';
        table.parentNode.insertBefore(p, table.nextSibling);
      }
      table.remove();
      toast('已删除表格', 'success');
      break;
    }
  }
  markDirty();
});

/* ---------- 浮动工具条统一调度 ----------
   三个工具条互斥：光标同一时刻只可能落在链接 / 代码块 / 表格中的一处。 */
function syncContextBars() {
  syncCodeBar();
  syncTableBar();
}
function hideAllFloatBars() {
  hideLinkBubble();
  hideCodeBar();
  hideTableBar();
}
/* 滚动与窗口尺寸变化会让绝对定位的工具条与目标脱节，直接收起最省心 */
$('.editor-scroll') && $('.editor-scroll').addEventListener('scroll', hideAllFloatBars);
window.addEventListener('resize', hideAllFloatBars);
/* 点到工具条之外就收起（链接气泡除外，它由 editor 的 click 逻辑接管） */
document.addEventListener('mousedown', (e) => {
  if (!linkBubble.contains(e.target) && !e.target.closest('a')) hideLinkBubble();
  if (!codeBar.contains(e.target) && !e.target.closest('pre')) hideCodeBar();
  if (!tableBar.contains(e.target) && !e.target.closest('table')) hideTableBar();
}, true);

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
