// PLACEHOLDER (owned by the VIEWER agent; replaced at merge): the compat viewer API over a
// recorded export, with the signature the spec fixes. Until the real module lands every
// route answers 501.
import type { ExportIndex } from './exportIndex.ts';

export interface ViewerApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: Uint8Array;
}

export interface ViewerApiContext {
  objectUrl(sha256: string): string;
  saveSketch(png: Uint8Array, name: string): Promise<string>;
}

export interface ViewerApiResponse {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  body?: Uint8Array;
  redirect?: string;
}

export async function handleViewerApi(
  index: ExportIndex,
  req: ViewerApiRequest,
  ctx: ViewerApiContext,
): Promise<ViewerApiResponse> {
  void index;
  void ctx;
  return { status: 501, json: { error: `the cloud viewer API is not built yet (${req.method} ${req.path})` } };
}
