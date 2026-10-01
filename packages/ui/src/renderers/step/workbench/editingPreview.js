// Ephemeral per-tab editing state. Saved-file catalog entries remain immutable.
export function initialEditingPreview() {
  return {
    epoch: "",
    revision: 0,
    preview: null,
    previewUnavailable: false,
    saved: null,
    retainedSaved: null,
    superseded: false,
    // Whether this revision's build was last heard finished (done or failed), and the catalog's
    // tree when the feed last went quiet: what a quiet feed's preview is judged by.
    ended: false,
    quietFrom: "",
    state: "disconnected",
    phase: "",
    detail: "",
    updatedAt: 0,
    error: "",
  };
}

export function previewGeometryChanged(previous, next) {
  return Boolean(previous && next && previous.file === next.file && previous.hash !== next.hash &&
    (previous.preview || next.preview));
}

// `catalogTree` is the catalog's tree for the file as this answer lands: a feed going quiet
// remembers it.
export function reduceEditingPreview(current, next, { catalogTree = "" } = {}) {
  if (!next || typeof next !== "object") return current;
  if (!next.epoch) {
    const quiet = !next.error;
    const wasQuiet = current.state === "disconnected" && !current.error;
    return {
      ...current, state: "disconnected", phase: "", detail: "", updatedAt: 0,
      error: next.error || "",
      quietFrom: quiet && !wasQuiet ? catalogTree : current.quietFrom || "",
    };
  }
  const previous = current.epoch && current.epoch !== next.epoch ? initialEditingPreview() : current;
  const revision = Number(next.revision) || 0;
  if (revision < previous.revision) return current;
  const same = revision === previous.revision;
  const candidate = next.preview;
  // A build the file moved past (the server's `superseded`) describes nothing on disk: neither its
  // preview nor anything it saved stands in for the file any longer.
  const superseded = next.superseded === true;
  let preview = superseded ? null : candidate && (!same || !previous.preview || previous.preview.revision !== revision || candidate.sequence >= previous.preview.sequence)
    ? { ...candidate, revision } : previous.preview;
  if (JSON.stringify(preview) === JSON.stringify(previous.preview)) preview = previous.preview;
  const previewUnavailable = candidate
    ? false
    : next.previewUnavailable === true
      ? true
      : same
        ? previous.previewUnavailable === true
        : false;
  const state = next.state || "building";
  const active = ["submitted", "queued", "building"].includes(state);
  const phase = active
    ? String(next.phase || (same ? previous.phase : "") || "").trim()
    : "";
  const detail = active
    ? String(next.detail || (same ? previous.detail : "") || "").trim()
    : "";
  const updatedAt = active
    ? Number(next.updatedAt) || (same ? previous.updatedAt : 0) || 0
    : 0;
  return {
    epoch: next.epoch,
    revision,
    preview,
    previewUnavailable,
    saved: superseded ? null : next.saved || null,
    retainedSaved: superseded ? null : next.saved || previous.saved || previous.retainedSaved || null,
    superseded,
    ended: active ? false : ["done", "failed"].includes(state) || (same && previous.ended === true),
    quietFrom: "",
    state,
    phase,
    detail,
    updatedAt,
    error: next.error || "",
    output: next.output,
    file: next.file || next.output,
  };
}

export function editingPreviewEntry(state, catalogEntry) {
  if (!state.preview) return null;
  // Follow edits remains on the authored tree after this revision's STEP save.
  // The saved catalog is selected only for a completed revision which had no
  // matching preview (a no-op), or when the server says that preview's object
  // graph is gone. If the latest save failed, an earlier validated saved
  // result can still recover that expired preview. In all cases the catalog
  // must prove the exact saved tree and document-byte identities; a merely
  // pending revision must not displace the previous usable preview.
  const savedFallback = state.saved || (state.previewUnavailable ? state.retainedSaved : null);
  const savedMatchesCatalog = savedFallback &&
    catalogEntry?.hash === savedFallback.tree &&
    catalogEntry?.documentHash === savedFallback.documentHash;
  if (savedMatchesCatalog && (
    state.previewUnavailable === true || state.preview.revision !== state.revision
  )) return null;
  // A quiet feed -- no build of this file running or remembered, as two minutes after any build,
  // or once its daemon has gone -- vouches for nothing on disk. A finished build's preview then
  // stands in only for a file it saved: any other changed without the feed (built by another
  // installation, a checkout, a STEP written by hand), and the catalog's revision is shown,
  // loaded behind the model on screen like any update. A build last heard running keeps its
  // preview through a quiet answer (a daemon too busy to list its jobs) until the file changes.
  // A feed that failed to answer is not quiet at all.
  const catalogTree = String(catalogEntry?.hash || "");
  const quiet = state.state === "disconnected" && !state.error;
  const own = catalogTree === state.saved?.tree || catalogTree === state.retainedSaved?.tree;
  if (quiet && catalogTree && !own && (state.ended === true || catalogTree !== state.quietFrom)) return null;
  const previewAppearance = state.preview.appearance || null;
  const previewAnimation = state.preview.animation || null;
  const previewMetadataKey = `${Number(state.preview.revision) || 0}:${Number(state.preview.sequence) || 0}`;
  return {
    ...catalogEntry,
    file: catalogEntry?.file || state.file || state.output,
    kind: state.preview.kind || catalogEntry?.kind || "part",
    url: state.preview.url,
    hash: state.preview.tree,
    bytes: 0,
    documentHash: "",
    sourceUrl: "",
    sourceSidecar: null,
    appearanceHash: previewAppearance ? state.preview.appearanceHash || `preview:${previewMetadataKey}` : "",
    poseUrl: "",
    animationHash: previewAnimation ? state.preview.animationHash || `preview:${previewMetadataKey}` : "",
    editingPreview: true,
    previewKinematics: state.preview.kinematics || null,
    previewAppearance,
    previewAnimation,
  };
}
