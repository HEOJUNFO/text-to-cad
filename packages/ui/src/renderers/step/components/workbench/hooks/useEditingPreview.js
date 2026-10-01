import { useEffect, useMemo, useRef, useState } from "react";
import {
  editingPreviewEntry, initialEditingPreview, reduceEditingPreview,
} from "../../../workbench/editingPreview.js";
import { observeEditingPreview } from "../../../workbench/editingPreviewFeed.js";

export function useEditingPreview(file, { enabled, catalogEntry, client } = {}) {
  const [snapshot, setSnapshot] = useState(() => ({ file: "", state: initialEditingPreview() }));
  // The catalog's tree as each answer lands: a feed going quiet remembers it.
  const catalogTree = useRef("");
  catalogTree.current = String(catalogEntry?.hash || "");
  useEffect(() => {
    if (!enabled || !file) return undefined;
    // A poll that changes nothing, a failed one included, keeps the snapshot: the surface re-renders
    // only for news, not once per poll while the feed is down.
    const apply = next => setSnapshot(previous => {
      const before = previous.file === file ? previous.state : initialEditingPreview();
      const state = reduceEditingPreview(before, next, { catalogTree: catalogTree.current });
      return previous.file === file && JSON.stringify(before) === JSON.stringify(state)
        ? previous : { file, state };
    });
    return observeEditingPreview(file, apply, error => apply({ error: error.message }), { client });
  }, [file, enabled, client]);
  const state = useMemo(() => enabled && snapshot.file === file
    ? snapshot.state : initialEditingPreview(), [enabled, file, snapshot]);
  // The feed says the file moved on after its build: the catalog is read now, so the view goes to
  // the file on disk, never back to an older catalog entry it still holds.
  const superseded = state.superseded === true;
  useEffect(() => {
    if (superseded && file) void client?.refresh?.({ file, markRefreshing: false })?.catch?.(() => {});
  }, [superseded, file, client, state.revision]);
  const entry = useMemo(() => editingPreviewEntry(state, catalogEntry), [
    state.preview, state.revision, state.output, state.file,
    state.previewUnavailable,
    state.saved?.tree, state.saved?.documentHash,
    state.retainedSaved?.tree, state.retainedSaved?.documentHash, state.state, state.error, state.ended,
    state.quietFrom, catalogEntry,
  ]);
  return { entry, state };
}
