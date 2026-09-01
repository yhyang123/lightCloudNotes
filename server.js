#!/usr/bin/env node
/*
 * nasCloudNote - 自托管云笔记服务（零依赖，Node.js >= 16）
 * 数据保存在 DATA_DIR（默认 ./data），上传图片保存在 DATA_DIR/uploads
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_JSON = 15 * 1024 * 1024;   // 笔记内容上限 15MB
const MAX_UPLOAD = 20 * 1024 * 1024; // 上传文件上限 20MB
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);

let db = { folders: [], notes: [] };
let secret = null;

/* ---------------- 存储与工具 ---------------- */

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function loadAll() {
  ensureDir(DATA_DIR);
  ensureDir(UPLOAD_DIR);
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    db = { folders: [], notes: [] };
  }
  if (!Array.isArray(db.folders)) db.folders = [];
  if (!Array.isArray(db.notes)) db.notes = [];
  try {
    secret = fs.readFileSync(SECRET_FILE);
    if (secret.length < 16) throw new Error('bad secret');
  } catch (e) {
    secret = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_FILE, secret);
  }
}

function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
}

const newId = (p) => p + '_' + crypto.randomBytes(9).toString('hex');
const getFolder = (id) => db.folders.find((f) => f.id === id) || null;
const getNote = (id) => db.notes.find((n) => n.id === id) || null;

/* 文件夹密码：scrypt 哈希 + 随机盐 */
function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function verifyPassword(folder, pw) {
  const h = Buffer.from(hashPassword(pw, folder.salt), 'hex');
  const stored = Buffer.from(folder.passwordHash, 'hex');
  return h.length === stored.length && crypto.timingSafeEqual(h, stored);
}

/* 解锁令牌：HMAC(secret, folderId)，客户端凭令牌访问受保护内容 */
function tokenFor(folderId) {
  return crypto.createHmac('sha256', secret).update(folderId).digest('hex');
}
function noteTokenFor(noteId) {
  return crypto.createHmac('sha256', secret).update('note:' + noteId).digest('hex');
}
/* folderId 自身及其祖先中所有已加锁的文件夹 id */
function lockedChain(folderId) {
  const out = [];
  let cur = getFolder(folderId);
  while (cur) {
    if (cur.passwordHash) out.push(cur.id);
    cur = cur.parentId ? getFolder(cur.parentId) : null;
  }
  return out;
}
/* 逐层校验：链上每一把锁都必须持有对应令牌，缺任意一层即拒绝。
   注意不能用 some —— 否则「父加密 + 子再加密」时只解开父就能进子，内层锁形同虚设 */
function checkUnlock(folderId, tokens) {
  const locks = lockedChain(folderId);
  if (!locks.length) return true;
  return locks.every((id) => tokens.includes(tokenFor(id)));
}
/* 笔记可见性 = 所在文件夹链全部解锁 且（若笔记自身加密）持有笔记令牌 */
function checkNoteUnlock(note, tokens) {
  if (!checkUnlock(note.folderId, tokens)) return false;
  if (note.passwordHash) return tokens.includes(noteTokenFor(note.id));
  return true;
}
function isDescendant(folderId, maybeAncestorId) {
  let cur = getFolder(folderId);
  while (cur && cur.parentId) {
    if (cur.parentId === maybeAncestorId) return true;
    cur = getFolder(cur.parentId);
  }
  return false;
}

/* 目录树：加锁且未解锁的文件夹不下发子级；已持有效令牌（unlocked）则正常下发子级，
   这样刷新目录树后已解锁的文件夹仍保持可展开，无需重复解锁。
   unlocked 必须用 checkUnlock 逐层判定，与接口实际放行结果保持一致 */
function treeNode(parentId, tokens) {
  return db.folders
    .filter((f) => f.parentId === parentId)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    .map((f) => {
      const hasPw = !!f.passwordHash;
      const unlocked = hasPw && checkUnlock(f.id, tokens || []);
      return {
        id: f.id,
        name: f.name,
        locked: hasPw,
        unlocked,
        hint: hasPw ? (f.pwHint || '') : null,
        children: (hasPw && !unlocked) ? null : treeNode(f.id, tokens),
      };
    });
}

/* ---------------- HTTP 基础 ---------------- */

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJSON(req) {
  const buf = await readBody(req, MAX_JSON);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    const err = new Error('无效的 JSON');
    err.status = 400;
    throw err;
  }
}

function clientTokens(req) {
  const h = req.headers['x-unlock'];
  if (!h) return [];
  return String(h).split(',').map((s) => s.trim()).filter(Boolean);
}

function requireUnlock(req, folderId) {
  if (!checkUnlock(folderId, clientTokens(req))) {
    const err = new Error('文件夹已锁定，请先输入密码解锁');
    err.status = 403;
    throw err;
  }
}

/* ---------------- multipart 解析（用于图片上传） ---------------- */

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return [];
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const parts = [];
  let idx = buf.indexOf(boundary);
  while (idx !== -1) {
    const next = buf.indexOf(boundary, idx + boundary.length);
    if (next === -1) break;
    let part = buf.slice(idx + boundary.length, next);
    if (part[0] === 13 && part[1] === 10) part = part.slice(2);
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) {
      part = part.slice(0, -2);
    }
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerStr = part.slice(0, headerEnd).toString('utf8');
      const headers = {};
      headerStr.split('\r\n').forEach((line) => {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      });
      parts.push({ headers, data: part.slice(headerEnd + 4) });
    }
    idx = next;
  }
  return parts;
}

/* ---------------- 静态文件 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.txt': 'text/plain; charset=utf-8',
};

function serveFile(res, rootDir, relPath) {
  const safe = path.resolve(rootDir, '.' + path.sep + relPath);
  if (!safe.startsWith(path.resolve(rootDir) + path.sep) && safe !== path.resolve(rootDir)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  let stat;
  try { stat = fs.statSync(safe); } catch (e) {
    res.writeHead(404); res.end('Not Found'); return;
  }
  if (!stat.isFile()) { res.writeHead(404); res.end('Not Found'); return; }
  const ext = path.extname(safe).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    /* 开发迭代频繁，全部禁缓存，保证改版立即生效 */
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(safe).pipe(res);
}

/* ---------------- API ---------------- */

async function handleApi(req, res, pathname) {
  const method = req.method;

  /* ---- 目录树 ---- */
  if (method === 'GET' && pathname === '/api/tree') {
    return sendJSON(res, 200, { tree: treeNode(null, clientTokens(req)) });
  }

  /* ---- 文件夹 ---- */
  let m;
  if (method === 'POST' && pathname === '/api/folders') {
    const body = await readJSON(req);
    const name = String(body.name || '').trim();
    if (!name) return sendJSON(res, 400, { error: '文件夹名称不能为空' });
    const parentId = body.parentId || null;
    if (parentId && !getFolder(parentId)) return sendJSON(res, 404, { error: '父文件夹不存在' });
    if (parentId) requireUnlock(req, parentId);
    const folder = {
      id: newId('f'),
      name,
      parentId,
      passwordHash: null,
      salt: null,
      createdAt: Date.now(),
    };
    db.folders.push(folder);
    saveDb();
    return sendJSON(res, 200, { id: folder.id, name: folder.name });
  }

  m = /^\/api\/folders\/([^/]+)$/.exec(pathname);
  if (m) {
    const folder = getFolder(m[1]);
    if (!folder) return sendJSON(res, 404, { error: '文件夹不存在' });

    if (method === 'PATCH') {
      requireUnlock(req, folder.id);
      const body = await readJSON(req);
      if (typeof body.name === 'string') {
        const name = body.name.trim();
        if (!name) return sendJSON(res, 400, { error: '文件夹名称不能为空' });
        folder.name = name;
      }
      if ('parentId' in body) {
        const parentId = body.parentId || null;
        if (parentId) {
          const dest = getFolder(parentId);
          if (!dest) return sendJSON(res, 404, { error: '目标文件夹不存在' });
          if (dest.id === folder.id || isDescendant(parentId, folder.id)) {
            return sendJSON(res, 400, { error: '不能移动到自身或其子文件夹内' });
          }
          requireUnlock(req, parentId);
        }
        folder.parentId = parentId;
      }
      saveDb();
      return sendJSON(res, 200, { ok: true });
    }

    if (method === 'DELETE') {
      requireUnlock(req, folder.id);
      const doomed = [];
      const collect = (id) => {
        doomed.push(id);
        db.folders.filter((f) => f.parentId === id).forEach((c) => collect(c.id));
      };
      collect(folder.id);
      db.notes = db.notes.filter((n) => !doomed.includes(n.folderId));
      db.folders = db.folders.filter((f) => !doomed.includes(f.id));
      saveDb();
      return sendJSON(res, 200, { ok: true });
    }
  }

  /* ---- 文件夹密码 ---- */
  m = /^\/api\/folders\/([^/]+)\/password$/.exec(pathname);
  if (m && method === 'POST') {
    const folder = getFolder(m[1]);
    if (!folder) return sendJSON(res, 404, { error: '文件夹不存在' });
    if (folder.passwordHash) requireUnlock(req, folder.id); // 修改/移除需先解锁
    else if (folder.parentId) requireUnlock(req, folder.parentId); // 在锁定目录内加锁
    const body = await readJSON(req);
    const pw = body.password;
    if (pw === null || pw === '' || pw === undefined) {
      folder.passwordHash = null;
      folder.salt = null;
      folder.pwHint = null;
    } else {
      if (String(pw).length < 1) return sendJSON(res, 400, { error: '密码不能为空' });
      folder.salt = crypto.randomBytes(16).toString('hex');
      folder.passwordHash = hashPassword(pw, folder.salt);
      folder.pwHint = typeof body.hint === 'string' ? body.hint.slice(0, 100) : null;
    }
    if ('hint' in body && typeof body.hint === 'string') folder.pwHint = body.hint.slice(0, 100) || null;
    saveDb();
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- 解锁文件夹 ---- */
  m = /^\/api\/folders\/([^/]+)\/unlock$/.exec(pathname);
  if (m && method === 'POST') {
    const folder = getFolder(m[1]);
    if (!folder) return sendJSON(res, 404, { error: '文件夹不存在' });
    /* 必须先解锁全部祖先，才允许对本层尝试密码（防止跳过外层直接爆破内层） */
    if (folder.parentId) requireUnlock(req, folder.parentId);
    if (!folder.passwordHash) return sendJSON(res, 400, { error: '该文件夹未设置密码' });
    const body = await readJSON(req);
    if (verifyPassword(folder, body.password || '')) {
      return sendJSON(res, 200, { token: tokenFor(folder.id) });
    }
    return sendJSON(res, 403, { error: '密码错误' });
  }

  /* ---- 文件夹子级（用于解锁后展开） ---- */
  m = /^\/api\/folders\/([^/]+)\/children$/.exec(pathname);
  if (m && method === 'GET') {
    const folder = getFolder(m[1]);
    if (!folder) return sendJSON(res, 404, { error: '文件夹不存在' });
    requireUnlock(req, folder.id);
    const tks = clientTokens(req);
    const folders = db.folders
      .filter((f) => f.parentId === folder.id)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      /* 已解锁的加密子文件夹同样按「可展开」下发（children: []），与 treeNode 保持一致 */
      .map((f) => {
        const hasPw = !!f.passwordHash;
        const unlocked = hasPw && checkUnlock(f.id, tks);
        return { id: f.id, name: f.name, locked: hasPw, unlocked, hint: hasPw ? (f.pwHint || '') : null, children: (hasPw && !unlocked) ? null : [] };
      });
    return sendJSON(res, 200, { folders });
  }

  /* ---- 文件夹密码提示 ---- */
  m = /^\/api\/folders\/([^/]+)\/hint$/.exec(pathname);
  if (m && method === 'GET') {
    const folder = getFolder(m[1]);
    if (!folder) return sendJSON(res, 404, { error: '文件夹不存在' });
    /* 提示只给「已经能看到这个文件夹」的人：祖先链必须先解锁 */
    if (folder.parentId) requireUnlock(req, folder.parentId);
    if (!folder.passwordHash) return sendJSON(res, 200, { hint: null });
    return sendJSON(res, 200, { hint: folder.pwHint || '' });
  }

  /* ---- 笔记列表 ---- */
  if (method === 'GET' && pathname === '/api/notes') {
    const q = new URL(req.url, 'http://x').searchParams;
    const folderId = q.get('folderId') || null;
    if (folderId) {
      if (!getFolder(folderId)) return sendJSON(res, 404, { error: '文件夹不存在' });
      requireUnlock(req, folderId);
    }
    const tks = clientTokens(req);
    const notes = db.notes
      .filter((n) => (n.folderId || null) === folderId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      /* unlocked：加密笔记是否已具备完整访问条件（文件夹链 + 笔记令牌），供前端渲染锁定图标 */
      .map((n) => ({
        id: n.id,
        title: n.title,
        locked: !!n.passwordHash,
        unlocked: !!n.passwordHash && checkNoteUnlock(n, tks),
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
      }));
    return sendJSON(res, 200, { notes });
  }

  /* ---- 新建笔记 ---- */
  if (method === 'POST' && pathname === '/api/notes') {
    const body = await readJSON(req);
    const folderId = body.folderId || null;
    if (folderId) {
      if (!getFolder(folderId)) return sendJSON(res, 404, { error: '文件夹不存在' });
      requireUnlock(req, folderId);
    }
    const note = {
      id: newId('n'),
      folderId,
      title: String(body.title || '无标题笔记').slice(0, 200),
      content: typeof body.content === 'string' ? body.content : '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    db.notes.push(note);
    saveDb();
    return sendJSON(res, 200, { id: note.id });
  }

  /* ---- 笔记密码设置/修改/移除 ---- */
  m = /^\/api\/notes\/([^/]+)\/password$/.exec(pathname);
  if (m && method === 'POST') {
    const note = getNote(m[1]);
    if (!note) return sendJSON(res, 404, { error: '笔记不存在' });
    requireUnlock(req, note.folderId);
    if (note.passwordHash && !checkNoteUnlock(note, clientTokens(req))) {
      return sendJSON(res, 403, { error: '笔记已加密，请先输入密码解锁' });
    }
    const body = await readJSON(req);
    const pw = body.password;
    if (pw === null || pw === '' || pw === undefined) {
      note.passwordHash = null;
      note.salt = null;
      note.pwHint = null;
    } else {
      if (String(pw).length < 1) return sendJSON(res, 400, { error: '密码不能为空' });
      note.salt = crypto.randomBytes(16).toString('hex');
      note.passwordHash = hashPassword(pw, note.salt);
      note.pwHint = typeof body.hint === 'string' ? body.hint.slice(0, 100) : (note.pwHint || null);
    }
    if ('hint' in body && typeof body.hint === 'string') note.pwHint = body.hint.slice(0, 100) || null;
    saveDb();
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- 笔记解锁 ---- */
  m = /^\/api\/notes\/([^/]+)\/unlock$/.exec(pathname);
  if (m && method === 'POST') {
    const note = getNote(m[1]);
    if (!note) return sendJSON(res, 404, { error: '笔记不存在' });
    requireUnlock(req, note.folderId);
    if (!note.passwordHash) return sendJSON(res, 400, { error: '该笔记未设置密码' });
    const body = await readJSON(req);
    if (verifyPassword(note, body.password || '')) {
      return sendJSON(res, 200, { token: noteTokenFor(note.id) });
    }
    return sendJSON(res, 403, { error: '密码错误' });
  }

  /* ---- 笔记密码提示 ---- */
  m = /^\/api\/notes\/([^/]+)\/hint$/.exec(pathname);
  if (m && method === 'GET') {
    const note = getNote(m[1]);
    if (!note) return sendJSON(res, 404, { error: '笔记不存在' });
    requireUnlock(req, note.folderId);
    if (!note.passwordHash) return sendJSON(res, 200, { hint: null });
    return sendJSON(res, 200, { hint: note.pwHint || '' });
  }

  m = /^\/api\/notes\/([^/]+)\/beacon$/.exec(pathname);
  if (m && method === 'POST') {
    /* 页面关闭前的兜底保存：sendBeacon 无法携带 X-Unlock 头，需独立校验 */
    const note = getNote(m[1]);
    if (!note) return sendJSON(res, 404, { error: '笔记不存在' });
    requireUnlock(req, note.folderId);
    if (note.passwordHash && !checkNoteUnlock(note, clientTokens(req))) {
      return sendJSON(res, 403, { error: '笔记已加密' });
    }
    const body = await readJSON(req);
    if (typeof body.title === 'string') note.title = body.title.slice(0, 200);
    if (typeof body.content === 'string') note.content = body.content;
    note.updatedAt = Date.now();
    saveDb();
    return sendJSON(res, 200, { ok: true });
  }

  m = /^\/api\/notes\/([^/]+)$/.exec(pathname);
  if (m) {
    const note = getNote(m[1]);
    if (!note) return sendJSON(res, 404, { error: '笔记不存在' });

    if (method === 'GET') {
      requireUnlock(req, note.folderId);
      const locked = note.passwordHash && !checkNoteUnlock(note, clientTokens(req));
      /* 永不下发密码字段 */
      const { passwordHash, salt, ...meta } = note;
      return sendJSON(res, 200, {
        note: locked ? { ...meta, content: null, noteLocked: true, pwHint: note.pwHint || '' } : { ...meta, noteLocked: false },
      });
    }

    if (method === 'PATCH') {
      requireUnlock(req, note.folderId);
      /* 笔记自身加密则需笔记令牌 */
      if (note.passwordHash && !checkNoteUnlock(note, clientTokens(req))) {
        return sendJSON(res, 403, { error: '笔记已加密，请先输入密码解锁' });
      }
      const body = await readJSON(req);
      if (typeof body.title === 'string') note.title = body.title.slice(0, 200);
      if (typeof body.content === 'string') note.content = body.content;
      if ('folderId' in body) {
        const folderId = body.folderId || null;
        if (folderId) {
          if (!getFolder(folderId)) return sendJSON(res, 404, { error: '目标文件夹不存在' });
          requireUnlock(req, folderId);
        }
        note.folderId = folderId;
      }
      note.updatedAt = Date.now();
      saveDb();
      return sendJSON(res, 200, { ok: true });
    }

    if (method === 'DELETE') {
      requireUnlock(req, note.folderId);
      if (note.passwordHash && !checkNoteUnlock(note, clientTokens(req))) {
        return sendJSON(res, 403, { error: '笔记已加密，请先输入密码解锁' });
      }
      db.notes = db.notes.filter((n) => n.id !== note.id);
      saveDb();
      return sendJSON(res, 200, { ok: true });
    }
  }

  /* ---- 图片上传 ---- */
  if (method === 'POST' && pathname === '/api/upload') {
    const buf = await readBody(req, MAX_UPLOAD);
    const parts = parseMultipart(buf, req.headers['content-type']);
    const filePart = parts.find((p) => {
      const cd = p.headers['content-disposition'] || '';
      return /name="file"/i.test(cd) && /filename=/i.test(cd);
    });
    if (!filePart) return sendJSON(res, 400, { error: '未找到上传的文件' });
    const cd = filePart.headers['content-disposition'] || '';
    const fm = /filename="([^"]*)"/i.exec(cd);
    const filename = (fm && fm[1]) || '';
    let ext = (path.extname(filename).toLowerCase().match(/[a-z0-9]+/) || [''])[0];
    if (!ext || !IMAGE_EXTS.has(ext)) {
      ext = '';
      const ctype = filePart.headers['content-type'] || '';
      for (const [e, t] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp'], ['svg', 'image/svg+xml'], ['bmp', 'image/bmp'], ['avif', 'image/avif']]) {
        if (ctype === t) { ext = e; break; }
      }
      if (!ext) return sendJSON(res, 400, { error: '仅支持上传图片文件' });
    }
    if (!filePart.data.length) return sendJSON(res, 400, { error: '文件为空' });
    const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), filePart.data);
    return sendJSON(res, 200, { url: '/uploads/' + name });
  }

  return sendJSON(res, 404, { error: '接口不存在' });
}

/* ---------------- 入口 ---------------- */

const server = http.createServer(async (req, res) => {
  try {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch (e) {
      pathname = '/';
    }
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }
    if (pathname.startsWith('/uploads/')) {
      serveFile(res, UPLOAD_DIR, pathname.slice('/uploads/'.length));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); res.end('Method Not Allowed'); return;
    }
    if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (pathname === '/') pathname = '/index.html';
    serveFile(res, PUBLIC_DIR, pathname);
  } catch (err) {
    const status = err.status || 500;
    try { sendJSON(res, status, { error: err.message || '服务器内部错误' }); } catch (e) { /* noop */ }
  }
});

loadAll();
server.listen(PORT, HOST, () => {
  console.log(`[nasCloudNote] 服务已启动: http://${HOST}:${PORT}`);
  console.log(`[nasCloudNote] 数据目录: ${DATA_DIR}`);
});
