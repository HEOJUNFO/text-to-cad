import { App as McpApp } from '@modelcontextprotocol/ext-apps';
import { version } from '../package.json';
import { createRoot } from 'react-dom/client';
import { createCadClient, type CadClient } from '@text-to-cad/core/client';
import '@text-to-cad/ui/tokens.css';
import '@text-to-cad/ui/styles.css';
import './style.css';
import Viewer from './App';
import { CAD_ORIGIN, createBridgeFetch, type OpenFile } from './transport';
import { createComposerContext } from './promptContext';
import { createFileHandoff } from './handoff';

const root = createRoot(document.getElementById('root')!);
const app = new McpApp({ name: 'CAD', version }, {}, { autoResize: false });
let disposed = false;
let client: CadClient | undefined;
let composer: ReturnType<typeof createComposerContext> | undefined;
let opened: OpenFile | undefined;
let colorScheme: 'light' | 'dark' = 'light';
let hostContext: Record<string, unknown> = {};
function paint() {
  if (client && composer && opened && !disposed) root.render(<Viewer key={opened.rootId} client={client} opened={opened} promptContext={composer.port} colorScheme={colorScheme} />);
}
function open(value: OpenFile) {
  if (disposed) return;
  if (opened?.rootId !== value.rootId) {
    client?.dispose(); composer?.dispose();
    client = createCadClient({ origin: CAD_ORIGIN, workspaceId: value.rootId, fetch: createBridgeFetch(app), shouldPoll: () => document.visibilityState !== 'hidden' });
    composer = createComposerContext(app, value.rootId, value.rootPath);
    composer.setCapabilities(app.getHostCapabilities());
    composer.syncHostContext(hostContext);
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
  disposed = true;
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
