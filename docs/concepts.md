# ZotFlow — Key Concepts & Design Philosophy

> **This is the most important doc to read before using ZotFlow.**
>
> ZotFlow has an opinionated model for how literature review should work inside Obsidian. Spending 5 minutes here will make every other setting, every doc, and every design decision immediately make sense.

---

ZotFlow isn't just "Zotero inside Obsidian." It's a particular _way_ of working with literature in your vault, shaped by a few opinionated choices. Here are the ideas to keep in your head as you use it.

### 1. Stay in the Flow

The whole point of ZotFlow is to **eliminate app-switching**. Reading, annotating, citing, note-taking — they should all happen inside one tool, with one set of keybindings, in one theme. Every feature in ZotFlow is designed to remove a reason to leave Obsidian.

### 2. Zotero Is the Source of Truth (Mostly)

Your Zotero library is the canonical store for your references. ZotFlow:

- **Pulls** metadata, items, collections, and annotations from Zotero into a local IndexedDB cache.
- **Pushes** changes you make in Obsidian (annotations, edits) back to Zotero — if you let it.

Each library you have access to is configured independently as one of:

| Mode              | What it does                                                                           |
| ----------------- | -------------------------------------------------------------------------------------- |
| **Bidirectional** | Pulls from Zotero and pushes local changes back. Requires write access on the API key. |
| **Read Only**     | Pulls only. Your local annotations stay local and never reach Zotero.                  |
| **Ignored**       | Skipped entirely during sync.                                                          |

When the same field changes in both places between syncs, a **field-level diff viewer** lets you decide which side wins.

### 3. Source Notes: One Note Per Item, Auto-Generated, Locked

For every Zotero item you sync, ZotFlow can generate one Markdown file — a **source note**. This is the central idea of ZotFlow's note model:

- **One note per source.** A stable, addressable node in your knowledge graph for every paper or book.
- **Auto-generated from a template.** You define the template (with [LiquidJS](https://liquidjs.com)); ZotFlow fills in metadata, child notes, attachments, and annotations.
- **Locked by default.** Source notes carry a `zotflow-locked: true` frontmatter flag, open in reading view, and are read-only. They re-render whenever the underlying item or its annotations change.

#### Link, don't edit

Source notes capture **what the author said**. Your own thinking — interpretations, critiques, ideas the paper sparked — belongs in **separate notes** that link back to the source note. This boundary is the single most important thing to internalize:

> 🧠 **The source note is _not_ your note. It's the author's note, automatically maintained for you. Your notes link _to_ it.**

This is a Zettelkasten-flavored design: stable, atomic, never-rewritten reference nodes — surrounded by your own evolving, editable insight notes.

#### Zotero Item Notes: editable regions & the standalone editor

Zotero **child notes** (note items attached to a parent paper, book, etc.) are the most important exception to the "locked" rule. ZotFlow treats them as **first-class, editable objects** with two equivalent editing surfaces — both write to the same record in IndexedDB and both push back on the next bidirectional sync.

- **Editable region inside the source note** — every child note rendered into a source note is fenced by hidden `ZF_NOTE_BEG_<key>` / `ZF_NOTE_END_<key>` HTML comments. In Source / Live Preview mode the region shows a small **🔒 lock icon** at its start; click to unlock and edit in place. Annotation comments work the same way (fenced by `ZF_ANNO_…` markers).
- **Standalone Note Editor view** — double-click a `📝` note in the Tree View (or use the `Open note` action) to open the same child note in its own Obsidian tab, powered by the full embeddable Markdown editor. Right-click any non-attachment item to **Create child note** or right-click a note to **Delete note**.

See the [Item Notes guide](item-notes.md) for the full create / edit / delete workflow.

**Frontmatter is the other exception.** The YAML frontmatter block at the top of a source note is **always editable** — you can add your own fields (tags, status, custom metadata) freely. On the next re-render, ZotFlow **merges**: template-defined fields are refreshed from Zotero, mandatory fields (`zotflow-locked`, `library-id`, `zotero-key`, `item-version`) are re-asserted, and any custom fields you added are preserved untouched.

### 4. Two Reader Modes: Library vs Local

ZotFlow's built-in reader (the same engine Zotero uses for PDFs, EPUBs, and HTML snapshots, themed to match Obsidian) works in two modes:

| Mode               | What it reads                                        | Where annotations live                                       |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------------------ |
| **Library Reader** | Attachments from your synced Zotero library          | In Zotero (synced back via bidirectional sync)               |
| **Local Reader**   | PDF/EPUB/HTML files that live directly in your vault | In a co-located `.zf.json` **sidecar file** next to the file |

The Local Reader is opt-in: enable **Settings → ZotFlow → General → Overwrite PDF/EPUB/HTML Viewer** to make any vault PDF/EPUB/HTML open in ZotFlow's reader. Local annotations never touch Zotero.

### 5. Templates Are Everywhere

ZotFlow is **template-first**. Almost everything user-facing is rendered through a LiquidJS template you can customize:

- The path where a source note is created.
- The body of library source notes.
- The body of local source notes.
- Every citation format (Pandoc, Wikilink, Footnote, Citekey, Embed).

If you don't like the default output, you don't file a feature request — you edit the template. See the [Template Guide](template-guide.md) for the full variable and filter reference.

### 6. Offline-First

Every Zotero item, collection, and library you sync is cached locally in IndexedDB. After the first sync you can browse, read, search, and edit annotations **with no network connection**. Network is only used for two things:

- Syncing with the Zotero Web API.
- Downloading attachments (from Zotero cloud storage or your WebDAV server).

Cached attachment files are managed with an LRU policy and a size limit you control.

### 7. The Two Main Surfaces

You'll interact with ZotFlow mostly through two UI surfaces. Get familiar with these and you know your way around:

- **🌳 Zotero Tree View** (sidebar) — your navigation. Browse libraries → collections → items → attachments. Search, sort, drag items to cite them, double-click attachments to open them.
- **⚙️ Activity Center** (modal, opened from ribbon) — your control panel. Trigger syncs, watch task progress, inspect the log console, test templates.

### 8. Privacy & Security by Default

- No telemetry, analytics, or third-party tracking.
- Network calls go only to the Zotero API and your configured WebDAV.
- API keys and WebDAV passwords are stored in Obsidian's platform-native `SecretStorage` — **not** in your synced `data.json`.

---

Ready to install? Head to the **[Getting Started guide](getting-started.md)**.
