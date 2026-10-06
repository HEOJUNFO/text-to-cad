// PLACEHOLDER (owned by the VIEWER agent; replaced at merge): the export.json types the
// gateway imports. The real module adds the lookup helpers behind viewerApi.ts.

export interface ExportFile {
  path: string;
  kind: string;
  bytes: number;
  sha256: string;
}

export interface ExportObjectRoute {
  object: string;
  type: string;
  bytes: number;
}

export interface ExportIndex {
  schema: 1;
  cadgen: string;
  files: ExportFile[];
  views: string[];
  routes: Record<string, Record<string, unknown>>;
}
