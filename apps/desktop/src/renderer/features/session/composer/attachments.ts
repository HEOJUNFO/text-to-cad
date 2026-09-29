import type { FileUIPart } from "@renderer/components/ai-elements/types";
import { isCadFile, type CadReference } from "@shared/cad-refs";

/**
 * The files behind the composer's attachments, kept until they are sent.
 *
 * AI Elements' `PromptInput` holds an attachment as a `blob:` URL and, on
 * submit, turns it back into bytes with `fetch(url)`. The renderer is loaded
 * from `file://`, whose origin is opaque, and Chromium refuses to fetch a
 * blob URL from an opaque origin: the fetch throws, the part keeps its blob
 * URL, and `toPromptBlocks` cannot read it — the image is dropped without a
 * word. So every file this app adds — a capture from the viewer, a pasted
 * image, a file from the attach button — is remembered here by name, and
 * `dataUrlOf` reads it with a `FileReader`, which needs no fetch. A drop onto
 * the box goes through the vendored component's own input and is the one
 * path this does not cover.
 */
const remembered = new Map<string, File[]>();

export function rememberFiles(files: readonly File[]): File[] {
  for (const file of files) {
    const list = remembered.get(file.name) ?? [];
    list.push(file);
    remembered.set(file.name, list);
  }
  return [...files];
}

/** The file for an attachment, taken out of the registry; null when unknown. */
function takeFile(part: FileUIPart): File | null {
  const list = remembered.get(part.filename ?? "");
  const file = list?.shift() ?? null;
  if (list && list.length === 0) {
    remembered.delete(part.filename ?? "");
  }
  return file;
}

function readAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** An attachment's bytes as a data URL: what it already carries, else the remembered file's. */
export async function dataUrlOf(part: FileUIPart): Promise<string | null> {
  if (part.url?.startsWith("data:")) {
    return part.url;
  }
  const file = takeFile(part);
  return file ? readAsDataUrl(file) : null;
}

/** For the tests. */
export function forgetRememberedFiles(): void {
  remembered.clear();
}

/* -------------------------------------------------------------------------- */
/* What may be attached — decided when a file is added, not when it is sent    */
/* -------------------------------------------------------------------------- */

/**
 * The largest text file embedded in a prompt. An ASCII STEP or a log passes
 * the text check, and every byte of it would become prompt: past this, the
 * file belongs in the project, where the agent reads it by path.
 */
export const MAX_INLINE_TEXT_BYTES = 256 * 1024;

/** How much of a file is read to tell text from bytes. */
const PROBE_BYTES = 8192;

/** The project (and worktree) whose folder a picked CAD file is looked for in. */
export type AttachScope = { projectId: string; root: string | null } | null;

export const attachmentRefusal = {
  notText: (name: string) => `${name} is not text or an image, so it was not attached.`,
  tooLarge: (name: string) =>
    `${name} is larger than ${MAX_INLINE_TEXT_BYTES / 1024} KB, so it was not attached. Put it in the project folder and mention its path instead.`,
  cadOutside: (name: string) =>
    `${name} is a CAD file that is not in this project, so it was not attached. Copy it into the project folder, then refer to it by its path.`,
  cadAmbiguous: (name: string, paths: readonly string[]) =>
    `${name} matches ${paths.length} files in this project (${paths.join(", ")}), so it was not attached. Type the path of the one you mean.`,
};

/** Is this a UTF-8 text prefix? NUL bytes or an invalid sequence say no. */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) {
    return false;
  }
  try {
    // `stream` so a character cut in half at the end of the probe is not an error.
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
    return true;
  } catch {
    return false;
  }
}

function readHead(file: File): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result instanceof ArrayBuffer ? new Uint8Array(reader.result) : null);
    reader.onerror = () => resolve(null);
    reader.readAsArrayBuffer(file.slice(0, PROBE_BYTES));
  });
}

/**
 * The project file a picked CAD file is, when the project holds exactly one
 * file of that name and size. The renderer is never told where a picked file
 * came from (Electron no longer puts a path on `File`), so this asks the
 * project instead of the file.
 */
async function findInProject(file: File, scope: NonNullable<AttachScope>): Promise<string[]> {
  const at = { projectId: scope.projectId, ...(scope.root ? { root: scope.root } : {}) };
  const { paths } = await window.textToCad.explorer.paths({ ...at, path: "" });
  const named = paths.filter((path) => (path.split("/").pop() ?? path) === file.name);
  const sized = await Promise.all(named.slice(0, 20).map(async (path) => {
    try {
      const stat = await window.textToCad.explorer.stat({ ...at, path });
      return stat.kind === "file" && stat.size === file.size ? path : null;
    } catch {
      return null;
    }
  }));
  return sized.filter((path): path is string => path !== null);
}

export type Screened = { attach: File[]; references: CadReference[]; refusals: string[] };

/**
 * Sort what was picked, pasted or dropped before any of it is attached:
 * images and small text files are attached; a CAD file the project already
 * holds becomes its path — the same token a typed reference chip sends — so
 * the agent opens it rather than reading its bytes in the prompt; a CAD file
 * from elsewhere, any other binary, and text past `MAX_INLINE_TEXT_BYTES` are
 * refused with the reason. Nothing is copied into the project: that would be
 * a write into the person's folder they did not ask for.
 */
export async function screenAttachments(files: readonly File[], scope: AttachScope): Promise<Screened> {
  const result: Screened = { attach: [], references: [], refusals: [] };
  for (const file of files) {
    if (file.type.startsWith("image/")) {
      result.attach.push(file);
      continue;
    }
    if (isCadFile(file.name)) {
      const found = scope ? await findInProject(file, scope).catch(() => []) : [];
      if (found.length === 1) {
        result.references.push({ file: found[0]!, selector: "" });
      } else {
        result.refusals.push(found.length > 1 ? attachmentRefusal.cadAmbiguous(file.name, found) : attachmentRefusal.cadOutside(file.name));
      }
      continue;
    }
    const head = await readHead(file);
    if (!head || !looksLikeText(head)) {
      result.refusals.push(attachmentRefusal.notText(file.name));
    } else if (file.size > MAX_INLINE_TEXT_BYTES) {
      result.refusals.push(attachmentRefusal.tooLarge(file.name));
    } else {
      result.attach.push(file);
    }
  }
  return result;
}
