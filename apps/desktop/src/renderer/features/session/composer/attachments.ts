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

/** How much of a file too large to attach is read to tell text from bytes. */
const PROBE_BYTES = 8192;

/**
 * How far apart a picked file's modified time and the project file's may be and still be the same
 * file: the `File` and the stat round the same clock differently.
 */
const MTIME_TOLERANCE_MS = 1000;

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
  cadUnreadable: (name: string) =>
    `Could not read the project folder, so ${name} was not attached. Type its path instead.`,
  cadUnconfirmed: (name: string) =>
    `${name} could not be confirmed to be in this project (it has too many files to search), so it was not attached. Type its path instead.`,
  cadStale: (name: string, paths: readonly string[]) =>
    `${name} has the name and size of ${paths.join(", ")} in this project but was modified at a different time, so it was not attached. If it is the project's file, type its path; if not, copy it into the project folder first.`,
};

/**
 * Is this UTF-8 text? NUL bytes or an invalid sequence say no. A `prefix` may end in the middle of a
 * character; a whole file may not.
 */
export function looksLikeText(bytes: Uint8Array, { prefix = true }: { prefix?: boolean } = {}): boolean {
  if (bytes.includes(0)) {
    return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: prefix });
    return true;
  } catch {
    return false;
  }
}

function readBytes(blob: Blob): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result instanceof ArrayBuffer ? new Uint8Array(reader.result) : null);
    reader.onerror = () => resolve(null);
    reader.readAsArrayBuffer(blob);
  });
}

/** Every file path in the project (or worktree), walked once per batch of picked files. */
/** A walk of the project, or `failed` when the walk itself did not run (project closed, bad root). */
type ProjectListing = { paths: string[]; truncated: boolean; failed?: true };

type Found =
  | { kind: "one"; path: string }
  | { kind: "ambiguous"; paths: string[] }
  | { kind: "stale"; paths: string[] }
  | { kind: "unconfirmed" }
  | { kind: "failed" }
  | { kind: "outside" };

/**
 * The project file a picked CAD file is: the one file of that name, size and modified time. The
 * renderer is never told where a picked file came from (Electron no longer puts a path on `File`),
 * so this asks the project instead of the file. A same-named, same-sized file modified at another
 * time is a different file — an old copy, most likely — and referencing it would send the agent to
 * the wrong bytes without a word. A walk that hit its cap cannot say a file is not there.
 */
async function findInProject(file: File, scope: NonNullable<AttachScope>, listing: ProjectListing): Promise<Found> {
  if (listing.failed) return { kind: "failed" };
  const at = { projectId: scope.projectId, ...(scope.root ? { root: scope.root } : {}) };
  const named = listing.paths.filter((path) => (path.split("/").pop() ?? path) === file.name);
  const stats = await Promise.all(named.slice(0, 20).map(async (path) => {
    try {
      const stat = await window.textToCad.explorer.stat({ ...at, path });
      return stat.kind === "file" && stat.size === file.size ? { path, fresh: Math.abs(stat.modifiedAt - file.lastModified) < MTIME_TOLERANCE_MS } : null;
    } catch {
      return null;
    }
  }));
  const sized = stats.filter((stat): stat is { path: string; fresh: boolean } => stat !== null);
  const exact = sized.filter((stat) => stat.fresh).map((stat) => stat.path);
  if (exact.length === 1) return { kind: "one", path: exact[0]! };
  if (exact.length > 1) return { kind: "ambiguous", paths: exact };
  if (sized.length > 0) return { kind: "stale", paths: sized.map((stat) => stat.path) };
  return listing.truncated ? { kind: "unconfirmed" } : { kind: "outside" };
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
  // One walk of the project for the whole batch, and only when a CAD file needs it. A walk that
  // fails vouches for nothing, and says so — it is not a project with too many files.
  let listing: Promise<ProjectListing> | null = null;
  const list = (at: NonNullable<AttachScope>) => listing ??= window.textToCad.explorer
    .paths({ projectId: at.projectId, ...(at.root ? { root: at.root } : {}), path: "" })
    .catch((): ProjectListing => ({ paths: [], truncated: false, failed: true }));
  for (const file of files) {
    if (file.type.startsWith("image/")) {
      result.attach.push(file);
      continue;
    }
    if (isCadFile(file.name)) {
      const found: Found = scope ? await findInProject(file, scope, await list(scope)) : { kind: "outside" };
      if (found.kind === "one") result.references.push({ file: found.path, selector: "" });
      else if (found.kind === "ambiguous") result.refusals.push(attachmentRefusal.cadAmbiguous(file.name, found.paths));
      else if (found.kind === "stale") result.refusals.push(attachmentRefusal.cadStale(file.name, found.paths));
      else if (found.kind === "unconfirmed") result.refusals.push(attachmentRefusal.cadUnconfirmed(file.name));
      else if (found.kind === "failed") result.refusals.push(attachmentRefusal.cadUnreadable(file.name));
      else result.refusals.push(attachmentRefusal.cadOutside(file.name));
      continue;
    }
    // A file small enough to attach is decoded whole, as the send will decode it: a file that is
    // text for its first few KB and not after is refused now, not shown attached and dropped at
    // send. A larger one is refused either way; its first bytes only pick the reason.
    const inline = file.size <= MAX_INLINE_TEXT_BYTES;
    const bytes = await readBytes(inline ? file : file.slice(0, PROBE_BYTES));
    if (!bytes || !looksLikeText(bytes, { prefix: !inline })) {
      result.refusals.push(attachmentRefusal.notText(file.name));
    } else if (!inline) {
      result.refusals.push(attachmentRefusal.tooLarge(file.name));
    } else {
      result.attach.push(file);
    }
  }
  return result;
}
