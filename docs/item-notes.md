# Item Notes

A Zotero **child note** (a note item attached to a parent paper, book, or other library item) is a first-class object in ZotFlow. You can **create** them, **edit** them, and **delete** them — entirely from inside Obsidian — and your changes flow back to Zotero on the next bidirectional sync.

There are two distinct concepts that can both be called "notes." Don't confuse them:

| Concept                          | What it is                                                                        | Where it lives                                |
| -------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------- |
| **Source note** (Obsidian)       | The auto-generated, template-rendered Markdown file for a Zotero item             | A `.md` file in your vault                    |
| **Item note** (Zotero, this doc) | A Zotero child-note item attached to a parent item — Zotero's native note feature | IndexedDB → synced to Zotero on the next sync |

This guide covers **item notes** only. For source notes, see [Source Notes](source-notes.md).

---

## Where Item Notes Show Up

In the **Zotero Tree View**, child notes appear as `📝` leaves under their parent item:

```
📚 My Library
└── 📄 Smith et al. (2024) — Distributed Tracing
    ├── 📎 smith2024.pdf
    ├── 📝 Open questions
    └── 📝 Summary
```

Inside a **source note**, every child note is rendered into its own editable region fenced by `<!-- ZF_NOTE_BEG_<key> --> … <!-- ZF_NOTE_END_<key> -->` markers (see [Editable Regions](source-notes.md#editable-regions)).

---

## Create an Item Note

From the **Zotero Tree View**:

1. **Right-click** a parent item (anything that's not a standalone attachment).
2. Choose **Create child note**.
3. ZotFlow:
    - Creates an empty note item in IndexedDB with `syncStatus: "created"`.
    - Refreshes the tree so the new `📝` node appears.
    - Opens the new note in the **Note Editor view** in a new tab, ready for typing.

> The note is given a temporary key. On the next bidirectional sync, Zotero assigns the real key and ZotFlow updates the local record. Until then, the note is fully usable locally.

**Permissions.** The **Create child note** action is hidden when:

- The item is a **standalone attachment** (attachments without a parent can't have children).
- The library is set to **Read Only**, or the API key lacks `notes` write permission.

---

## Edit an Item Note

There are two ways to edit an item note. Both write to the same record in IndexedDB and both produce the same outgoing sync — pick whichever fits your context.

### 1. Note Editor view (full-tab editor)

Open the Note Editor by:

- **Double-clicking** a `📝` node in the Tree View, **or**
- Right-clicking and selecting **Open note** (where applicable), **or**
- Using a `obsidian://zotflow?type=open-note&libraryID=<id>&key=<key>` URI.

The editor is Obsidian's standard embeddable Markdown editor, so all your hotkeys, snippets, CSS, and plugin behaviors work normally. What it does on top:

- **Loads** the note's Zotero HTML, converts it to Markdown, and renders it.
- **Strips** the internal `<!-- ZF_NOTE_META … -->` round-trip comment so you never see or edit it.
- **Saves** automatically on every change with a ~2 s debounce. There is no "save" button.
- **Updates the tab title** from the note's first line.
- **Refreshes the source note** of the parent item (debounced) so the embedded region reflects your edit.
- **Shows `(READ ONLY)`** in the tab title when the library is read-only — the editor is loaded but typing is disabled.

### 2. Editable region inside the source note

If you have the **parent's source note** open in Source or Live Preview mode, scroll to the child note's region and click the **🔒 lock icon** at the start of its `ZF_NOTE_BEG_…` fence. The region becomes editable. Type your edits in place. After the ~2 s debounce, ZotFlow converts the Markdown back to Zotero-flavored HTML and updates the same IndexedDB record. The Note Editor view (if open) will refresh; the source note re-render is suppressed to avoid overwriting what you just typed.

See [Editable Regions](source-notes.md#editable-regions) for the full mechanics of the unlock workflow and the global default-locked setting.

> ⚠️ **Don't edit a note from both surfaces at the same time.** Both write to the same IDB record. If you have the Note Editor open and the source note open and type in both within the debounce window, the last write wins.

---

## Delete an Item Note

From the **Zotero Tree View**:

1. **Right-click** a `📝` note node.
2. Choose **Delete note**.

ZotFlow marks the note for deletion in IndexedDB, refreshes the tree, and shows a `Note deleted.` notification. The deletion is pushed to Zotero on the next bidirectional sync. If the note had only ever lived locally (`syncStatus: "created"`, never synced), it's removed outright.

> There is no undo. If you delete by accident, recreate the note before the next sync or restore it from Zotero afterwards.

---

## Sync Behavior

Every create / edit / delete of an item note is captured locally first and reconciled with Zotero on the next sync.

| Local action | Local `syncStatus` | What the next bidirectional sync does            |
| ------------ | ------------------ | ------------------------------------------------ |
| Create       | `"created"`        | Pushes a new note item to Zotero, gets real key. |
| Edit         | `"updated"`        | Pushes the new HTML to Zotero.                   |
| Delete       | `"deleted"`        | Deletes the note item from Zotero.               |

Item notes follow the same **field-level conflict resolution** as other items: if the same note is edited in both Zotero and ZotFlow between syncs, the diff viewer lets you choose the winner.

---

## Markdown ↔ Zotero HTML Conversion

Zotero stores notes as ProseMirror HTML. ZotFlow converts on the way in and on the way out:

- **Open / display** — IDB HTML → Markdown via the `html2md` pipeline.
- **Save** — Markdown → HTML via the `md2html` pipeline.

The conversion is **round-trip safe** for the features Zotero supports (rich text, headings, lists, tables, images, math, code, blockquotes, links, citations). For internal implementation details see [convert-pipeline.md](convert-pipeline.md).

A small `<!-- ZF_NOTE_META … -->` comment is preserved internally to maintain wrapper-div attributes (schema version, etc.) across round-trips. The Note Editor strips it from the visible content and re-injects it on save — you should never see it.

---

## Permissions Recap

| Scope                                                 | Behavior                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| Library mode = **Bidirectional**, key has notes/write | Create / edit / delete all enabled. Changes pushed on next sync.      |
| Library mode = **Read Only**                          | Create and delete actions hidden in the tree. Editors load read-only. |
| API key lacks notes write permission                  | Same as Read Only — actions hidden, editors read-only.                |
| Library mode = **Ignored**                            | Items aren't synced at all; you won't see notes for the library.      |

---

## What's Next?

- **[Source Notes](source-notes.md)** — How auto-generated Markdown notes wrap your item notes (editable regions, frontmatter merging).
- **[Reading & Annotating](reading-and-annotating.md)** — The other native Zotero entity ZotFlow handles: annotations.
- **[Citation Guide](citation-guide.md)** — Citing items (and their notes) from anywhere in your vault.
