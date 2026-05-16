# Source Notes

ZotFlow generates **source notes** — structured Markdown files that capture an item's metadata and annotations. Each Zotero item gets exactly one note, which acts as a stable reference node in your knowledge graph.

## How Source Notes Work

### Library Source Notes

When you create or update a source note for a Zotero item:

1. The **path template** is rendered to determine where the file should live.
2. ZotFlow reads your content template (or uses the built-in default).
3. The item's metadata, child notes, attachments, and annotations are gathered from the local database.
4. The template is rendered with LiquidJS, producing the Markdown content.
5. **Frontmatter is merged**: if the file already exists, any custom frontmatter fields you added are preserved — only template-defined fields are overwritten.
6. **Mandatory fields are injected** (these always override the template):
    - `zotflow-locked: true` — marks the note as locked (opens in reading view).
    - `library-id` — identifies the Zotero library.
    - `zotero-key` — links the note to the Zotero item.
    - `item-version` — used for update detection; the note is only regenerated when the version changes.
7. The file is written to disk.

### Local Source Notes

Same pipeline, but with different context variables and mandatory fields:

- `zotflow-locked: true`
- `zotflow-local-attachment: [[path/to/file.pdf]]`

Annotation data for local files is stored in a co-located `.zf.json` sidecar file (e.g., `Papers/paper.pdf` → `Papers/paper.zf.json`), not in the source note itself.

---

## Editable Regions

Source notes are read-only by default — but two kinds of content inside them are explicitly designed to be edited from Obsidian, and one piece (the frontmatter) is always free.

### Frontmatter

The YAML frontmatter at the top of every source note is **always editable**. You can add any custom fields you want (`tags`, `status`, `rating`, project metadata, …). On every re-render ZotFlow **merges**:

- **Template-defined fields** are refreshed from Zotero (overwriting any local change to those specific keys).
- **Mandatory fields** (`zotflow-locked`, `library-id`, `zotero-key`, `item-version`, and for local notes `zotflow-local-attachment`) are always re-asserted.
- **Custom fields** you added — anything not produced by the template or mandatory — are preserved untouched.

### Zotero Note Regions & Annotation Comment Regions

Inside the body, two region types are wrapped in hidden HTML comment markers and treated as editable zones:

| Region                 | Marker fence                                       | Default contains                               |
| ---------------------- | -------------------------------------------------- | ---------------------------------------------- |
| **Zotero child note**  | `<!-- ZF_NOTE_BEG_<key> -->` … `ZF_NOTE_END_<key>` | Markdown rendering of a Zotero note item       |
| **Annotation comment** | `<!-- ZF_ANNO_BEG_<key> -->` … `ZF_ANNO_END_<key>` | The comment text you attached to an annotation |

In **Source / Live Preview** mode, each region shows a small **🔒 lock icon** at the start of its fence. Click the icon to unlock the region and edit its content directly inside the source note.

What happens when you save an unlocked edit:

- **Note region** → the Markdown content is converted back to Zotero-flavored HTML and the corresponding Zotero note in IndexedDB is updated. If the note region includes a `<!-- ZF_NOTE_META … -->` line, those wrapper attributes are reconstructed on the way out.
- **Annotation comment region** (which lives inside a blockquote in the default template) → leading `> ` markers are stripped, the remaining Markdown is converted to the restricted HTML Zotero uses for annotation comments, and the annotation in IndexedDB is updated.

Writes are debounced (~2 s) so rapid typing produces a single update. On the next bidirectional sync, the change is pushed back to Zotero.

> ⚠️ Everything _between_ the markers — the surrounding metadata, annotation excerpts, generated structure, headings — remains locked and template-driven. Only what's _inside_ the BEG/END fences (and the frontmatter) is yours to edit.

### Settings & Limits

- **Default Editable Region Locked** (Settings → ZotFlow → General) controls whether new regions start locked (with an icon to unlock) or unlocked (with an icon to re-lock). Per-region toggles override the default for the current editor session.
- Libraries set to **Read Only** disable the unlock icon entirely — you can read the regions, but you cannot edit them.
- Editable regions are only surfaced in **Source** and **Live Preview** modes. Reading view keeps the note fully read-only as before.

---

## Auto-Update Behavior

### Library Source Notes

#### Sync Updates

Source notes update automatically during sync:

1. A sync pulls updated items from Zotero.
2. For each changed item that already has a source note in the vault, a debounced re-render is scheduled (2-second delay).
3. The update is **version-aware**: if the file's `item-version` frontmatter matches the item's current version, no re-render happens.

#### Annotation Updates

When you add, edit, or delete annotations in the reader, the source note updates automatically to reflect those changes. This happens on a debounced schedule (2-second delay) to avoid excessive writes while you're actively annotating. This update is forced regardless of version.

### Local Source Notes

Local source notes update automatically when you add, edit, or delete annotations in the reader. Updates are debounced (2-second delay) to avoid excessive writes while you're actively annotating.

---

## What's Next?

- **[Citation Guide](citation-guide.md)** — Insert citations in various formats and with annotation context.
- **[Template Guide](template-guide.md)** — Full template variable and filter reference.
