import type { DocumentDrafts, LiveTextDocument, LivePdfDocument } from './documents.js';
import type { PromptContextPort } from '@text-to-cad/core/prompt';
import type { DocumentSource } from '../file-viewer/types.js';

/** Environmental effects are supplied by the app; shared UI never discovers a clipboard. */
export interface ClipboardPort {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
  writeImage(image: Blob | Promise<Blob>): Promise<void>;
}
export interface ViewerHost {
  files: DocumentSource;
  documents?: { drafts: DocumentDrafts; bind(target: LiveTextDocument): () => void };
  /** Optional URL of host-bundled PDF.js cmaps/, standard_fonts/, wasm/, and iccs/. */
  pdf?: { assetBaseUrl?: string; bind(target: LivePdfDocument): () => void };
  clipboard: ClipboardPort;
  promptContext: PromptContextPort;
  /** Optional navigation to another document; omitted hosts expose no file-open affordance. */
  navigation?: { openFile(path: string, options?: { target: 'current' | 'new' }): OpenFileResult | Promise<OpenFileResult> };
  /**
   * `platform` names the keyboard's modifiers (⌘ on `darwin`, Ctrl elsewhere); `reducedMotion` is
   * the app's own motion setting, honoured beside the system's `prefers-reduced-motion`.
   */
  environment: { colorScheme: 'light' | 'dark'; platform?: string; reducedMotion?: boolean };
}
export type OpenFileResult = { status: 'opened' } | { status: 'unavailable'; reason?: string };
