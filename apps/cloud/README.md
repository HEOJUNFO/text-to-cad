# Cloud

The hosted CAD server: agents send model code over MCP or REST, a sandbox builds
it with the released cadgen, and the result opens in the same CAD viewer at a
link anyone with the link can open. It is a separate server from `cadgen mcp`,
which runs on the person's own machine.

**PURPOSE** — accept code, run builds, snapshots and inspection scripts in
single-use sandboxes, keep their outputs, and serve each build to the shared
viewer.

**MAY DEPEND ON** — `@text-to-cad/core` and `@text-to-cad/ui` through their
public exports (the viewer page), and its own server dependencies. Never
another app, and never cadgen: the server only ever talks to a sandbox.

**DEPENDED ON BY** — nothing in this repository. The `cad-cloud` skill teaches
agents to use it.

## The laws

1. **The server never runs uploaded code and never imports cadgen.** Every CAD
   operation (a build, a snapshot, an inspection script) runs in a sandbox
   that carries the released cadgen wheel and the runner in `runner/`.
2. **A sandbox is single-use, has no network and holds no credentials.** The
   server writes its inputs and reads its outputs through the provider's file
   API. Whatever a sandbox returns is untrusted data about its own job.
3. **Viewing never wakes compute.** A build's view is its recorded export
   (`cadgen viewer export`), served as a read-only copy of the viewer API at
   `/b/<build>/__cad/*`. Model files come from object storage.
4. **The viewer is `CadViewer`, unchanged.** This app is one more host of the
   viewer host contract (`packages/ui/docs/viewer-host.md`); anything it needs
   from shared UI is a host capability, never a cloud branch.
5. **Every cost has a cap the server enforces.** Per job, per person per day,
   and a global daily budget. Providers rarely stop spending on their own.
6. **A build is immutable.** An edit is a new build: a base build's files plus
   the changes.
