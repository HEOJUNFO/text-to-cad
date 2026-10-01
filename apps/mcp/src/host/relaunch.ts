import type { Bridge } from './bridge';
import { readLaunch, toolText, type Launch } from './server';

/** A path's `file:` URI, every character a path may hold (`#`, `?`, a drive's backslashes) kept in it. */
function fileUri(path: string): string {
  const url = new URL('file:///');
  url.pathname = path.replace(/\\/g, '/').replace(/^(?!\/)/, '/');
  return url.href;
}

/**
 * The same view, launched again in today's terms: a tab the host restores from an older build
 * replays the launch it was first opened with, which this page no longer reads. The sidebar's home,
 * a thread's tab, a file's tab or an agent's model, as that launch was.
 */
export async function relaunch(bridge: Pick<Bridge, 'callTool'>, stale: Launch): Promise<Launch> {
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await bridge.callTool(name, args);
    const fresh = readLaunch(result);
    if (!fresh) throw new Error(toolText(result, 'CAD could not open.'));
    return fresh;
  };
  if (stale.page === 'home') return call('cad_home', {});
  if (!stale.model) return call('cad_tab', {});
  if (stale.surface === 'file') return call('cad_file', { file: { name: stale.model.split(/[\\/]/).pop(), resourceUri: fileUri(stale.model) } });
  return { ...(await call('cad_launch', { model: stale.model })), surface: stale.surface };
}
