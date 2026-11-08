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
const sidebarMask = $('#sidebarMask');

/* 与 style.css 的 @media (max-width: 768px) 断点保持一致 */
const MOBILE_MQ = window.matchMedia('(max-width: 768px)');
const TOUCH_MQ = window.matchMedia('(hover: none)');
function isMobile() { return MOBILE_MQ.matches; }
function isTouch() { return TOUCH_MQ.matches || 'ontouchstart' in window; }

/* 正文的最小可用宽度：低于这个数，工具栏和表格就开始难用了。
   大折叠内屏横持约 840px，若直接套用桌面存下的 520px 列宽，正文只剩 300 出头，
   所以已保存的列宽必须按当前视口夹一次，不能无条件回填。 */
const EDITOR_MIN_W = 400;
const SIDEBAR_MIN_W = 200;
const SIDEBAR_MAX_W = 520;
/* 中等宽屏（大折叠内屏 724~896px、小平板、分屏窗口）上，桌面存下的 520px 会让
   侧栏比正文还宽。这里给一条随视口伸缩的上限：取「视口 32%」与「视口 - 700」
   的较大者，再夹进 [200, 520]。
   两段都是关于视口的连续函数，取 max / min 后依然连续，因此拖动窗口时侧栏
   宽度平滑变化，不会在某个断点上突跳。
   实测：855px 内屏得 273px（正文 577px），1220px 起恢复到完整的 520px。 */
const SIDEBAR_VW_RATIO = 0.32;
const DESKTOP_COMFORT_W = 700;
function fitSidebarWidth(w) {
  const vw = window.innerWidth;
  /* .resizer 宽 5px，触摸端已隐藏，这里统一预留属于保守估计 */
  const room = vw - EDITOR_MIN_W - 5;
  const cap = Math.min(SIDEBAR_MAX_W, Math.max(vw * SIDEBAR_VW_RATIO, vw - DESKTOP_COMFORT_W));
  return Math.round(Math.max(SIDEBAR_MIN_W, Math.min(w, cap, room)));
}

function applyLayout() {
  const L = getLayout();
  if (isMobile()) {
    /* 窄屏不吃已保存的列宽（宽度由 CSS 接管），抽屉默认关闭，先让编辑区露出来 */
    sidebarEl.style.width = '';
    sidebarEl.style.flex = '';
    collapsePane('sidebar', { persist: false });
    return;
  }
  if (L.sidebarW) {
    sidebarEl.style.width = fitSidebarWidth(L.sidebarW) + 'px';
    sidebarEl.style.flex = 'none';
  }
  /* 这里必须显式二选一：窄屏分支会强行挂上 .collapsed，
     折叠屏展开、手机横屏、桌面窗口拉宽时若只处理 collapse 一侧，
     .collapsed 会残留在大屏上，表现为侧栏凭空消失。
     applyLayout 是在还原状态而非响应用户操作，两边都不回写存储。 */
  if (L.sidebarHidden) collapsePane('sidebar', { persist: false });
  else expandPane('sidebar', { persist: false });
}

function syncMask(open) {
  if (!sidebarMask) return;
  if (open && isMobile()) {
    sidebarMask.classList.remove('hidden');
    /* 先上屏再加 .show，让 opacity 过渡有起始帧 */
    requestAnimationFrame(() => sidebarMask.classList.add('show'));
  } else {
    sidebarMask.classList.remove('show');
    sidebarMask.classList.add('hidden');
  }
}

function collapsePane(which, opts) {
  const persist = !opts || opts.persist !== false;
  sidebarEl.classList.add('collapsed');
  resizerSidebar.classList.add('hidden-resizer');
  $('#btnExpandSidebar').classList.remove('hidden');
  syncMask(false);
  if (persist && !isMobile()) setLayout({ sidebarHidden: true });
}
function expandPane(which, opts) {
  const persist = !opts || opts.persist !== false;
  sidebarEl.classList.remove('collapsed');
  resizerSidebar.classList.remove('hidden-resizer');
  /* 窄屏下 ☰ 是抽屉的唯一入口，必须常驻 */
  if (isMobile()) {
    syncMask(true);
  } else {
    $('#btnExpandSidebar').classList.add('hidden');
    syncMask(false);
  }
  if (persist && !isMobile()) setLayout({ sidebarHidden: false });
}

/* 窄屏下选中笔记后自动收起抽屉，把整屏让给正文 */
function autoCloseSidebar() {
  if (isMobile() && !sidebarEl.classList.contains('collapsed')) {
    collapsePane('sidebar', { persist: false });
  }
}

if (sidebarMask) {
  sidebarMask.addEventListener('click', () => collapsePane('sidebar', { persist: false }));
}

/* 跨越断点时重算布局，避免旋屏后停留在错误形态 */
MOBILE_MQ.addEventListener('change', () => {
  sidebarEl.style.width = '';
  sidebarEl.style.flex = '';
  syncMask(false);
  applyLayout();
});

/* 宽屏内部的宽度变化不跨断点，change 不会触发，但正文照样可能被挤瘦
   （折叠屏内屏横竖切换、桌面窗口缩放都属于这种）。这里只重夹列宽，
   不碰折叠状态，避免与用户手动收起侧栏的意图打架。 */
let fitTimer = 0;
window.addEventListener('resize', () => {
  if (isMobile()) return;
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    if (isMobile()) return;
    const L = getLayout();
    if (!L.sidebarW) return;
    sidebarEl.style.width = fitSidebarWidth(L.sidebarW) + 'px';
    sidebarEl.style.flex = 'none';
  }, 120);
});

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
bindResizer(resizerSidebar, sidebarEl, SIDEBAR_MIN_W, SIDEBAR_MAX_W, 'sidebarW');
applyLayout();

$('#btnCollapseSidebar').addEventListener('click', () => collapsePane('sidebar'));
$('#btnExpandSidebar').addEventListener('click', () => expandPane('sidebar'));

/* ================= 排序 =================
   三种模式：time（修改时间倒序，默认）/ name（名称升序）/ custom（手动拖拽顺序）。
   排序方式是「看」的偏好，全局共用一份存 localStorage；
   拖出来的顺序是「数据」，由服务端按文件夹分别记在 order 字段里。 */
const SORT_MODES = ['time', 'name', 'custom'];
function getSortMode() {
  const m = getLayout().sortMode;
  return SORT_MODES.includes(m) ? m : 'time';
}
function setSortMode(mode) {
  setLayout({ sortMode: SORT_MODES.includes(mode) ? mode : 'time' });
}

/* 置顶恒在最前，不受排序方式影响；多个置顶项之间再按当前模式排。
   返回新数组，避免就地改动 treeData / noteCache 造成后续渲染顺序漂移。 */
function sortItems(list, mode) {
  /* 笔记有 updatedAt，文件夹只有 createdAt（重命名不算内容变更，服务端不打时间戳），
     统一取「能拿到的最新时间戳」，让两类条目在同一套规则下可比 */
  const ts = (it) => it.updatedAt || it.createdAt || 0;
  const cmp = {
    /* 时间倒序：新的在上。没有时间戳的当作最旧，沉到末尾 */
    time: (a, b) => ts(b) - ts(a),
    /* 中文按拼音排，数字按大小排（否则 "10" 会排在 "2" 前面） */
    name: (a, b) => String(a.name || a.title || '').localeCompare(
      String(b.name || b.title || ''), 'zh-CN', { numeric: true }),
    custom: (a, b) => (a.order || 0) - (b.order || 0),
  }[mode] || ((a, b) => ts(b) - ts(a));

  return list.slice().sort((a, b) => {
    const pa = a.pinned ? 1 : 0;
    const pb = b.pinned ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return cmp(a, b);
  });
}

const sortSelect = $('#sortMode');
sortSelect.value = getSortMode();
sortSelect.addEventListener('change', () => {
  setSortMode(sortSelect.value);
  renderTree();
});

/* ---- 手动拖拽：同级重排 + 跨级移动 ----
   一行上存在两种落点意图，靠鼠标落在行内的纵向位置区分：
   - 贴近上/下边缘（各 30%）→ 插到该行前/后，属于「排序」，仅同类同父有效
   - 落在中间（40%）        → 放进这个文件夹里，属于「移动」，可跨父级、跨类型
   另外把文件夹拖到树的空白处 = 移回顶层，拖到「未分组」行 = 笔记移出分类。 */
let dragCtx = null;

/* 行元素 / 落点容器 → 它代表的业务身份。
   鼠标端这些信息在闭包里就够用了；触摸端必须按手指坐标反查元素，
   拿到元素后还得知道它是谁，所以额外登记一份。
   用 WeakMap 而非 data-*：值里有对象和函数，且随 DOM 重建自动回收。 */
const rowMeta = new WeakMap();
const dropZones = new WeakMap();

/* 把整个同级的最终顺序提交给服务端。
   提交完整列表而非单个位移，服务端按下标重写 order —— 重放多少次结果都一样。 */
async function commitOrder(kind, parentId, ids) {
  await api('/api/reorder', { method: 'POST', body: { kind, parentId, ids } });
}

/* 三种落点标记散布在不同元素上，拖拽结束时统一扫干净，
   否则残留的描边会让用户以为还处在可放状态 */
function clearDropMarks() {
  document.querySelectorAll('.drop-before,.drop-after,.drop-into')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
  const tree = $('#folderTree');
  if (tree) tree.classList.remove('drop-root');
}

/* 目标容器能否接收当前被拖的东西。
   folderId 为 null 时：文件夹视作「顶层」，笔记视作「未分组」。 */
function canDropInto(folderId) {
  if (!dragCtx) return false;
  /* 已经在这个容器里了，再放一次没有意义，也不该给出可放的提示 */
  if (dragCtx.parentId === folderId) return false;
  if (dragCtx.kind === 'folder') {
    /* 被拖的加密文件夹自身没解锁也不行：服务端改 parentId 时会校验源文件夹，
       同样是必然 403。排序不受此限（换位置不算动内容），所以只拦在这里。 */
    if (dragCtx.locked) return false;
    /* 不能把文件夹放进自己或自己的子孙里 —— 那会把整棵子树从树上摘掉 */
    if (folderId !== null && dragCtx.subtree.has(folderId)) return false;
  }
  return true;
}

/* 判定本次 dragover/drop 的意图：'before' | 'after' | 'into' | null（不可放） */
function dropIntent(e, row, kind, id, parentId) {
  if (!dragCtx || dragCtx.id === id) return null;
  const canSort = dragCtx.kind === kind && dragCtx.parentId === parentId;
  /* 只有文件夹能当容器；未解锁的加密文件夹直接不收 ——
     服务端必然以 403 拒绝，提前排除比让用户拖完再报错更好 */
  const canInto = kind === 'folder' && row.dataset.lock !== 'locked' && canDropInto(id);
  if (!canSort && !canInto) return null;

  const r = row.getBoundingClientRect();
  const ratio = (e.clientY - r.top) / (r.height || 1);
  if (canSort && canInto) {
    if (ratio < 0.3) return 'before';
    if (ratio > 0.7) return 'after';
    return 'into';
  }
  /* 只剩一种意图时就别再按位置挑剔了，整行都算有效落点 */
  if (canInto) return 'into';
  return ratio > 0.5 ? 'after' : 'before';
}

/* 跨父级移动：把 ctx 指向的文件夹/笔记放进 targetId。
   与右键「移动到…」共用同一套服务端接口和同一套本地状态清理，避免两条路行为不一致。 */
async function moveIntoFolder(ctx, targetId) {
  try {
    if (ctx.kind === 'folder') {
      await api(`/api/folders/${ctx.id}`, { method: 'PATCH', body: { parentId: targetId } });
      /* 换了父级就换了锁链（祖先集合变了），旧的本地解锁状态语义已失效，
         连同子树一起撤销，让用户在新位置按新锁链重新解锁 */
      purgeFolderSubtree(ctx.id);
      if (targetId) state.expanded.add(targetId);
      await loadTree();
    } else {
      /* 正在编辑的笔记先落盘，否则移动后重新加载会丢掉未保存的改动 */
      if (state.currentNoteId === ctx.id) await saveNow();
      await api(`/api/notes/${ctx.id}`, { method: 'PATCH', body: { folderId: targetId } });
      /* 归属变了必须同步登记表，否则上锁新文件夹时会漏撤该笔记的令牌 */
      rememberOwner(ctx.id, targetId);
      delete noteCache[ctx.parentId || '__root__'];
      delete noteCache[targetId || '__root__'];
      state.expanded.add(targetId || '__root__');
      await loadFolderNotes(ctx.parentId);
      if (targetId !== ctx.parentId) await loadFolderNotes(targetId);
    }
    toast('已移动', 'success');
  } catch (err) {
    toast(err.message || '移动失败', 'error');
  }
}

/* 只收不发的落点：「未分组」标题行、树的空白区域。
   它们不是可拖动的行，也不参与排序，只承接「移出到这里」这一种意图。 */
function makeDropZone(el, folderId, acceptKind, markClass, guard) {
  /* 登记而不是往 DOM 上刷 data-*：触摸拖拽要按手指位置反查落点，
     复用这里的 guard 才能保证和鼠标端判一样的结果 */
  dropZones.set(el, { folderId, acceptKind, markClass, guard });

  const ok = (e) => dragCtx && dragCtx.kind === acceptKind
    && canDropInto(folderId) && (!guard || guard(e));

  el.addEventListener('dragover', (e) => {
    if (!ok(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add(markClass);
  });

  el.addEventListener('dragleave', () => el.classList.remove(markClass));

  el.addEventListener('drop', async (e) => {
    if (!ok(e)) return;
    e.preventDefault();
    e.stopPropagation();
    clearDropMarks();
    const ctx = dragCtx;
    dragCtx = null;
    await moveIntoFolder(ctx, folderId);
  });
}

/* 让一行可拖拽。kind 区分文件夹/笔记，parentId 是它所在的同级容器，
   siblings 是当前「已排好序」的同级数组 —— 拖拽结果要基于用户眼前看到的顺序计算。 */
function makeDraggable(row, kind, id, parentId, siblings) {
  row.draggable = true;
  /* 触摸端要在 touchmove 里按手指位置找「当前悬停在哪一行」，
     那时拿到的只是个 DOM 元素，得能反查出它代表谁 */
  rowMeta.set(row, { kind, id, parentId, siblings });

  row.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    /* subtree 在拖起来的这一刻算好并缓存：dragover 每移动几像素就触发一次，
       每次重算整棵子树太浪费；而拖拽期间树结构不会变，缓存是安全的 */
    dragCtx = {
      kind, id, parentId, siblings,
      subtree: kind === 'folder' ? folderSubtreeIds(id) : null,
      locked: row.dataset.lock === 'locked',
    };
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    /* Firefox 不设 data 就不触发 drag 事件，内容本身用不上 */
    e.dataTransfer.setData('text/plain', id);
  });

  row.addEventListener('dragend', (e) => {
    e.stopPropagation();
    row.classList.remove('dragging');
    clearDropMarks();
    dragCtx = null;
  });

  row.addEventListener('dragover', (e) => {
    const intent = dropIntent(e, row, kind, id, parentId);
    if (!intent) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    /* 本行接管后要顺手熄掉容器的「移回顶层」提示：这里 stopPropagation 之后
       容器的 dragover 收不到事件，它自己没有机会把标记清掉，会两个提示同时亮 */
    const tree = $('#folderTree');
    if (tree) tree.classList.remove('drop-root');
    row.classList.toggle('drop-before', intent === 'before');
    row.classList.toggle('drop-after', intent === 'after');
    row.classList.toggle('drop-into', intent === 'into');
  });

  row.addEventListener('dragleave', () => {
    row.classList.remove('drop-before', 'drop-after', 'drop-into');
  });

  row.addEventListener('drop', async (e) => {
    /* 不读 class 而是按当前鼠标位置重算：dragleave 可能已经把标记清掉了，
       依赖 class 会在某些浏览器上把 drop 判成无效 */
    const intent = dropIntent(e, row, kind, id, parentId);
    if (!intent) return;
    e.preventDefault();
    e.stopPropagation();
    clearDropMarks();

    const ctx = dragCtx;
    dragCtx = null;
    await performDrop(ctx, intent, id);
  });

  /* 触摸端的拖拽通路：HTML5 DnD 在移动浏览器上不派发，只能自己用 touch 事件走一遍。
     长按菜单不在这里绑 —— 它是 contextmenu 的触摸等价物，绑在渲染处更贴切。 */
  if (isTouch()) bindTouchDrag(row, kind, id, parentId, siblings);
}

/* 落点确定后的实际执行。鼠标 drop 与 touch 拖拽共用同一条路径，
   保证两种输入方式的结果与提示完全一致。 */
async function performDrop(ctx, intent, targetId) {
  if (!ctx) return;

  if (intent === 'into') {
    await moveIntoFolder(ctx, targetId);
    return;
  }

  /* 基于用户眼前的顺序算新序列：先摘掉被拖的那一项，再插到目标位置 */
  const ids = ctx.siblings.map((it) => it.id).filter((x) => x !== ctx.id);
  const at = ids.indexOf(targetId);
  if (at < 0) return;
  ids.splice(intent === 'after' ? at + 1 : at, 0, ctx.id);

  try {
    await commitOrder(ctx.kind, ctx.parentId, ids);
    /* 拖过就意味着用户要的是自己的顺序，自动切到自定义模式，
       否则提交成功了但界面仍按时间/名称排，看上去像「拖了没反应」 */
    if (getSortMode() !== 'custom') {
      setSortMode('custom');
      sortSelect.value = 'custom';
      toast('已切换为自定义顺序');
    }
    /* order 由服务端重算，重新拉数据而不是本地猜 */
    if (ctx.kind === 'note') await loadFolderNotes(ctx.parentId);
    else await loadTree();
  } catch (err) {
    toast(err.message || '排序失败');
  }
}

/* ================= 触摸端交互补全 ================= */

/* 长按 = 右键。手机浏览器不派发 contextmenu，重命名/置顶/加密/移动
   这几个只挂在右键菜单上的功能在手机上等于消失，必须补一条通路。
   getTarget 传函数而非对象：菜单弹出时才求值，拿到的是当时最新的节点数据。 */
const LONG_PRESS_MS = 480;
const LONG_PRESS_SLOP = 10;

function bindLongPress(el, getTarget) {
  let timer = null;
  let sx = 0;
  let sy = 0;
  let fired = false;

  const cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  el.addEventListener('touchstart', (e) => {
    /* 手柄按下是拖拽，不该同时酝酿菜单；多指是缩放/滚动，一律不接 */
    if (e.touches.length > 1 || e.target.closest('.drag-handle')) return;
    fired = false;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      /* 已经确定要出菜单了，给一次触觉反馈，让用户知道手可以松了 */
      if (navigator.vibrate) navigator.vibrate(12);
      showContextMenu(sx, sy, getTarget());
    }, LONG_PRESS_MS);
  }, { passive: true });

  /* 手指移动超过阈值说明用户想滚列表，不是长按 */
  el.addEventListener('touchmove', (e) => {
    if (!timer) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - sx) > LONG_PRESS_SLOP || Math.abs(t.clientY - sy) > LONG_PRESS_SLOP) cancel();
  }, { passive: true });

  el.addEventListener('touchend', (e) => {
    cancel();
    /* 菜单已弹出时，抬手不应再触发这一行的 click（打开笔记/展开文件夹），
       否则菜单刚出现就被跳转盖掉 */
    if (fired) {
      e.preventDefault();
      fired = false;
    }
  });

  el.addEventListener('touchcancel', cancel, { passive: true });
}

/* 拖拽手柄的触摸实现。
   为什么用专用手柄而不是「长按后拖动」：长按已经派给菜单了，两者抢同一个手势
   只会互相误触发；手柄还自带可发现性，用户一眼看得出这行能拖。 */
function bindTouchDrag(row, kind, id, parentId, siblings) {
  const handle = row.querySelector('.drag-handle');
  if (!handle) return;

  let active = false;
  let lastEl = null;
  /* 边缘自动滚动：拖拽期间 touchmove 被 preventDefault，列表不会跟着手指滚。
     手机一屏就那么几行，目标只要不在当前视口里就永远够不着，必须自己滚。 */
  let edgeTimer = null;
  let edgeDir = 0;
  const EDGE_ZONE = 56;
  const EDGE_STEP = 8;

  const stopEdgeScroll = () => {
    if (edgeTimer) { clearInterval(edgeTimer); edgeTimer = null; }
    edgeDir = 0;
  };

  const updateEdgeScroll = (clientY) => {
    const tree = document.getElementById('folderTree');
    if (!tree) return;
    const r = tree.getBoundingClientRect();
    let dir = 0;
    if (clientY < r.top + EDGE_ZONE) dir = -1;
    else if (clientY > r.bottom - EDGE_ZONE) dir = 1;

    if (dir === edgeDir) return;
    stopEdgeScroll();
    if (!dir) return;
    edgeDir = dir;
    /* 用定时器而不是每次 touchmove 滚一格：手指停在边缘不动时也要持续滚 */
    edgeTimer = setInterval(() => { tree.scrollTop += dir * EDGE_STEP; }, 16);
  };

  const cleanup = () => {
    active = false;
    lastEl = null;
    stopEdgeScroll();
    row.classList.remove('touch-dragging');
    clearDropMarks();
    dragCtx = null;
  };

  handle.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) return;
    /* 手柄上的手势只可能是拖拽，直接吃掉，避免页面跟着滚 */
    e.preventDefault();
    e.stopPropagation();
    active = true;
    dragCtx = {
      kind, id, parentId, siblings,
      subtree: kind === 'folder' ? folderSubtreeIds(id) : null,
      locked: row.dataset.lock === 'locked',
    };
    row.classList.add('touch-dragging');
    if (navigator.vibrate) navigator.vibrate(8);
  });

  handle.addEventListener('touchmove', (e) => {
    if (!active) return;
    e.preventDefault();
    const t = e.touches[0];
    updateEdgeScroll(t.clientY);
    clearDropMarks();
    lastEl = null;

    /* 手指底下是谁：touch 事件的 target 永远是 touchstart 那个元素，
       必须按坐标现查，这也是 touch 拖拽比鼠标麻烦的根源 */
    const hit = document.elementFromPoint(t.clientX, t.clientY);
    if (!hit) return;

    /* 先看是不是落在某一行上 —— 行的意图更具体，优先级高于容器 */
    const overRow = hit.closest('.tree-row, .tree-note-row');
    /* 停在自己身上时什么都不该亮：行会因 dragCtx.id === id 拒绝，
       若放任它往下走就会去点亮容器的「移到顶层」，等于原地不动却提示要挪走 */
    if (overRow === row) return;
    if (overRow && rowMeta.has(overRow)) {
      const meta = rowMeta.get(overRow);
      const intent = dropIntent(t, overRow, meta.kind, meta.id, meta.parentId);
      if (intent) {
        overRow.classList.toggle('drop-before', intent === 'before');
        overRow.classList.toggle('drop-after', intent === 'after');
        overRow.classList.toggle('drop-into', intent === 'into');
        lastEl = overRow;
        return;
      }
    }

    /* 行不接就交给容器（「未分组」行、树空白区）。
       从命中点向上找最近的已登记落点，语义与鼠标端的事件冒泡一致。 */
    const zoneEl = findDropZoneFrom(hit);
    if (zoneEl) {
      const z = dropZones.get(zoneEl);
      if (dragCtx.kind === z.acceptKind && canDropInto(z.folderId)
          && (!z.guard || z.guard({ target: hit }))) {
        zoneEl.classList.add(z.markClass);
        lastEl = zoneEl;
      }
    }
  });

  handle.addEventListener('touchend', async (e) => {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();

    const target = lastEl;
    const ctx = dragCtx;
    /* 先复位再落库：performDrop 里有 await，期间树会重建，
       此时 row 已是游离节点，晚清理就清不掉了 */
    const rowTarget = target && rowMeta.has(target) ? rowMeta.get(target) : null;
    const zone = target && dropZones.has(target) ? dropZones.get(target) : null;
    /* intent 必须在 clearDropMarks 之前从 class 读出来 */
    let intent = null;
    if (target && rowTarget) {
      if (target.classList.contains('drop-before')) intent = 'before';
      else if (target.classList.contains('drop-after')) intent = 'after';
      else if (target.classList.contains('drop-into')) intent = 'into';
    }
    cleanup();

    if (!target) return;
    if (rowTarget && intent) await performDrop(ctx, intent, rowTarget.id);
    else if (zone) await moveIntoFolder(ctx, zone.folderId);
  });

  handle.addEventListener('touchcancel', cleanup);
}

/* 从命中元素向上找最近的已登记落点容器。
   模拟鼠标端事件冒泡时「谁先收到 dragover」的顺序。 */
function findDropZoneFrom(el) {
  let cur = el;
  while (cur && cur !== document.body) {
    if (dropZones.has(cur)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

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

  const build = (nodes, parentEl, parentId) => {
    /* 按当前偏好排一遍再渲染；sorted 同时作为拖拽计算的基准顺序 */
    const sorted = sortItems(nodes, getSortMode());
    sorted.forEach((node) => {
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
        ${node.pinned ? '<span class="pin-badge" title="已置顶">📌</span>' : ''}
        ${lockBtn}
        <span class="tree-actions">
          <button class="tree-action" data-act="newnote" title="在此文件夹新建笔记">📝</button>
          <button class="tree-action" data-act="new" title="新建子文件夹">＋</button>
          <button class="tree-action" data-act="del" title="删除">🗑</button>
        </span>
        <span class="drag-handle" aria-label="拖动排序或移动">⠿</span>`;

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
        showContextMenu(e.clientX, e.clientY, { type: 'folder', id: node.id, node });
      });
      /* 手机没有右键，长按补上同一条通路 */
      if (isTouch()) bindLongPress(row, () => ({ type: 'folder', id: node.id, node }));
      makeDraggable(row, 'folder', node.id, parentId || null, sorted);
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
        build(node.children || [], childrenBox, node.id);
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
  build(treeData, container, null);

  /* 「未分组」放在所有顶层文件夹之后：它只是没归类笔记的兜底容器，
     不该抢占列表首位，也不参与排序模式与拖拽 */
  const allExpanded = state.expanded.has('__root__');
  const allRow = document.createElement('div');
  allRow.className = 'tree-node';
  allRow.innerHTML = `<div class="tree-row ${state.activeFolder === null ? 'active' : ''}">
    <span class="tree-caret ${allExpanded ? 'open' : ''}">▶</span>
    <span class="tree-folder-icon">🗂️</span>
    <span class="tree-name">未分组</span>
    <span class="tree-actions">
      <button class="tree-action" data-act="newnote" title="在未分组新建笔记">📝</button>
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
  /* 「未分组」只收笔记：文件夹的「没有分类」等价于「回到顶层」，
     那是树空白区的语义，两者不该混在同一行上 */
  makeDropZone(allRow.querySelector('.tree-row'), null, 'note', 'drop-into');
  container.appendChild(allRow);
  if (allExpanded) renderNotesBlock(container, null);
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
    /* 与文件夹同一套规则：先按当前偏好排，sorted 再作为拖拽的基准顺序 */
    const sorted = sortItems(notes, getSortMode());
    sorted.forEach((n) => {
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
        <span class="tree-note-actions"></span>
        <span class="drag-handle" aria-label="拖动排序或移动">⠿</span>`;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.tree-action')) return;
        openNote(n.id);
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, { type: 'note', id: n.id, note: n });
      });
      if (isTouch()) bindLongPress(row, () => ({ type: 'note', id: n.id, note: n }));
      makeDraggable(row, 'note', n.id, folderId || null, sorted);
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
  syncAutoLockBadge();
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

/* ================= 闲置自动上锁 =================
   解锁令牌是会话级的，但会话可能一整天都开着不关。这里再加一层「本设备闲置超时」：
   超过设定时长没有任何笔记/文件夹操作，就撤销本会话全部令牌，
   等同于对所有已解锁的文件夹和笔记各执行一次「🔒 重新上锁」。
   时长存 localStorage（跟设备走，不跟会话走），0 表示关闭。 */
const AUTO_LOCK_DEFAULT_MIN = 5;
const AUTO_LOCK_OPTIONS = [0, 1, 3, 5, 10, 30, 60];

function getAutoLockMin() {
  const v = getLayout().autoLockMin;
  /* 只认白名单里的值：手工改过的 localStorage 或历史脏数据一律回落到默认值。
     放任 NaN 进来会让后面的时间差比较恒为 false —— 那是自动上锁静默失效，最危险的一种坏法。 */
  return AUTO_LOCK_OPTIONS.indexOf(v) === -1 ? AUTO_LOCK_DEFAULT_MIN : v;
}
function setAutoLockMin(min) {
  setLayout({ autoLockMin: min });
  restartAutoLockWatch();
  syncAutoLockBadge();
}

function hasUnlocked() {
  const box = getTokens();
  return Object.keys(box.folder).length > 0 || Object.keys(box.note).length > 0;
}

/* 顶栏按钮：显示当前时长，会话内存在已解锁内容时点亮 */
function syncAutoLockBadge() {
  const btn = $('#btnAutoLock');
  if (!btn) return;
  const min = getAutoLockMin();
  const label = $('#autoLockLabel');
  if (label) label.textContent = min ? `${min} 分钟` : '关闭';
  btn.classList.toggle('armed', min > 0 && hasUnlocked());
  btn.title = min
    ? `自动上锁：闲置 ${min} 分钟后重新上锁（点击修改）`
    : '自动上锁：已关闭（点击修改）';
}

let lastActivityAt = Date.now();
let autoLockTimer = null;
let autoLocking = false;

/* 活动打点。滚动、连续按键这类事件很密集，节流到 1 秒一次；
   命中后只写一个时间戳，不碰 DOM，开销可忽略。 */
function markActivity() {
  const now = Date.now();
  if (now - lastActivityAt < 1000) return;
  lastActivityAt = now;
}
['pointerdown', 'keydown', 'wheel', 'touchstart', 'input'].forEach((ev) => {
  document.addEventListener(ev, markActivity, { capture: true, passive: true });
});

/* 检查粒度取超时时长的 1/10，再夹进 [3s, 15s]：
   1 分钟档最多迟到 6 秒，5 分钟档最多迟到 15 秒，既不过度唤醒也不会明显拖沓。 */
function restartAutoLockWatch() {
  clearInterval(autoLockTimer);
  autoLockTimer = null;
  const min = getAutoLockMin();
  if (!min) return;
  const step = Math.min(15000, Math.max(3000, (min * 60000) / 10));
  autoLockTimer = setInterval(checkAutoLock, step);
}

function checkAutoLock() {
  const min = getAutoLockMin();
  if (!min || autoLocking) return;
  if (!hasUnlocked()) return;
  /* 判定依据是时间戳差值而不是 tick 计数：系统休眠、标签页切到后台时定时器都不准，
     但 Date.now() 的差值永远真实，醒来后第一次检查就能立刻补锁。 */
  if (Date.now() - lastActivityAt < min * 60000) return;
  autoLockAll(min);
}

/* 回到前台立刻补判一次：后台标签页的定时器会被浏览器降频到分钟级，
   不补这一下，用户切回来可能先看到几秒钟本该已经锁上的内容。 */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkAutoLock();
});

async function autoLockAll(min) {
  if (autoLocking) return;
  autoLocking = true;
  try {
    const box = getTokens();
    const folderIds = Object.keys(box.folder);
    const noteIds = Object.keys(box.note);

    /* 必须先落盘再撤令牌：顺序反了的话这次保存会撞 403，用户的编辑就白写了 */
    await ensureSaved();

    /* 归属判断也要赶在清理之前做完：loadTree 一跑，被重新上锁的子树就从 treeData 上消失了，
       那时再问「当前笔记在不在锁定范围内」已经查不到答案。 */
    const cur = state.currentNoteId;
    const inLockedScope = (fid) =>
      !!fid && folderIds.some((id) => id === fid || isDescendantOf(fid, id));
    const needCloseEditor = !!cur &&
      (noteIds.indexOf(cur) !== -1 || inLockedScope(noteFolderOf(cur)));
    const activeLocked = inLockedScope(state.activeFolder);

    folderIds.forEach((id) => state.expanded.delete(id));
    /* 笔记缓存整体作废，而不是只挑锁定的那几个文件夹：note 级令牌对应的加密笔记
       散落在普通文件夹里，逐个挑很容易漏掉，结果就是列表上的 🔓 图标不刷新。
       全清的代价只是紧接着那一次 loadFolderNotes 重新拉取，可以忽略。 */
    Object.keys(noteCache).forEach((k) => { delete noteCache[k]; });
    clearAllTokens();

    /* 闲置这么久，浮层多半是忘了关的。一并收掉，
       免得上锁后还有一张放大的图或一个浮动工具条浮在上面。 */
    hideAllFloatBars();
    closeLightbox();
    closeModal();

    if (needCloseEditor) closeEditor();
    await loadTree();
    if (activeLocked) {
      /* 当前所在文件夹已被锁上，退回未分组（顺带把面包屑刷新掉） */
      await selectFolder(null);
    } else {
      await loadFolderNotes(state.activeFolder);
    }
    syncAutoLockBadge();
    toast(`已闲置 ${min} 分钟，加密内容已自动重新上锁`, 'success');
  } catch (e) {
    /* 常见于 ensureSaved 撞上网络问题。此时令牌还没撤，内容仍是解锁态，
       下个周期会自动重试；把计时重置一下，免得每隔几秒就弹一次同样的失败提示。 */
    lastActivityAt = Date.now();
    toast('自动上锁失败，稍后重试：' + e.message, 'error');
  } finally {
    autoLocking = false;
  }
}

/* 顶栏入口：设置闲置时长 */
$('#btnAutoLock').addEventListener('click', () => {
  const cur = getAutoLockMin();
  const opts = AUTO_LOCK_OPTIONS.map((m) =>
    `<option value="${m}"${m === cur ? ' selected' : ''}>${m ? `${m} 分钟` : '关闭（不自动上锁）'}</option>`
  ).join('');
  openModal('自动上锁设置', `
    <label>闲置多久后自动上锁</label>
    <select id="dlgAutoLock">${opts}</select>
    <div class="modal-hint">
      超过该时长没有任何笔记 / 文件夹操作时，本设备上已解锁的加密文件夹与笔记会自动重新上锁，
      再次查看需要重新输入密码。未保存的编辑会先保存再上锁，不会丢失。
    </div>
    <div class="modal-hint">该设置只影响当前设备，默认 ${AUTO_LOCK_DEFAULT_MIN} 分钟。</div>
  `, () => {
    setAutoLockMin(parseInt($('#dlgAutoLock').value, 10));
    closeModal();
    const m = getAutoLockMin();
    toast(m ? `已设置为闲置 ${m} 分钟自动上锁` : '已关闭自动上锁', 'success');
  }, '保存');
});

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
  $('#currentFolderName').textContent = node ? `📂 ${node.name}` : '🗂️ 未分组';

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

async function createNote(folderId, format = 'html', content = null, title = '无标题笔记') {
  try {
    if (folderId) {
      const node = findNode(folderId);
      if (node && node.locked && !node.unlocked) { promptUnlock(node); return; }
    }
    const data = await api('/api/notes', {
      method: 'POST',
      body: { folderId: folderId || null, title, format, content: content === null ? (format === 'markdown' ? '' : '<p><br></p>') : content },
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
  setHeaderCollapsed(false);
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
const markdownSource = $('#markdownSource');
$('#btnMarkdownImage').addEventListener('click', () => $('#fileInput').click());
markdownSource.addEventListener('paste', (e) => {
  const item = Array.from(e.clipboardData?.items || []).find((entry) => entry.type.startsWith('image/'));
  if (!item || !state.editMode) return;
  e.preventDefault();
  const file = item.getAsFile();
  if (file) uploadImage(file);
});
markdownSource.addEventListener('drop', async (e) => {
  const files = Array.from(e.dataTransfer?.files || []).filter((file) => file.type.startsWith('image/'));
  if (!files.length || !state.editMode) return;
  e.preventDefault();
  for (const file of files) await uploadImage(file);
});
state.noteFormat = 'html';
state.markdownPreview = true;
state.toolbarCollapsed = getLayout().toolbarCollapsed === true;
const btnToggleToolbar = $('#btnToggleToolbar');

function syncToolbarVisibility() {
  const available = state.noteFormat === 'html' && !state.noteLocked;
  const expanded = available && !state.toolbarCollapsed;
  $('#toolbar').classList.toggle('hidden', !expanded);
  btnToggleToolbar.classList.toggle('hidden', !available);
  btnToggleToolbar.textContent = state.toolbarCollapsed ? '⌄ 展开工具栏' : '⌃ 收起工具栏';
  btnToggleToolbar.title = state.toolbarCollapsed ? '展开格式工具栏' : '收起格式工具栏';
  btnToggleToolbar.setAttribute('aria-expanded', String(expanded));
}

btnToggleToolbar.addEventListener('mousedown', (event) => {
  event.preventDefault();
  saveRange();
});
btnToggleToolbar.addEventListener('click', () => {
  state.toolbarCollapsed = !state.toolbarCollapsed;
  try { setLayout({ toolbarCollapsed: state.toolbarCollapsed }); } catch (e) {}
  hideAllFloatBars();
  syncToolbarVisibility();
});
syncToolbarVisibility();

function updateMarkdownPreview() {
  if (state.noteFormat !== 'markdown' || state.noteLocked) return;
  editorEl.innerHTML = renderMarkdown(markdownSource.value);
  editorEl.querySelectorAll('pre > code[class]').forEach((code) => {
    const language = Array.from(code.classList).find((name) => name.startsWith('language-'));
    if (language) code.parentElement.dataset.lang = language.slice(9);
  });
}

function syncMarkdownUI() {
  const markdown = state.noteFormat === 'markdown';
  const editing = markdown && state.editMode && !state.noteLocked;
  syncToolbarVisibility();
  $('#markdownTools').classList.toggle('hidden', !editing);
  markdownSource.classList.toggle('hidden', !editing);
  $('#markdownWorkspace').classList.toggle('split', editing && state.markdownPreview);
  editorEl.classList.toggle('hidden', state.noteLocked || (editing && !state.markdownPreview));
  $('#btnExportMarkdown').classList.toggle('hidden', !markdown || state.noteLocked);
}

markdownSource.addEventListener('input', () => {
  markDirty();
  updateMarkdownPreview();
});
markdownSource.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !state.editMode) return;
  e.preventDefault();
  markdownSource.setRangeText('  ', markdownSource.selectionStart, markdownSource.selectionEnd, 'end');
  markDirty();
  updateMarkdownPreview();
});
$('#btnMarkdownPreview').addEventListener('click', () => {
  state.markdownPreview = !state.markdownPreview;
  $('#btnMarkdownPreview').textContent = state.markdownPreview ? '预览：开' : '预览：关';
  $('#btnMarkdownPreview').setAttribute('aria-pressed', String(state.markdownPreview));
  syncMarkdownUI();
});
$('#btnMarkdownHelp').addEventListener('click', () => {
  openModal('Markdown 快捷语法', '<p>在当前富文本正文中输入即可自动转换，无需切换笔记格式。</p><p>行首输入 <code>#</code> / <code>##</code> / <code>###</code> 后按空格：标题；<code>&gt;</code> 后按空格：引用；<code>-</code> / <code>*</code> / <code>+</code> 后按空格：无序列表；<code>1.</code> 后按空格：有序列表。</p><p>独立一行输入三个反引号（可跟语言名，如 javascript）后按回车：代码块；<code>---</code> 或 <code>***</code> 后按回车：分隔线。</p><p>输入 <code>**文字**</code>：加粗；<code>*文字*</code>：斜体；<code>~~文字~~</code>：删除线；<code>`代码`</code>：行内代码。输入结束标记后自动转换。</p><p>粘贴、输入法组合输入、代码块及表格内不会触发。转换后可用 Ctrl / ⌘ + Z 撤销。</p>', closeModal, '知道了');
});
$('#btnExportMarkdown').addEventListener('click', () => {
  if (state.noteFormat !== 'markdown' || state.noteLocked) return;
  const url = URL.createObjectURL(new Blob([markdownSource.value], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = (titleEl.value || '笔记').replace(/[\\/:*?"<>|]/g, '_') + '.md';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

async function openNote(id) {
  if ((state.dirty || state.titleDirty) && state.currentNoteId && state.currentNoteId !== id) {
    await ensureSaved();
  }
  /* 已解锁的加密笔记在本会话内保持解锁，切换笔记不再撤销令牌 */
  try {
    const data = await api(`/api/notes/${id}`);
    const note = data.note;
    if (note.format && !['html', 'markdown'].includes(note.format)) throw new Error('不支持的笔记格式');
    state.dirty = false;
    state.titleDirty = false;
    state.noteFormat = note.format || 'html';
    markdownSource.value = note.noteLocked ? '' : (state.noteFormat === 'markdown' ? note.content || '' : '');
    state.currentNoteId = id;
    state.suppressSave = true;
    /* 换笔记时旧选区与浮动条都失效了，必须清干净再渲染新内容 */
    savedRange = null;
    savedCaret = null;
    hideAllFloatBars();
    blockTypeSel.value = 'p'; /* 选区已清空，段落类型下拉框不能留着上一篇的状态 */
    /* 以服务端返回的 folderId 为准刷新归属登记 */
    rememberOwner(id, note.folderId);

    /* 加密笔记且未解锁 → 显示锁定界面 */
    if (note.noteLocked) {
      state.noteLocked = true;
      state.editMode = false;
      titleEl.value = note.title || '';
      editorEl.innerHTML = '<p><br></p>';
      syncMarkdownUI();
      showNoteLockScreen(note);
    } else {
      state.noteLocked = false;
      titleEl.value = note.title || '';
      editorEl.innerHTML = state.noteFormat === 'markdown' ? renderMarkdown(markdownSource.value) : note.content || '<p><br></p>';
      stripLegacyCodeLang(editorEl); /* 剥离旧版写入正文的语言标签 */
      refreshRotatedImages(editorEl); /* 按当前列宽重算旋转图片的排版补偿 */
      hideNoteLockScreen();
      /* 默认只读模式 */
      setEditMode(false);
    }
    syncReadonlyBadge();
    $('#noteMeta').textContent = `创建于 ${fmtTime(note.createdAt)} · 更新于 ${fmtTime(note.updatedAt)}`;
    $('#editorEmpty').classList.add('hidden');
    $('#editorMain').classList.remove('hidden');
    autoCloseSidebar(); /* 窄屏下打开笔记即让出整屏 */
    renderTree();
    setTimeout(() => { state.suppressSave = false; }, 50);
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ---------- 只读 / 编辑模式（单按钮切换） ---------- */
const btnToggleEdit = $('#btnToggleEdit');

function setHeaderCollapsed(collapsed) {
  $('#app').classList.toggle('header-collapsed', collapsed);
  const button = $('#btnToggleHeader');
  button.textContent = collapsed ? '⌄' : '⌃';
  button.title = collapsed ? '展开顶部栏' : '收起顶部栏';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-expanded', String(!collapsed));
  hideAllFloatBars();
  closeToolbarPanels();
}

$('#btnToggleHeader').addEventListener('mousedown', event => event.preventDefault());
$('#btnToggleHeader').addEventListener('click', () => {
  setHeaderCollapsed(!$('#app').classList.contains('header-collapsed'));
});

function setEditMode(on) {
  setHeaderCollapsed(on);
  state.editMode = on;
  editorEl.contentEditable = on && state.noteFormat !== 'markdown' ? 'true' : 'false';
  editorEl.classList.toggle('readonly', !on || state.noteFormat === 'markdown');
  updateMarkdownPreview();
  syncMarkdownUI();
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
    (state.noteFormat === 'markdown' ? markdownSource : editorEl).focus();
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
    syncAutoLockBadge();
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
  if (state.noteFormat === 'markdown') return markdownSource.value;
  if (!editorEl.querySelector('.cell-active, .img-selected, pre .code-lang, img[data-rot]')) return editorEl.innerHTML;
  const clone = editorEl.cloneNode(true);
  clone.querySelectorAll('.cell-active, .img-selected').forEach((el) => {
    el.classList.remove('cell-active', 'img-selected');
    if (!el.classList.length) el.removeAttribute('class');
  });
  /* 旋转图片的补偿 margin 依赖当前视口宽度，属派生值：不落库，打开时现算 */
  clone.querySelectorAll('img[data-rot]').forEach((el) => { el.style.margin = ''; });
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
    if (state.currentNoteId !== noteId) return;
    if (savingContent && body.content === editorContentHTML()) state.dirty = false;
    if (savingTitle && body.title === (titleEl.value.trim() || '无标题笔记')) state.titleDirty = false;
    if (state.dirty || state.titleDirty) scheduleSave();
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
installMarkdownShortcuts(editorEl, () => state.editMode && !state.noteLocked && !state.suppressSave && state.noteFormat === 'html', () => {
  saveRange();
  syncBlockType();
  syncContextBars();
  markDirty();
});
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
  if (state.noteFormat === 'markdown') return false;
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

function closeToolbarPanels() {
  document.querySelectorAll('.toolbar-panel').forEach(panel => panel.classList.add('hidden'));
  document.querySelectorAll('.toolbar-group-toggle').forEach(button => button.setAttribute('aria-expanded', 'false'));
}

document.querySelectorAll('.toolbar-group-toggle').forEach(button => {
  button.addEventListener('click', () => {
    const panel = document.getElementById(button.getAttribute('aria-controls'));
    const opening = panel.classList.contains('hidden');
    closeToolbarPanels();
    if (!opening || !state.editMode) return;
    const rect = $('#toolbar').getBoundingClientRect();
    const width = Math.min(400, window.innerWidth - 24);
    panel.style.width = width + 'px';
    panel.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + 'px';
    panel.style.top = (rect.bottom + 4) + 'px';
    panel.style.maxHeight = Math.max(80, window.innerHeight - rect.bottom - 20) + 'px';
    panel.classList.remove('hidden');
    button.setAttribute('aria-expanded', 'true');
  });
});
document.addEventListener('click', event => {
  if (!event.target.closest('#toolbar')) closeToolbarPanels();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeToolbarPanels();
});
window.addEventListener('resize', closeToolbarPanels);
$('#btnToggleToolbar').addEventListener('click', closeToolbarPanels);
$('#btnToggleEdit').addEventListener('click', closeToolbarPanels);
$('#toolbar').addEventListener('click', event => {
  if (event.target.closest('.toolbar-panel button') && !event.target.closest('.color-control')) closeToolbarPanels();
});

/* ---------- 段落类型 ----------
   这个下拉框是「状态」而不是「一次性动作」：它必须实时反映光标所在块的类型。
   早先用完就把 value 重置成 'p'，于是在标题里再选「正文」时值根本没变化，
   浏览器不触发 change 事件，formatBlock 永远不执行 —— 表现就是标题切不回正文。 */
const blockTypeSel = $('#blockType');
const BLOCK_TAGS = ['p', 'h1', 'h2', 'h3', 'blockquote', 'pre'];

/* 从当前光标向上找最近的块级容器，同步到下拉框 */
function syncBlockType() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  let el = sel.getRangeAt(0).commonAncestorContainer;
  if (el.nodeType === 3) el = el.parentNode;
  if (!el || !editorEl.contains(el)) return;
  let tag = '';
  while (el && el !== editorEl) {
    const t = el.tagName ? el.tagName.toLowerCase() : '';
    if (BLOCK_TAGS.includes(t)) { tag = t; break; }
    /* 列表项与表格单元格自成一体，不归属任何段落类型，就近截断 */
    if (t === 'li' || t === 'td' || t === 'th') break;
    el = el.parentNode;
  }
  blockTypeSel.value = tag || 'p'; /* 没有块级包裹的裸文本按正文处理 */
}

/* 块级格式与行内格式的差别：对折叠光标同样有效，不需要选中文字。
   所以恢复选区要用 savedCaret（始终记录最新落点），
   而不是 restoreRange 依赖的 savedRange（只记非折叠选区，可能是别处的旧选区）。
   另外 formatBlock 的值在部分内核必须带尖括号才被识别。 */
function execBlockFormat(tag) {
  if (!ensureEditableForFormat()) return;
  restoreCaret();
  document.execCommand('formatBlock', false, '<' + tag + '>');
  saveRange();
  markDirty();
  syncBlockType(); /* 命令未生效时把下拉框拨回真实状态 */
}

blockTypeSel.addEventListener('change', (e) => {
  execBlockFormat(e.target.value);
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
  if (state.noteFormat === 'markdown') { hideBubble(); hideCodeBar(); hideTableBar(); return; }
  saveRange(); /* 随选区变化持续记录，供工具栏 / 气泡命令恢复使用 */
  syncContextBars(); /* 同步代码块 / 表格上下文工具条 */
  syncBlockType(); /* 让段落类型下拉框始终反映光标所在块 */
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

  openModal(target ? '编辑链接' : '插入链接', `
    <div class="dialog-intro">${target ? '修改链接文字或跳转地址。' : selectedText ? '已带入选中的文字，你仍可在插入前调整。' : '填写显示文字和跳转地址，插入后可点击链接再次编辑。'}</div>
    <label for="dlgText">显示文字</label>
    <input type="text" id="dlgText" placeholder="例如：查看项目文档" value="${esc(initText)}" autocomplete="off">
    <label for="dlgUrl">链接地址</label>
    <input type="text" id="dlgUrl" placeholder="example.com 或 https://example.com" value="${esc(initUrl)}" inputmode="url" autocomplete="off">
    <div class="link-options">
      <label class="check-row"><input type="checkbox" id="dlgNewWindow"${!target || target.getAttribute('target') === '_blank' ? ' checked' : ''}> 在新窗口打开</label>
      <button type="button" class="text-action" id="dlgPasteUrl">粘贴地址</button>
    </div>
    <div class="modal-hint">可省略 https://，系统会自动补全；邮箱地址会自动转为邮件链接。</div>
  `, () => {
    const url = normalizeUrl($('#dlgUrl').value);
    if (!url) { toast('请输入链接地址', 'error'); $('#dlgUrl').focus(); return; }
    const text = $('#dlgText').value.trim() || url;
    const newWindow = $('#dlgNewWindow').checked;

    if (target) {
      target.setAttribute('href', url);
      if (newWindow) {
        target.setAttribute('target', '_blank');
        target.setAttribute('rel', 'noopener noreferrer');
      } else {
        target.removeAttribute('target');
        target.removeAttribute('rel');
      }
      target.textContent = text;
      markDirty();
    } else {
      const attrs = newWindow ? ' target="_blank" rel="noopener noreferrer"' : '';
      insertHTMLAtCaret(`<a href="${esc(url)}"${attrs}>${esc(text)}</a>&nbsp;`);
    }
    closeModal();
    hideLinkBubble();
  }, target ? '保存修改' : '插入链接');

  $('#dlgPasteUrl').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) { $('#dlgUrl').value = text.trim(); $('#dlgUrl').focus(); }
    } catch (_) { toast('无法读取剪贴板，请手动粘贴', 'error'); }
  });
  /* 优先让用户输入地址；若已有地址则从显示文字开始修改 */
  setTimeout(() => (initUrl ? $('#dlgText') : $('#dlgUrl')).focus(), 70);
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
  if (!state.editMode || state.noteFormat === 'markdown') return;
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

/* target 有值时可同时修改代码内容与语言，否则是新建 */
function showCodeDialog(target) {
  if (!ensureEditableForFormat()) return;
  const sel = window.getSelection();
  const selected = !target && sel && !sel.isCollapsed ? sel.toString() : '';
  const initLang = target ? target.getAttribute('data-lang') || '' : '';
  const initCode = target ? target.textContent : selected;

  openModal(target ? '编辑代码块' : '插入代码块', `
    <div class="dialog-intro">${target ? '在一个窗口里修改代码内容和语言。' : selected ? '已将选中文字带入代码编辑区。' : '先粘贴或输入代码，再选择语言。'}</div>
    <label for="dlgCode">代码内容</label>
    <textarea id="dlgCode" class="code-input" rows="10" placeholder="在这里输入或粘贴代码…" spellcheck="false">${esc(initCode)}</textarea>
    <div class="field-title-row"><label for="dlgLang">语言</label><button type="button" class="text-action" id="dlgClearLang">设为纯文本</button></div>
    <input type="text" id="dlgLang" placeholder="搜索或输入语言，如 javascript" value="${esc(initLang)}" autocomplete="off">
    <div class="lang-chips" id="langChips">
      ${CODE_LANGS.map((l) => `<button type="button" class="lang-chip${l === initLang ? ' on' : ''}" data-lang="${l}">${l}</button>`).join('')}
    </div>
    <div class="modal-hint">编辑区支持 Tab 缩进；插入后，代码块工具条仍可复制、修改或退出代码块。</div>
  `, () => {
    const lang = $('#dlgLang').value.trim().toLowerCase();
    const code = $('#dlgCode').value;
    if (!code.trim()) { toast('请输入代码内容', 'error'); $('#dlgCode').focus(); return; }
    if (target) {
      target.textContent = code;
      target.setAttribute('data-lang', lang);
      markDirty();
      showCodeBar(target);
    } else {
      insertHTMLAtCaret(`<pre data-lang="${esc(lang)}">${esc(code)}</pre><p><br></p>`);
    }
    closeModal();
    hideCodeBar();
  }, target ? '保存代码' : '插入代码');

  const langInput = $('#dlgLang');
  const syncLangChips = () => {
    const value = langInput.value.trim().toLowerCase();
    $('#langChips').querySelectorAll('.lang-chip').forEach((c) => c.classList.toggle('on', c.dataset.lang === value));
  };
  $('#langChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.lang-chip');
    if (!chip) return;
    langInput.value = langInput.value.trim() === chip.dataset.lang ? '' : chip.dataset.lang;
    syncLangChips();
  });
  langInput.addEventListener('input', syncLangChips);
  $('#dlgClearLang').addEventListener('click', () => { langInput.value = ''; syncLangChips(); });
  $('#dlgCode').addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const ta = e.currentTarget;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.setRangeText('  ', start, end, 'end');
  });
  setTimeout(() => $('#dlgCode').focus(), 70);
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
  if (!pre || !state.editMode || state.noteFormat === 'markdown') { hideCodeBar(); return; }
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
      cellsHTML += `<button type="button" class="grid-cell" data-r="${r}" data-c="${c}" aria-label="${r} 行 ${c} 列"></button>`;
    }
    cellsHTML += '</div>';
  }

  openModal('插入表格', `
    <div class="dialog-intro">拖过网格快速选择尺寸，也可以直接输入行列数。</div>
    <div class="grid-picker">
      <div class="grid-rows" id="gridRows" role="grid">${cellsHTML}</div>
      <div class="grid-label">当前尺寸 <b id="gridLabel">3 × 3</b></div>
    </div>
    <div class="table-size-fields">
      <label>行数<input type="number" id="dlgRows" min="1" max="30" value="3"></label>
      <span>×</span>
      <label>列数<input type="number" id="dlgCols" min="1" max="12" value="3"></label>
    </div>
    <label class="check-row table-header-option"><input type="checkbox" id="dlgHeader" checked> 首行作为表头</label>
    <div class="modal-hint">插入后将自动定位到第一个单元格；按 Tab / Shift+Tab 可前后移动，最后一格按 Tab 会新增一行。</div>
  `, () => {
    rows = Math.max(1, Math.min(30, parseInt($('#dlgRows').value, 10) || 1));
    cols = Math.max(1, Math.min(12, parseInt($('#dlgCols').value, 10) || 1));
    insertTable(rows, cols, $('#dlgHeader').checked);
    closeModal();
  }, '插入表格');

  const grid = $('#gridRows');
  const label = $('#gridLabel');
  const rowsInput = $('#dlgRows');
  const colsInput = $('#dlgCols');
  const paint = (r, c, syncInputs = true) => {
    rows = Math.max(1, Math.min(30, r));
    cols = Math.max(1, Math.min(12, c));
    label.textContent = `${rows} × ${cols}`;
    if (syncInputs) { rowsInput.value = rows; colsInput.value = cols; }
    grid.querySelectorAll('.grid-cell').forEach((cell) => {
      cell.classList.toggle('on', +cell.dataset.r <= rows && +cell.dataset.c <= cols);
    });
  };
  grid.addEventListener('pointerover', (e) => {
    const cell = e.target.closest('.grid-cell');
    if (cell) paint(+cell.dataset.r, +cell.dataset.c);
  });
  grid.addEventListener('click', (e) => {
    const cell = e.target.closest('.grid-cell');
    if (!cell) return;
    paint(+cell.dataset.r, +cell.dataset.c);
    insertTable(rows, cols, $('#dlgHeader').checked);
    closeModal();
  });
  [rowsInput, colsInput].forEach((input) => input.addEventListener('input', () => {
    paint(parseInt(rowsInput.value, 10) || 1, parseInt(colsInput.value, 10) || 1, false);
  }));
  paint(rows, cols);
}

function insertTable(rows, cols, withHeader = true) {
  let html = '<table><tbody>';
  for (let r = 0; r < rows; r++) {
    html += '<tr>';
    const tag = withHeader && r === 0 ? 'th' : 'td';
    for (let c = 0; c < cols; c++) html += `<${tag}>${tag === 'th' ? '表头' + (c + 1) : '<br>'}</${tag}>`;
    html += '</tr>';
  }
  html += '</tbody></table><p><br></p>';
  if (!insertHTMLAtCaret(html)) return;
  /* 插入后直接落到第一个单元格，减少再次点击定位的动作 */
  const tables = editorEl.querySelectorAll('table');
  const table = tables[tables.length - 1];
  if (table && table.rows[0] && table.rows[0].cells[0]) {
    focusCell(table.rows[0].cells[0]);
    showTableBar(table.rows[0].cells[0]);
  }
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
  if (!cell || !state.editMode || state.noteFormat === 'markdown') { hideTableBar(); return; }
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
  hideImageBar();
}
/* 滚动与窗口尺寸变化会让绝对定位的工具条与目标脱节，直接收起最省心 */
$('.editor-scroll') && $('.editor-scroll').addEventListener('scroll', hideAllFloatBars);
window.addEventListener('resize', hideAllFloatBars);
/* 点到工具条之外就收起（链接气泡除外，它由 editor 的 click 逻辑接管） */
document.addEventListener('mousedown', (e) => {
  if (!linkBubble.contains(e.target) && !e.target.closest('a')) hideLinkBubble();
  if (!codeBar.contains(e.target) && !e.target.closest('pre')) hideCodeBar();
  if (!tableBar.contains(e.target) && !e.target.closest('table')) hideTableBar();
  if (!imageBar.contains(e.target) && !imgResizeHandle.contains(e.target) && e.target.tagName !== 'IMG') hideImageBar();
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
  if (!state.currentNoteId || state.noteLocked || !state.editMode) return;
  const noteId = state.currentNoteId;
  const format = state.noteFormat;
  const start = markdownSource.selectionStart;
  const end = markdownSource.selectionEnd;
  if (!file.type.startsWith('image/')) { toast('仅支持图片文件', 'error'); return; }
  if (file.size > 20 * 1024 * 1024) { toast('图片不能超过 20MB', 'error'); return; }
  const fd = new FormData();
  fd.append('file', file);
  setSaveStatus('上传图片中…', 'saving');
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '上传失败');
    if (state.currentNoteId !== noteId || !state.editMode) {
      toast('笔记已切换，图片未插入', 'error');
      return;
    }
    if (format === 'markdown') {
      const alt = file.name.replace(/[\[\]\\\r\n]/g, '');
      markdownSource.setRangeText(`\n\n![${alt}](${data.url})\n\n`, start, end, 'end');
      markdownSource.focus();
      updateMarkdownPreview();
      markDirty();
      return;
    }
    editorEl.focus();
    /* 默认以缩略图插入：大图收窄到 360px 内，小图保持原尺寸不放大 */
    document.execCommand('insertHTML', false, `<img src="${esc(data.url)}" alt="${esc(file.name)}" style="max-width:min(360px,100%)"><p><br></p>`);
    markDirty();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    setSaveStatus('就绪');
  }
}

/* 编辑区粘贴图片 / 拖拽图片 */
editorEl.addEventListener('paste', (e) => {
  if (state.noteFormat === 'markdown') return;
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
  if (state.noteFormat === 'markdown') return;
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  const imgs = Array.from(files).filter((f) => f.type.startsWith('image/'));
  if (!imgs.length) return;
  e.preventDefault();
  imgs.forEach(uploadImage);
});

/* ---------- 图片选中工具条 + 尺寸调整 + 放大浮窗 ---------- */
const imageBar = $('#imageBar');
const IMG_PRESETS = { small: 240, medium: 420, large: 640 };
let activeImage = null;

/* 拖拽角标：编辑态选中图片时吸附在图片右下角，仅指针设备可用 */
const imgResizeHandle = document.createElement('div');
imgResizeHandle.id = 'imgResizeHandle';
imgResizeHandle.className = 'img-resize-handle hidden';
imgResizeHandle.title = '拖动调整图片宽度';
document.body.appendChild(imgResizeHandle);

function hideImageBar() {
  imageBar.classList.add('hidden');
  imgResizeHandle.classList.add('hidden');
  if (activeImage) activeImage.classList.remove('img-selected');
  activeImage = null;
}

function selectImage(img) {
  if (activeImage && activeImage !== img) activeImage.classList.remove('img-selected');
  activeImage = img;
  img.classList.add('img-selected');
  imageBar.classList.remove('hidden');
  syncImageOverlay();
}

/* 工具条与角标跟随图片当前位置（改档位 / 拖拽后都要刷新） */
function syncImageOverlay() {
  if (!activeImage) return;
  const rect = activeImage.getBoundingClientRect();
  placeFloatBar(imageBar, rect);
  imgResizeHandle.style.top = (rect.bottom - 10) + 'px';
  imgResizeHandle.style.left = (rect.right - 10) + 'px';
  imgResizeHandle.classList.remove('hidden');
}

function setImageWidth(img, px) {
  img.style.width = px ? px + 'px' : '';
  img.style.maxWidth = px ? '100%' : '';
  applyRotLayout(img); /* 尺寸变了，旋转的排版补偿要跟着重算 */
  if (!img.getAttribute('style')) img.removeAttribute('style');
  markDirty();
}

/* ---------- 图片旋转（90° 步进） ----------
   服务端只把上传的字节原样落盘、没有图像处理能力，所以旋转走前端 CSS transform，
   不改动原图文件（也就不会因反复重编码掉画质）。
   角度写在 data-rot 属性 + 内联 transform 上：保存前 editorContentHTML() 会剥离临时 class，
   状态放 class 里会丢，必须落在属性和内联样式上才能跟着正文一起持久化。 */

function getImageRot(img) {
  const n = parseInt(img.dataset.rot || '0', 10);
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : 0;
}

/* 元素的内容宽度（clientWidth 含 padding，要扣掉才是真正的可用列宽） */
function contentWidthOf(el) {
  const cs = getComputedStyle(el);
  return el.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
}

/* transform 是排版之后的视觉变换，不改变布局盒子：
   90°/270° 时视觉宽高与布局宽高互换，排版却仍按原尺寸留位，
   于是图片会横向溢出正文列、竖向压住相邻文字。
   这里把宽高差值摊成上下左右 margin 补回排版空间（负值表示该收紧）。 */
function applyRotLayout(img) {
  const rot = getImageRot(img);
  if (!rot) {
    img.style.transform = '';
    img.style.margin = '';
    return;
  }
  img.style.transform = `rotate(${rot}deg)`;
  if (rot === 180) { img.style.margin = ''; return; } /* 180° 宽高不变，无需补偿 */
  const w = img.offsetWidth;
  const h = img.offsetHeight;
  img.style.margin = `${Math.round((w - h) / 2)}px ${Math.round((h - w) / 2)}px`;
}

/* 竖转（90°/270°）后视觉宽度等于渲染高度，超出当前列宽就按比例收窄
   （max-width 只约束布局宽度，管不到 transform 之后的视觉宽度） */
function clampRotatedWidth(img) {
  const rot = getImageRot(img);
  if (rot !== 90 && rot !== 270) return;
  const limit = contentWidthOf(img.parentElement || editorEl);
  const h = img.offsetHeight;
  if (limit > 80 && h > limit) {
    img.style.width = Math.max(60, Math.round(img.offsetWidth * limit / h)) + 'px';
    img.style.maxWidth = '100%';
  }
}

function rotateImage(img, delta) {
  const rot = (getImageRot(img) + delta + 360) % 360;
  if (rot) img.dataset.rot = String(rot);
  else delete img.dataset.rot;
  clampRotatedWidth(img);
  applyRotLayout(img);
  if (!img.getAttribute('style')) img.removeAttribute('style');
  markDirty();
}

/* 正文渲染后按当前列宽重算补偿：保存时的窗口宽度可能和现在不同（比如换到手机看） */
function refreshRotatedImages(root) {
  root.querySelectorAll('img[data-rot]').forEach((img) => {
    const settle = () => { clampRotatedWidth(img); applyRotLayout(img); };
    if (img.complete && img.naturalWidth) settle();
    else img.addEventListener('load', settle, { once: true });
  });
}

/* 窗口尺寸变化（旋转设备 / 拖拽窗口）时按新列宽重算，避免补偿失真 */
let rotResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(rotResizeTimer);
  rotResizeTimer = setTimeout(() => {
    rotResizeTimer = null;
    if (state.currentNoteId) refreshRotatedImages(editorEl);
  }, 200);
});

/* 编辑态点击图片弹出工具条；只读态点击直接放大预览 */
editorEl.addEventListener('click', (e) => {
  const img = e.target.closest('img');
  if (!img || !editorEl.contains(img)) return;
  e.preventDefault();
  if (!state.editMode || state.noteFormat === 'markdown') { openLightbox(img); return; }
  selectImage(img);
});

imageBar.addEventListener('mousedown', (e) => e.preventDefault());
imageBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.sb-btn[data-act]');
  if (!btn || !activeImage) return;
  const act = btn.dataset.act;
  if (IMG_PRESETS[act]) {
    setImageWidth(activeImage, IMG_PRESETS[act]);
    syncImageOverlay();
    return;
  }
  switch (act) {
    case 'full':
      setImageWidth(activeImage, 0);
      syncImageOverlay();
      break;
    case 'rotl':
    case 'rotr':
      rotateImage(activeImage, act === 'rotl' ? -90 : 90);
      syncImageOverlay();
      break;
    case 'zoom':
      openLightbox(activeImage);
      break;
    case 'del': {
      const target = activeImage;
      hideImageBar();
      target.remove();
      markDirty();
      toast('已删除图片', 'success');
      break;
    }
  }
});

/* 角标拖拽：以按下瞬间的宽度为基准，横向位移即宽度增量 */
imgResizeHandle.addEventListener('mousedown', (e) => {
  if (!activeImage) return;
  e.preventDefault();
  e.stopPropagation();
  const img = activeImage;
  const startX = e.clientX;
  /* 用 offsetWidth 而非 getBoundingClientRect()：后者返回旋转后的外接矩形，
     图片竖转时宽高互换，拿它当基准会导致按下瞬间宽度跳变 */
  const startW = img.offsetWidth;
  const onMove = (ev) => {
    const w = Math.max(60, Math.round(startW + ev.clientX - startX));
    img.style.width = w + 'px';
    img.style.maxWidth = '100%';
    applyRotLayout(img);
    syncImageOverlay();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    markDirty();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

/* 放大浮窗：点击遮罩或 Esc 关闭 */
const imgLightbox = $('#imgLightbox');
function openLightbox(img) {
  const pic = $('#imgLightboxPic');
  pic.src = img.currentSrc || img.src;
  /* 浮窗里同步正文中的旋转角；90°/270° 视觉宽高互换，
     可视范围的限制条件也要跟着互换，否则会超出屏幕被裁掉 */
  const rot = getImageRot(img);
  const swap = rot === 90 || rot === 270;
  pic.style.transform = rot ? `rotate(${rot}deg)` : '';
  pic.style.maxWidth = swap ? '92vh' : '';
  pic.style.maxHeight = swap ? '96vw' : '';
  imgLightbox.classList.remove('hidden');
}
function closeLightbox() {
  imgLightbox.classList.add('hidden');
  const pic = $('#imgLightboxPic');
  pic.removeAttribute('src');
  pic.removeAttribute('style');
}
imgLightbox.addEventListener('click', closeLightbox);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !imgLightbox.classList.contains('hidden')) closeLightbox();
});

/* ---------- 导出 PDF（浏览器打印通道，零依赖） ----------
   @media print 样式只保留标题与正文，用户在打印对话框选「另存为 PDF」即可。 */
$('#btnExportPdf').addEventListener('click', () => {
  if (!state.currentNoteId) { toast('请先打开一篇笔记', 'error'); return; }
  if (state.noteLocked) { toast('请先解锁笔记再导出', 'error'); return; }
  hideAllFloatBars();
  closeLightbox();
  const oldTitle = document.title;
  document.title = titleEl.value.trim() || '无标题笔记'; /* 打印文件名默认取页面标题 */
  try { window.print(); } finally { document.title = oldTitle; }
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
async function showTrash() {
  try {
    const data = await api('/api/trash');
    openModal('回收站', '<p>删除的项目保留 30 天，到期自动清除。文件夹恢复时包含其子文件夹及笔记。</p><div class="trash-list">' +
      (data.items.length ? data.items.map(item => `<div class="trash-row"><div><strong>${item.kind === 'folder' ? '📁' : '📝'} ${esc(item.name)}</strong><small>${item.locked ? '需输入删除时的保护密码' : '原位置：' + esc(item.originalLocation)}<br>删除：${esc(new Date(item.deletedAt).toLocaleString())} · 剩余 ${Math.max(1, Math.ceil((item.expiresAt - Date.now()) / 86400000))} 天</small></div><button class="btn ghost sm" data-trash-id="${esc(item.id)}">${item.locked ? '解锁' : '放回原位'}</button></div>`).join('') : '<p class="empty-hint">回收站是空的</p>') + '</div>', closeModal, '关闭');
    $('#modalBody').querySelectorAll('[data-trash-id]').forEach(button => {
      const item = data.items.find(entry => entry.id === button.dataset.trashId);
      button.addEventListener('click', async () => {
        if (item.locked) {
          openModal('解锁回收项目', '<p>请输入删除时的文件夹或笔记密码。多层密码保护需依次解锁。</p><input id="trashPassword" type="password" autocomplete="current-password">', async () => {
            try {
              const result = await api(`/api/trash/${item.id}/unlock`, { method: 'POST', body: { password: $('#trashPassword').value } });
              if (result.token) addToken(result.id.startsWith('n_') ? 'note' : 'folder', result.id, result.token);
              await showTrash();
            } catch (e) { toast(e.message, 'error'); }
          }, '解锁');
          return;
        }
        button.disabled = true;
        try {
          await api(`/api/trash/${item.id}/restore`, { method: 'POST', body: {} });
          Object.keys(noteCache).forEach(key => delete noteCache[key]);
          await loadTree();
          await loadFolderNotes(state.activeFolder);
          toast('已放回原位', 'success');
          await showTrash();
        } catch (e) { toast(e.message, 'error'); button.disabled = false; }
      });
    });
  } catch (e) { toast(e.message, 'error'); }
}
$('#btnTrash').addEventListener('click', showTrash);
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
    <div class="modal-warn">其子文件夹和全部笔记将一起移入回收站，30 天内可放回原位，逾期自动清除。</div>
  `, async () => {
    try {
      /* 先在删除前快照子树（删除后树上就查不到子孙了），再清理本地残留状态 */
      const ids = folderSubtreeIds(node.id);
      const curOwner = state.currentNoteId ? noteFolderOf(state.currentNoteId) : null;
      await ensureSaved();
      if (state.dirty || state.titleDirty) throw new Error('保存未完成，请稍后再删除');
      await api(`/api/folders/${node.id}`, { method: 'DELETE' });
      /* 清理已删除子树的全部残留令牌、归属登记与缓存 */
      purgeFolderSubtree(node.id);
      if (ids.has(state.activeFolder)) state.activeFolder = null;
      /* 当前笔记随文件夹一起被删，关闭编辑器 */
      if (curOwner && ids.has(curOwner)) closeEditor();
      await loadTree();
      await selectFolder(state.activeFolder);
      closeModal();
      toast('文件夹已移入回收站', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }, '删除');
}

function showContextMenu(x, y, target) {
  const menu = $('#contextMenu');
  menu._target = target;
  $('#contextPass').querySelector('span:last-child').textContent = target.type === 'folder'
    ? ((findNode(target.id) || {}).locked ? '修改/移除密码' : '设置密码')
    : '设置/修改密码';

  /* 置顶目前只对文件夹开放，笔记右键时整项隐藏而不是置灰 —— 菜单很短，
     摆一个永远点不动的条目只会让人以为出了问题 */
  const pinBtn = $('#contextPin');
  if (target.type === 'folder') {
    const node = target.node || findNode(target.id) || {};
    pinBtn.classList.remove('hidden');
    pinBtn.querySelector('span:last-child').textContent = node.pinned ? '取消置顶' : '置顶';
  } else {
    pinBtn.classList.add('hidden');
  }

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
$('#contextPin').addEventListener('click', async () => {
  const target = contextMenu._target;
  hideContextMenu();
  if (!target || target.type !== 'folder') return;
  const node = target.node || findNode(target.id);
  if (!node) return;
  try {
    await api(`/api/folders/${node.id}`, { method: 'PATCH', body: { pinned: !node.pinned } });
    await loadTree();
    toast(node.pinned ? '已取消置顶' : '已置顶');
  } catch (e) {
    toast(e.message || '操作失败');
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
/* 触摸端不能只靠 mousedown：长按 fire 后我们 preventDefault 了 touchend，
   浏览器不会再合成鼠标事件，菜单就关不掉了。这里补一条原生通路。
   菜单是在 setTimeout 里弹的，此时 touchstart 早已结束，不会自己关掉自己。 */
document.addEventListener('touchstart', (e) => {
  if (contextMenu.classList.contains('hidden')) return;
  if (!contextMenu.contains(e.target)) hideContextMenu();
}, { passive: true });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });
window.addEventListener('resize', hideContextMenu);

async function promptMoveFolder(node) {
  // 构建可选目标列表：根 + 所有文件夹（排除自身与子孙）
  /* 文件夹移到 parentId=null 是「顶层」，与笔记的「未分组」是两个概念，措辞不能混用 */
  const targets = [{ id: null, name: '顶层', depth: 0 }];
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

  /* 走 openModal 而不是手动铺 title/body —— 弹窗的显示动作（去掉 mask 的 hidden）
     只在 openModal 里做，自己拼装很容易漏掉那一步，表现就是「点了没反应」 */
  openModal(
    `移动文件夹「${node.name}」到…`,
    listHTML + '<div class="modal-hint">注意：不能移动到自身或其子文件夹内。</div>',
    null,
    '移动'
  );
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
      syncAutoLockBadge();
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
  const delId = state.currentNoteId;
  openModal('删除笔记', `
    <p>确定删除笔记 <b>${esc(titleEl.value || '无标题笔记')}</b> 吗？</p>
    <div class="modal-warn">移入回收站后，30 天内可放回原位，逾期自动清除。</div>
  `, async () => {
    try {
      await saveNow();
      if (state.currentNoteId !== delId || state.dirty || state.titleDirty) throw new Error('笔记已切换或保存未完成，请重新操作');
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
      toast('笔记已移入回收站', 'success');
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
  const targets = [{ id: null, name: '未分组', depth: 0 }];
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

  /* 收集可搜索范围：未分组 + 所有未加锁（或已解锁）的文件夹 */
  const scopes = [{ id: null, name: '未分组' }];
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
  /* 树容器是「移回顶层」的落点。挂在这里而不是 renderTree 里 ——
     容器元素本身从不重建，放进 renderTree 会每次渲染叠加一份监听。
     guard 排除鼠标正落在某一行上的情况：那时该由行自己决定意图，
     否则冒泡上来会把「放进某个文件夹」误判成「移回顶层」。 */
  makeDropZone($('#folderTree'), null, 'folder', 'drop-root',
    (e) => !e.target.closest('.tree-row'));

  try {
    await loadTree();
    state.expanded.add('__root__');
    await loadFolderNotes(null);
  } catch (e) {
    toast('加载失败：' + e.message, 'error');
  }

  /* 放在 try 之外：即便首屏加载失败，闲置看守也必须照常起来 —— 
     这次失败不代表本会话没有已解锁内容，漏掉看守等于漏掉一次该有的上锁。 */
  restartAutoLockWatch();
  syncAutoLockBadge();
})();
