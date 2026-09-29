# CAD for ChatGPT and Codex

**Give your agent CAD superpowers.**

CAD embeds the shared viewer in an MCP App host. It owns only the host
bridge, file handoff, appearance, composer delivery and iframe lifecycle. Geometry,
selection tools, renderers, file updates and reference serialization remain in
`@text-to-cad/ui` and `@text-to-cad/core`. The MCP server belongs to `cadgen`.

The global sidebar shows models previously viewed with this extension, across
folders: thumbnail previews, filename/folder search, pinning and removal from
history. It reads the persisted `cad_library`; it never scans the server's current
working directory or pretends to know the active host workspace. An empty library
shows one concise instruction to open a CAD file. The host keeps its own composer;
this gallery does not imitate or duplicate it.
Loading, unavailable files and operation failures have explicit states. The home
refreshes when its window regains focus or becomes visible, and polls every five
seconds while visible so changes from other CAD views appear automatically.
Requests are coalesced; polling stops when hidden or unmounted.

A recent model requests a native file tab only when the host advertises
`experimental["openai/files"]`, through `openai/files/open` with its saved absolute
path. The acknowledgement means the host accepted the request, not that rendering
finished. Hosts without that capability show an explicit **Preview here** action,
which reopens saved server authority using `cad_open(recentId)` and offers a return
to the recent-model home. Failed opens remain visible and retryable.

Opened STEP/STP, STL, GLB and 3MF files use the shared document-only `FileViewer`.
There is no explorer, file picker, breadcrumbs or second filename bar. Model
controls, snapshots and selection are shared; the app injects file services,
composer delivery and lifecycle. Existing skills and standalone web navigation
remain independent. File subscriptions resolve the displayed path before polling,
so requests remain file-scoped.

Thumbnails come from the mounted shared renderer's live capture after complete
geometry presentation and a stable opening camera, scaled to at most 320 pixels
and 256 KiB PNG. A capture is discarded after unmount, and its
saved-file revision must still match before storage. Home thumbnails load only
for visible items and cache by PNG content token, so replacing a preview refreshes
it even when the model revision is unchanged; unavailable previews use a quiet
placeholder, never fabricated geometry. Viewing another file through CAD records
history; searching or pinning does not count as opening it.

## Host protocol

`cad_open` returns `{file, rootId, rootPath, recentId?, revision?}`. `file` is root-relative, or null for
an empty sidebar view. Opening from the sidebar passes no file; it does not infer
the active host workspace from the server's working directory. A native file entrypoint may initially omit its trusted local path;
after mounting, the app invokes `cad_open` with its original tool input so the
host can supply that path through trusted metadata. This resolution also replaces
a nonempty result produced before native metadata was available. Data requests
retain the opened `rootId` alongside `recentId`: opening the same file from another
root cannot change the authority or relative paths of an existing view. No browser
path is trusted.

All service calls, cache requests and binary resources use the app-only
`cad_request` tool: `{path, method, body?: base64, recentId?, rootId?}` returns
`{status, headers, body: base64}`. Large file reads add `transfer: {offset,
totalBytes, revision}` and continue with `offset`/`revision` arguments; the adapter
checks continuity before returning complete bytes. This keeps each response under
the MCP stdio message limit. A custom fetch adapter plugs into the existing
CAD client. Its existing resource provider hands workers transferable byte
tickets, so neither the iframe nor its workers fetch a localhost server. The
client keeps the usual file polling, build-state handling and resource disposal.

The shared renderer supplies one **Add To Prompt** action outside Preview. It
captures the displayed view, including drawing ink, and adds STEP selection
references when present. The app supplies only `PromptContextPort`; it owns no
selection action or snapshot button. Hosts advertising
`experimental["openai/modelContext"]` and model-context updates receive removable,
titled composer attachments via `ui/update-model-context`; nothing submits a
message. Attachment titles and their first line identify the filename and selected
feature. The native host controls composer placement and its generic Context chip,
while the attachment popover exposes that identifying text. The app cannot embed
or reposition the native composer. References retain the canonical full-path
selector and observed document revision. Host context updates, including user
removals, remain authoritative. A change during asynchronous capture cancels that
delivery rather than restoring stale attachments. Unsupported hosts show a disabled
action with a reason. Reference clipboard commands remain available in shared tools.

`cad_library` supplies `list`, `pin`, `remove` and revision-checked `thumbnail`
operations. List and mutations are serialized, so late responses cannot overwrite
newer pin/removal results. Library requests are cancelled on teardown. Native or
preview opening keeps a generation guard so a late open cannot replace a newer
host selection. The library and immutable UI cache tests use isolated state dirs.

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

The build emits one self-contained `dist/index.html`. The MCP server advertises
a content-versioned resource URI through `cad_open` metadata, so changed builds
cannot reuse a cached interface. Restart the MCP connection after rebuilding to
publish the new resource; closing and reopening a pane alone may reuse the old
resource metadata. It inlines script, CSS, workers and drawing fonts because
an MCP UI resource has no HTTP asset directory. Font discovery, license notices
and the OFL Liberation replacement reuse the UI package's drawing-assets helpers;
the same large Xiaolai fallback excluded by the standalone viewer is omitted.
The JavaScript is gzip-compressed at build time and inflated with the browser's
`DecompressionStream` before importing a blob module. The JSON-framed resource
must stay below 8 MiB, leaving headroom under the MCP SDK's 10 MiB stdio limit.
Modules and workers use blob URLs, so the host's resource policy must permit them.
No shared renderer source is altered for this packaging. The full 3D CAD wordmark
(`src/assets/logo-cad.png`) sits at the home’s upper-left, above the recent-model gallery; the single C
(`src/assets/logo-c.svg`) is the compact favicon. Both use canonical repository
brand assets and are inlined. Metadata uses the CAD name and plugin tagline.

## Known host limits

These are observations of the installed Codex host, not guarantees for every host
or version. A native file-open acknowledgement confirms acceptance, not render
readiness. A new app- or model-origin file tab can require per-tab authorization
("Allow CAD to open this file?"); MCP read-only annotations do not control that
host permission step.

`openai/files/open` accepts a file path. No supported dynamic tab-title or
host-logo override is available through that request; native chrome uses the tool
title and supported compact-icon metadata. The full CAD wordmark belongs inside
this app. The host also owns composer placement and Context chip presentation.
Use one handoff route: native file opening when available, or the `cad_open` inline
fallback. Invoking both creates duplicate views. See the official
[extension guide](https://developers.openai.com/plugins/build/extensions) and
[plugin reference](https://developers.openai.com/plugins/reference).

## Controls supplied by Codex

| Standalone web control | Extension behavior |
| --- | --- |
| File selection | The recent-model home requests native file tabs when supported, with explicit local preview fallback. Per-file views have no explorer or picker. |
| URL navigation, filename bar and browser history | Omitted; shared tools stay over the viewport, with one Add To Prompt action below the viewport. |
| Theme selector | Follows the host theme. |
| Brand, version, release and project links | Omitted from the pane; plugin management owns installation and updates. |
| Reveal in file manager and server reload | Omitted; these standalone host actions are not exposed through MCP. |

Model controls, geometry selection, measurements, display settings, snapshots and
reference copying remain shared viewer features. One Add To Prompt action captures
the view and any selected references. It delivers removable
composer context rather than submitting a message; successful delivery adds no
status text, while failures remain visible for retry.

Adapter tests cover serialized library updates, disposal, revision-bound thumbnails, search, binary forwarding, worker tickets, cancellation, path handoff,
canonical reference delivery, failed deliveries and user removal reconciliation.
The browser integration test exercises the built resource against a real MCP
bridge and the CAD backend with temporary geometry. A live Codex smoke test is
still needed to verify the product's native file menu and removable composer
attachment presentation; the protocol harness does not impersonate that UI.
