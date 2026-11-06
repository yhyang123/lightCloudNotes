# 📝 lightCloudNotes · 自托管云笔记

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D16-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/npm%20deps-0-success)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](Dockerfile)

一个**零 npm 依赖、单容器**的自托管云笔记应用，专为 NAS 部署设计。Markdown 浏览器依赖随项目本地分发，离线可用。

- 🚫 **零 npm 依赖**：后端仅用 Node.js 原生模块（http / fs / crypto），构建秒级、离线可用、无供应链风险
- 🪶 **极简架构**：一个 `server.js` + 三个前端文件，合计约 2600 行，可通读、可审计
- 🔒 **双层加密**：文件夹 + 笔记均可独立设密码，scrypt 加盐哈希，逐层校验祖先锁
- 💾 **数据自持**：所有数据（笔记 + 图片）保存在本地 `data/` 目录，备份即拷贝一个文件夹

---

## ✨ 功能特性

### 📁 文件夹与笔记管理
- 文件夹任意层级嵌套，新建 / 重命名 / 删除 / 移动
- 笔记新建 / 重命名 / 删除 / 跨文件夹移动
- 右键菜单（重命名 / 设密码 / 移动）+ 双击重命名
- 标题搜索、侧栏拖拽调宽、侧栏折叠

### 🔐 密码保护（文件夹级 + 笔记级）
- 任意文件夹可**独立设密码**（scrypt 哈希 + 随机盐，不明文存储）
- 加锁文件夹必须输入密码才能展开查看，**父加密 + 子再加密的嵌套锁逐层校验**
- 笔记也可单独加密，与所在文件夹锁互相独立
- 解锁令牌基于 HMAC 签名，保存在浏览器 sessionStorage，关闭标签页即失效
- 支持随时重新上锁、修改 / 移除密码、设置密码提示

### ✍️ 富文本编辑器
- 加粗 / 斜体 / 下划线 / 删除线，标题（H1–H3）/ 引用 / 代码块
- 无序 / 有序列表、链接、分隔线、撤销 / 重做
- 字体大小与文字颜色、背景高亮（工具栏 + 选中文字浮动气泡双入口）
- **图片**：按钮 / 粘贴 / 拖拽三种方式上传，存至服务器
- **表格**：自定义行列，直接在单元格内编辑
- 只读 / 编辑模式切换（默认只读，防误改）
- 标题旁可收起 / 展开格式工具栏，折叠状态按设备记忆；收起不影响 Markdown 快捷输入，PDF 不显示开关。
- 手机及折叠屏紧凑布局（视口不超过 1100px）：标题、时间与操作分行，按钮集中排列；只读时隐藏格式工具栏。
- 工具栏常驻加粗、正文 / 标题、撤销；文字样式、列表、插入操作按组展开，选区格式保留，窄屏无需长距离横滑。

### 📝 富文本 Markdown 快捷语法
- 直接在当前富文本笔记中输入，无需创建 Markdown 文件或切换编辑器；转换结果按原有 HTML 保存。
- 行首 `#` / `##` / `###` 后按空格生成标题，`>` 后按空格生成引用。
- 行首 `-` / `*` / `+` 后按空格生成无序列表，`1.` 后按空格生成有序列表。
- 独立一行输入三个反引号（可附语言名）后按回车生成代码块，`---` / `***` 后按回车生成分隔线。
- 输入 `**文字**`、`*文字*`、`~~文字~~`、单反引号包裹代码，分别转换为加粗、斜体、删除线、行内代码。
- 粘贴、输入法组合输入、代码块、表格不会触发；列表或复杂富文本段落不执行行首转换。可使用原生撤销 / 重做。
- 工具栏「M↓ 快捷语法」可查看说明。图片旋转、表格、字体颜色等现有操作保留不变。
- 不再提供独立 Markdown 新建或副本转换入口；兼容此前测试产生的 Markdown 笔记，保留其源码编辑与预览，不自动改写数据。
- 兼容预览使用本地 Marked 15.0.12、DOMPurify 3.2.7，许可证位于 `public/vendor/`，无需联网。

### 💾 自动保存
- 停止输入 1.2 秒后自动保存，`Ctrl / ⌘ + S` 手动保存
- 窗口失焦 / 标签页隐藏时立即保存
- 页面关闭前通过 `navigator.sendBeacon` 兜底最后保存一次

---

## 🚀 快速开始

### 本地运行（无需 Docker）

```bash
node server.js
# 打开 http://localhost:3000
```

要求 Node.js **≥ 16**，无需 `npm install`。

### Docker Compose（推荐 NAS 部署）

```bash
docker compose up -d --build
```

访问 `http://NAS的IP:3000`。

### Docker 手动构建

```bash
docker build -t nascloudnote .
docker run -d \
  --name nascloudnote \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /volume1/docker/nascloudnote/data:/app/data \
  nascloudnote
```

---

## 💽 数据持久化

所有数据都在挂载的 `data` 目录里：

| 文件 / 目录 | 内容 |
|---|---|
| `data/db.json` | 全部文件夹与笔记数据 |
| `data/uploads/` | 上传的图片 |
| `data/secret.key` | 解锁令牌的签名密钥（**丢失后所有已加密内容无法解锁，请一并备份**） |

升级镜像时**保留 `data` 目录**即可，笔记数据不受影响。

---

## ⚙️ 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | 数据目录 |

---

## 🗂 目录结构

```
nasCloudNote/
├── server.js              # 零依赖 Node.js 后端（路由 / 鉴权 / 存储 / 静态服务）
├── public/
│   ├── index.html         # 页面结构
│   ├── style.css          # 样式
│   └── app.js             # 前端逻辑
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── .gitignore
└── data/                  # 运行时生成，已 gitignore（数据库 + 密钥 + 图片）
```

---

## 🛠 技术说明

### 架构

```
浏览器 (原生 HTML/CSS/JS)
        │  REST API + multipart 上传
        ▼
server.js (Node 原生 http)
        │  同步写 JSON 文件 + 文件流
        ▼
data/  (db.json + uploads/ + secret.key)
```

- **前端**：原生 HTML / CSS / JS，`contenteditable` 富文本，无框架无构建
- **后端**：Node.js 原生 `http` 模块，手写路由、multipart 解析、静态文件服务
- **存储**：单 JSON 文件，写盘采用 `tmp + rename` 保证原子性

### 加密设计
- 文件夹 / 笔记密码：`scrypt(password, salt, 64)` 哈希，随机 16 字节盐
- 解锁令牌：`HMAC-SHA256(secret, folderId)` / `HMAC-SHA256(secret, 'note:'+noteId)`
- 校验：沿文件夹祖先链逐层检查所有锁，任一未解锁即 403
- 令牌经 `X-Unlock` 请求头携带，前端存于 sessionStorage（会话级）

### API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tree` | 目录树 |
| POST | `/api/folders` | 新建文件夹 |
| PATCH / DELETE | `/api/folders/:id` | 改 / 删文件夹 |
| POST | `/api/folders/:id/password` | 设 / 改 / 移除密码 |
| POST | `/api/folders/:id/unlock` | 解锁文件夹 |
| GET | `/api/folders/:id/children` | 展开子文件夹 |
| GET | `/api/folders/:id/hint` | 密码提示 |
| GET / POST | `/api/notes` | 笔记列表 / 新建 |
| GET / PATCH / DELETE | `/api/notes/:id` | 读 / 改 / 删笔记 |
| POST | `/api/notes/:id/password` · `/unlock` · `/hint` | 笔记密码相关 |
| POST | `/api/notes/:id/beacon` | 关页面兜底保存 |
| POST | `/api/upload` | 图片上传（multipart） |

---

## ⚠️ 注意事项

- **密码无法找回**。忘记密码时只能删除该文件夹 / 笔记，请务必牢记。
- 目前**未内置登录认证**，适合家庭内网 / VPN 使用；若暴露公网，请自行加反向代理 Basic Auth 或 IP 白名单。
- 图片上传单张上限 **20MB**，笔记正文上限 **15MB**。
- 首次启动会自动生成 `data/secret.key`，请勿删除或泄露。

---

## 📄 License

[MIT](LICENSE) © 2026
