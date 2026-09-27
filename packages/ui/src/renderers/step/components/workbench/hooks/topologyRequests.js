// The part ids a viewer's topology requests name, as sets: pure helpers for the request
// session in useCadAssets (loadReferencesForEntry), split out so they unit-test in Node.

function idList(ids) {
  return (Array.isArray(ids) ? ids : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean);
}

export function sameTopologyIds(a, b) {
  const left = new Set(idList(a));
  const right = new Set(idList(b));
  return left.size === right.size && [...left].every((id) => right.has(id));
}

// Whether every id of `ids` is one of `within`.
export function topologyIdsWithin(ids, within) {
  const allowed = new Set(idList(within));
  return idList(ids).every((id) => allowed.has(id));
}

// What one batch composes: every requested part already loaded (a part no longer requested drops
// out), and up to `budget` requested parts that are not, the most recently requested first
// (`requestOrder`: id -> a number that grows with each new request).
export function chooseTopologyBatch(requestedIds, loadedIds, { budget = Infinity, requestOrder = null } = {}) {
  const loaded = new Set(idList(loadedIds));
  const kept = [];
  let missing = [];
  for (const id of new Set(idList(requestedIds))) {
    (loaded.has(id) ? kept : missing).push(id);
  }
  if (missing.length > budget) {
    missing = missing
      .map((id, index) => ({ id, index, order: Number(requestOrder?.get(id)) || 0 }))
      .sort((a, b) => (b.order - a.order) || (a.index - b.index))
      .slice(0, Math.max(0, budget))
      .map(({ id }) => id);
  }
  return [...kept, ...missing];
}
