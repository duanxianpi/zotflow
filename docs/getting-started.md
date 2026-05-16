# Getting Started

Welcome to ZotFlow! Before you dive into installation, this guide first introduces the **key concepts** and **design philosophy** behind ZotFlow. Understanding these ideas up front will make every other doc — and every setting you tweak — make a lot more sense.

> **Already familiar with the concepts?** Jump straight to [Installation](#installation).

---

## Part 1 — Key Concepts & Design Philosophy

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

#### Editable regions: Zotero notes & annotation comments

There are two narrow exceptions to the "locked" rule. Inside a source note, ZotFlow marks **Zotero child notes** and **annotation comments** as **editable regions** — fenced by hidden `ZF_NOTE_BEG_…` / `ZF_ANNO_BEG_…` HTML comments in the template. In Source / Live Preview mode, each region shows a small **🔒 lock icon** at its start; click it to unlock and edit that region directly.

What happens when you edit an unlocked region:

- **Zotero note region** → the Markdown content is converted back to Zotero-flavored HTML and the corresponding Zotero note in IndexedDB is updated.
- **Annotation comment region** → the new comment text is written to the annotation in IndexedDB.

Edits are debounced (~2 s) and pushed back to Zotero on the next bidirectional sync. Everything else inside the body of the source note (the annotation excerpt itself, generated structure, headings) stays locked and template-driven. You can also globally flip the default with **Settings → ZotFlow → General → Default Editable Region Locked**; libraries set to **Read-Only** disable the unlock icon entirely.

**Frontmatter is the exception.** The YAML frontmatter block at the top of a source note is **always editable** — you can add your own fields (tags, status, custom metadata) freely. On the next re-render, ZotFlow **merges**: template-defined fields are refreshed from Zotero, mandatory fields (`zotflow-locked`, `library-id`, `zotero-key`, `item-version`) are re-asserted, and any custom fields you added are preserved untouched.

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

## Part 2 — Installation

> **Note:** ZotFlow is currently in beta and is not yet in the official Obsidian Community Plugins store.

### Install via BRAT

1. **Install BRAT**
    - Open Obsidian → **Settings (⚙️) → Community plugins**.
    - Click **Browse**, search for "BRAT", install and enable it.

2. **Add ZotFlow as a beta plugin**
    - In Community plugins, click **Options** next to **BRAT**.
    - Click **Add Beta plugin**.
    - Enter the repository: `duanxianpi/obsidian-zotflow`
    - Click **Add Plugin**.

3. **Enable ZotFlow**
    - Back in **Settings → Community plugins**, find **Obsidian ZotFlow**.
    - Toggle it on.

---

## Part 3 — Connect to Zotero

### Create a Zotero API Key

1. Go to [https://www.zotero.org/settings/keys/new](https://www.zotero.org/settings/keys/new).
2. Give the key a descriptive name (e.g., "ZotFlow").
3. Under **Personal Library**, check **Allow library access** and **Allow write access** (the latter is required for bidirectional sync).
4. If you use group libraries, grant access to the groups you want to sync.
5. Click **Save Key** and copy the generated key.

### Add the Key to ZotFlow

1. Open **Settings → ZotFlow → Sync**.
2. Paste the API key into the **API Key** field.
3. Click **Verify Key**.
    - ZotFlow validates the key, fetches your user info, and discovers all accessible libraries.
    - On success, a **Verified** badge appears next to the key field.
4. A **Library Synchronization** table appears with every library you can access.

### Pick a Sync Mode per Library

For each library in the table, pick a sync mode (see the [concept above](#2-zotero-is-the-source-of-truth-mostly)):

- **Bidirectional** — pulls _and_ pushes.
- **Read Only** — pulls only.
- **Ignored** — skipped.

You can change this any time.

---

## Part 4 — Run Your First Sync

1. Click the **ZotFlow ribbon icon** (left sidebar) to open the **Activity Center**.
2. Go to the **Sync** tab.
3. Click **Sync All** to sync every non-ignored library, or click **Sync** on a specific library.
4. Watch progress in the **Tasks** tab.
5. When the task completes, your Zotero items are cached locally. You're now offline-ready.

---

## Part 5 — Browse Your Library

1. Open the **Zotero Tree View**:
    - Command palette → `ZotFlow: Open Zotero Tree View`, or
    - Click the Library icon in the left sidebar.
2. Expand libraries → collections → items → attachments.
3. Use the **search bar** at the top to filter items.
4. **Double-click** an attachment to open it in the reader.
5. **Drag** a regular item into any note to insert a citation.

---

## Part 6 — Optional Setup

### WebDAV (Self-Hosted Attachments)

If your Zotero attachments live on a WebDAV server instead of Zotero cloud storage:

1. **Settings → ZotFlow → WebDAV**.
2. Enable **WebDAV Sync**.
3. Enter **Server URL**, **Username**, **Password**.
4. Click **Verify & Connect**.

### Attachment Cache

ZotFlow caches downloaded attachments for fast reopening.

- **Settings → ZotFlow → Cache → Enable Cache** (default: on).
- Set a **size limit** in MB (default: 500 MB). Oldest files are evicted first.
- Click **Purge Cache** to clear everything.

### Linked Attachment Base Directory

If you use Zotero's **Linked Attachment Base Directory** (Zotero → Preferences → Advanced → Files and Folders), tell ZotFlow where those files live:

1. **Settings → ZotFlow → General → Linked Attachment Base Directory**.
2. Enter the **same absolute path** you set in Zotero (e.g., `D:\Papers` or `/Users/name/Papers`).
3. Attachments stored as `attachments:papers/foo.pdf` will resolve to `D:\Papers\papers\foo.pdf`.

Skip this step if you don't use linked attachments.

### Local Reader for Vault Files

To open _any_ PDF/EPUB/HTML in your vault with the ZotFlow reader:

1. **Settings → ZotFlow → General → Overwrite PDF/EPUB/HTML Viewer** → enable.
2. **Restart Obsidian.**
3. Vault PDFs/EPUBs/HTMLs now open in the ZotFlow reader; annotations save to `.zf.json` sidecar files.

---

## What's Next?

Now that you understand the model and have ZotFlow running, head into the feature guides:

- **[Reading & Annotating](reading-and-annotating.md)** — Reader features, annotation types, image extraction, drag & drop.
- **[Source Notes](source-notes.md)** — How and when source notes update, frontmatter merging, version-aware re-rendering.
- **[Citation Guide](citation-guide.md)** — Every way to insert a citation, with annotation context.
- **[Template Guide](template-guide.md)** — Full LiquidJS variable & filter reference.
