import { ORBIT_STORAGE_KEY, readOrbit, writeOrbit } from '../kit/tools/preview/orbitPreferences.js';
import { TOOL_STACK_STORAGE_KEY, readToolStack, writeToolStack } from '../kit/tools/toolStackLayout.js';
import { ANIMATION_STORAGE_KEY, readAnimationPreferences, writeAnimationPreferences } from '../kit/tools/playbar/animationPreferences.js';


export interface CadPreferences {
  orbit?: { speed: number };
  /**
   * The tool stack's layout, in every file (`kit/tools/toolStackLayout.js`): its one width in CSS
   * pixels, the caps a person dragged the tree and Reference panels to, and which panels are folded.
   */
  toolStack?: ToolStackLayout;
  /** Whether entering preview starts the routine (`kit/tools/playbar/animationPreferences.js`). */
  animation?: { autoplay: boolean };
}
export interface ToolStackLayout {
  width: number;
  heights: { tree?: number; position?: number; reference?: number };
  collapsed: Record<string, boolean>;
}
export interface CadPreferenceSource {
  getSnapshot(): CadPreferences;
  subscribe(listener: () => void): () => void;
  update(patch: Partial<CadPreferences>): void;
}
/** Host storage is supplied explicitly; construction never discovers browser storage. */
export function createCadPreferences({ initial = {}, onChange }: {
  initial?: CadPreferences;
  onChange?: (preferences: CadPreferences) => void;
} = {}): CadPreferenceSource {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update(patch) {
      const next = { ...current, ...patch };
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      current = next;
      onChange?.(next);
      for (const listener of listeners) listener();
    }
  };
}

/** Preferences kept in a host's `Storage`, which other windows of the same app may share. */
export interface StoredCadPreferences extends CadPreferenceSource {
  /**
   * Another window changed `key` in the same storage (a `storage` event's key; `null` is a clear):
   * the preferences stored under it are read again. Any other key is someone else's.
   */
  storageChanged(key: string | null): void;
}

/**
 * The viewer preferences as the host stores them: the one owner of their storage format. The app
 * hands over its `Storage` and forwards its `storage` events; what is written, and under which key,
 * is this module's. Construction reads the storage and nothing else.
 */
export function createStoredCadPreferences(storage: Storage): StoredCadPreferences {
  const read = (): CadPreferences => ({ orbit: readOrbit(storage), toolStack: readToolStack(storage), animation: readAnimationPreferences(storage) });
  let syncing = false;
  let baseline = read();
  const source = createCadPreferences({ initial: baseline, onChange(preferences) {
    // A preference read back from storage is not written again.
    if (!syncing && preferences.orbit && JSON.stringify(preferences.orbit) !== JSON.stringify(baseline.orbit)) writeOrbit(storage, preferences.orbit);
    if (!syncing && preferences.toolStack && JSON.stringify(preferences.toolStack) !== JSON.stringify(baseline.toolStack)) writeToolStack(storage, preferences.toolStack);
    if (!syncing && preferences.animation && JSON.stringify(preferences.animation) !== JSON.stringify(baseline.animation)) writeAnimationPreferences(storage, preferences.animation);
    baseline = preferences;
  } });
  return {
    ...source,
    storageChanged(key) {
      if (key !== null && key !== ORBIT_STORAGE_KEY && key !== TOOL_STACK_STORAGE_KEY && key !== ANIMATION_STORAGE_KEY) return;
      syncing = true;
      try { source.update(read()); } finally { syncing = false; }
    },
  };
}
