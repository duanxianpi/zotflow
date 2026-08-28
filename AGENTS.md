# ZotFlow — Agent Guide

> This document is the single source of truth for any AI agent working on this
> codebase. Read it fully before making changes.

---

## 1. Project Identity

| Field                 | Value                                             |
| --------------------- | ------------------------------------------------- |
| **Name**              | ZotFlow (`obsidian-zotflow`)                      |
| **Type**              | Obsidian Community Plugin                         |
| **Language**          | TypeScript (strict mode)                          |
| **Bundler**           | esbuild (custom config in `esbuild.config.mjs`)   |
| **Package manager**   | npm                                               |
| **Entry point**       | `src/main.ts` → bundled to `main.js`              |
| **Release artifacts** | `main.js`, `manifest.json`, `styles.css`          |
| **License**           | AGPL-3.0-only                                     |
| **Mobile**            | `isDesktopOnly: false` — code must be mobile-safe |

---

## 2. Architecture Overview

ZotFlow uses a **Main Thread + Web Worker** split architecture. The main thread
handles all Obsidian API interactions and UI rendering. A dedicated Web Worker
handles Zotero API communication, sync logic, database access, and PDF
processing.

```
┌─────────────── Main Thread (Obsidian) ──────────────────────┐
│                                                              │
│  main.ts (Plugin lifecycle, commands, view registration)     │
│       │                                                      │
│       ├── services/  (ServiceLocator singleton)              │
│       │     ├── IndexService   (vault file → zotero-key)     │
│       │     ├── LogService     (in-memory log buffer)        │
│       │     ├── NotificationService  (styled Notice)         │
│       │     └── TaskMonitor    (pub/sub task updates)        │
│       │                                                      │
│       ├── ui/                                                │
│       │     ├── reader/   (ZoteroReaderView, IframeReaderBridge, │
│       │     │              LocalReaderView, LocalDataManager)    │
│       │     ├── tree-view/ (React: ZotFlowTree, Node)        │
│       │     ├── activity-center/ (React: ActivityCenterModal) │
│       │     ├── modals/suggest.ts (BaseItemSearchModal + ZoteroSearchModal) │
│       │     ├── zotflow-lock-extension.ts (CM6 readonly)      │
│       │     └── zotflow-comment-extension.ts (CM6 deco)       │
│       │                                                      │
│       └── settings/ (tab-based settings UI)                  │
│                                                              │
│  bridge/index.ts  ←─ WorkerBridge singleton (Comlink)        │
│  bridge/parent-host.ts ←─ ParentHost (exposed to Worker)     │
│                                                              │
└──────────────── Comlink (postMessage) ───────────────────────┘
                          │
┌─────────────── Web Worker ──────────────────────────────────┐
│                                                              │
│  worker/worker.ts  (exposes WorkerAPI via Comlink)           │
│       │                                                      │
│       ├── services/                                          │
│       │     ├── zotero.ts       (Zotero Web API wrapper)     │
│       │     ├── sync.ts         (bidirectional sync engine)  │
│       │     ├── attachment.ts   (download + LRU cache)       │
│       │     ├── webdav.ts       (WebDAV file download)       │
│       │     ├── library-note.ts (library source note CRUD)   │
│       │     ├── local-note.ts   (local source note CRUD)     │
│       │     ├── other-template.ts (LiquidJS path + citation templates) │
│       │     ├── library-template.ts (LiquidJS library templates) │
│       │     ├── local-template.ts (LiquidJS local templates) │
│       │     ├── tree-view.ts    (tree topology builder)      │
│       │     ├── document-worker.ts (Zotero Document Worker)  │
│       │     ├── annotation.ts   (reader annotation CRUD)     │
│       │     ├── key.ts          (API key/library metadata)   │
│       │     └── db-helper.ts        (general-purpose DB queries) │
│       │                                                      │
│       └── tasks/                                             │
│             ├── base.ts         (BaseTask abstract class)    │
│             ├── manager.ts      (TaskManager + AbortController) │
│             └── impl/           (SyncTask, BatchNoteTask, …) │
│                                                              │
│  db/  (Dexie.js — IndexedDB, WORKER-ONLY)                    │
│       ├── db.ts          (schema: keys, groups, items,       │
│       │                   collections, libraries, files)     │
│       ├── normalize.ts   (API response → IDB shape)          │
│       └── annotation.ts  (IDB ↔ AnnotationJSON conversion)   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 Communication patterns

| Path                 | Mechanism                             | Module                                  |
| -------------------- | ------------------------------------- | --------------------------------------- |
| Main → Worker        | `Comlink.wrap` on Worker              | `bridge/index.ts`                       |
| Worker → Main        | `Comlink.proxy(parentHost)` callbacks | `bridge/parent-host.ts`                 |
| Main → Reader iframe | `penpal` (connectToChild)             | `ui/reader/bridge.ts`                   |
| Reader iframe → Main | `penpal` (connectToParent)            | `reader/reader/src/obsidian-adapter.js` |
| Worker → Document Worker | raw `postMessage`/`onmessage`     | `worker/services/document-worker.ts`   |

### 2.2 Data flow (Sync example)

1. User triggers sync → `main.ts` command → `workerBridge.tasks.createSyncTask()`
2. `TaskManager` creates `SyncTask`, calls `SyncService.startSync(signal)`
3. `SyncService` calls `ZoteroAPIService` (proxied through `ParentHost.request` to bypass CORS)
4. Fetched data normalized via `db/normalize.ts` → stored in Dexie tables
5. `ParentHost.onTaskUpdate()` pushes progress to `TaskMonitor` on main thread
6. UI components (TreeView, ActivityCenter) re-fetch via `workerBridge.treeView`

### 2.3 Reader architecture

The Zotero Reader is embedded as an iframe. All reader assets (PDF.js, viewer HTML/CSS/JS, fonts, cmaps) are **gzip-compressed, base64-encoded, and bundled inline** via esbuild's `inlineResourcePlugin`. At runtime, `bundle-assets/inline-assets.ts` decompresses them into Blob URLs. The viewer HTML is patched (`patch-inlined-assets.ts`) to replace all relative resource references with Blob URLs.

**Two reader views exist:**

- `ZoteroReaderView` — for Zotero cloud attachments (synced via API/WebDAV)
- `LocalReaderView` — for local vault files (PDF/EPUB/HTML)

The iframe bridge (`ui/reader/bridge.ts`) is a **state machine**:
`idle → connecting → bridge-ready → reader-ready → disposing → disposed`

### 2.3.1 Local annotation sidecar (`.zf.json`)

Annotations made on local vault files (PDF/EPUB) are persisted in a **co-located
sidecar JSON file** next to the attachment:

```
Papers/myPaper.pdf      → Papers/myPaper.zf.json
Books/intro.epub        → Books/intro.zf.json
```

The sidecar format:

```json
{
    "version": 1,
    "annotations": [/* AnnotationJSON[] */]
}
```

**Main-thread** (`LocalDataManager` in `ui/reader/local-data-manager.ts`):

- Reads/writes the `.zf.json` file via Obsidian vault I/O (`utils/file.ts`).
- Maintains an in-memory annotation cache during a reader session.
- On save/delete, persists to `.zf.json` then triggers a worker-side note
  re-render via `workerBridge.localNote.triggerUpdate()`.
- Falls back to legacy inline-comment parsing (worker-side) and auto-migrates
  to the `.zf.json` format.

**Worker-thread** (`LocalTemplateService`):

- `previewLocalNote()` reads annotations from the sidecar via
  `parentHost.checkFile()` / `parentHost.readTextFile()` so template previews
  include annotation data.

**Lifecycle** (`main.ts`):

- File rename → renames the sidecar (`handleSidecarRename`).
- File delete → deletes the sidecar (`handleSidecarDelete`).

### 2.4 Logging

`LogService` (`services/log-service.ts`) is an in-memory ring buffer (max 1 000
entries, newest first) that also mirrors every entry to the browser console.

```ts
// Main thread — via ServiceLocator
services.logService.info("Sync started", "SyncService");
services.logService.error("Write failed", "LibraryNoteService", err);

services.logService.log("debug", "Fetched items", "ZoteroAPIService", {
    count: items.length,
});

// Worker thread — via ParentHost proxy (Comlink)
this.parentHost.log("info", "Pull complete", "SyncService");
```

**Log levels:** `debug` | `info` | `warn` | `error`

Each `LogEntry` contains:

| Field       | Type       | Notes                                     |
| ----------- | ---------- | ----------------------------------------- |
| `id`        | `string`   | `crypto.randomUUID()`                     |
| `timestamp` | `number`   | `Date.now()`                              |
| `level`     | `LogLevel` | One of`debug`, `info`, `warn`, `error`    |
| `message`   | `string`   | Human-readable description                |
| `context`   | `string?`  | Originating service / component name      |
| `error`     | `any?`     | Attached error object (for `error` level) |

**Routing:** Worker code cannot call `LogService` directly. Instead it calls
`parentHost.log(level, message, context, details)`, which `ParentHost`
(`bridge/parent-host.ts`) forwards to `services.logService.log()` on the main
thread.

**Rules:**

- Always include a `context` string identifying the caller (e.g. `"SyncService"`, `"Worker"`).
- Use `debug` for verbose/tracing output, `info` for normal operations, `warn` for recoverable issues, `error` for failures.
- The log buffer is ephemeral (lost on plugin unload). It is intended for the Activity Center UI, not persistent storage.

### 2.5 Notifications

`NotificationService` (`services/notification-service.ts`) wraps Obsidian's
`Notice` API with styled, type-aware notifications. **All user-facing
notifications must go through this service** — never call `new Notice()`
directly.

```ts
// Main thread — via ServiceLocator
services.notificationService.notify("success", "Sync complete");
services.notificationService.notify("error", "Failed to open note");
services.notificationService.notify("warning", "Enter API Key first.");
services.notificationService.notify("info", "WebDAV disconnected.");

// Worker thread — via ParentHost proxy (Comlink)
this.parentHost.notify("info", "Downloading attachment.pdf");
this.parentHost.notify("error", "Sync failed for library");
```

**Notification types:** `info` | `success` | `warning` | `error`

| Type      | Icon             | Duration   | Color            |
| --------- | ---------------- | ---------- | ---------------- |
| `info`    | `info`           | 2 000 ms   | `--text-muted`   |
| `success` | `check-circle`   | 2 000 ms   | `--text-success` |
| `warning` | `alert-triangle` | 5 000 ms   | `--text-warning` |
| `error`   | `alert-octagon`  | persistent | `--text-error`   |

**Routing:** Worker code cannot call `NotificationService` directly. Instead it
calls `parentHost.notify(type, message)`, which `ParentHost`
(`bridge/parent-host.ts`) forwards to
`services.notificationService.notify()` on the main thread.

**Rules:**

- Never use `new Notice()` directly — always use `services.notificationService.notify()` (main thread) or `this.parentHost.notify()` (worker thread).
- Use `error` for failures (persists until dismissed), `warning` for recoverable issues, `success` for completed operations, `info` for status updates.
- Keep messages short and user-friendly. Do not expose raw error messages or stack traces.
- CSS classes `zotflow-notice-container`, `zotflow-notice-icon`, and `zotflow-notice-message` are defined in `styles.css`.

---

## 3. File Structure (src/)

```
src/
├── main.ts                         # Plugin entry point — lifecycle ONLY
│
├── bridge/
│   ├── index.ts                    # WorkerBridge class (Comlink, singleton)
│   ├── parent-host.ts              # ParentHost — main-thread API for Worker
│   └── types.ts                    # IParentProxy interface
│
├── bundle-assets/
│   ├── inline-assets.ts            # Decompress reader resources → Blob URLs
│   └── patch-inlined-assets.ts     # Rewrite viewer.html to use Blob URLs
│
├── db/
│   ├── db.ts                       # Dexie schema & getCombinations() helper (WORKER-ONLY)
│   ├── normalize.ts                # Zotero API → IDB normalization (WORKER-ONLY)
│   └── annotation.ts               # AnnotationJSON ↔ IDB conversion (WORKER-ONLY)
│
├── services/
│   ├── services.ts                 # ServiceLocator singleton (main thread)
│   ├── index-service.ts            # Maps vault files by zotero-key frontmatter
│   ├── log-service.ts              # In-memory log buffer (max 1000)
│   ├── notification-service.ts     # Styled Obsidian Notice wrapper
│   ├── task-monitor.ts             # Pub/sub for task progress updates
│   ├── csl-folder-service.ts       # Vault folder watcher feeding .csl/locale XML to the worker
│   └── view-state-service.ts       # Reader view state persistence
│
├── settings/
│   ├── types.ts                    # ZotFlowSettings interface & defaults
│   ├── settings.ts                 # ZotFlowSettingTab (tab-based UI)
│   └── sections/
│       ├── general-section.ts      # Template paths, folders, toggles
│       ├── sync-section.ts         # API key, library sync modes
│       ├── cache-section.ts        # Cache toggle, limit, purge
│       ├── csl-section.ts          # CSL renderer: default style/format, styles folder, cache
│       └── webdav-section.ts       # WebDAV URL/user/password
│
├── types/
│   ├── db-schema.d.ts              # IDB table interfaces
│   ├── zotero-api-client.d.ts      # zotero-api-client ambient types
│   ├── zotero-item.d.ts            # Auto-generated Zotero item types (from schema.json)
│   ├── zotero-item-const.ts        # Zotero item type string array
│   ├── zotero.d.ts                 # ZoteroKey, ZoteroGroup, etc.
│   ├── zotero-reader.d.ts          # Reader event types, AnnotationJSON
│   ├── zotflow.d.ts                # TFileWithoutParentAndVault
│   ├── template-context.ts         # Template rendering context types
│   └── tasks.ts                    # ITaskInfo, TaskStatus
│
├── ui/
│   ├── icons.ts                    # Icon name → Obsidian icon mappings
│   ├── ObsidianIcon.tsx            # React wrapper for Obsidian icons
│   ├── viewer.ts                   # openAttachment() utility
│   ├── editor/
│   │   ├── markdown-editor.ts      # Markdown editor utilities
│   │   ├── zotflow-lock-extension.ts   # CM6: readonly when zotflow-locked
│   │   └── zotflow-comment-extension.ts # CM6: annotation marker decorations
│   ├── reader/
│   │   ├── view.ts                 # ZoteroReaderView (remote Zotero items)
│   │   ├── local-view.ts           # LocalReaderView (vault files)
│   │   ├── bridge.ts               # IframeReaderBridge (penpal state machine)
│   │   └── local-data-manager.ts   # Sidecar .zf.json I/O + annotation cache for local reader
│   ├── tree-view/
│   │   ├── view.tsx                # ZotFlowTreeView (Obsidian ItemView wrapper)
│   │   ├── TreeView.tsx            # React: tree component (react-arborist)
│   │   └── Node.tsx                # React: single tree node renderer
│   ├── activity-center/
│   │   ├── modal.tsx               # ActivityCenterModal (Obsidian Modal wrapper)
│   │   ├── ZotFlowActivityCenter.tsx # Tab container component
│   │   ├── SyncView.tsx            # Sync tab content (stub)
│   │   ├── TemplateTestView.tsx    # Template testing tab
│   │   ├── CslStylesView.tsx       # CSL tab: styles (aliases nested under parents) & locales
│   │   └── CslRows.tsx             # CSL tab row components (status dot, badges, alias rows)
│   └── modals/
│       ├── suggest.ts              # BaseItemSearchModal + ZoteroSearchModal
│       ├── item-picker.ts          # ItemPickerModal (extends BaseItemSearchModal)
│       ├── file-picker.ts          # FilePickerModal (local vault file picker)
│       ├── csl-add-modal.ts        # AddCslStyleModal / AddCslLocaleModal (fetch-by-id preview + add)
│       ├── csl-details-modal.ts    # StyleDetailsModal (state-aware actions for installed styles)
│       └── csl-style-details.ts    # Shared StyleDetails block (meta table + deps + preview)
│
├── worker/
│   ├── worker.ts                   # Worker entry point — exposes WorkerAPI via Comlink
│   ├── services/
│   │   ├── zotero.ts               # ZoteroAPIService (zotero-api-client wrapper)
│   │   ├── sync.ts                 # SyncService (bidirectional, conflict-aware)
│   │   ├── attachment.ts           # AttachmentService (download, cache, LRU prune)
│   │   ├── webdav.ts               # WebDavService (file download, verify)
│   │   ├── library-note.ts         # LibraryNoteService (library source note CRUD)
│   │   ├── local-note.ts           # LocalNoteService (local source note CRUD)
│   │   ├── other-template.ts       # OtherTemplateService (LiquidJS path + citation templates)
│   │   ├── library-template.ts     # LibraryTemplateService (LiquidJS for library items)
│   │   ├── local-template.ts       # LocalTemplateService (LiquidJS for local files)
│   │   ├── tree-view.ts            # TreeViewService (builds flattened topology)
│   │   ├── document-worker.ts      # DocumentWorkerService (nested Zotero worker)
│   │   ├── annotation.ts           # AnnotationService (reader annotation CRUD)
│   │   ├── key.ts                  # KeyService (API key verify, library metadata)
│   │   ├── csl-render.ts           # CslRenderWorkerService (CSL rendering; wraps worker/csl core)
│   │   └── db-helper.ts            # DbHelperService (general-purpose DB queries)
│   ├── csl/                        # Vendored csl-render core (citeproc wrapper; platform
│   │                               #   agnostic, relative imports, WORKER-ONLY via services)
│   └── tasks/
│       ├── base.ts                 # BaseTask abstract (id, status, progress)
│       ├── manager.ts              # TaskManager (register, start, cancel)
│       └── impl/
│           ├── sync-task.ts                        # SyncTask
│           ├── batch-note-task.ts                   # BatchNoteTask
│           ├── batch-extract-images-task.ts         # BatchExtractImagesTask
│           ├── batch-extract-external-annotations-task.ts # BatchExtractExternalAnnotationsTask
│           ├── download-attachment-task.ts          # DownloadAttachmentTask
│           └── test-task.ts                        # TestTask (dev/debug)
│
└── utils/
    ├── error.ts                    # ZotFlowError class (codes, context, wrapping)
    ├── utils.ts                    # getNotePath() (sanitized filename)
    ├── file.ts                     # File CRUD helpers (read/write/check/delete)
    └── credentials.ts              # Credential storage (Obsidian SecretStorage, not data.json)
```

---

## 4. Key Dependencies

| Package               | Purpose                            | Thread                     |
| --------------------- | ---------------------------------- | -------------------------- |
| `comlink`             | Main ↔ Worker RPC                  | Both                       |
| `penpal`              | Main ↔ Reader iframe communication | Main                       |
| `dexie`               | IndexedDB wrapper                  | Worker                     |
| `zotero-api-client`   | Zotero Web API                     | Worker (via proxied fetch) |
| `liquidjs`            | Note template rendering            | Worker                     |
| `citeproc`            | CSL citation/bibliography engine   | Worker                     |
| `fflate`              | gzip decompression (reader assets) | Main                       |
| `spark-md5`           | File integrity (attachment cache)  | Worker                     |
| `p-limit`             | Concurrency control                | Worker                     |
| `uuid`                | Task/entity ID generation          | Worker                     |
| `react` + `react-dom` | Tree view, activity center UI      | Main                       |
| `react-arborist`      | Virtual tree component             | Main                       |

---

## 5. Build System

### Commands

```bash
npm install          # Install dependencies
npm run dev:plugin   # esbuild watch mode (plugin only)
npm run dev:reader   # webpack watch mode (reader only)
npm run build:plugin   # Production build: tsc check + esbuild (plugin only)
npm run build:reader   # Production build: webpack prod mode (reader only)
npm run build        # Production build: reader + plugin
npm run build:ci     # Full CI: build pdf.js + reader + plugin
npm run test         # lint + typecheck:tests + the whole vitest suite
npm run test:vitest  # vitest, one shot
npm run test:watch   # vitest, watch mode
npm run typecheck:tests   # tsc over tests/ (uses tests/tsconfig.json)
npm run test:coverage     # vitest + v8 coverage (text + html)
npm run lint         # eslint over the whole repo (still has a backlog)
```

`eslint .` runs as part of `npm test`. Keep the whole repository free of lint
errors; remaining warnings should only represent explicit compatibility or UX
decisions.

### Tests

Vitest, configured in `vitest.config.ts`. Everything lives under `tests/`:

| Path                 | Contents                                                          |
| -------------------- | ----------------------------------------------------------------- |
| `tests/unit/`        | Pure functions and the convert pipeline                           |
| `tests/integration/` | Worker services driven through fakes                              |
| `tests/fakes/`       | `resetDb`, `createFakeParentHost`, `createFakeZoteroServer`       |
| `tests/fixtures/`    | Real CSL styles/locales, cached in `tests/.csl-fixtures/`         |
| `tests/stubs/`       | Inert `obsidian` module                                           |
| `tests/setup.ts`     | fake-indexeddb, `navigator.onLine`, one IndexedDB spec workaround |

Two things worth knowing before writing a service test:

- **The `db` singleton is real.** `tests/setup.ts` installs `fake-indexeddb`, so
  `db/db.ts` opens the actual Dexie schema — real compound indexes, real
  version upgrades. Call `resetDb()` in `beforeEach`. Do not mock `db/db`.
- **Zotero is faked at the HTTP layer**, not at `ZoteroAPIService`.
  `createFakeZoteroServer().install()` replaces `globalThis.fetch`, which is
  where `worker.ts` installs its proxied fetch in production. That keeps
  `Last-Modified-Version` bookkeeping, 412 conflicts, `format=versions` deltas
  and request chunking under test instead of mocked away.

`tests/unit/obsidian-syntax.test.ts` is a discovery harness as well as a
regression gate. Run it with `ZF_SYNTAX_MATRIX=1` to print the syntax survival
matrix and the list of known gaps.

`SyncService` is covered by four files, split by what they hold still:
`sync-orchestration` (which libraries a run touches, the 412 retry loop,
progress and notices), `sync-pull`, `sync-push`, and `sync-guards` (paths
`startSync` cannot reach, e.g. `pushDirtyItems` called directly by the task
layer). `createSyncHarness()` in `tests/fakes/sync-harness.ts` wires all of it
in one call.

Coverage is a map of what is untested, not a gate — there is no threshold, and
a green number proves only that a line ran. When a sync branch matters, confirm
the test actually binds it by breaking the branch on purpose and watching the
expected test fail.

### esbuild Custom Plugins

1. **`inlineWorkerPlugin`** (`virtual:worker`) — Compiles `src/worker/worker.ts` into an IIFE string, exported as a module. At runtime, WorkerBridge creates a Blob URL from this string and instantiates a Worker.

2. **`inlineResourcePlugin`** (`virtual:reader-resources`) — Reads all files from `reader/reader/build/obsidian/`, gzip-compresses and base64-encodes each, and generates a switch-case module that returns the encoded data by filename.

### TypeScript Configuration

Key `tsconfig.json` flags that **must stay enabled**:

- `"strictNullChecks": true`
- `"noImplicitAny": true`
- `"noImplicitReturns": true`
- `"noUncheckedIndexedAccess": true`
- `"useUnknownInCatchVariables": true`
- `"verbatimModuleSyntax": true`
- `"jsx": "react-jsx"`
- `"baseUrl": "src"` (all imports are relative to `src/`)

The `reader/reader` directory is **excluded** from TypeScript compilation. Do not modify files under `reader/reader` unless specifically asked.

---

## 6. Code Style & Conventions

### 6.1 General

- **TypeScript strict mode**. Never add `// @ts-ignore` or `@ts-expect-error` unless absolutely unavoidable (undocumented Obsidian API). If you must, add a comment explaining why.
- Prefer `async/await` over `.then()` chains.
- Use `for...of` for async iteration, **never** `Array.forEach` with async callbacks.
- Use `ReturnType<typeof setTimeout>` for timer IDs, never `NodeJS.Timeout` (this runs in a browser/Worker, not Node).
- Prefer specific types over `any`. If `any` is unavoidable, add a `// TODO: type this` comment.

### 6.2 Import style

```ts
// 1. External packages
import * as Comlink from "comlink";
import { Notice, Plugin } from "obsidian";

// 2. Internal modules (absolute from src/)
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";
import type { ZotFlowSettings } from "settings/types";

// 3. Use `import type` for type-only imports (required by verbatimModuleSyntax)
import type { IParentProxy } from "bridge/types";

// 4. Worker-only modules — NEVER import these from main-thread code
import { db } from "db/db"; // Only in src/worker/ files
import { getAnnotationJson } from "db/annotation"; // Only in src/worker/ files
```

Imports use **absolute paths from `src/`** (configured via `baseUrl`). Do not use relative paths like `../../db/db` — use `db/db` instead.

**Import isolation rule:** `bridge/index.ts` must use `import type` for all
worker service imports (e.g. `import type { AnnotationService } from
"worker/services/annotation"`). A value import would pull the entire worker
dependency tree (including Dexie) into the main bundle.

### 6.3 Error handling

Use `ZotFlowError` consistently:

```ts
// Wrapping unknown errors
throw ZotFlowError.wrap(
    e,
    ZotFlowErrorCode.SYNC_FAILED,
    "SyncService",
    "Pull items failed",
);

// Creating new errors
throw new ZotFlowError(
    ZotFlowErrorCode.FILE_WRITE_FAILED,
    "LibraryNoteService",
    "Could not write note",
);

// Type-checking
if (ZotFlowError.is(e)) {
    /* typed error */
}
```

**Rules:**

- Worker services: always wrap errors with `ZotFlowError.wrap()` before re-throwing.
- Background/debounced operations: catch + log via `parentHost.log()`, never let errors propagate silently.
- UI layer: catch errors and show user-friendly `Notice`, never expose raw error messages.

### 6.4 Naming

| Kind             | Convention                                                 | Example                           |
| ---------------- | ---------------------------------------------------------- | --------------------------------- |
| Files            | `kebab-case.ts`                                            | `note-service.ts`                 |
| React components | `PascalCase.tsx`                                           | `TreeView.tsx`                    |
| Classes          | `PascalCase`                                               | `SyncService`                     |
| Interfaces/Types | `PascalCase`, prefix `I` only for cross-boundary contracts | `IParentProxy`, `ZotFlowSettings` |
| IDB interfaces   | `IDB` prefix                                               | `IDBZoteroItem`                   |
| Constants        | `UPPER_SNAKE_CASE`                                         | `DEBOUNCE_DELAY`                  |
| Functions        | `camelCase`                                                | `getNotePath()`                   |
| CSS classes      | `zotflow-` prefix, `kebab-case`                            | `zotflow-settings-lib-table`      |

### 6.5 UI / Styling

- **Use CSS classes** defined in `styles.css`. Never use inline `element.style.xxx = ...` in settings or UI code.
- CSS classes must be prefixed with `zotflow-` to avoid collisions.
- React components are used for complex interactive views (tree, activity center). Simple UI uses Obsidian's native `Setting`, `Modal`, `SettingGroup` APIs.
- Obsidian icons in React: use the `<ObsidianIcon icon="icon-name" />` wrapper.

### 6.6 Settings

- All settings are defined in `settings/types.ts` (`ZotFlowSettings` interface + `DEFAULT_SETTINGS`).
- **Sensitive credentials** (passwords, tokens) must use `utils/credentials.ts` — stored via Obsidian's `SecretStorage` API (cross-platform safe, requires v1.11.4+), never in `data.json` which gets synced.
- Settings UI is split into section classes (`general-section.ts`, `sync-section.ts`, etc.), each rendering within a `SettingGroup`.
- After any `saveSettings()`, both `workerBridge.updateSettings()` and `services.updateSettings()` are called automatically.

---

## 7. Lifecycle & Cleanup Rules

### Plugin lifecycle

```
onload()                              onunload()
   │                                      │
   ├─ loadSettings()                      ├─ workerBridge.terminate()
   ├─ services.initialize()               │    ├─ Worker.terminate()
   ├─ workerBridge.initialize()           │    └─ revoke worker blob URL
   ├─ registerView() × 3                  └─ revokeBlobUrls()
   ├─ registerEvent()                          └─ revoke all reader blob URLs
   ├─ registerEditorExtension() × 2
   ├─ registerObsidianProtocolHandler()
   ├─ registerExtensions() (PDF/EPUB/HTML)
   └─ addCommand(), addSettingTab()
```

### Mandatory rules

1. **Every `register*` call** in `onload()` is automatically cleaned up by Obsidian. Use these instead of manual cleanup.
2. **`onunload()` must terminate the Worker** and revoke all Blob URLs.
3. **Worker services with timers** (LibraryNoteService, LocalNoteService) must implement `dispose()` that clears all debounce timers.
4. **Singletons** (`workerBridge`, `services`) protect their getters with `assertInitialized()` guards.
5. **Never create dangling Components, DOM elements, or intervals** outside of `register*` helpers.

---

## 8. Worker Isolation Rules

The Web Worker **cannot** access:

- `document`, `window`, `navigator` (except `navigator.userAgent`)
- Obsidian API (`Plugin`, `App`, `Vault`, `Workspace`, etc.)
- DOM APIs

All such operations must go through `ParentHost` (the `IParentProxy` interface):

```ts
// Worker needs to read a file → calls parentHost
const content = await this.parentHost.readTextFile(path);

// Worker needs network access → global fetch is patched to proxy through parentHost.request()
const response = await fetch(url, { ... }); // transparently proxied
```

**When adding new Worker ↔ Main interactions:**

1. Add the method signature to `IParentProxy` in `bridge/types.ts`
2. Implement it in `ParentHost` in `bridge/parent-host.ts`
3. Call it via `this.parentHost.methodName()` in Worker code

---

## 9. Database (Dexie/IndexedDB) — Worker-Only

**Critical:** The `db/` module (Dexie) must **only** be imported from Worker
code (`src/worker/`). Main-thread code (`src/ui/`, `src/settings/`,
`src/bridge/`, `src/main.ts`) must **never** import from `db/db.ts`,
`db/annotation.ts`, or `db/normalize.ts` — not even indirectly.

If esbuild bundles Dexie into both the main bundle and the worker bundle, the
two copies will clash at runtime:

> `Error: Two different versions of Dexie loaded in the same app`

All database access from the main thread goes through worker services
(`AnnotationService`, `KeyService`, `QueryService`, `AttachmentService`, etc.)
via the Comlink `WorkerBridge`.

### Worker services for DB access

| Service             | Replaces main-thread `db` usage in | Key methods                                                            |
| ------------------- | ---------------------------------- | ---------------------------------------------------------------------- |
| `AnnotationService` | `view.ts`, `bridge.ts`             | `getKeyInfo`, `getAnnotations`, `saveAnnotations`, `deleteAnnotations` |
| `KeyService`        | `sync-section.ts`, `SyncView.tsx`  | `getKeyInfo`, `deleteKey`, `getLibraryRows`, `verifyAndPersistKey`     |
| `QueryService`      | `view.ts` (attachment lookup)      | `getAttachmentItem` (extensible for future `getItem`, etc.)            |
| `AttachmentService` | `cache-section.ts`                 | `getCacheTotalSizeBytes`, `purgeCache`                                 |

### Schema (current version: 5)

Primary keys are the `&`-prefixed declarations in `db/db.ts`, and the `Table<T, K>`
type parameters mirror them. **There is no `localID` column** — `items`,
`collections` and `files` are all keyed by the compound `[libraryID+key]`, which
is why `db.items.get([libraryID, key])` and
`db.items.update([libraryID, key], …)` are the correct way to address a row.

| Table         | Primary key        | Secondary indexes                                                                                                                                                                       |
| ------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keys`        | `&key`             | —                                                                                                                                                                                       |
| `groups`      | `&id`              | —                                                                                                                                                                                       |
| `libraries`   | `&id`              | —                                                                                                                                                                                       |
| `items`       | `&[libraryID+key]` | `[libraryID+syncStatus]`, `[libraryID+itemType+trashed]`, `[libraryID+parentItem+itemType+trashed]`, `*collections`, `*searchCreators`, `*searchTags`, `dateModified`, `lastAccessedAt` |
| `collections` | `&[libraryID+key]` | `[libraryID+trashed]`, `[libraryID+syncStatus]`, `[libraryID+parentCollection]`                                                                                                         |
| `files`       | `&[libraryID+key]` | `md5`, `lastAccessedAt`                                                                                                                                                                 |
| `cslCache`    | `&key`             | — (string KV cache for CSL styles/locales/index)                                                                                                                                        |

Version history: v1 base schema · v2 adds `[libraryID+parentCollection]` to
`collections` · v3 adds `lastAccessedAt` to `items` · v4 clears `files` (cached
bytes moved from `Blob` to `ArrayBuffer`) · v5 adds `cslCache`.

`*`-prefixed entries are Dexie multi-valued indexes.

### Rules

- Always use `.where()` with compound indexes for queries (not `.filter()`).
- Use `getCombinations()` from `db/db.ts` for Cartesian product queries on compound indexes.
- Use Dexie transactions (`db.transaction('rw', ...)`) for multi-table writes.
- When adding new indexes or tables, bump the Dexie version number and add a migration.
- **Never import `db/` modules from main-thread code.** If the main thread needs data from IDB, add a method to an existing worker service (or create a new one) and call it via `workerBridge`.

---

## 10. How the Reader Bridge Works

`IframeReaderBridge` in `ui/reader/bridge.ts` manages iframe lifecycle:

1. **Create iframe** → load `viewer.html` (Blob URL)
2. **Inject bootstrap property** on iframe's `contentWindow` (before penpal connects)
3. **Penpal `connectToChild()`** establishes bidirectional RPC
4. **Bridge ready** → send `initReader()` with data, annotations, settings
5. **Reader events** arrive via `parentApi.handleEvent()` (annotations saved/deleted, navigation, etc.)
6. **Dispose** → `reader.destroy()` → penpal `connection.destroy()` → remove iframe

The bridge uses **deferred execution queues** (`afterBridgeReadyQueue`, `afterReaderReadyQueue`) —
actions requested before the reader is ready are queued and flushed once the
corresponding state is reached.

---

## 11. Agent Do / Don't

### Do

- Always run `npm run build:plugin` after making changes to verify compilation.
- Add new service methods behind the existing `IParentProxy` pattern when the Worker needs main-thread access.
- Use `ZotFlowError` for all error paths. Include the originating service name and a human-readable message.
- Add CSS classes to `styles.css` for any new UI styling. Use the `zotflow-` prefix.
- When adding new settings, update `ZotFlowSettings`, `DEFAULT_SETTINGS`, and the relevant settings section UI class.
- Keep `main.ts` minimal — it should only contain lifecycle orchestration.
- Use `import type` for type-only imports.
- Add `dispose()` / cleanup methods to any new service that creates timers, listeners, or cached state.
- Write defensive code: check for `null`/`undefined` before accessing nested properties, especially from DB queries and API responses.

### Don't

- Don't use `Array.forEach` with async callbacks. Use `for...of` or `Promise.all(arr.map(...))`.
- Don't use `NodeJS.Timeout` — use `ReturnType<typeof setTimeout>`.
- Don't use `any` without a `// TODO: type this` comment.
- Don't add inline styles in TypeScript. Use CSS classes.
- Don't store sensitive data (passwords, API keys) in `data.json` via `saveData()`. Use `utils/credentials.ts` (backed by Obsidian `SecretStorage`).
- Don't introduce new `@ts-expect-error` or `@ts-ignore` without a clear justification comment.
- Don't access Obsidian/DOM APIs from Worker code. All main-thread access goes through `ParentHost`.
- Don't import `db/` modules (`db/db.ts`, `db/annotation.ts`, `db/normalize.ts`) from main-thread code. All DB access from the main thread must go through worker services via `workerBridge`.
- Don't use value imports (e.g. `import { Foo } from "worker/..."`) in `bridge/index.ts` or any main-thread file — use `import type` instead. A value import will pull the worker's Dexie dependency into the main bundle.
- Don't create Blob URLs without a corresponding revocation path (e.g., in `revokeBlobUrls()`).
- Don't modify files under `reader/reader/` unless explicitly asked. That's a separate build.
- Don't remove or rename existing command IDs.
- Don't introduce new npm dependencies without considering bundle size impact. Prefer browser-native APIs.

---

## 12. Environment & Commands

```bash
npm install                  # Install all dependencies
npm run dev:plugin           # esbuild watch mode (plugin only)
npm run dev:reader           # webpack watch mode (reader only, separate terminal)
npm run build                # Production build (tsc + esbuild)
npm run build:ci             # Full build (pdf.js + reader + plugin)
npm run lint                 # ESLint
```

### Testing

Manual install: copy `main.js`, `manifest.json`, `styles.css` to:

```
<Vault>/.obsidian/plugins/obsidian-zotflow/
```

Reload Obsidian → **Settings → Community plugins** → enable.

---

## 13. Versioning & Releases

- Bump `version` in `manifest.json` (SemVer, no leading `v`).
- Update `versions.json` to map new version → minimum Obsidian version.
- Create GitHub release with tag matching `manifest.json` version exactly.
- Attach `manifest.json`, `main.js`, `styles.css` as release assets.

---

## 14. Security & Privacy

- Default to local/offline operation. Network calls only for Zotero API and WebDAV.
- No telemetry, no analytics, no third-party tracking.
- Never execute remote code or fetch-and-eval scripts.
- Sensitive credentials stored via Obsidian's `SecretStorage` API (`utils/credentials.ts`), never in synced `data.json`.
- Reader iframe communicates only via penpal (structured clone, no `eval`).
- All external service usage (Zotero API, WebDAV) is explicitly configured and disclosed in settings.

---

## 15. References

- Obsidian Plugin API: https://docs.obsidian.md
- Obsidian Developer Policies: https://docs.obsidian.md/Developer+policies
- Obsidian Plugin Guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- Obsidian Style Guide: https://help.obsidian.md/style-guide
- Comlink: https://github.com/GoogleChromeLabs/comlink
- Penpal: https://github.com/nicmeriano/penpal
- Dexie.js: https://dexie.org
- LiquidJS: https://liquidjs.com
- Zotero Web API: https://www.zotero.org/support/dev/web_api/v3/start
