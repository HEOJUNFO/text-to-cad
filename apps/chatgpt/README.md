# CAD for ChatGPT and Codex

CAD embeds the shared viewer in an MCP App host. It owns only the host
bridge, file handoff, appearance, composer delivery and iframe lifecycle. Geometry,
selection tools, renderers, file updates and reference serialization remain in
`@text-to-cad/ui` and `@text-to-cad/core`. The MCP server belongs to `cadgen`.

Open CAD from the global sidebar to browse the server's working directory. The
shared explorer opens immediately with the shared empty state and file search.
Alternatively, open a STEP/STP, STL, GLB or 3MF file in Codex and choose CAD to
start with that model. The explorer browses supported files within the served
directory and its subdirectories. It starts closed for a host-opened file;
Show files reveals the tree, and selecting another file keeps the tree open. The read-only source reuses
`createCadFileSource` for listing, search, metadata and update subscriptions,
filtering file listings and search to STEP/STP, STL, GLB and 3MF. Navigation stays
within the existing workspace, and references identify the currently viewed file.
The app has no native picker, URL navigation, release menu or file-manager actions.
Existing skills and the standalone web viewer remain independent.

## Host protocol

`cad_open` returns `{file, rootId, rootPath}`. `file` is root-relative, or null for
an empty sidebar view. Opening from the sidebar passes no file and uses the
server's configured working directory. A native file entrypoint may initially omit its trusted local path;
after mounting, the app invokes `cad_open` with its original tool input so the
host can supply that path through trusted metadata. No browser path is trusted.

All service calls, cache requests and binary resources use the app-only
`cad_request` tool: `{path, method, body?: base64}` returns
`{status, headers, body: base64}`. Large file reads add `transfer: {offset,
totalBytes, revision}` and continue with `offset`/`revision` arguments; the adapter
checks continuity before returning complete bytes. This keeps each response under
the MCP stdio message limit. A custom fetch adapter plugs into the existing
CAD client. Its existing resource provider hands workers transferable byte
tickets, so neither the iframe nor its workers fetch a localhost server. The
client keeps the usual file polling, build-state handling and resource disposal.

The STEP selection slot adds the shared `PromptContextAction`. Hosts advertising
`experimental["openai/modelContext"]` and text model-context updates receive
removable, titled composer attachments via `ui/update-model-context`; nothing
submits a message. References use the canonical full-path selector plus the
observed document revision. Snapshot actions use the same prompt port when image updates are supported. Host
context updates, including user removals, remain authoritative. A change during
an asynchronous capture cancels that delivery rather than restoring stale
attachments. Unsupported hosts show a disabled action with a reason. Ordinary
Copy Reference remains a clipboard action.

Theme comes from the host context. View settings live in memory for the mounted
app instance. Root changes dispose the previous workspace service and prompt
port; host teardown and pagehide release the viewer and workers.

## Build and validation

Install from the root workspace, then:

```sh
npm run build:packages
npm --prefix apps/chatgpt run typecheck
npm --prefix apps/chatgpt run build
npm --prefix apps/chatgpt test
```

The build emits one self-contained `dist/index.html`, served as
`ui://cad/viewer/v1.html`. It inlines script, CSS, workers and drawing fonts because
an MCP UI resource has no HTTP asset directory. Font discovery, license notices
and the OFL Liberation replacement reuse the UI package's drawing-assets helpers;
the same large Xiaolai fallback excluded by the standalone viewer is omitted.
The JavaScript is gzip-compressed at build time and inflated with the browser's
`DecompressionStream` before importing a blob module. The JSON-framed resource
must stay below 8 MiB, leaving headroom under the MCP SDK's 10 MiB stdio limit.
Modules and workers use blob URLs, so the host's resource policy must permit them.
No shared renderer source is altered for this packaging.

## Controls supplied by Codex

| Standalone web control | Extension behavior |
| --- | --- |
| File selection | The sidebar opens the shared explorer; a native file opening starts with the selected model. The explorer switches CAD files in the served directory. No second native picker. |
| URL navigation and browser history | Files switch in the extension pane, without another URL or history stack. |
| Theme selector | Follows the host theme. |
| Brand, version, release and project links | Omitted from the pane; plugin management owns installation and updates. |
| Reveal in file manager and server reload | Omitted; these standalone host actions are not exposed through MCP. |

Model controls, geometry selection, measurements, display settings, snapshots and
reference copying remain shared viewer features. Add to prompt delivers removable
composer context rather than submitting a message.

Adapter tests cover binary forwarding, worker tickets, cancellation, path handoff,
canonical reference delivery, failed deliveries and user removal reconciliation.
The browser integration test exercises the built resource against a real MCP
bridge and the CAD backend with temporary geometry. A live Codex smoke test is
still needed to verify the product's native file menu and removable composer
attachment presentation; the protocol harness does not impersonate that UI.
