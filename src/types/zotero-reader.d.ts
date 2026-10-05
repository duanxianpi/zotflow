import type { AnnotationProfileConfig } from "utils/annotation-profiles";
import { ZotFlowSettings } from "settings/types";
import type {
    MarkdownEditorProps,
    EmbeddableMarkdownEditor,
} from "ui/editor/markdown-editor";

/** Reader color scheme. */
export type ColorScheme = "light" | "dark";

/** Configuration object for initializing the embedded Zotero reader iframe. */
export interface CreateReaderOptions {
    data: { buf: Uint8Array; url: null } | { buf: null; url: string };
    type: string;
    platform?: string;

    password?: string;
    /** Digest of these exact opened bytes, when already computed during download. */
    contentMD5?: string;
    preview?: boolean;
    colorScheme?: ColorScheme;
    customThemes?: CustomReaderTheme[];
    lightTheme?: string;
    darkTheme?: string;

    annotations?: AnnotationJSON[];
    annotationProfileConfig?: AnnotationProfileConfig;
    authorName?: string;
    sidebarOpen?: boolean;
    sidebarWidth?: number;
    primaryViewState?: Record<string, unknown>;
    secondaryViewState?: Record<string, unknown>;
    readOnly?: boolean;
    autoDisableNoteTool?: boolean;
    autoDisableTextTool?: boolean;
    autoDisableImageTool?: boolean;
    fontFamily?: string;
}

/** Discriminated union of all events the reader iframe can emit to the parent. */
export type ChildEvents =
    | { type: "annotationProfileChanged"; profileId: string }
    | { type: "error"; code: string; message: string }
    | { type: "addToNote" }
    | { type: "annotationsSaved"; annotations: AnnotationJSON[] }
    | { type: "annotationsDeleted"; ids: string[] }
    | { type: "viewStateChanged"; state: unknown; primary: boolean }
    | {
          type: "openTagsPopup";
          annotationID: unknown;
          left: number;
          top: number;
      }
    | { type: "closePopup"; data: unknown }
    | { type: "openLink"; url: string }
    | { type: "sidebarToggled"; open: boolean }
    | { type: "sidebarWidthChanged"; width: number }
    | {
          type: "setDataTransferAnnotations";
          dataTransfer: unknown;
          annotations: unknown;
          fromText: unknown;
      }
    | {
          type: "confirm";
          title: string;
          text: string;
          confirmationButtonTitle: string;
      }
    | { type: "rotatePages"; pageIndexes: unknown; degrees: unknown }
    | { type: "deletePages"; pageIndexes: unknown; degrees: unknown }
    | { type: "toggleContextPane" }
    | { type: "textSelectionAnnotationModeChanged"; mode: unknown }
    | { type: "saveCustomThemes"; customThemes: unknown }
    | { type: "setLightTheme"; theme: unknown }
    | { type: "setDarkTheme"; theme: unknown };

/**
 * A place in the document, in both directions: the reader hands one out for
 * the current selection, and the parent hands one back to move the reader.
 *
 * Only the fields ZotFlow itself reads or writes are named. The rest of the
 * object is Zotero's, and it also arrives verbatim from the `navigation`
 * parameter of a `zotflow://open-attachment` link, so the shape is open.
 */
export interface ReaderNavigation {
    annotationID?: string;
    pageLabel?: string;
    position?: ZoteroPosition;
    [key: string]: unknown;
}

/** Penpal API exposed by the parent (Obsidian) to the reader iframe. */
export type ParentAPI = {
    /** Direct iframe bridge: callbacks stay in-process; only Worker RPC uses Comlink. */
    getSDTPack: (options: {
        password?: string;
        onProgress?: (progress: number) => void;
    }) => Promise<ReaderSDTPackResult>;
    getBlobUrlMap: () => Record<string, string>;
    handleEvent: (evt: ChildEvents) => void;
    isAndroidApp: () => boolean;
    isLocalReader: () => boolean;
    getOrigin: () => string;
    /** Obsidian's own MathJax configuration, handed to the reader verbatim. */
    getMathJaxConfig: () => Record<string, unknown>;
    getStyleSheets: () => StyleSheetList;
    getColorScheme: () => ColorScheme;
    getPluginSettings: () => ZotFlowSettings;
    getLinkToSelection: (
        text: string,
        navigationInfo: ReaderNavigation,
    ) => string;
    handleSetDataTransferAnnotations: (
        dataTransfer: DataTransfer,
        annotations: AnnotationJSON[],
        fromText?: boolean,
    ) => void;
    copyAnnotationCitation: (
        annotations: AnnotationJSON[],
        format: string,
    ) => void;
    createAnnotationEditor: (
        container: HTMLElement,
        options: Partial<MarkdownEditorProps>,
    ) => EmbeddableMarkdownEditor;
    renderMarkdownToContainer: (
        container: HTMLElement,
        text: string,
    ) => { unload: () => void };
};

/** The upstream Reader owns successful SDT results for the lifetime of its document. */
export type ReaderSDTPackResult =
    | {
          ok: true;
          bytes: ArrayBuffer;
          packVersion: number;
          schemaMajorVersion: number;
      }
    | { ok: false; reason: "unavailable" | "failed" };

/** Penpal API exposed by the reader iframe to the parent — init, navigate, annotate, destroy. */
export type ChildAPI = {
    initReader: (opts: CreateReaderOptions) => Promise<boolean>;
    setAnnotationProfileConfig: (config: AnnotationProfileConfig) => Promise<boolean>;
    setColorScheme: (colorScheme: ColorScheme) => Promise<boolean>;
    addAnnotation: (annotation: AnnotationJSON) => Promise<boolean>;
    refreshAnnotations: (annotations: AnnotationJSON[]) => Promise<boolean>;
    navigate: (navigationInfo: ReaderNavigation) => Promise<boolean>;
    destroy: () => Promise<boolean>;
};

/** Annotation position in a PDF page. */
export interface ZoteroPosition {
    pageIndex: number;
    rects: number[][];
}

/** Union of Zotero annotation kinds. */
export type AnnotationType =
    | "highlight"
    | "underline"
    | "note"
    | "image"
    | "text"
    | "ink"
    | "eraser";

/** Serialized annotation object exchanged between the reader iframe and the plugin. */
export interface AnnotationJSON {
    libraryID?: number;
    /**
     * Attachment item key this annotation belongs to (ZotFlow addition, like
     * libraryID). The reader strips it in transit, so payload builders restore
     * it from the attachment they were opened on.
     */
    parentItem?: string;
    id: string;
    type: AnnotationType;
    /** A `data:image/png;base64,...` URI, split and decoded by saveBase64Image. */
    image?: string;
    isExternal?: boolean;
    authorName?: string;
    isAuthorNameAuthoritative?: boolean;
    lastModifiedByUser?: string | number;
    readOnly?: boolean;
    text?: string | null;
    comment?: string;
    pageLabel?: string;
    color?: string;
    sortIndex?: string;
    position: ZoteroPosition;
    tags: Array<{
        name: string;
        color?: string;
        position?: number;
    }>;
    dateModified: string;
    dateAdded: string;
    dateCreated?: string;
}

/** User-defined reader color theme. */
export interface CustomReaderTheme {
    id: string;
    label: string;
    background: string;
    foreground: string;
}
