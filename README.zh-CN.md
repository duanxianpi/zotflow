# ZotFlow — 让你的科研工作流保持顺畅

[English](README.md) | 简体中文

> **你的 Zotero 文献库、阅读器与笔记，在 Obsidian 里无缝衔接。**

ZotFlow 是一个 [Obsidian](https://obsidian.md) 社区插件，可将 [Zotero](https://www.zotero.org) 的核心能力直接带入你的库。你可以在不离开 Obsidian 的情况下阅读论文、标注 PDF、生成模板化来源笔记并插入引用。

![ZotFlow Hero](docs/assets/hero.gif)

---

## 为什么选择 ZotFlow？

如果你有这些需求，ZotFlow 就是为你设计的：

- 📚 想在一个地方完成 **PDF/EPUB 阅读与标注**，不再在 Zotero、PDF 阅读器和 Obsidian 之间来回切换。
- 🎨 想让阅读器 **自动匹配 Obsidian 主题**，包括深色模式和自定义字体。
- 🔄 想要 **真正的双向同步**：在 Obsidian 做的标注可回写 Zotero，反之亦然。
- ✍️ 想为每个 Zotero 条目自动生成 **可模板化的来源笔记**，并保持持续更新。
- 🔗 想用拖拽、自动补全或快捷键插入文献引用，支持 **Pandoc / Wikilink / 脚注 / citekey** 多种格式。
- 📂 想直接标注 **库内任意 PDF/EPUB**，即使它们不在 Zotero 里。
- 🛡️ 想要一个 **离线优先、尊重隐私** 的工具：无遥测，凭据安全存储。

---

## ZotFlow 能做什么

### 🪟 在 Obsidian 内阅读与标注

完整功能的 PDF/EPUB/HTML 阅读器，直接嵌入工作区并与 Obsidian 主题一致。高亮、下划线、手写、便签、区域截图等 Zotero 支持的标注类型都可用。

![Built-in Reader](docs/assets/reader.gif)

### 🔄 真正的双向同步

从 Zotero 拉取条目、元数据和标注，也可将改动回推到 Zotero。每个文献库可独立设置为 **双向**、**只读** 或 **忽略**。发生冲突时，可用字段级差异视图手动决策。

![Bidirectional Sync](docs/assets/sync.gif)

### ✨ 模板驱动来源笔记

每个 Zotero 条目都可生成一份 Markdown 来源笔记，并通过 [LiquidJS](https://liquidjs.com) 模板完全自定义。

![Source Notes](docs/assets/source-notes.gif)

### 🗒️ 原生 Zotero 条目笔记支持

无需离开 Obsidian，即可创建、编辑、删除 **Zotero 子笔记**。可在树视图右键创建，也可在专用标签页编辑，或在来源笔记可编辑区域内原位修改；改动自动保存并回写 Zotero。

![Item Notes](docs/assets/item-notes.gif)

### 📝 标注任意库内文件

如果你的 PDF/EPUB 不在 Zotero 中，也能用同一个阅读器打开。标注会保存到同目录 `.zf.json` 边车文件，无需 Zotero 账号。

![Local Reader](docs/assets/local-reader.gif)

### 📎 多格式引用

可插入 **Pandoc** (`[@key]`)、**Wikilink** (`[[Source/@key|Author (year)]]`)、**脚注** 或原始 **citekey**。支持从树视图拖拽、触发字符串自动补全（`@@`）以及阅读器快捷键复制；还可自动带入页码与摘录内容。

![Citations](docs/assets/citations.gif)

### 🌳 Zotero 树视图与搜索弹窗

在高性能虚拟树中浏览你的全部 Zotero 内容：文献库、集合、条目、附件。支持搜索、排序、拖拽、右键操作。双击附件即可打开，拖拽条目即可引用。

![Tree View](docs/assets/tree-view.gif)

### 🛠️ 还有更多

- **WebDAV 支持**：从自托管 Zotero 存储下载附件。
- **链接附件基础目录**：兼容 Zotero 外部文件存储模式。
- **批量任务**：一键批量生成来源笔记、提取标注图片、重渲染模板。
- **活动中心**：查看同步进度、运行任务与可搜索日志。
- **离线优先**：数据本地缓存到 IndexedDB，网络仅用于 Zotero/WebDAV。
- **安全凭据**：API Key 使用 Obsidian 原生 `SecretStorage` 保存，不写入 `data.json`。
- **移动端友好**：架构支持移动端（当前能力仍有一定限制）。

---

## 快速开始

初次使用 ZotFlow？从文档网站开始：

👉 **[阅读文档网站（中文）](https://zotflow.peterduan.dev/zh)**

如果你希望快速上手：

1. 打开 **设置 → 第三方插件 → 浏览**，搜索 **ZotFlow**，安装并启用。（也可通过 [Obsidian 插件目录](https://community.obsidian.md/plugins/zotflow)）
2. 创建一个具备读写权限的 [Zotero API Key](https://www.zotero.org/settings/keys/new)
3. 在 **设置 → ZotFlow → Sync** 粘贴 API Key，点击 **Verify Key**
4. 打开 **Activity Center**（侧边栏图标）→ **Sync All**
5. 打开 **Zotero Tree View**，双击附件即可开始阅读

---

## 文档

请优先使用新文档网站：

- **English:** [https://zotflow.peterduan.dev/](https://zotflow.peterduan.dev/)
- **简体中文:** [https://zotflow.peterduan.dev/zh](https://zotflow.peterduan.dev/zh)

仓库中的 [docs/](docs/README.md) 目录仍保留为历史 Markdown 文档。

---

## 安装

### 方案 1：Obsidian 社区插件（推荐）

1. 打开 Obsidian → **设置（⚙️）→ 第三方插件**。
2. 点击 **浏览**，搜索 **ZotFlow**，安装并启用。

直达链接：[https://community.obsidian.md/plugins/zotflow](https://community.obsidian.md/plugins/zotflow)

### 方案 2：通过 BRAT 安装测试版

若要体验预发布版本，可使用 [BRAT](https://github.com/TfTHacker/obsidian42-brat)：

1. 在第三方插件中安装并启用 **BRAT**。
2. 在 BRAT 选项中点击 **Add Beta plugin**，输入：`duanxianpi/obsidian-zotflow`
3. 在第三方插件列表中启用 **ZotFlow**。

详细步骤见文档网站：[https://zotflow.peterduan.dev/zh](https://zotflow.peterduan.dev/zh)

---

## 架构

ZotFlow 采用 **主线程 + Web Worker** 架构以提升响应性：

- **主线程**：负责 Obsidian API 与 UI 渲染（复杂界面使用 React，设置页使用原生 API）。
- **Web Worker**：负责 Zotero API 调用、同步引擎、IndexedDB（Dexie）、模板渲染与 PDF 处理。
- **阅读器 iframe**：嵌入并沙箱化的 Zotero PDF/EPUB/HTML 阅读器。

通信机制：主线程与 Worker 使用 [Comlink](https://github.com/GoogleChromeLabs/comlink)，主线程与阅读器 iframe 使用 [Penpal](https://github.com/nicmeriano/penpal)。

---

## 开发

### 前置要求

- Node.js ≥ 16
- npm

### 初始化

```bash
git clone https://github.com/duanxianpi/obsidian-zotflow.git --recursive
cd obsidian-zotflow
npm install
```

### 构建

```bash
npm run build:ci       # 完整 CI 构建（PDF.js + reader + plugin）
npm run dev:plugin     # 插件 esbuild watch
npm run dev:reader     # 阅读器 webpack watch（需单独终端）
npm run lint
```

### 本地安装

将 `main.js`、`manifest.json`、`styles.css` 复制到：

```
<vault>/.obsidian/plugins/obsidian-zotflow/
```

重载 Obsidian 后启用插件。

---

## 隐私

- **无遥测、无分析、无追踪**。
- 网络请求仅发往 Zotero API 与你配置的 WebDAV 服务器。
- 凭据保存在 Obsidian 平台原生 `SecretStorage`。
- 阅读器 iframe 仅通过结构化消息通信，不使用 `eval`、不执行远程代码。

---

## 许可证

[AGPL-3.0-only](LICENSE)

---

## 作者

**Xianpi Duan** — [GitHub](https://github.com/duanxianpi/)

## 赞助

感谢使用 ZotFlow！我目前是学生，利用业余时间持续开发这个项目。如果它对你的研究有帮助，欢迎小额赞助支持项目继续迭代。

<div>
	<a href="https://www.buymeacoffee.com/duanxianpi" target="_blank" title="buymeacoffee">
	  <img src="https://iili.io/JoQ0zN9.md.png"  alt="buymeacoffee-orange-badge" style="width: 200px;">
	</a>
</div>

---

## 致谢

ZotFlow 站在许多优秀开源项目之上。感谢这些项目的团队与作者，他们启发了 ZotFlow 的产品设计与技术架构：

- **[Zotero Reader](https://github.com/zotero/reader)** — ZotFlow 内嵌 PDF/EPUB/HTML 阅读器的核心引擎。
- **[Task Genius](https://github.com/taskgenius)** — ZotFlow 的可嵌入 Markdown 编辑器能力来源。
- **[Zotero Web Library](https://github.com/zotero/web-library)** — Zotero 数据模型与交互模式的重要参考。
- **[Obsidian Zotero Integration](https://github.com/obsidian-community/obsidian-zotero-integration)**（mgmeyers）— 经典实现，给了 ZotFlow 大量启发。
- **[ZotLit](https://github.com/aidenlx/zotlit)**（aidenlx）— 在 Zotero 与 Obsidian 联动体验上树立了高标准。
- **[Zotero Better Notes](https://github.com/windingwind/zotero-better-notes)**（windingwind）— 启发了 ZotFlow 在笔记编辑与 Markdown↔HTML 同步方面的设计。

---

## 路线图与反馈

有建议或发现 bug？欢迎加入 Discord：

<a href="https://discord.gg/7vNrR6qhVr"> <img alt="Join our Discord" src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white&style=for-the-badge"> </a>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=duanxianpi/obsidian-zotflow&type=date&legend=top-left)](https://www.star-history.com/#duanxianpi/obsidian-zotflow&type=date&legend=top-left)
