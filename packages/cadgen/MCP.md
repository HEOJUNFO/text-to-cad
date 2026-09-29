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

## Files and trust

Without `--root`, model-requested paths use the working directory.
File entrypoints instead carry a host-provided
`_meta["openai/resource"]["path"]`. That trusted path selects the containing
directory so the existing viewer can resolve CAD files and sidecars there.
Each app request receives that metadata again; a filename or opaque resource
URI supplied by the app never grants filesystem access. The process retains
at most 16 directory backends, including its working directory.

`--root <directory>` restricts document access, including host file entrypoints,
to the explicit directory. Containment and symlinked CAD libraries follow the
standalone viewer's rules. Only viewer CAD assets are served; model source is
never exposed. Derived store objects retain the existing content-addressed
viewer contract, not arbitrary filesystem access.

## Tools and interface

- `cad_open` accepts an optional project path or the host's file-entrypoint
  input `{file: {name, resourceUri}}`. It returns `{file, rootId, rootPath}`.
  Successful file opens also return `recentId` and the file's current
  `revision`, and record the model in the extension's persistent library.
  The file is relative to its root; null means no document is selected. Initial
  entrypoint invocation can precede host path injection, so the embedded app
  resolves that input with one `cad_open` call of its own.
  The tool title is **CAD** for both the global sidebar and file entrypoints.
  Opening CAD from the sidebar passes `{}` and shows the recent-model library
  without browsing a directory. The interface exposes no filesystem explorer
  or workspace selector.
  Models can also call `cad_open` with an existing artifact path.
  Passing `{recentId}` reopens a recorded model with its previously authorized
  directory. It cannot be combined with a new path or host file input.
- `cad_request` is visible only to the app. It carries `{path, method, body?}`
  to allowlisted viewer routes and returns `{status, headers, body}`. Both
  bodies are base64. It permits document reads, document compilation and
  derived display caches, never source execution, native clipboard or reveal.
  Large file responses add `transfer: {offset, totalBytes, revision}`. Repeat
  the same GET with `offset` and `revision` to retrieve the next chunk. The
  app assembles all bytes before rendering; a changed revision fails the read.
  An optional `recentId` restores the library's recorded directory authority
  when the app previews a recent model without a new native file entrypoint.
- `cad_library` is app-only. `action: "list"` returns up to 100 `items`, with
  pinned models first, then most recently opened. Each item includes `id`,
  `name`, `file`, `rootPath`, `absolutePath`, `lastOpened` (Unix seconds),
  `pinned`, `missing`, `revision` and `thumbnailRevision`. The app searches
  these records locally. `action: "pin"` takes `recentId` and `pinned`;
  `action: "remove"` takes `recentId`. Both return the updated list; removal
  forgets history without deleting the model.
  `action: "thumbnail"` with `recentId` returns `{thumbnail, revision}`,
  where `thumbnail` is a PNG data URL or null. Add a PNG `thumbnail` and its
  source file `revision` to upload a validated PNG preview of at most 256 KiB
  and 2048 pixels per dimension. Uploads reject
  changed files, and reads hide stale previews. Images are loaded individually
  so the library list stays below transport frame limits.
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

Only models successfully opened through this extension enter its library.
It never scans workspaces, imports the standalone viewer catalog, or executes
source. A recorded model retains its authorized directory across MCP
processes, allowing a global recent-model home. An explicit `--root` filters
the library and restricts reopening and data requests to that directory.
Missing files remain visible as missing until removed or restored.
Replacing a saved root directory with a symlink requires opening the file
again through the host; existing nested symlink libraries retain the viewer's
usual semantics.

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
