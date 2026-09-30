/**
 * `settings.fallbacks`: what the Settings pages say about a stored value that
 * is not the one in effect.
 *
 * Two different things, kept apart because the rows word them differently: a
 * `refused` value main could not parse (or git refuses) and read as the
 * default, and a remembered folder that parses fine but is `gone`. A stored
 * value of the wrong type is the first; it must never surface as the second,
 * whose note says the folder no longer exists.
 */
import { settings } from "../db/repositories";
import { existingPath } from "./dialogs";

export async function settingsFallbacks(): Promise<{ refused: Record<string, string>; gone: Record<string, string> }> {
  // `get` has already read a wrong-typed folder as null, so only a real,
  // well-formed path is stat'ed.
  const stored = settings.get();
  const gone: Record<string, string> = {};
  for (const key of ["defaultProjectFolder", "worktreeRoot"] as const) {
    const folder = stored[key];
    if (folder && (await existingPath(folder, { directory: true })) === undefined) {
      gone[key] = folder;
    }
  }
  return { refused: settings.fallbacks(), gone };
}
