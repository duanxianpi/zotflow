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
    preview?: boolean;
    colorScheme?: ColorScheme;
    customThemes?: CustomReaderTheme[];
    lightTheme?: string;
    darkTheme?: string;

    annotations?: AnnotationJSON[];
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

/** Penpal API exposed by the parent (Obsidian) to the reader iframe. */
export type ParentAPI = {
    getBlobUrlMap: () => Record<string, string>;
    handleEvent: (evt: ChildEvents) => void;
    isAndroidApp: () => boolean;
    isLocalReader: () => boolean;
    getOrigin: () => string;
    getMathJaxConfig: () => any;
    getStyleSheets: () => StyleSheetList;
    getColorScheme: () => ColorScheme;
    getPluginSettings: () => ZotFlowSettings;
    getLinkToSelection: (text: string, navigationInfo: any) => string;
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

/** Penpal API exposed by the reader iframe to the parent — init, navigate, annotate, destroy. */
export type ChildAPI = {
    initReader: (opts: CreateReaderOptions) => Promise<boolean>;
    setColorScheme: (colorScheme: ColorScheme) => Promise<boolean>;
    addAnnotation: (annotation: AnnotationJSON) => Promise<boolean>;
    refreshAnnotations: (annotations: AnnotationJSON[]) => Promise<boolean>;
    navigate: (navigationInfo: any) => Promise<boolean>;
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
    id: string;
    type: AnnotationType;
    image?: Uint8Array;
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
