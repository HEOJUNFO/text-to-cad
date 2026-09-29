# CAD plugin extension

`cadgen mcp` connects the shared CAD Viewer to an MCP Apps host. The bundled
interface reuses the viewer components; the Python adapter calls `CadApp`
directly, without a second geometry pipeline or browser connection to localhost.
The CAD skills remain the authoring workflow. Opening a document never executes
its source program.

Install `cadgen[mcp]`, then run `cadgen mcp` for stdio. Development can use
`cadgen mcp --transport streamable-http --port 8000` at loopback `/mcp`.
HTTP has no remote authentication and is not a public hosting configuration.

## Document transport and protocol

The app starts with `cad_handshake({apiVersion: 2})`. The response includes
`apiVersion`, `supportedApiVersions`, `documentTransport: "descriptor"`,
`serverVersion`, `uiDigest`, `uiResourceUri` and `uiCacheAvailable`. Unsupported
versions return `API_VERSION_UNSUPPORTED` with a reconnect instruction. A host
connected to an older server without this tool must reconnect to the updated
server; the app must not silently continue with a guessed protocol.

A document descriptor is `{id, path, name, revision}`. Its path is an absolute,
canonical local STEP/STP, STL, GLB or 3MF file. Its ID is a deterministic SHA-256
of the canonical path with the `cad-document-v2` namespace; it is not a database
key or a secret capability. The process's ordinary filesystem permissions govern
access. Symlink aliases share an identity. The revision describes the current
file and is informative: saving new bytes at the same path does not invalidate
the descriptor. Replacing that path with an alias to another file requires an
explicit reopen.

Every v2 data request carries the descriptor. No history database, previous tool
call, current working directory or workspace registration is required to resolve
it. A home opened with no file requires neither history initialization nor a
filesystem scan. Relative paths fail with a teaching error. `--root` is retired;
the standalone HTTP viewer's directory-containment behavior is unchanged.

- `cad_open` takes `apiVersion: 2` and one `path`, `document`, or native
  `{file: {name, resourceUri}}`, or no selection for home. It returns
  `{apiVersion, document: descriptor | null}` and echoes native `resourceUri`.
  A native file input resolves only through host-injected
  `_meta["openai/resource"]["path"]`; an opaque URI or name is not a disk path.
  An initial unresolved native input returns null so the app can resolve it
  after connecting. Explicit path/descriptor opens are not rebound by unrelated
  host metadata. History writes are best effort: failure adds
  `warnings: [{code: "HISTORY_UNAVAILABLE", message, retryable: true}]` while
  preserving the successful document result.
- `cad_request` is app-only. It takes `{apiVersion: 2, document, path, method,
  body?}` and returns `{apiVersion, status, headers, body}`. Both bodies are
  base64. Catalogs contain only the selected file, named absolutely, and use
  `scopeId: document.id`; they expose no workspace fields. The routes allow
  document reads, compilation from saved bytes and derived display caches.
  They do not expose native clipboard/reveal operations or source execution.
  Large file reads add `transfer: {offset, totalBytes, revision}`. Repeat the
  same GET with `offset` and transfer `revision` to continue; a changed file
  fails the transfer. Reads use 4 MiB chunks, with no total file-size limit.
  Non-file messages and writes are capped at 6 MiB decoded for stdio framing.
- `cad_library` is app-only and optional. `action: "list"` returns up to 100
  items, pinned first then most recently opened. Fields are `id`, `path`, `name`,
  `lastOpened` (Unix seconds), `pinned`, `missing`, `revision`, and
  `thumbnailRevision`. `action: "pin"` takes `documentId` and `pinned`;
  `action: "remove"` takes `documentId`. Both return the updated list. Removal
  deletes history, pin and thumbnail, never the document or an open view.
  `action: "thumbnail"` takes `documentId` and returns `{thumbnail, revision}`.
  The PNG data URL may be null; this revision identifies image content, matching
  `thumbnailRevision`. Uploads also pass `thumbnail` and the source-file
  `revision`. They validate PNG bytes, at most 256 KiB and 2048 pixels per
  dimension, reject changed files and hide stale previews.

Every success identifies `apiVersion: 2`. Tool failures set `isError: true` and
return `{apiVersion, error: {code, message, retryable}}` as structured content,
with the same message in text. Codes distinguish `API_VERSION_UNSUPPORTED`,
`INVALID_DOCUMENT`, `FILE_NOT_FOUND`, `DOCUMENT_CHANGED`, `HISTORY_UNAVAILABLE`,
and `INTERNAL_ERROR`. Unexpected errors log their traceback to stderr, never
stdio protocol stdout. Existing viewer-route HTTP responses retain their own
status and body. Clients may retry explicitly retryable reads; they must not
blindly repeat writes.

API 1 compatibility means the preceding document-ID interface: an omitted
version or `apiVersion: 1` may use `documentId` for open/data requests. That
lookup still needs readable historical state and reports its absence. Existing
API-1 viewers retain their historical ID as catalog/server `scopeId`, so an
upgrade does not silently replace the identity of their live caches. New apps
must use descriptors. Earlier workspace-root interfaces are not advertised as
compatible; cached old apps must reconnect and load the current bundle.

## Selected assets and viewer reuse

The document backend uses the shared single-file catalog builders without
walking its containing directory. It serves that document, its STEP sidecar,
and buffers/images explicitly declared by a GLB. Relative declarations resolve
from the file's location, including `../`; network dependencies are not fetched.
GLB JSON declarations are bounded at 16 MiB. The parent directory is an internal
compiler origin, never an access grant to neighboring files. Other CAD files
must be selected as their own documents. Store and display-cache requests retain
the shared viewer's content-addressed contracts. Geometry work remains in
cadgen's build pool; the server imports no CAD kernel.

## Optional history and safe upgrades

History initializes lazily. Discovery, home, handshake and descriptor-based
asset requests do not open its database. File opens attempt a short transactional
history write and remain successful if storage is missing, locked, read only or
corrupt. Library actions report `HISTORY_UNAVAILABLE` so the app can show that
state independently of its viewer.

History, pins and previews are user state, separate from derived geometry.
SQLite transactions coordinate MCP processes with a short contention timeout;
there are no write retries. The database is `extension-library.sqlite3` under
`~/Library/Application Support/cadgen` on macOS, `%LOCALAPPDATA%/cadgen` on Windows,
or `$XDG_STATE_HOME/cadgen` (default `~/.local/state/cadgen`) on Linux.
`CADGEN_STATE_DIR` overrides the directory; tests can inject `library_path`.

Upgrades never rename or drop existing tables. The live history schema remains
`recent_models`, preserving compatibility with installed older readers and
writers; `model_roots` is retained for their existing grants. The intermediate
`documents`/`recents` schema remains intact. Its saved rows, pins and previews
are copied once into live history, tracked by an additive migration marker so
later removals are not resurrected. If an earlier destructive migration removed
`recent_models` or `model_roots`, initialization recreates them and recovers
available history from surviving state. Deleted historical directory grants
cannot be reconstructed safely: old views needing those grants must reopen.
Updating/reconnecting an old destructive-migration binary is still necessary;
new code cannot stop an old process from dropping tables again. Descriptor-based
file access remains independent of that failure.

## Interface delivery

`ui://cad/viewer/v2/<sha256>.html` identifies a self-contained snapshot of
`_runtime/chatgpt/index.html`. The protocol namespace prevents cross-version
cache reuse; the digest makes each resource immutable. Clients discover the URI
from `cad_open` metadata and verify compatibility through the handshake before
using the app. A protocol change needs a new namespace and explicit negotiation,
not merely a new content hash.

Within v2, different MCP processes can read each other's published bundles from
the separate `cadgen-mcp-ui/v2` OS cache (`CADGEN_MCP_UI_CACHE_DIR` overrides the
cache root). Reads verify hashes. Cache publication is best effort: a connection
always serves its own in-memory bundle, and the handshake reports whether it
could publish that snapshot. An unknown, corrupt or inaccessible cached version
fails with a reconnect instruction; it never substitutes another bundle.

`--ui <html>` is a development override. A missing packaged bundle fails startup
with an explicit build/reinstall hint. Resource metadata permits only `data:`
and `blob:` for bundled assets and requests optional clipboard-write permission.
It grants no network origins. Hosts may decline permissions and must implement
MCP Apps and the OpenAI file-entrypoint/model-context extensions for the complete
file-to-composer workflow.
