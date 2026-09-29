import { App as McpApp } from '@modelcontextprotocol/ext-apps';
import { version } from '../package.json';
import { createRoot } from 'react-dom/client';
import { createCadClient, type CadClient } from '@text-to-cad/core/client';
import '@text-to-cad/ui/tokens.css';
import '@text-to-cad/ui/styles.css';
import './style.css';
import Viewer from './App';
import { CAD_ORIGIN, createBridgeFetch, readOpenFile, type OpenFile } from './transport';
import { createComposerContext } from './promptContext';
import { createFileHandoff } from './handoff';
import { createRecentLibrary, type RecentModel } from './library';
import { createNativeFiles } from './nativeFiles';
import RecentHome from './RecentHome';

const root = createRoot(document.getElementById('root')!);
const app = new McpApp({ name: 'CAD', version }, {}, { autoResize: false });
const library = createRecentLibrary(app);
const nativeFiles = createNativeFiles(app);
let disposed = false;
let navigationGeneration = 0;
let previewHome: OpenFile | undefined;
let client: CadClient | undefined;
let composer: ReturnType<typeof createComposerContext> | undefined;
let opened: OpenFile | undefined;
let colorScheme: 'light' | 'dark' = 'light';
let hostContext: Record<string, unknown> = {};
async function openRecent(item: RecentModel) {
  const generation = ++navigationGeneration;
  if (nativeFiles.available()) { await nativeFiles.open(item.absolutePath); return; }
  const result = await app.callServerTool({ name: 'cad_open', arguments: { recentId: item.id } });
  if (disposed || generation !== navigationGeneration) return;
  const value = readOpenFile(result.structuredContent);
  if (result.isError || !value?.file) {
    const message = result.content?.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
    throw new Error(message || 'Could not open this recent model.');
  }
  previewHome = opened;
  open(value, true);
}
function paint() {
  if (!opened || disposed) return;
  if (!opened.file) root.render(<RecentHome library={library} nativeOpenAvailable={nativeFiles.available()} onOpen={openRecent} />);
  else if (client && composer) root.render(<>
    <Viewer key={`${opened.rootId}:${opened.recentId || opened.file}`} client={client} opened={opened} promptContext={composer.port} colorScheme={colorScheme} library={library} />
    {previewHome && <button className="cad-recent-back" onClick={() => { const home = previewHome!; previewHome = undefined; open(home); }}>Back to recent models</button>}
  </>);
}
function open(value: OpenFile, fromHome = false) {
  if (disposed) return;
  navigationGeneration++;
  if (!fromHome) previewHome = undefined;
  if (!value.file || opened?.rootId !== value.rootId || opened?.recentId !== value.recentId || !client) {
    client?.dispose(); composer?.dispose(); client = undefined; composer = undefined;
    if (value.file) {
      client = createCadClient({ origin: CAD_ORIGIN, workspaceId: value.rootId, fetch: createBridgeFetch(app, { recentId: value.recentId, rootId: value.rootId }), shouldPoll: () => document.visibilityState !== 'hidden' });
      composer = createComposerContext(app, value.rootId, value.rootPath);
      composer.setCapabilities(app.getHostCapabilities());
      composer.syncHostContext(hostContext);
    }
  }
  opened = value;
  paint();
}
function contextChanged(context: Record<string, unknown>) {
  hostContext = { ...hostContext, ...context };
  colorScheme = hostContext.theme === 'dark' ? 'dark' : 'light';
  document.documentElement.classList.toggle('dark', colorScheme === 'dark');
  document.documentElement.style.colorScheme = colorScheme;
  composer?.syncHostContext(context);
  paint();
}
function teardown() {
  if (disposed) return;
  disposed = true; navigationGeneration++; library.dispose();
  handoff.dispose(); root.unmount(); client?.dispose(); composer?.dispose();
}
function showError(error: Error) {
  if (!disposed) root.render(<div className="cad-message" role="alert">{error.message}</div>);
}
const handoff = createFileHandoff(app, open, showError);
app.ontoolinput = params => handoff.input(params.arguments || {});
app.ontoolresult = result => handoff.result(result.structuredContent);
app.onhostcontextchanged = context => contextChanged(context as Record<string, unknown>);
app.onteardown = async () => { teardown(); return {}; };
window.addEventListener('pagehide', () => { teardown(); void app.close(); }, { once: true });
root.render(<div className="cad-message" role="status">Connecting CAD…</div>);
void app.connect().then(() => {
  if (disposed) return;
  contextChanged(app.getHostContext() as Record<string, unknown> || {});
  handoff.connected();
}).catch(error => showError(error instanceof Error ? error : new Error(String(error))));
