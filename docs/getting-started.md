# Getting Started

Welcome to ZotFlow! This guide walks you through installation and first setup.

> [!important] 📖 Strongly recommended read the Concepts Guide first
> ZotFlow has an opinionated model for how literature review works inside Obsidian (source notes, sync modes, the locked/editable system, reader modes). Spending 5 minutes with the **[Key Concepts & Design Philosophy](concepts.md)** guide will make every step below — and every setting you encounter later — immediately make sense.
>
> **[Key Concepts & Design Philosophy](concepts.md)**

---

## Part 1 — Installation

ZotFlow is available in the official Obsidian Community Plugins store. Pre-release builds are also available via BRAT.

### Option A — Community Plugins (recommended)

1. Open Obsidian → **Settings (⚙️) → Community plugins**.
2. Make sure **Restricted mode** is **off**.
3. Click **Browse**, search for **ZotFlow**, click **Install**, then **Enable**.

Direct link: [https://community.obsidian.md/plugins/zotflow](https://community.obsidian.md/plugins/zotflow)

### Option B — Beta builds via BRAT

Use this path if you want early access to features that haven't been promoted to the stable release yet.

1. **Install BRAT**
    - Open Obsidian → **Settings (⚙️) → Community plugins**.
    - Click **Browse**, search for "BRAT", install and enable it.

2. **Add ZotFlow as a beta plugin**
    - In Community plugins, click **Options** next to **BRAT**.
    - Click **Add Beta plugin**.
    - Enter the repository: `duanxianpi/obsidian-zotflow`
    - Click **Add Plugin**.

3. **Enable ZotFlow**
    - Back in **Settings → Community plugins**, find **ZotFlow**.
    - Toggle it on.

---

## Part 2 — Connect to Zotero

### Create a Zotero API Key

1. Go to [https://www.zotero.org/settings/keys/new](https://www.zotero.org/settings/keys/new).
2. Give the key a descriptive name (e.g., "ZotFlow").
3. Under **Personal Library**, check **Allow library access** and **Allow write access** (the latter is required for bidirectional sync).
4. If you want to use Zotero Item Notes (child notes), check **Allow notes access**.
5. If you use group libraries, grant access to the groups you want to sync.
6. Click **Save Key** and copy the generated key.

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

## Part 3 — Run Your First Sync

1. Click the **ZotFlow ribbon icon** (left sidebar) to open the **Activity Center**.
2. Go to the **Sync** tab.
3. Click **Sync All** to sync every non-ignored library, or click **Sync** on a specific library.
4. Watch progress in the **Tasks** tab.
5. When the task completes, your Zotero items are cached locally. You're now offline-ready.

---

## Part 4 — Browse Your Library

1. Open the **Zotero Tree View**:
    - Command palette → `ZotFlow: Open Zotero Tree View`, or
    - Click the Library icon in the left sidebar.
2. Expand libraries → collections → items → attachments.
3. Use the **search bar** at the top to filter items.
4. **Double-click** an attachment to open it in the reader.
5. **Drag** a regular item into any note to insert a citation.

---

## Part 5 — Optional Setup

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
