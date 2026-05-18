# ZotFlow — Template Guide

ZotFlow uses [LiquidJS](https://liquidjs.com) templates across four systems: **source notes** (Zotero and local), **citation formatting**, and **note path resolution**. This guide covers all template types, their context variables, built-in filters, and the rendering pipeline.

---

## Table of Contents

- [Overview](#overview)
- [Settings](#settings)
- [Template Syntax](#template-syntax)
- [Zotero Source Note Template](#zotero-source-note-template)
    - [Context Variables](#zotero-context-variables)
    - [Default Template](#default-zotero-template)
- [Local Source Note Template](#local-source-note-template)
    - [Context Variables](#local-context-variables)
    - [Default Template](#default-local-template)
- [Citation Templates](#citation-templates)
    - [Citation Context Variables](#citation-context-variables)
    - [Default Citation Templates](#default-citation-templates)
- [Path Templates](#path-templates)
    - [Library Path Variables](#library-path-variables)
    - [Local Path Variables](#local-path-variables)
    - [Default Path Templates](#default-path-templates)
- [Template Preview](#template-preview)
- [Custom Filters](#custom-filters)
- [Frontmatter Handling](#frontmatter-handling)
- [Editable Regions](#editable-regions)
- [Tips & Examples](#tips--examples)

---

## Overview

ZotFlow has **four template systems**:

| Template Type          | Purpose                                               |
| ---------------------- | ----------------------------------------------------- |
| **Zotero Source Note** | Content of source notes for Zotero library items      |
| **Local Source Note**  | Content of source notes for local vault files         |
| **Citation Templates** | Inline citations (pandoc, wikilink, footnote formats) |
| **Path Templates**     | File paths for where source notes are created         |

Both use the same LiquidJS engine, but expose different context variables. If no custom template file is configured, a built-in default template is used.

---

## Settings

Configure templates in **Settings → General** and **Settings → Citation**:

### Source Note Settings (General)

| Setting                           | Description                                                       | Example                                   |
| --------------------------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| **Template Path**                 | Vault-relative path to a Zotero source note template file         | `templates/SourceNoteTemplate.md`         |
| **Note Path Template**            | LiquidJS template for Zotero source note file paths               | `Source/{{libraryName}}/@{{citationKey}}` |
| **Local Source Note Template**    | Vault-relative path to a local source note template file          | `templates/LocalSourceNoteTemplate.md`    |
| **Local Note Path Template**      | LiquidJS template for local source note file paths                | `Source/Local/@{{basename}}`              |
| **Auto Import Annotation Images** | Extract area/ink annotation images from PDFs during note creation | Toggle                                    |
| **Annotation Image Folder**       | Folder where extracted annotation images are saved                | `Attachments/ZotFlow`                     |

### Citation Settings

| Setting                          | Description                                                | Default      |
| -------------------------------- | ---------------------------------------------------------- | ------------ |
| **Default Citation Format**      | Format used when no modifier key is held                   | `footnote`   |
| **Trigger Character**            | String that opens the citation suggest popup in the editor | `@@`         |
| **Pandoc Template**              | LiquidJS template for pandoc citations                     | _(built-in)_ |
| **Footnote Reference Template**  | Template for the inline `[^key]` marker                    | _(built-in)_ |
| **Footnote Definition Template** | Template for the footnote definition text                  | _(built-in)_ |
| **Wikilink Template**            | Template for wikilink citations                            | _(built-in)_ |

If **Template Path** or **Local Source Note Template** is left empty, the built-in default template is used.

---

## Template Syntax

Templates use [LiquidJS syntax](https://liquidjs.com/tutorials/intro-to-liquid.html):

- **Output tags:** `{{ variable }}` — insert a value
- **Logic tags:** `{% if condition %} ... {% endif %}` — conditional blocks
- **Loops:** `{% for item in array %} ... {% endfor %}` — iterate over arrays
- **Filters:** `{{ value | filter_name }}` — transform values (e.g., `| json`, `| default: "fallback"`)
- **Whitespace control:** `{%-` and `-%}` trim surrounding whitespace

### Global Variables

Available in both template types:

| Variable  | Type     | Description                                                                        |
| --------- | -------- | ---------------------------------------------------------------------------------- |
| `newline` | `string` | A literal newline character (`"\n"`). Useful for `replace` filters in blockquotes. |

---

## Zotero Source Note Template

Used when creating/updating source notes for **Zotero library items** (journal articles, books, conference papers, etc.).

### Zotero Context Variables

The template context is an object with two top-level keys: `item` and `settings`.

#### `item` — The Zotero Item

| Variable                     | Type                      | Description                                                           |
| ---------------------------- | ------------------------- | --------------------------------------------------------------------- |
| `item.key`                   | `string`                  | Zotero item key (e.g., `"ABC12345"`)                                  |
| `item.version`               | `number`                  | Zotero item version number                                            |
| `item.libraryID`             | `number`                  | Zotero library ID                                                     |
| `item.citationKey`           | `string`                  | Citation key (e.g., from Better BibTeX), empty string if unset        |
| `item.itemType`              | `string`                  | Zotero item type (e.g., `"journalArticle"`, `"book"`, `"attachment"`) |
| `item.title`                 | `string`                  | Item title                                                            |
| `item.creators`              | `Array<{ name: string }>` | List of creators with a combined `name` field                         |
| `item.date`                  | `string \| null`          | Publication date string (as entered in Zotero)                        |
| `item.dateAdded`             | `string`                  | ISO timestamp when item was added to Zotero                           |
| `item.dateModified`          | `string`                  | ISO timestamp when item was last modified                             |
| `item.accessDate`            | `string \| null`          | Date the item was last accessed                                       |
| `item.abstractNote`          | `string \| undefined`     | Abstract text                                                         |
| `item.publicationTitle`      | `string \| undefined`     | Journal/conference name                                               |
| `item.publisher`             | `string \| undefined`     | Publisher name                                                        |
| `item.place`                 | `string \| undefined`     | Place of publication                                                  |
| `item.volume`                | `string \| undefined`     | Volume number                                                         |
| `item.issue`                 | `string \| undefined`     | Issue number                                                          |
| `item.pages`                 | `string \| undefined`     | Page range                                                            |
| `item.series`                | `string \| undefined`     | Series name                                                           |
| `item.seriesNumber`          | `string \| undefined`     | Series number                                                         |
| `item.edition`               | `string \| undefined`     | Edition                                                               |
| `item.url`                   | `string \| undefined`     | URL                                                                   |
| `item.DOI`                   | `string \| undefined`     | DOI                                                                   |
| `item.ISBN`                  | `string \| undefined`     | ISBN                                                                  |
| `item.ISSN`                  | `string \| undefined`     | ISSN                                                                  |
| `item.tags`                  | `Array<{ tag, type? }>`   | Tags attached to the item                                             |
| `item.itemPaths`             | `string[]`                | Collection paths for the item (e.g., `["Research/ML"]`)               |
| `item.attachments`           | `AttachmentContext[]`     | Child attachment items (PDFs, etc.) — see below                       |
| `item.annotations`           | `AnnotationContext[]`     | Direct child annotations (for standalone attachment items)            |
| `item.attachmentAnnotations` | `AnnotationContext[]`     | All annotations across all attachments (flattened)                    |
| `item.notes`                 | `NoteContext[]`           | Child Zotero notes — see below                                        |
| `item.relatedItems`          | `RelatedItemContext[]`    | Items linked via Zotero's "Related" tab (`dc:relation`) — see below   |

#### `item.attachments[]` — Attachment Children

| Variable                  | Type                    | Description                           |
| ------------------------- | ----------------------- | ------------------------------------- |
| `attachment.key`          | `string`                | Attachment item key                   |
| `attachment.libraryID`    | `number`                | Library ID                            |
| `attachment.filename`     | `string`                | Filename (e.g., `"paper.pdf"`)        |
| `attachment.contentType`  | `string`                | MIME type (e.g., `"application/pdf"`) |
| `attachment.tags`         | `Array<{ tag, type? }>` | Tags                                  |
| `attachment.dateAdded`    | `string`                | ISO timestamp                         |
| `attachment.dateModified` | `string`                | ISO timestamp                         |
| `attachment.annotations`  | `AnnotationContext[]`   | Annotations on this attachment        |

#### `item.notes[]` — Note Children

| Variable            | Type                    | Description                      |
| ------------------- | ----------------------- | -------------------------------- |
| `note.key`          | `string`                | Note item key                    |
| `note.libraryID`    | `number`                | Library ID                       |
| `note.title`        | `string`                | Note title (first line or empty) |
| `note.note`         | `string`                | Full note HTML content           |
| `note.tags`         | `Array<{ tag, type? }>` | Tags                             |
| `note.dateAdded`    | `string`                | ISO timestamp                    |
| `note.dateModified` | `string`                | ISO timestamp                    |

#### `item.relatedItems[]` — Related Items

Items the current item is linked to via Zotero's **Related** tab (the `dc:relation` predicate). Each entry corresponds to one related item URI; `key` and `libraryID` are always populated by parsing the URI itself, while the remaining fields are only filled in when the related item is present in ZotFlow's local database.

| Variable             | Type                  | Description                                                                                       |
| -------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| `rel.key`            | `string`              | Zotero item key of the related item                                                               |
| `rel.libraryID`      | `number`              | Library ID parsed from the relation URI                                                           |
| `rel.resolved`       | `boolean`             | `true` if the item was found in the local DB, `false` for cross-library / unsynced / missing items |
| `rel.title`          | `string \| undefined` | Title of the related item (only when `resolved`)                                                  |
| `rel.itemType`       | `string \| undefined` | Zotero item type (only when `resolved`)                                                           |
| `rel.citationKey`    | `string \| undefined` | Citation key, e.g. from Better BibTeX (only when `resolved`)                                      |
| `rel.notePath`       | `string \| undefined` | Vault path of that item's ZotFlow source note (only when `resolved`)                              |

Cross-library or unsynced relations still appear in the list with `resolved: false` so they can be referenced or surfaced as a placeholder. Guard with `{% if rel.title %}` (or `{% if rel.resolved %}`) when you only want fully-known entries.

#### `item.annotations[]` / `attachment.annotations[]` — Annotations

| Variable                  | Type                    | Description                                                                                                           |
| ------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `annotation.key`          | `string`                | Annotation item key                                                                                                   |
| `annotation.libraryID`    | `number`                | Library ID                                                                                                            |
| `annotation.type`         | `string`                | Annotation type: `"highlight"`, `"note"`, `"image"`, `"ink"`                                                          |
| `annotation.authorName`   | `string \| undefined`   | Author of the annotation                                                                                              |
| `annotation.text`         | `string \| null`        | Highlighted text (for highlights; `>` and `<` are escaped)                                                            |
| `annotation.comment`      | `string \| undefined`   | User comment converted to Markdown: `<b>`→`**`, `<i>`→`*`, `<sub>`/`<sup>` kept as inline HTML, stray `<`/`>` escaped |
| `annotation.color`        | `string \| undefined`   | Hex color code (e.g., `"#ffd400"`)                                                                                    |
| `annotation.pageLabel`    | `string \| undefined`   | Page label where the annotation appears                                                                               |
| `annotation.tags`         | `Array<{ tag, type? }>` | Tags                                                                                                                  |
| `annotation.dateAdded`    | `string`                | ISO timestamp when annotation was created                                                                             |
| `annotation.dateModified` | `string`                | ISO timestamp when annotation was last modified                                                                       |
| `annotation.raw`          | `AnnotationJSON`        | Raw annotation object (for advanced use with filters)                                                                 |

#### `settings` — Plugin Settings

The entire `ZotFlowSettings` object is available under `settings`. Commonly used:

| Variable                         | Type     | Description                                               |
| -------------------------------- | -------- | --------------------------------------------------------- |
| `settings.annotationImageFolder` | `string` | Folder path for annotation images (trailing `/` stripped) |
| `settings.sourceNoteFolder`      | `string` | Default source note folder                                |

### Default Zotero Template

If no custom template is configured, the following built-in template is used:

```liquid
---
citationKey: {{ item.citationKey | json }}
title: {{ item.title | json }}
itemType: {{ item.itemType | json }}
creators: [{% for c in item.creators %}"{{ c.name }}"{% unless forloop.last %}, {% endunless %}{% endfor %}]
publication: {{ item.publicationTitle | default: item.publisher | json }}
date: {{ item.date | json }}
year: {{ item.date | slice: 0, 4 }}
url: {{ item.url | json }}
doi: {{ item.DOI | json }}
---
{%- capture quote_string %}{{ newline }}> {% endcapture -%}
{%- capture quote_string_2 %}{{ newline }}> >{% endcapture -%}
# {{ item.title }}
{%- if item.abstractNote -%}
## Abstract
> {{ item.abstractNote | replace: newline, quote_string }}

{%- endif -%}
{%- if item.attachments.length > 0 -%}
## Attachments
{%- for attachment in item.attachments -%}
- [{{ attachment.filename }}](obsidian://zotflow?type=open-attachment&libraryID={{ attachment.libraryID }}&key={{ attachment.key }})
{%- endfor -%}

{%- endif -%}
{%- if item.notes.length > 0 -%}
## Notes
{%- for note in item.notes -%}
### {{ note.title | default: "Note" }}
{{ note.note }}
{%- endfor -%}

{%- endif -%}
{%- if item.attachments.length > 0 and item.attachmentAnnotations.length > 0 -%}
## Annotations
{%- for attachment in item.attachments -%}
{%- if attachment.annotations.length > 0 -%}
### {{ attachment.filename }}
{%- for annotation in attachment.annotations -%}
> [!zotflow-{{ annotation.type }}-{{ annotation.color }}] [{{ attachment.filename }}, p.{{ annotation.pageLabel }}](obsidian://zotflow?type=open-attachment&libraryID={{ attachment.libraryID }}&key={{ attachment.key }}&navigation={{ annotation.key | process_nav_info}})
{%- if annotation.type == "ink" or annotation.type == "image"-%}
> > ![[{{settings.annotationImageFolder}}/{{ annotation.key }}.png]]
{%- else -%}
> > {{ annotation.text | replace: newline, quote_string_2 }}
{%- endif -%}
{%- if annotation.comment != "" -%}
>
> {{ annotation.comment | replace: newline, quote_string }}
{%- endif -%}^{{ annotation.key }}

{%- endfor -%}
{%- endif -%}
{%- endfor -%}
{%- endif -%}
{%- if item.attachments.length == 0 and item.itemType == "attachment" and item.annotations.length > 0 -%}
## Annotations
{%- for annotation in item.annotations -%}
> [!zotflow-{{ annotation.type }}-{{ annotation.color }}] [{{ item.title }}, p.{{ annotation.pageLabel }}](obsidian://zotflow?type=open-attachment&libraryID={{ item.libraryID }}&key={{ item.key }}&navigation={{ annotation.key | process_nav_info}})
{%- if annotation.type == "ink" or annotation.type == "image"-%}
> > ![[{{settings.annotationImageFolder}}/{{ annotation.key }}.png]]
{%- else -%}
> > {{ annotation.text | replace: newline, quote_string_2 }}
{%- endif -%}
{%- if annotation.comment != "" -%}
>
> {{ annotation.comment | replace: newline, quote_string }}
{%- endif -%}^{{ annotation.key }}

{%- endfor -%}
{%- endif -%}
```

---

## Local Source Note Template

Used when creating/updating source notes for **local vault files** (PDFs, EPUBs, HTMLs) opened in the Local Zotero Reader.

### Local Context Variables

The template context has three top-level keys: `item`, `settings`, and `path`.

#### `item` — The Local Attachment

| Variable           | Type                | Description                                        |
| ------------------ | ------------------- | -------------------------------------------------- |
| `item.name`        | `string`            | Full filename with extension (e.g., `"paper.pdf"`) |
| `item.path`        | `string`            | Vault-relative path (e.g., `"Articles/paper.pdf"`) |
| `item.extension`   | `string`            | File extension (e.g., `"pdf"`)                     |
| `item.basename`    | `string`            | Filename without extension (e.g., `"paper"`)       |
| `item.annotations` | `LocalAnnotation[]` | Annotations made in the local reader — see below   |

#### `item.annotations[]` — Local Annotations

| Variable                  | Type                    | Description                                                                  |
| ------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| `annotation.key`          | `string`                | Annotation ID                                                                |
| `annotation.libraryID`    | `number`                | Always `0` for local files                                                   |
| `annotation.type`         | `string`                | Annotation type: `"highlight"`, `"note"`, `"image"`, `"ink"`                 |
| `annotation.authorName`   | `string \| undefined`   | Author name                                                                  |
| `annotation.text`         | `string \| null`        | Highlighted text (`>` is escaped)                                            |
| `annotation.comment`      | `string \| undefined`   | User comment                                                                 |
| `annotation.color`        | `string \| undefined`   | Hex color code                                                               |
| `annotation.pageLabel`    | `string \| undefined`   | Page label                                                                   |
| `annotation.tags`         | `Array<{ tag, type? }>` | Tags                                                                         |
| `annotation.dateAdded`    | `string \| undefined`   | ISO timestamp when annotation was created                                    |
| `annotation.dateModified` | `string \| undefined`   | ISO timestamp when annotation was last modified                              |
| `annotation.raw`          | `AnnotationJSON`        | Raw annotation object (for advanced use with `process_raw_anno_json` filter) |

#### `path` — Top-Level Variable

| Variable | Type     | Description                                    |
| -------- | -------- | ---------------------------------------------- |
| `path`   | `string` | Same as `item.path` — vault-relative file path |

#### `settings` — Plugin Settings

Same as the Zotero template. `settings.annotationImageFolder` is the most commonly used.

### Default Local Template

```liquid
---
zotflow-locked: {{true}}
zotflow-local-attachment: [[{{ path }}]]
---
{%- capture quote_string %}{{ newline }}> {% endcapture -%}
{%- capture quote_string_2 %}{{ newline }}> >{% endcapture -%}
# {{ item.basename }}
{%- if item.annotations.length > 0 -%}
## Annotations
{%- for annotation in item.annotations -%}

> [!zotflow-{{ annotation.type }}-{{ annotation.color }}] [[{{item.path}}#page={{ annotation.pageLabel }}#annotation={{ annotation.key | process_nav_info }}|{{ item.name }}, p.{{ annotation.pageLabel }}]]
{%- if annotation.type == "ink" or annotation.type == "image"-%}
> > ![[{{settings.annotationImageFolder}}/{{ annotation.key }}.png]]
{%- else -%}
> > {{ annotation.text | replace: newline, quote_string_2 }}
{%- endif -%}
{%- if annotation.comment != "" -%}
>
> {{ annotation.comment | replace: newline, quote_string }}
{%- endif -%}
^{{ annotation.key }}

{%- endfor -%}
{%- endif -%}
```

---

## Citation Templates

Citation templates control how inline citations are rendered when you drag items, use the suggest popup, or copy from the reader. There are four citation template slots — one for each format. See the [Citation Guide](citation-guide.md) for how to insert citations.

### Citation Context Variables

All citation templates share the same context:

| Variable                | Type                  | Description                                                              |
| ----------------------- | --------------------- | ------------------------------------------------------------------------ |
| `item.key`              | `string`              | Zotero item key                                                          |
| `item.citationKey`      | `string`              | Citation key (e.g., from Better BibTeX), or empty                        |
| `item.title`            | `string`              | Item title                                                               |
| `item.creators`         | `Array<{ name }>`     | Creator list with combined `name` field                                  |
| `item.date`             | `string`              | Publication date string                                                  |
| `item.itemType`         | `string`              | Item type (e.g., `"journalArticle"`)                                     |
| `item.url`              | `string \| undefined` | URL                                                                      |
| `item.DOI`              | `string \| undefined` | DOI                                                                      |
| `item.publicationTitle` | `string \| undefined` | Journal/conference name                                                  |
| `item.publisher`        | `string \| undefined` | Publisher                                                                |
| `item.volume`           | `string \| undefined` | Volume                                                                   |
| `item.issue`            | `string \| undefined` | Issue                                                                    |
| `item.pages`            | `string \| undefined` | Page range                                                               |
| `item.tags`             | `Array<{ tag }>`      | Tags                                                                     |
| `item.*`                |                       | All other Zotero item metadata fields are also available                 |
| `notePath`              | `string`              | Vault-relative path to the source note (e.g., `"Source/@smith2024"`)     |
| `annotations`           | `Array`               | Selected annotations (empty array if none). See annotation fields below. |

#### `annotations[]` — Selected Annotations

When a citation is copied with annotations selected, the annotation data is available:

| Variable                  | Type                  | Description                                 |
| ------------------------- | --------------------- | ------------------------------------------- |
| `annotation.key`          | `string`              | Annotation ID / item key                    |
| `annotation.type`         | `string`              | `"highlight"`, `"note"`, `"image"`, `"ink"` |
| `annotation.text`         | `string \| null`      | Highlighted text                            |
| `annotation.comment`      | `string \| undefined` | User comment                                |
| `annotation.color`        | `string \| undefined` | Hex color code                              |
| `annotation.pageLabel`    | `string \| undefined` | Page number                                 |
| `annotation.tags`         | `Array<{ tag }>`      | Tags                                        |
| `annotation.dateAdded`    | `string`              | ISO timestamp                               |
| `annotation.dateModified` | `string`              | ISO timestamp                               |

Use `annotations.size` to check if annotations were included, and `annotations | map: 'pageLabel'` to extract page numbers.

### Default Citation Templates

#### Pandoc

```liquid
[@{{ item.citationKey | default: item.key }}{% if annotations.size > 0 %}{% assign pages = annotations | map: 'pageLabel' | compact | uniq | join: ', ' %}{% if pages != empty %}, pp. {{ pages }}{% endif %}{% endif %}]
```

**Output example:** `[@smith2024, pp. 3, 7]`

#### Footnote Reference (inline marker)

```liquid
[^{{ item.citationKey | default: item.key }}]
```

**Output example:** `[^smith2024]`

#### Footnote Definition (appended to document)

```liquid
{%- if item.creators.length > 1 -%}
{{ item.creators[0].name }} et al.
{%- elsif item.creators.length == 1 -%}
{{ item.creators[0].name }}
{%- else -%}
Unknown Author
{%- endif -%}, *{{ item.title }}* ({{ item.date | slice: 0, 4 }}).
```

**Output example:** `Smith et al., *Deep Learning for NLP* (2024).`

#### Wikilink

```liquid
{%- if annotations.size > 0 -%}
{%- for annotation in annotations -%}
[[{{ notePath }}#^{{ annotation.key }}|{{ item.creators[0].name | default: "Unknown" }} ({{ item.date | slice: 0, 4 }}), p. {{ annotation.pageLabel }}]]
{%- if forloop.last == false %}, {% endif -%}
{%- endfor -%}
{%- else -%}
[[{{ notePath }}|{{ item.creators[0].name | default: "Unknown" }} ({{ item.date | slice: 0, 4 }})]]
{%- endif -%}
```

**Output examples:**

- Without annotations: `[[Source/@smith2024|Smith (2024)]]`
- With annotations: `[[Source/@smith2024#^ABC123|Smith (2024), p. 3]], [[Source/@smith2024#^DEF456|Smith (2024), p. 7]]`

---

## Path Templates

Path templates determine the file path where source notes are created. They use the same LiquidJS syntax but produce a **file path** instead of note content. Each path segment is sanitized (illegal characters removed, reserved names handled).

### Library Path Variables

| Variable           | Type              | Description                           |
| ------------------ | ----------------- | ------------------------------------- |
| `key`              | `string`          | Zotero item key                       |
| `citationKey`      | `string`          | Citation key (e.g., `"smith2024"`)    |
| `libraryID`        | `number`          | Library ID                            |
| `itemType`         | `string`          | Item type                             |
| `title`            | `string`          | Item title                            |
| `creators`         | `Array<{ name }>` | Creator list                          |
| `date`             | `string`          | Publication date                      |
| `year`             | `string`          | 4-digit year extracted from date      |
| `libraryName`      | `string`          | Library display name                  |
| `publicationTitle` | `string`          | Journal/conference name               |
| `publisher`        | `string`          | Publisher                             |
| `tags`             | `Array<{ tag }>`  | Tags                                  |
| `itemPaths`        | `string[]`        | Collection paths for the item         |
| `*`                |                   | All other Zotero item metadata fields |

### Local Path Variables

| Variable    | Type     | Description                                        |
| ----------- | -------- | -------------------------------------------------- |
| `basename`  | `string` | Filename without extension (e.g., `"myPaper"`)     |
| `name`      | `string` | Full filename (e.g., `"myPaper.pdf"`)              |
| `path`      | `string` | Vault-relative path (e.g., `"Papers/myPaper.pdf"`) |
| `extension` | `string` | File extension without dot (e.g., `"pdf"`)         |

### Default Path Templates

**Library:**

```liquid
Source/{{libraryName}}/@{{citationKey | default: title | default: key}}
```

**Output example:** `Source/My Library/@smith2024`

**Local:**

```liquid
Source/Local/@{{basename}}
```

**Output example:** `Source/Local/@myPaper`

### Path Template Tips

- Use `/` to create folder hierarchies: `References/{{year}}/{{citationKey}}`
- The `@` prefix is a convention to visually distinguish source notes — it's optional.
- `| default:` chains provide fallbacks: `{{citationKey | default: title | default: key}}`
- Collection paths: `{{itemPaths[0]}}` gives the first collection path (e.g., `"Research/ML"`)

---

## Template Preview

The **Activity Center** (ribbon icon or `ZotFlow: Open Activity Center` command) includes a **Template Test** tab where you can edit and preview any template in real time — no need to create actual notes to see the output.

### How to Use

1. Open the Activity Center and switch to the **Template Test** tab.
2. Select a **template context** from the dropdown. There are eight options:

| Context                          | Description                            |
| -------------------------------- | -------------------------------------- |
| **Library Source Note**          | Zotero source note template            |
| **Local Source Note**            | Local source note template             |
| **Library Source Note Path**     | Path template for Zotero source notes  |
| **Local Source Note Path**       | Path template for local source notes   |
| **Citation Pandoc**              | Pandoc citation template               |
| **Citation Wikilink**            | Wikilink citation template             |
| **Citation Footnote Reference**  | Footnote reference (`[^key]`) template |
| **Citation Footnote Definition** | Footnote definition template           |

3. Click **Pick Zotero Item** (for library contexts) or **Pick Local File** (for local contexts) to select the item the template will render against. The selected item/file name appears below the button.
4. For citation contexts, an **annotation selector** dropdown appears once an item is picked. Use the toggle-all checkbox or individual checkboxes to select which annotations to include in the citation render.
5. The left panel contains a **template editor** (CodeMirror). When you switch contexts, it loads the default template for that context. Edit it freely — changes stay within the preview and don't affect your saved templates.
6. Click **Render** to generate the output. The right panel shows the result in two modes:
    - **Source** — raw rendered Markdown text (read-only editor)
    - **Preview** — styled Markdown preview (rendered via Obsidian's `MarkdownRenderer`)
7. Use the **Copy** button on the template panel header to copy the template to your clipboard.

### Tips

- Use Template Preview to experiment with LiquidJS syntax and see how variables resolve for a real item before committing to a custom template file.
- The annotation multi-select dropdown is only shown for citation contexts and lets you test how citation templates behave with zero, one, or multiple annotations.
- If rendering fails, an error message appears below the output panel describing the issue (e.g., LiquidJS syntax errors, missing variables).

---

## Custom Filters

In addition to all [built-in LiquidJS filters](https://liquidjs.com/filters/overview.html), ZotFlow registers these custom filters:

### `process_nav_info`

Available in: **Both** template types

Converts an annotation key string into a URL-encoded JSON navigation parameter. Used to construct `obsidian://zotflow` deep links.

```liquid
{{ annotation.key | process_nav_info }}
```

**Input:** `"ABC12345"` (annotation key)
**Output:** `%7B%22annotationID%22%3A%22ABC12345%22%7D` (URL-encoded `{"annotationID":"ABC12345"}`)

### `html2md`

Available in: **Zotero Source Note** template only

Converts a Zotero HTML string to Markdown using ZotFlow's full HTML-to-Markdown pipeline (the same one used when opening a note in the Note Editor view). Handles ProseMirror HTML, math, code, tables, images, and Zotero's wrapper `<div>` attributes.

```liquid
{{ note.note | html2md }}
```

Almost always chained with `wrap_editable` to produce an editable note region:

```liquid
{{ note.note | html2md | wrap_editable: "NOTE", note.key }}
```

**Input:** raw Zotero note HTML (`note.note`)
**Output:** clean Markdown string

> This filter is async — LiquidJS evaluates it as a Promise automatically. Do not call it on non-HTML strings.

### `wrap_editable`

Available in: **Zotero Source Note** template only

Wraps content in the hidden HTML comment markers that ZotFlow's editor extension recognises as an editable region.

```liquid
{{ value | wrap_editable: "TYPE", key }}
```

| Argument | Type     | Description                                                       |
| -------- | -------- | ----------------------------------------------------------------- |
| `"TYPE"` | `string` | `"NOTE"` for Zotero child notes; `"ANNO"` for annotation comments |
| `key`    | `string` | The Zotero item key of the note or annotation                     |

**Output:** the input string surrounded by `<!-- ZF_TYPE_BEG_key -->` / `<!-- ZF_TYPE_END_key -->` markers on their own lines.

See [Editable Regions](#editable-regions) for full usage examples.

### `process_raw_anno_json`

Available in: **Local** template only

Encodes the raw annotation JSON object into a URL-encoded string (with image data stripped for compactness). Used inside the `%% ZOTFLOW_ANNO_..._BEG %%` comment markers.

```liquid
{{ annotation.raw | process_raw_anno_json }}
```

---

## Frontmatter Handling

Both template types process frontmatter through a specific pipeline:

### Rendering Pipeline

1. **Parse template** — extract the frontmatter block (between `---` delimiters) and the body separately.
2. **Render frontmatter** — the frontmatter section is processed through LiquidJS first (so you can use `{{ item.title }}` etc. in your frontmatter).
3. **Parse YAML** — the rendered frontmatter string is parsed as YAML.
4. **Merge** — the parsed template frontmatter is merged with any **existing frontmatter** from the file (during updates). Template keys **overwrite** existing keys.
5. **Inject mandatory fields** — ZotFlow adds required fields automatically:
    - **Zotero notes:** `zotflow-locked: true`, `zotero-key`, `item-version`
    - **Local notes:** `zotflow-locked: true`, `zotflow-local-attachment`
6. **Stringify** — the final merged frontmatter is converted back to YAML.
7. **Render body** — the body portion is rendered through LiquidJS.
8. **Combine** — frontmatter + body are joined into the final markdown file.

### Mandatory Frontmatter Fields

These fields are **always injected** regardless of your template. Do not remove them from generated notes.

| Field                      | Template Type | Description                                                    |
| -------------------------- | ------------- | -------------------------------------------------------------- |
| `zotflow-locked`           | Both          | Always `true`. Enables the CM6 readonly extension.             |
| `zotero-key`               | Zotero        | The Zotero item key. Used to link the note to the Zotero item. |
| `item-version`             | Zotero        | The Zotero item version. Used for update detection.            |
| `zotflow-local-attachment` | Local         | Wiki-link to the source file (e.g., `[[Articles/paper.pdf]]`). |

---

## Editable Regions

Source notes are read-only by default, but your template can mark specific sections as **editable regions** — zones that users can unlock and edit directly inside the Obsidian editor. Editable regions are created using two custom LiquidJS filters: `html2md` and `wrap_editable`. You never write the HTML comment markers by hand.

### How It Works

`wrap_editable` wraps a piece of content in the hidden `<!-- ZF_<TYPE>_BEG_<key> -->` / `<!-- ZF_<TYPE>_END_<key> -->` comment markers that ZotFlow's CM6 extension recognises as editable boundaries.

```liquid
{{ value | wrap_editable: "TYPE", key }}
```

| Argument | Value                | Description                                                           |
| -------- | -------------------- | --------------------------------------------------------------------- |
| `"TYPE"` | `"NOTE"` or `"ANNO"` | Which kind of record to update on save                                |
| `key`    | a Zotero item key    | The note key or annotation key ZotFlow uses to look up the IDB record |

Two region types are supported:

| Type                   | Filter call                                     | What it edits on save               |
| ---------------------- | ----------------------------------------------- | ----------------------------------- |
| **Zotero child note**  | `\| html2md \| wrap_editable: "NOTE", note.key` | The note item in IndexedDB          |
| **Annotation comment** | `\| wrap_editable: "ANNO", annotation.key`      | The annotation comment in IndexedDB |

### Note Regions

`note.note` is raw Zotero HTML, so pipe it through `| html2md` first to convert it to Markdown, then `| wrap_editable` to fence it:

```liquid
{%- if item.notes.length > 0 -%}
{%- for note in item.notes -%}
{{ note.note | html2md | wrap_editable: "NOTE", note.key }}

{%- endfor -%}
{%- endif -%}
```

When the user edits the unlocked region and the debounce fires, ZotFlow converts the Markdown back to Zotero-flavored HTML and writes it to IndexedDB.

### Annotation Comment Regions

`annotation.comment` arrives in the template context **already converted to Markdown** via a lightweight `annoHtml2md` pass — no `| html2md` step needed. Zotero's annotation editor only supports four HTML tags (`<b>`, `<i>`, `<sub>`, `<sup>`); the conversion maps them like this:

| Zotero HTML       | Markdown / Obsidian                                    |
| ----------------- | ------------------------------------------------------ |
| `<b>text</b>`     | `**text**`                                             |
| `<i>text</i>`     | `*text*`                                               |
| `<sub>text</sub>` | `<sub>text</sub>` (kept; Obsidian renders inline HTML) |
| `<sup>text</sup>` | `<sup>text</sup>` (kept; Obsidian renders inline HTML) |
| stray `<` / `>`   | `\<` / `\>` (escaped to avoid accidental markdown)     |

So just pipe directly to `wrap_editable`:

```liquid
{%- if item.attachments.length > 0 and item.attachmentAnnotations.length > 0 -%}
## Annotations
{%- for attachment in item.attachments -%}
{%- if attachment.annotations.length > 0 -%}
### {{ attachment.filename }}
{%- for annotation in attachment.annotations -%}
> [!zotflow-{{ annotation.type }}-{{ annotation.color }}] [{{ attachment.filename }}, p.{{ annotation.pageLabel }}](obsidian://zotflow?type=open-attachment&libraryID={{ attachment.libraryID }}&key={{ attachment.key }}&navigation={{ annotation.key | process_nav_info}})
{%- if annotation.type == "ink" or annotation.type == "image"-%}
> > ![[{{settings.annotationImageFolder}}/{{ annotation.key }}.png]]
{%- else -%}
> > {{ annotation.text | replace: newline, quote_string_2 }}
{%- endif -%}
>
> {{ annotation.comment | wrap_editable: "ANNO", annotation.key | replace: newline, quote_string }}
^{{ annotation.key }}

{%- endfor -%}
{%- endif -%}
{%- endfor -%}
{%- endif -%}
```

On save, ZotFlow runs the reverse pass (`annoMd2html`): `**` → `<b>`, `*` → `<i>`, `<sub>`/`<sup>` kept, escaped `\<`/`\>` unescaped. Any other HTML is stripped before writing back to IndexedDB.

### How the Editor Renders Regions

- In **Source / Live Preview** mode: each region shows a **🔒 lock icon** at the start of its BEG marker line. Click to unlock and edit. A **🔓 re-lock icon** appears at the END marker line.
- In **Reading view**: fully read-only, same as the rest of the note.
- The marker lines themselves can be **hidden** with **Settings → ZotFlow → General → Hide Editable Region Markers**.
- **Default Editable Region Locked** (Settings → ZotFlow → General): whether regions start locked or unlocked when you open the note. Default: locked.
- Libraries set to **Read Only** disable the unlock icon entirely.

---

## Tips & Examples

### Extracting a Year from a Date

```liquid
year: {{ item.date | slice: 0, 4 }}
```

### Formatting Creators as a Comma-Separated List

```liquid
authors: [{% for c in item.creators %}"{{ c.name }}"{% unless forloop.last %}, {% endunless %}{% endfor %}]
```

### Wrapping Text in Blockquotes (Multi-line Safe)

Use the `capture` + `replace` pattern to handle multi-line text inside blockquotes:

```liquid
{%- capture quote_string %}{{ newline }}> {% endcapture -%}
> {{ item.abstractNote | replace: newline, quote_string }}
```

### Conditionally Showing Sections

```liquid
{%- if item.DOI -%}
DOI: [{{ item.DOI }}](https://doi.org/{{ item.DOI }})
{%- endif -%}
```

### Rendering Tags

```liquid
{%- if item.tags.length > 0 -%}
tags:
{%- for tag in item.tags -%}
  - {{ tag.tag }}
{%- endfor -%}
{%- endif -%}
```

### Listing Related Items

```liquid
{%- if item.relatedItems.size > 0 -%}
## Related

{% for rel in item.relatedItems -%}
{% if rel.notePath -%}
- [[{{ rel.notePath }}|{{ rel.title }}]]
{%- elsif rel.title -%}
- {{ rel.title }} (`{{ rel.key }}`)
{%- else -%}
- `{{ rel.key }}` *(not synced)*
{%- endif %}
{% endfor -%}
{%- endif -%}
```

The three branches handle: items with a known source-note path (wikilink), items found locally but without a resolvable path (plain title + key), and unsynced/cross-library items (key only). Drop branches you don't need.

### Deep-Linking to Attachments

```liquid
[Open PDF](obsidian://zotflow?type=open-attachment&libraryID={{ attachment.libraryID }}&key={{ attachment.key }})
```

### Navigating to a Specific Annotation

```liquid
[Jump to annotation](obsidian://zotflow?type=open-attachment&libraryID={{ attachment.libraryID }}&key={{ attachment.key }}&navigation={{ annotation.key | process_nav_info }})
```

### Annotation Callouts with Color

The default template uses Obsidian callouts with type-and-color information:

```liquid
> [!zotflow-{{ annotation.type }}-{{ annotation.color }}] Title text
> > Quoted annotation text
```

You can style these callouts in CSS using classes like `callout[data-callout="zotflow-highlight-#ffd400"]`.

### Using `| json` for Safe YAML Values

Always use `| json` for frontmatter values that may contain special characters:

```liquid
title: {{ item.title | json }}
```

This wraps the value in quotes and escapes special characters, preventing YAML parsing errors.

### Accessing Nested Annotations by Attachment

```liquid
{%- for attachment in item.attachments -%}
{%- if attachment.annotations.length > 0 -%}
### {{ attachment.filename }}
{%- for annotation in attachment.annotations -%}
- p.{{ annotation.pageLabel }}: {{ annotation.text }}
{%- endfor -%}
{%- endif -%}
{%- endfor -%}
```

### Using the Flattened `attachmentAnnotations`

If you want all annotations regardless of which attachment they belong to:

```liquid
{%- for annotation in item.attachmentAnnotations -%}
- {{ annotation.text }} ({{ annotation.color }})
{%- endfor -%}
```

### Custom Pandoc Citation with Annotation Text

Include the highlighted text snippet directly in a pandoc citation:

```liquid
[@{{ item.citationKey | default: item.key }}{% if annotations.size > 0 %}, "{{ annotations[0].text | truncate: 40 }}"{% endif %}]
```

**Output:** `[@smith2024, "The model achieves state-of-the-art…"]`

### Wikilink Citation That Links to Each Annotation

```liquid
{%- for annotation in annotations -%}
[[{{ notePath }}#^{{ annotation.key }}|p. {{ annotation.pageLabel }}]]{% unless forloop.last %} {% endunless %}
{%- endfor -%}
```

**Output:** `[[Source/@smith2024#^ABC123|p. 3]] [[Source/@smith2024#^DEF456|p. 7]]`

### Path Template Using Collection Hierarchy

Organize source notes by Zotero collection structure:

```liquid
References/{{ itemPaths[0] | default: "Unsorted" }}/@{{ citationKey | default: key }}
```

**Output:** `References/Research/Machine Learning/@smith2024`
