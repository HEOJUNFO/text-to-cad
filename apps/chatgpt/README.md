# CAD for ChatGPT and Codex

**Give your agent CAD superpowers.**

CAD embeds the shared viewer in an MCP App host. It owns only the host
bridge, file handoff, appearance, composer delivery and iframe lifecycle. Geometry,
selection tools, renderers, file updates and reference serialization remain in
`@text-to-cad/ui` and `@text-to-cad/core`. The MCP server belongs to `cadgen`.

The global sidebar shows models previously viewed with this extension, across
folders: thumbnail previews, filename/folder search, pinning and removal from
history. Pinned models have their own section and are excluded from Recent. The
full CAD logo, left-aligned search and compact controls follow the viewer design
system; pin/remove actions retain their space on hover and keyboard focus. The
footer links to the installed version’s release, GitHub and Discord. Version text
comes from package metadata stamped from canonical `VERSION` by the bundle.
Links use the host’s supported external-link action when supplied. It reads the persisted `cad_library`; it never scans the server's current
working directory or pretends to know the active host workspace. An empty library
shows one concise instruction to open a CAD file. The host keeps its own composer;
this gallery does not imitate or duplicate it.
Loading, unavailable files and operation failures have explicit states. The home
refreshes when its window regains focus or becomes visible, and polls every five
seconds while visible so changes from other CAD views appear automatically.
Requests are coalesced; polling stops when hidden or unmounted.

**Open Model** launches the operating system's file picker through the local
`cad_pick_file` MCP tool. Cancelling leaves the library unchanged. The backend
validates the selected file and returns its absolute document descriptor; no
file upload or temporary copy is involved. The handshake advertises picker
availability, and unsupported environments show a disabled action with a reason.

Both choosing a file and clicking a recent model display the shared viewer
**in the current CAD page**, with **Back to models** to return to the library.
The home does not hand off to `openai/files/open`: its acknowledgement could
create a tab outside the visible page without confirming the model rendered.
File tabs opened independently by Codex still use the registered file entrypoint.
Failed opens remain visible and retryable.

Opened STEP/STP, STL, GLB and 3MF files use the shared `FileViewer`. Custom
views supply its optional `browser` capability. FileViewer owns the same
`FileNavRow`, breadcrumb menus, `FileTree` and exclusive resizable panel column
as the standalone viewer; apps do not recompose this layout. The app owns browsing location,
expansion and navigation; the document viewer retains its separate absolute-path
source. The explorer starts collapsed, reveals the open file when expanded and
keeps its location when switching models. Browse location offers Project folder
when supplied, Computer, Home and Up one folder. A model outside the current
location still renders; its filename can reveal it under Computer.

`cad_open({path, browseRoot})` accepts the thread's actual project/worktree folder
as optional browsing context. The skill supplies it explicitly: the extension
does not infer it from the MCP server's current directory. Without context the
root is Computer (`/` on POSIX, drives on Windows). `cad_browse` reads one requested
directory at a time, including hidden entries so paths inside worktrees can be
revealed. Filtering searches loaded files only, with an explicit label; it never
recursively scans the computer. Returning focus refreshes loaded directories.
Folder failures remain retryable without replacing the model. Changing browsing
location does not remount the renderer or change document identity.

Native registered file views, identified by their host resource URI, omit this
composition because Codex already supplies their navigation row. Both routes
reuse the same renderers, tools and prompt delivery. No shared component detects
which application hosts it.

Thumbnails come from the mounted shared renderer's live capture after complete
geometry presentation and a stable opening camera, scaled to at most 320 pixels
and 256 KiB PNG. A capture is discarded after unmount, and its
saved-file revision must still match before storage. Home thumbnails load only
for visible items and cache by PNG content token, so replacing a preview refreshes
it even when the model revision is unchanged; unavailable previews use a quiet
placeholder, never fabricated geometry. Viewing another file through CAD records
history; searching or pinning does not count as opening it.

## Host protocol

After connecting to its host, the app calls `cad_handshake({apiVersion: 2})`.
It checks the protocol before loading a document or history, and retains the
runtime version and UI resource identity for diagnostics. An incompatible or
unreachable runtime produces a visible reconnect instruction. Tool errors and
malformed results cannot silently leave the interface waiting. Teardown aborts
pending work; bounded request deadlines do not automatically replay mutations.

`cad_open` returns `{apiVersion: 2, document: {id, path, name, revision} | null, browseRoot: string | null}`.
The path is canonical and absolute, with an ID derived from that path. The whole
descriptor travels with document requests, so viewing does not depend on history
storage or a registry created by a different MCP process. A null document shows
the global recent-model home without initializing a CAD client or reading a
catalog. Native results echo their `resourceUri`: a matching initial result is
used directly. Only a missing path or mismatched native result requires a second
`cad_open` call with the original tool input and trusted host metadata.

All service calls, cache requests and binary resources use the app-only
`cad_request` tool: `{apiVersion: 2, document, path, method, body?: base64}` returns
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
operations keyed by `documentId`. Recent entries expose one absolute `path`, with
folder labels derived for display only. List and mutations are serialized, so late responses cannot overwrite
newer pin/removal results. Library requests are cancelled on teardown. Opening from the library keeps a generation guard so a late open cannot replace a newer
host selection. The library and immutable UI cache tests use isolated state dirs.

Theme comes from the host context. View settings live in memory for the mounted
app instance. The global page and a file opened in a conversation mount the same
`App` and shared FileViewer; they do not use different renderers or control styles.
Each mount owns its camera and tool state, and framing responds to its viewport
size. Codex supplies the surrounding page heading, file chrome and conversation
tabs. Add To Prompt updates composer context; it does not submit a message or
create a conversation tab. Document changes dispose the previous document service and prompt
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
title and supported compact-icon metadata. The inspected desktop file-extension
wrapper explicitly disables file navigation in its breadcrumb/Open row. That row
is host chrome; it is not the standalone viewer's interactive breadcrumb control.
The global page's outer text heading is also host chrome. The full CAD wordmark
belongs at the upper-left of this app's content. Setting the iframe document title
helps browser accessibility but does not rename native Codex tabs. The host also
owns composer placement and Context chip presentation.
The home opens documents within its own view. Agent-initiated opens prefer
`cad_open` with absolute `path` and optional thread `browseRoot`. Native file
opening remains an explicit alternative; invoking both creates a second view. See the official
[extension guide](https://developers.openai.com/plugins/build/extensions) and
[plugin reference](https://developers.openai.com/plugins/reference).

## Controls supplied by Codex

| Standalone web control | Extension behavior |
| --- | --- |
| File selection | Open Model uses the native OS file picker. Recent models open inside the CAD page. Custom views also offer shared folder browsing; native registered views omit duplicate navigation. |
| Breadcrumbs and file explorer | Shared components in custom views, app-owned browsing context and MCP directory access. Registered file views keep host chrome. |
| Theme selector | Follows the host theme. |
| Brand, version and community links | The library shows the full CAD logo plus version, GitHub and Discord links. Custom views also show the wordmark in their navigation row; registered views retain document controls. |
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
