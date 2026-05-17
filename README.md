# ZotFlow — Keep Your Research in Flow

> **Your Zotero library, your reader, your notes — one seamless workspace inside Obsidian.**

ZotFlow is a community plugin for [Obsidian](https://obsidian.md) that brings the full power of [Zotero](https://www.zotero.org) into your vault. Read papers, annotate PDFs, generate templated source notes, and cite literature — all without ever leaving Obsidian.

![ZotFlow Hero](docs/assets/hero.gif)

---

## Why ZotFlow?

If any of these sound like you, ZotFlow was built for you:

- 📚 You want to **read and annotate PDFs/EPUBs** without switching between Zotero, a PDF viewer, and Obsidian.
- 🎨 You want your reader to **match your Obsidian theme** — dark mode, custom fonts, the works.
- 🔄 You want **true bidirectional sync** — annotations made in Obsidian flow back to Zotero, and vice versa.
- ✍️ You want every Zotero item to have an **auto-generated, template-driven source note** that always stays up to date.
- 🔗 You want to **cite literature** in Pandoc, Wikilink, Footnote, or raw citekey format — by drag-and-drop, autocomplete, or hotkey.
- 📂 You want to annotate **any PDF or EPUB already in your vault**, even ones that aren't in Zotero.
- 🛡️ You want an **offline-first, privacy-respecting** tool with no telemetry and secure credential storage.

---

## What You Can Do With ZotFlow

### 🪟 Read & Annotate Inside Obsidian

A full-featured PDF/EPUB/HTML reader, embedded right in your workspace and **themed to match Obsidian**. Highlight, underline, draw, add sticky notes, capture image regions — every annotation type Zotero supports, in a window that finally feels like home.

![Built-in Reader](docs/assets/reader.gif)

### 🔄 True Bidirectional Sync

Pull items, metadata, and annotations from Zotero — and push your changes back. Configure each library independently as **Bidirectional**, **Read-Only**, or **Ignored**. When conflicts happen, a field-level diff viewer lets you decide what to keep.

![Bidirectional Sync](docs/assets/sync.gif)

### ✨ Template-Powered Source Notes

Every Zotero item gets one auto-generated Markdown note, rendered with [LiquidJS](https://liquidjs.com) templates you fully control.

![Source Notes](docs/assets/source-notes.gif)

### 🗒️ Native Zotero Item Notes

Create, edit, and delete **Zotero child notes** without leaving Obsidian. Right-click any item in the Tree View to add a note, edit it in a dedicated tab with Obsidian's full Markdown editor, or unlock its region inside the parent source note and edit in place. Every change auto-saves and syncs back to Zotero.

![Item Notes](docs/assets/item-notes.gif)

### 📝 Annotate Any Vault File

Have PDFs or EPUBs that aren't in Zotero? Open them with the same reader. Annotations save into a co-located `.zf.json` sidecar — no Zotero account required. Perfect for personal notes, downloaded papers, or books you're reading.

![Local Reader](docs/assets/local-reader.gif)

### 📎 Multi-Format Citations

Insert citations as **Pandoc** (`[@key]`), **Wikilink** (`[[Source/@key|Author (year)]]`), **Footnote**, or raw **citekey** — via drag-and-drop from the tree view, autocomplete with a trigger string (`@@`), or copy-from-reader hotkeys. Include annotation context (page numbers, quoted text) automatically.

![Citations](docs/assets/citations.gif)

### 🌳 Zotero Tree View & Search Modal

Browse your entire Zotero universe — libraries, collections, items, attachments — in a fast virtualized sidebar tree. Search, sort, drag, right-click. Click any attachment to open it; drag any item to cite it.

Or open the search modal from the command palette, type to filter your library, and hit Enter to jump to an item or open its attachment.

![Tree View](docs/assets/tree-view.gif)

### 🛠️ And a Whole Lot More

- **WebDAV support** — download attachments from your self-hosted Zotero storage.
- **Linked attachment base directory** — works with Zotero's external file storage feature.
- **Batch operations** — generate every source note, extract every annotation image, re-render every template in one click.
- **Activity Center** — a control panel for sync progress, running tasks, and a searchable log console.
- **Offline-first** — everything cached locally in IndexedDB; the network is only used for Zotero and WebDAV.
- **Secure credentials** — API keys stored in Obsidian's platform-native `SecretStorage`, never in synced `data.json`.
- **Mobile-aware** — built to be mobile-safe (current mobile support is limited).

---

## Quick Start

New to ZotFlow? Start here:

👉 **[Read the Getting Started guide](docs/getting-started.md)** — it introduces ZotFlow's key concepts and design philosophy first, then walks you through installation and your first sync.

For the impatient:

1. Open **Settings → Community plugins → Browse**, search for **ZotFlow**, install and enable it. (Or grab it from the [Obsidian plugin directory](https://community.obsidian.md/plugins/zotflow).)
2. Create a [Zotero API key](https://www.zotero.org/settings/keys/new) with read/write access.
3. Paste it into **Settings → ZotFlow → Sync** and click **Verify Key**.
4. Open the **Activity Center** (ribbon icon) → **Sync All**.
5. Open the **Zotero Tree View**, double-click an attachment, and start reading.

---

## Documentation

Full guides live in [docs/](docs/README.md):

- **[Getting Started](docs/getting-started.md)** — Concepts, philosophy, installation, first sync.
- **[Reading & Annotating](docs/reading-and-annotating.md)** — Using the built-in reader.
- **[Source Notes](docs/source-notes.md)** — How auto-generated notes work and how to customize them.
- **[Citation Guide](docs/citation-guide.md)** — Every way to insert a citation.
- **[Template Guide](docs/template-guide.md)** — Full LiquidJS variable & filter reference.

---

## Installation

### Option 1 — Obsidian Community Plugins (recommended)

1. Open Obsidian → **Settings (⚙️) → Community plugins**.
2. Click **Browse**, search for **ZotFlow**, install and enable it.

Direct link: [https://community.obsidian.md/plugins/zotflow](https://community.obsidian.md/plugins/zotflow)

### Option 2 — Beta builds via BRAT

For pre-release builds, install via [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable **BRAT** from Community Plugins.
2. In BRAT's options, click **Add Beta plugin** and enter: `duanxianpi/obsidian-zotflow`
3. Enable **ZotFlow** in Community Plugins.

See the [Getting Started guide](docs/getting-started.md) for step-by-step setup.

---

## Architecture

ZotFlow uses a **Main Thread + Web Worker** split for responsiveness:

- **Main thread** — Obsidian API, UI rendering (React for complex views, native APIs for settings).
- **Web Worker** — Zotero API calls, sync engine, IndexedDB (Dexie), template rendering, PDF processing.
- **Reader iframe** — Zotero's PDF/EPUB/HTML reader, embedded and sandboxed via penpal.

Communication: [Comlink](https://github.com/GoogleChromeLabs/comlink) (main ↔ worker) and [Penpal](https://github.com/nicmeriano/penpal) (main ↔ reader iframe).

---

## Development

### Prerequisites

- Node.js ≥ 16
- npm

### Setup

```bash
git clone https://github.com/duanxianpi/obsidian-zotflow.git --recursive
cd obsidian-zotflow
npm install
```

### Build

```bash
npm run build:ci       # Full CI build (PDF.js + reader + plugin)
npm run dev:plugin     # esbuild watch mode (plugin)
npm run dev:reader     # webpack watch mode (reader, separate terminal)
npm run lint
```

### Local install

Copy `main.js`, `manifest.json`, and `styles.css` to:

```
<vault>/.obsidian/plugins/obsidian-zotflow/
```

Reload Obsidian and enable the plugin.

---

## Privacy

- **No telemetry. No analytics. No tracking.**
- Network requests go only to the Zotero API and your configured WebDAV server.
- Credentials live in Obsidian's platform-native `SecretStorage`.
- The reader iframe communicates only via structured-clone messaging — no `eval`, no remote code.

---

## License

[AGPL-3.0-only](LICENSE)

---

## Author

**Xianpi Duan** — [GitHub](https://github.com/duanxianpi/)

## Sponsor

Thanks for checking out ZotFlow! I'm currently a student building this on nights and weekends. If it helps your research, a small tip keeps the features shipping.

<div>
	<a href="https://www.buymeacoffee.com/duanxianpi" target="_blank" title="buymeacoffee">
	  <img src="https://iili.io/JoQ0zN9.md.png"  alt="buymeacoffee-orange-badge" style="width: 200px;">
	</a>
</div>

---

## Acknowledgements

ZotFlow stands on the shoulders of some incredible open-source work. Huge thanks to the teams and individuals behind these projects — they inspired the design, shaped the architecture, and in some cases provided the actual engine running inside ZotFlow:

- **[Zotero Reader](https://github.com/zotero/reader)** — the PDF/EPUB/HTML reader engine embedded in ZotFlow. Without this, there's no reader.
- **[Zotero Web Library](https://github.com/zotero/web-library)** — reference for understanding Zotero's data model and UI patterns.
- **[Obsidian Zotero Integration](https://github.com/obsidian-community/obsidian-zotero-integration)** by mgmeyers — the battle-tested original that countless researchers rely on. ZotFlow owes a lot to its design decisions.
- **[ZotLit](https://github.com/aidenlx/zotlit)** by aidenlx — a beautiful, thoughtfully built plugin that pushed the bar for what Zotero+Obsidian integration could look like.
- **[Zotero Better Notes](https://github.com/windingwind/zotero-better-notes)** by windingwind — inspired ZotFlow's approach to seamless note editing and the tight Markdown↔HTML note sync loop.

---

## Roadmap & Feedback

Have ideas or found a bug? Join the Discord!

<a href="https://discord.gg/7vNrR6qhVr"> <img alt="Join our Discord" src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white&style=for-the-badge"> </a>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=duanxianpi/obsidian-zotflow&type=date&legend=top-left)](https://www.star-history.com/#duanxianpi/obsidian-zotflow&type=date&legend=top-left)
