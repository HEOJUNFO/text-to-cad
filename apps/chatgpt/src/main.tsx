import { App as McpApp } from '@modelcontextprotocol/ext-apps';
import { version } from '../package.json';
import { createRoot } from 'react-dom/client';
import { createCadClient, type CadClient } from '@text-to-cad/core/client';
import '@text-to-cad/ui/tokens.css';
import '@text-to-cad/ui/styles.css';
import './style.css';
import Viewer from './App';
import { CAD_API_VERSION, CAD_ORIGIN, CadBackendError, connectBackend, createBridgeFetch, readOpenFile, toolData, type BackendInfo, type OpenFile } from './transport';
import { Button } from '@text-to-cad/ui/primitives/button';
import { createComposerContext } from './promptContext';
import { createFileHandoff } from './handoff';
import { createRecentLibrary } from './library';
import RecentHome from './RecentHome';

const root = createRoot(document.getElementById('root')!, { onUncaughtError: error => showError(asError(error)) });
const app = new McpApp({ name: 'CAD', version }, {}, { autoResize: false });
const library = createRecentLibrary(app);
let disposed = false;
const lifetime = new AbortController();
let backend: BackendInfo | undefined;
let hostConnected = false;
let recovering = false;
let navigationGeneration = 0;
let libraryHome: OpenFile | undefined;
let client: CadClient | undefined;
let composer: ReturnType<typeof createComposerContext> | undefined;
let opened: OpenFile | undefined;
let colorScheme: 'light' | 'dark' = 'light';
let hostContext: Record<string, unknown> = {};
async function openPath(path?: string) {
  const generation = ++navigationGeneration;
  const result = await app.callServerTool(path === undefined
    ? { name: 'cad_pick_file', arguments: { apiVersion: CAD_API_VERSION } }
    : { name: 'cad_open', arguments: { apiVersion: CAD_API_VERSION, path } },
  { signal: lifetime.signal, timeout: path === undefined ? 150_000 : 30_000 });
  if (disposed || generation !== navigationGeneration) return;
  const data = toolData(result);
  if (path === undefined && data.cancelled === true && data.document === null) return;
  const value = readOpenFile(data);
  if (!value?.document) throw new Error('Could not open this model.');
  libraryHome = opened;
  open(value, true);
}
function paint() {
  if (!opened || disposed) return;
  if (!opened.document) root.render(<RecentHome library={library} onChooseFile={backend?.filePicker.supported ? () => openPath() : undefined} filePickerUnavailableReason={backend?.filePicker.reason} onOpen={openPath} onOpenLink={async url => {
    const result = await app.openLink({ url }, { signal: lifetime.signal, timeout: 15_000 });
    if (result.isError) throw new Error('Codex could not open this link.');
  }} />);
  else if (client && composer) root.render(<>
    <Viewer key={opened.document.id} client={client} document={opened.document} promptContext={composer.port} colorScheme={colorScheme} library={library} />
    {libraryHome && <Button size="sm" variant="secondary" className="cad-recent-back" onClick={() => { const home = libraryHome!; libraryHome = undefined; open(home); }}>Back to models</Button>}
  </>);
}
function open(value: OpenFile, fromHome = false) {
  if (disposed) return;
  navigationGeneration++;
  if (!fromHome) libraryHome = undefined;
  if (!value.document || opened?.document?.id !== value.document.id || !client) {
    client?.dispose(); composer?.dispose(); client = undefined; composer = undefined;
    if (value.document) {
      client = createCadClient({ origin: CAD_ORIGIN, scopeId: value.document.id, fetch: createBridgeFetch(app, value.document), shouldPoll: () => document.visibilityState !== 'hidden' });
      composer = createComposerContext(app, value.document);
      composer.setCapabilities(app.getHostCapabilities());
      composer.syncHostContext(hostContext);
    }
  }
  opened = value;
  document.title = value.document ? `${value.document.name} · CAD` : 'CAD';
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
  disposed = true; lifetime.abort(); navigationGeneration++; library.dispose();
  handoff.dispose(); root.unmount(); client?.dispose(); composer?.dispose();
}
function asError(error: unknown) { return error instanceof Error ? error : new Error(String(error)); }
function showStatus(message: string) {
  if (!disposed) root.render(<div className="cad-message text-ui" role="status">{message}</div>);
}
function showError(error: Error) {
  if (disposed) return;
  opened = undefined;
  client?.dispose(); composer?.dispose(); client = undefined; composer = undefined;
  const details = `Interface ${version}\nAPI ${CAD_API_VERSION}\nRuntime ${backend?.version ?? 'not connected'}\nResource ${backend?.uiResourceUri ?? 'unknown'}\n${error instanceof CadBackendError ? error.code : error.name}: ${error.message}`;
  root.render(<div className="cad-message text-ui" role="alert"><div className="flex max-w-md flex-col items-start gap-4">
    <h1 className="text-base font-medium">CAD could not open this view</h1>
    <p className="text-muted-foreground">{error.message}</p>
    {hostConnected && <Button size="sm" onClick={() => void recover()}>Try again</Button>}
    <details className="w-full text-tiny text-muted-foreground"><summary className="cursor-pointer">Connection details</summary><pre className="mt-2 whitespace-pre-wrap break-all select-text">{details}</pre></details>
  </div></div>);
}
async function recover() {
  if (recovering || disposed) return;
  recovering = true;
  showStatus('Connecting CAD…');
  try {
    backend = await connectBackend(app, lifetime.signal);
    if (!disposed) { handoff.connected(); handoff.retry(); }
  } catch (error) { showError(asError(error)); }
  finally { recovering = false; }
}
const handoff = createFileHandoff(app, open, showError, () => showStatus('Opening CAD…'));
app.ontoolinput = params => handoff.input(params.arguments || {});
app.ontoolresult = result => handoff.result(result);
app.ontoolcancelled = params => handoff.cancel(params.reason || 'Opening the CAD file was cancelled.');
app.onhostcontextchanged = context => contextChanged(context as Record<string, unknown>);
app.onteardown = async () => { teardown(); return {}; };
window.addEventListener('pagehide', () => { teardown(); void app.close(); }, { once: true });
showStatus('Connecting CAD…');
void app.connect(undefined, { timeout: 15_000 }).then(async () => {
  if (disposed) return;
  hostConnected = true;
  contextChanged(app.getHostContext() as Record<string, unknown> || {});
  backend = await connectBackend(app, lifetime.signal);
  if (!disposed) { showStatus('Opening CAD…'); handoff.connected(); }
}).catch(error => showError(asError(error)));
