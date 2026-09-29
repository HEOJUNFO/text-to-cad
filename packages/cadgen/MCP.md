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
  The file is relative to its root; null means no document is selected. Initial
  entrypoint invocation can precede host path injection, so the embedded app
  resolves that input with one `cad_open` call of its own.
  The tool title is **CAD** for both the global sidebar and file entrypoints.
  Opening CAD from the sidebar passes `{}` and shows workflow guidance without
  browsing a directory. The extension is a per-file viewer: the host supplies
  the file, and the interface exposes no explorer or workspace selector.
  Models can also call `cad_open` with an existing artifact path.
- `cad_request` is visible only to the app. It carries `{path, method, body?}`
  to allowlisted viewer routes and returns `{status, headers, body}`. Both
  bodies are base64. It permits document reads, document compilation and
  derived display caches, never source execution, native clipboard or reveal.
  Large file responses add `transfer: {offset, totalBytes, revision}`. Repeat
  the same GET with `offset` and `revision` to retrieve the next chunk. The
  app assembles all bytes before rendering; a changed revision fails the read.
- `ui://cad/viewer/v1.html` serves the self-contained interface from the
  bundled `_runtime/chatgpt/index.html`. `--ui <html>` is an explicit
  development override. Resource metadata permits only `data:` and `blob:`
  for bundled workers, fonts and assets, and requests optional clipboard-write
  permission. It declares no network origins. Hosts may decline permissions.

File reads use 4 MiB chunks with a revision check before and after each read;
there is no total file-size cap. Non-file messages and writes are capped at
6 MiB decoded so base64 fits within the standard stdio client's 10 MiB frame
limit. Oversized messages fail explicitly. Geometry work remains in cadgen's
existing build pool. The server imports no CAD kernel.

Hosts must implement MCP Apps and the OpenAI file-entrypoint and model-context
extensions for the complete file-to-composer workflow. Protocol tests establish
our server contract; they do not establish which host release enables a feature.
