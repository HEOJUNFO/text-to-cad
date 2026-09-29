import type { ComponentType, ElementType, ReactNode } from "react";
import type { EntryAction, FilePanel, Platform } from "./navigation/index.js";
import type { ViewerHost } from "../host/types.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface FileEntry { path: string; name: string; kind: "file" | "directory" }
export interface FileMetadata extends FileEntry {
  size: number;
  extension: string;
  mime?: string;
  /** A source hint; each registration remains responsible for matching. */
  mediaType?: string;
  revision?: string;
}
export interface TextDocument {
  content: string;
  revision?: string;
  truncated?: boolean;
  readOnly?: boolean;
}
/** A source owns the URL; each successful read supplies a distinct release lease. */
export interface ManagedFileAsset { url: string; bytes?: Uint8Array<ArrayBuffer>; mime?: string; release: () => void }
export type FileFailureCode = "denied" | "not-found" | "already-exists" | "unsupported" | "conflict" | "error";
export type FileChange =
  | { kind: "content" | "metadata"; path: string; revision?: string }
  | { kind: "added" | "deleted"; path: string; entryKind: FileEntry["kind"] }
  | { kind: "moved"; from: string; to: string; entryKind: FileEntry["kind"] };
export interface FileChanges { sourceId: string; changes: readonly FileChange[] }
export type FileMutationResult =
  | { status: "committed"; path: string; change: FileChange }
  | { status: "cancelled" }
  | { status: "failed"; code: FileFailureCode; message: string };
export type WriteResult =
  | { status: "saved"; document: TextDocument }
  | { status: "conflict"; message?: string; actualRevision?: string }
  | { status: "cancelled" }
  | { status: "error"; code?: FileFailureCode; message: string };
export type ExternalEntryAction = Exclude<EntryAction, "open" | "rename" | "new-file" | "new-folder" | "trash" | "duplicate">;
export interface FileActions {
  platform?: Platform;
  perform?: Partial<Record<ExternalEntryAction, (entry: Pick<FileEntry, "path" | "kind">) => void | Promise<void>>>;
}
/** The open document's storage and change stream, without directory discovery. */
export interface DocumentSource {
  /** Stable workspace/root identity. Connection ports must never be used here. */
  id: string;
  stat: (path: string, options: { signal: AbortSignal }) => Promise<FileMetadata>;
  readText?: (path: string, options: { signal: AbortSignal }) => Promise<TextDocument>;
  readAsset?: (path: string, options: { signal: AbortSignal }) => Promise<ManagedFileAsset>;
  /** Revision validation precedes an atomic replacement. Cancellation after dispatch cannot undo a commit. */
  writeText?: (path: string, options: { content: string; expectedRevision?: string; signal: AbortSignal }) => Promise<WriteResult>;
  subscribe?: (listener: (change: FileChanges) => void) => () => void;
}
/** Optional filesystem browsing composed outside FileViewer. */
export interface FileBrowserSource extends DocumentSource {
  rootName: string;
  list: (directory: string, options: { signal: AbortSignal }) => Promise<readonly FileEntry[]>;
  paths?: (options: { signal: AbortSignal }) => Promise<readonly string[]>;
  rename?: (path: string, options: { name: string; signal: AbortSignal }) => Promise<FileMutationResult>;
  create?: (directory: string, options: { kind: FileEntry["kind"]; name: string; signal: AbortSignal }) => Promise<FileMutationResult>;
  duplicate?: (path: string, options: { signal: AbortSignal }) => Promise<FileMutationResult>;
  trash?: (path: string, options: { signal: AbortSignal }) => Promise<FileMutationResult>;
}
/** Compatibility adapter shape. New hosts should name the narrow or browsing contract directly. */
export interface FileSource extends DocumentSource {
  rootName?: string;
  list?: FileBrowserSource["list"];
  paths?: FileBrowserSource["paths"];
  rename?: FileBrowserSource["rename"];
  create?: FileBrowserSource["create"];
  duplicate?: FileBrowserSource["duplicate"];
  trash?: FileBrowserSource["trash"];
}
export type DocumentSaveResult = WriteResult | { status: "unavailable" } | { status: "stale"; committed?: boolean };
export interface FileViewerState {
  panel: string | null;
  panelWidth: number;
  /**
   * Each file's view under `JSON.stringify([file path, renderer id])`: what the host's tab store
   * holds for this root (`@text-to-cad/ui/tab-store`), and where a renderer's `onStateChange` lands.
   */
  renderers?: Record<string, JsonValue>;
}
/** Browser navigation state composed around the document viewer. */
export interface FileBrowserState extends FileViewerState {
  expandedDirectories?: readonly string[];
}
export interface DocumentSession {
  /** Changes only for another source/file or an explicit/external reload. */
  key: string;
  value: string;
  revision?: string;
  readOnly: boolean;
  dirty: boolean;
  saving: boolean;
  stale: boolean;
  error: string | null;
  setValue: (value: string) => void;
  save: () => Promise<DocumentSaveResult>;
  reload: () => void;
  keepMine: () => void;
}
export interface PrepareContext {
  file: FileMetadata;
  source: DocumentSource;
  signal: AbortSignal;
  /** This same file was explicitly reloaded or invalidated by its source. */
  refresh?: boolean;
}
export interface PreparedDocument<T> { data: T; text?: TextDocument; dispose?: () => void }
/** Renderer-owned actions shown before the common panel buttons. Never persisted. */
export interface FileNavigationAction {
  id: string;
  /** The accessible name. */
  label: string;
  /** The hover hint, when shorter than the label ("Snapshot" for "Take snapshot"); default the label. */
  hint?: string;
  icon: ElementType;
  disabled?: boolean;
  active?: boolean;
  onInvoke: () => void | Promise<void>;
}
export interface RendererViewProps {
  /** Optional host-owned controls inside the Display popover. */
  displayActions?: ReactNode;
  onNavigationActionsChange?: (actions: readonly FileNavigationAction[]) => void;
  file: FileMetadata;
  source: DocumentSource;
  document: DocumentSession | null;
  /**
   * The open panel id, for a renderer that declares `panels` of its own (the desktop markdown's
   * source view). The CAD renderers declare none and read none of `openPanel`, `panelSlot` or
   * `onPanelOpen`: their controls are tool-stack panels, never the host's column.
   */
  openPanel: string;
  /** Renderer status in a host target or the document overlay. */
  navigationStatusSlot?: HTMLElement | null;
  /** The column's box for a declared `"slot"` panel to draw into. */
  panelSlot: HTMLElement | null;
  onPanelOpen: (id: string) => void;
  onReady: (ready: boolean) => void;
  onOpenFile?: (path: string, options?: { target: "current" | "new" }) => Promise<import("../host/types.js").OpenFileResult>;
  appearance: { colorScheme: "light" | "dark" };
  /** The file's saved view as it stood when this renderer opened it; later saves do not come back. */
  state: JsonValue | undefined;
  onStateChange: (state: JsonValue) => void;
  reload: () => void;
}
export type FileRendererProps<T> = RendererViewProps & { data: T };
export interface FileRendererDefinition<T> {
  id: string;
  priority: number;
  matches: (file: FileMetadata) => boolean;
  fallback?: boolean;
  /** The document's panels, which can depend on what `prepare` found (`data`). */
  panels?: (context: PanelContext & { data: T }) => FilePanel[];
  prepare: (context: PrepareContext) => Promise<PreparedDocument<T>>;
  load: () => Promise<{ default: ComponentType<FileRendererProps<T>> }>;
}
export interface PanelContext { open: string; ready: boolean; file: FileMetadata }
/** The typed payload is closed over by defineFileRenderer, never erased to `any`. */
export interface PreparedRenderer {
  Component: ComponentType<RendererViewProps>;
  /** The definition's panels over this document's prepared data. */
  panels?: (context: PanelContext) => FilePanel[];
  text?: TextDocument;
  dispose?: () => void;
}
export interface RendererRegistration {
  id: string;
  priority: number;
  matches: (file: FileMetadata) => boolean;
  fallback?: boolean;
  prepare: (context: PrepareContext) => Promise<PreparedRenderer>;
}
export interface FileViewerProps {
  file: string | FileMetadata | null;
  host: ViewerHost;
  renderers: readonly RendererRegistration[];
  state: FileViewerState;
  onStateChange: (next: FileViewerState) => void;
  /** Optional host targets for document status and actions; otherwise controls float over the document. */
  navigationTargets?: { status?: HTMLElement | null; actions?: HTMLElement | null };
  /** Use a surrounding frame's responsive measurement when it also owns a side panel. */
  mobileLayout?: boolean;
  /** Host controls inside the CAD Display popover. */
  displayActions?: ReactNode;
  onError?: (error: Error) => void;
  presentation?: { empty?: ReactNode; loading?: ReactNode; error?: (message: string) => ReactNode };
}
