# CAD plugin extension

`cadgen mcp` connects the shared CAD Viewer to an MCP Apps host. The bundled
web interface reuses the same viewer components as the standalone viewer; the
Python adapter calls `CadApp` directly, with no second CAD pipeline and no
browser connection to a localhost viewer server. The CAD skills remain the
authoring workflow. Opening an artifact never executes its source program.

Install the optional official MCP SDK with `pip install 'cadgen[mcp]'`.
Launch `cadgen mcp` for stdio, or `cadgen mcp --transport streamable-http
--port 8000` for a loopback-only development endpoint at `/mcp`. HTTP has no
remote authentication and is not a public hosting configuration.

## Documents and local files

CAD opens absolute local file paths anywhere the server process can read.
It has no workspace, directory catalog or project limit. A document is one
canonical STEP/STP, STL, GLB or 3MF path with a stable opaque ID. Symlink aliases
resolve to that same document. Relative paths fail with an instruction to
resolve the absolute artifact path; `--root` is retired. The standalone HTTP
viewer's directory-containment contract is unchanged.

Native file entrypoints supply `_meta["openai/resource"]["path"]`. This absolute
host path takes precedence during `cad_open`. An opaque resource URI or filename
alone never identifies a filesystem location. Once opened, every data request
uses `documentId`; later host metadata cannot switch an existing view to another
file. Replacing the registered path with an alias to another file requires
opening the new canonical document explicitly.

The document backend constructs catalog metadata for just that file, using the
shared viewer metadata builders without directory discovery. Asset requests can
read the document, its STEP sidecar, and local buffers/images explicitly declared
by a GLB. Declared relative dependencies resolve from the document's location,
including `../` references. Network dependencies are not fetched. GLB JSON asset
declarations are bounded at 16 MiB. The file's parent is an internal relative-path
origin for compilation, never a directory access grant. Unrelated sibling files
must be opened as their own documents. Derived store objects retain the existing
content-addressed viewer contract. No source program executes.

## Tools and interface

- `cad_open` accepts one absolute `path`, a saved `documentId`, or the host's
  input `{file: {name, resourceUri}}`. It returns
  `{document: {id, path, name, revision} | null}`. A successful open records
  recent history; the document ID survives removing that history. With no file,
  the global CAD entrypoint shows the recent-model home. Initial native input
  can precede host path injection; the result also echoes `resourceUri` and the
  app resolves that input with one `cad_open` call of its own. Null means no
  selected document. The tool title is **CAD** for global and file entrypoints.
- `cad_request` is app-only and requires `{documentId, path, method, body?}`.
  Its allowlisted viewer routes return `{status, headers, body}`; both bodies
  are base64. Catalog entries name absolute files, and catalogs/server info use
  `scopeId: documentId` without workspace fields. File-bearing requests are
  bound to that selected document. Reads, document compilation and derived
  display caches reuse the existing viewer services; native clipboard/reveal
  and source execution are unavailable. Large file responses add
  `transfer: {offset, totalBytes, revision}`. Repeat the same GET with `offset`
  and `revision` for the next chunk; changed files fail the transfer.
- `cad_library` is app-only. `action: "list"` returns up to 100 `items`, pinned
  first then most recently opened. Each has `id`, `path`, `name`, `lastOpened`
  (Unix seconds), `pinned`, `missing`, `revision` and `thumbnailRevision`.
  The app searches those records locally. `action: "pin"` takes `documentId`
  and `pinned`; `action: "remove"` takes `documentId`. Both return the updated
  list. Removal forgets history, pin and thumbnail without deleting the file
  or interrupting an open view.
  `action: "thumbnail"` with `documentId` returns `{thumbnail, revision}`,
  where the PNG data URL may be null and the revision identifies image content
  (the same token as `thumbnailRevision`). Replacing a preview changes that
  token even when the CAD file is unchanged. Add a PNG `thumbnail` and its
  source-file `revision` to upload a validated preview, at most 256 KiB and
  2048 pixels per dimension. Changed files reject uploads and hide stale
  previews. Images load individually to keep library responses small.
- `ui://cad/viewer/<sha256>.html` serves the self-contained interface from the
  bundled `_runtime/chatgpt/index.html`. The server snapshots the HTML at
  startup and hashes its bytes into the URI, which hosts use as their cache
  key. Every URI serves immutable content; restarting after a changed build
  advertises a new URI. Clients discover it from `cad_open` tool metadata.
  Discovery and resource reads can use different MCP processes. A resource
  template resolves published versions from a shared `cadgen-mcp-ui` directory
  in the operating system's user cache, verifying the bytes against the URI.
  Consequently, an already-running connection can serve a newer connection's
  bundle, and a new connection can still serve an earlier published version.
  This disposable interface cache is separate from the geometry store and
  recent-model state; `CADGEN_MCP_UI_CACHE_DIR` overrides it for isolated tests.
  Unknown or corrupted versions fail explicitly; no URI silently serves a
  different build. Reconnecting is still required to load changed Python tools.
  `--ui <html>` is an explicit development override. A missing bundle fails
  startup with a build or reinstall hint. Resource metadata permits only `data:` and `blob:`
  for bundled workers, fonts and assets, and requests optional clipboard-write
permission. It declares no network origins. Hosts may decline permissions.

## Persistent library

Only documents successfully opened through this extension enter its history.
The persistent document registry is separate from recent history: its IDs map
to canonical files across MCP processes and remain valid after history removal.
Reopening a file reuses its ID. Missing files remain visible as missing until
removed or restored. Existing library records migrate their IDs, pins and
thumbnails into this document registry; old directory grants are removed.

Library history, pins and thumbnails are user state, separate from the
disposable geometry store. SQLite transactions coordinate concurrent MCP
processes. The database is `extension-library.sqlite3` under
`~/Library/Application Support/cadgen` on macOS, `%LOCALAPPDATA%/cadgen` on
Windows, or `$XDG_STATE_HOME/cadgen` (default `~/.local/state/cadgen`) on Linux.
`CADGEN_STATE_DIR` overrides that directory. Tests can also inject the database
path through `create_server(..., library_path=...)`.

File reads use 4 MiB chunks with a revision check before and after each read;
there is no total file-size cap. Non-file messages and writes are capped at
6 MiB decoded so base64 fits within the standard stdio client's 10 MiB frame
limit. Oversized messages fail explicitly. Geometry work remains in cadgen's
existing build pool. The server imports no CAD kernel.

Hosts must implement MCP Apps and the OpenAI file-entrypoint and model-context
extensions for the complete file-to-composer workflow. Protocol tests establish
our server contract; they do not establish which host release enables a feature.
