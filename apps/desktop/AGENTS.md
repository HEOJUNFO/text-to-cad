# AGENTS.md — apps/desktop

Read `README.md` first: dev, checks, packaging and the layout tree are there.

## The plan is not in this repository

text-to-cad's design document lives outside the checkout, at
`~/robots/text-to-cad-notes/design/desktop-app.md` (user policy: design notes
are never committed). Section numbers in the comments here — "plan §3", "plan
§9" — point at it. If you cannot read it, ask; do not reconstruct it from the
code and do not write a copy into this tree.

## Directory ownership per phase

One phase owns a directory. A folder that is a stub with a comment naming its
phase is not an oversight — it is the seam.

| Phase | Owns |
| --- | --- |
| P0 (done) | the project itself, `src/preload`, `src/shared/{index,types,titlebar,globals.d}.ts`, `src/shared/ipc/{index,define,errors}.ts`, `src/main/{index,menu,window-state}.ts`, `src/main/db`, `src/main/ipc/{index,register}.ts`, `src/renderer/app` — the shell's frame and the command palette — Settings' frame, and `tests/` where no row below names the file |
| Shell & lifecycle | `src/main/{app-paths,children,quit-deadline,quitting,settings-effects,test-door}.ts`, `src/renderer/features/sidebar`, `src/renderer/lib/sidebar.ts`, `src/renderer/state/{history,workspace-root}.ts` |
| P1 (done) | `src/main/agents`, `src/main/acp` (but `acp/agent-options.ts`), `src/shared/acp` (but `acp/options.ts`), `src/shared/agents.ts`, `src/{shared,main}/ipc/{acp,agents}.ts`, `src/renderer/state/{acp,agents}.ts`, `scripts/{acp-harness,fetch-agent-icons}.mjs`, `tests/fake-agent`, `tests/fixtures/acp` |
| P2 | `src/renderer/features/session` — the transcript, activity rows, composer chips, permissions, plan card — and its path links and reference grammar, `src/renderer/state/path-links.ts`, `src/shared/cad-refs.ts`; plus what the model and effort chips are drawn from before a session exists: `src/shared/acp/options.ts`, `src/{shared,main}/ipc/agent-options.ts`, `src/main/acp/agent-options.ts`, `src/renderer/state/agent-options.ts` |
| P3 (done) | `src/main/explorer`, `src/{shared,main}/ipc/explorer.ts`, `src/shared/terminal-replies.ts`, `src/renderer/features/explorer` (but `drawing/`, `DrawingTab.tsx`, `host/` and `BrowserTab.tsx`) — file tab, tree, Monaco, review, browser, terminal — `src/renderer/state/live-documents.ts`, `scripts/{monaco-workers,pdf-assets}.mjs` |
| P4 (done) | `@text-to-cad/ui` CAD renderer and explicit `@text-to-cad/core/client`; FileTab hosts the shared FileViewer through `src/renderer/features/explorer/host/` and `src/renderer/state/{live-cad,cad-draft}.ts` |
| P5 (done) | `src/main/cad`, `src/main/integrations` (but `integrations/drawings/`), `src/{shared,main}/ipc/{cad,integrations,runtime,skills}.ts`, `resources/{cadgen,runtime,skills,text-to-cad-mcp}`, `skills/`, `scripts/{build,build-skills,build-mcp,cad-resources,bundle-runtime,perf-cad}.mjs`, `src/renderer/state/integration-commands.ts`, the `reveal` field of the explorer store and tree |
| Drawings | the drawing tab kind: `src/renderer/features/explorer/DrawingTab.tsx`, `src/renderer/features/explorer/drawing/`, `src/renderer/state/drawings.ts`, `src/main/integrations/drawings/` |
| P6 | `src/renderer/features/settings` — the pages' contents — and the choosers its path rows use, `src/{shared,main}/ipc/dialogs.ts` |
| P7 (done) | `src/main/projects` (`git.ts`, `workspace.ts`, `index.ts`), `src/{shared,main}/ipc/git.ts`, `src/renderer/lib/git-mode.ts`, the review tab's scopes and commit strip, Git and worktrees' per-project cards, `tests/e2e/git.spec.ts` |
| P8 (done) | `electron-builder.yml`, `build/`, `resources/brand`, `scripts/{package,make-icons,make-brand,app-version}.mjs`, `src/main/{updater,telemetry}.ts`, `src/{shared,main}/ipc/app.ts`, the CI jobs |
| Browser | the embedded browser P3's tab kind grew into: `src/main/browser/`, `src/shared/browser.ts`, `src/{shared,main}/ipc/browser.ts`, `features/explorer/BrowserTab.tsx`, `docs/browser.md` |
| Clipboard | `src/{shared,main}/ipc/clipboard.ts` — the one door to the native clipboard; renderer callers go through `window.textToCad.clipboard` |
| P9 (onboarding) | `src/main/onboarding.ts`, `src/{shared,main}/ipc/onboarding.ts`, `src/renderer/features/onboarding`, `src/renderer/state/onboarding.ts`, `resources/sample/`, the `onboarding*` settings fields |

Work outside your phase's directories only where the seam requires it — a new
IPC branch in `src/shared/ipc/<branch>.ts`, spread into `src/shared/ipc/index.ts`,
with its handlers in `src/main/ipc/<branch>.ts` spread into
`src/main/ipc/index.ts`, is expected; reshaping the shell to fit one feature is
not.

## Running it for the person

- **When a workstream lands, rebuild and relaunch the app for them.** A
  running Electron keeps the code it started with; a merge that is not
  followed by a restart is a merge they cannot see. The sequence is: stop
  the instance you launched (`pkill -TERM -f 'Electron\.app/Contents/MacOS/Electron \.$'`
  — only the dev instance, never a packaged text-to-cad.app), `npm run build`,
  then relaunch. Close every Playwright or debugging instance you started
  first, so the one window left is the current build.
- **Launch in the background.** `TEXT_TO_CAD_LAUNCH_INACTIVE=1 npx electron .`
  shows the window without taking focus (`showInactive` in
  `src/main/index.ts`), so the relaunch does not interrupt whatever they are
  doing. Run it detached (`nohup … &`) with stdout to a log file. Never a bare
  `npx electron .`: that one takes the screen.
- **A test launch shows nothing at all.** `npm run e2e` sets
  `TEXT_TO_CAD_E2E_HIDDEN=1` (`playwright.config.ts`) and main then skips `show()`
  entirely, so a suite run — a dozen windows — never appears over the person's
  screen. Playwright still drives the renderer over the DevTools protocol:
  screenshots, boxes, the mouse and the keyboard all work on an unshown
  window. Any scratch Playwright or Electron script you write sets the same
  variable, or `TEXT_TO_CAD_LAUNCH_INACTIVE=1` if it has to be visible.

## Rules that are easy to break here

Where a test holds a rule, it is named beside it; run it after touching what
the rule is about.

- **Pure refactor:** package moves preserve all app UI/UX and functionality.
  FileTab hosts `@text-to-cad/ui/file-viewer`; the viewer renderers both apps
  register live in UI, the file renderers only this app registers (Markdown,
  code, image, PDF, unsupported) live in `features/explorer/renderers/`, and
  IPC/native services and app state stay here. Never import web app source.

- **The renderer imports from `src/main` never, and from `src/shared` only
  types and pure, dependency-free modules** (zod aside) — never anything that
  touches Node, Electron or the file system. The modules it takes values from
  today: `types.ts` (the schemas, `PANE_LIMITS`), `acp/options.ts`,
  `acp/reduce.ts`, `cad-refs.ts`, `terminal-replies.ts`, `titlebar.ts` and
  `ipc/errors.ts`. A shared module that grows a Node import stops
  qualifying. Its one way off the page is `window.textToCad`, built from the
  contract in `src/shared/ipc/index.ts`.
  (`tests/unit/main/renderer-shared-imports.test.ts` enforces this.)
- **Every IPC channel is declared once**, as a request schema and a response
  schema. `registerIpc` validates both and refuses to start if a channel has no
  handler. Do not add an `ipcMain.handle` outside it. A branch is its own module
  under `src/shared/ipc/`, spread into the contract; `invoke` comes from
  `./define`, because importing `../ipc` from a branch is a load-time cycle.
  (`tests/unit/main/ipc-declared-once.test.ts`.)
- **Root workspace dependencies are installed in this checkout, never borrowed.** electron-builder walks
  the tree by real path: a symlinked `node_modules` resolves every transitive
  dependency to `undefined`, packages an app missing half its modules, and does
  not fail while doing it. Use root `npm ci` and explicit `npm run native:rebuild --workspace @text-to-cad/desktop`.
- **Nothing reads `process.env` for a build-time secret.** The Aptabase key is
  compiled in as `__APTABASE_KEY__` (`electron.vite.config.ts`); a packaged app
  has no build environment, and a key the launcher can set is a key anyone can
  redirect. (`tests/unit/main/build-secrets.test.ts`.)
- **Every path from the renderer arrives with the project it is relative to,
  and optionally a root within it.** Main resolves the pair against that
  project's directory — or, when the request names a `root`, against one of
  that project's own worktrees, and nothing else (`rootOf` in
  `src/main/ipc/explorer.ts`, `resolveProjectRoot` in
  `src/main/projects/workspace.ts`) — after `realpath`, so a symlink is not a
  door — and refuses anything outside. A channel that took a bare path would
  be a channel that reads any file on the machine.
  (`tests/unit/main/explorer-fs.test.ts` aims links out of the root;
  `tests/unit/main/git-paths.test.ts` does the same for a review's paths.)
- **No channel takes a directory by name.** A folder becomes a project only
  through a chooser main opened, the sample main copied, or a session that
  already records it, so no request under `projects.*` has a `path` or
  `directory` field (`tests/unit/shared/projects-no-paths.test.ts`). The one
  exception is the e2e suite's door, `src/main/test-door.ts`
  (`installE2eDoor`), installed only when `NODE_ENV=test` and
  `!app.isPackaged` — an environment variable is something anyone can set in
  front of a packaged app (`tests/unit/main/test-door.test.ts`).
- **`src/renderer/components/{ui,ai-elements}` is vendored**, from the shadcn
  and AI Elements registries. It is excluded from eslint (not from the
  typechecker). These deliberate edits are in it: the `ai` package's types are
  replaced by `./types` (`components/ai-elements/types.ts`), about nine
  index accesses are guarded for `noUncheckedIndexedAccess`, `shimmer.tsx`
  sweeps a foreground-coloured band rather than a background-coloured one
  (the stock band erases the letters it passes over), and `reasoning.tsx`'s
  `ReasoningContent` takes Streamdown `components` (and `rehypePlugins`), so
  a thought draws links and images through the transcript's own (a stock thought fetches any
  `https:` image on paint), and its `Reasoning` does not auto-close one the
  person opened or closed themselves; `tool.tsx` draws at most 64 KB of a
  tool's input or result (`capToolBody`, `TrimmedBody`) and a string result
  as plain text rather than as JSON; `prompt-input.tsx` does not fetch an
  attachment's `blob:` URL on submit (the CSP refuses it; the composer reads
  the File); `command.tsx`'s `CommandDialog` draws its title inside the dialog
  (stock draws it outside, a heading in the page while the dialog is shut),
  names its box through cmdk's `label`, and passes the dialog's
  `onOpenAutoFocus` and `onCloseAutoFocus` through; `message.tsx` and
  `reasoning.tsx` take their Mermaid plugin from `src/renderer/lib/mermaid.ts`
  rather than `@streamdown/mermaid`, so the diagram engine loads with the first
  diagram and not with the window. They likewise leave `@streamdown/math` out of the
  list until `src/renderer/lib/math.ts` (`useMathPlugin`) has loaded it for a
  text with a formula in it, so KaTeX is not in the window's first chunk. Re-vendoring a component means
  redoing those.
- **The renderer's first chunk stays small.** Monaco (the review tab), xterm
  (the terminal tab), the CAD client, Mermaid and KaTeX load with their first
  use; do not import them statically from the shell. A lazy tab's fallback
  carries `data-focus-pending` so `features/explorer/focus.ts` waits for it. The
  packages that must resolve to one copy are in `resolve.dedupe` in
  `electron.vite.config.ts`, and `tests/unit/main/renderer-bundle.test.ts`
  fails on duplicate chunks in a built bundle (CI runs it after the build with
  `TEXT_TO_CAD_BUNDLE_CHECK=1`; a local run without a fresh build passes).
  (README, "Development".)
- **The agent table on a warm launch is the last launch's.** `agents.list`
  answers from the `__agents` settings row with every row `probing`; a caller
  that would act on a row (refuse an agent as not installed, hand a binary to a
  login) waits for `AgentDetector.freshWithin(PROBE_WAIT_MS)` and treats null
  as unknown, never as absent. A screen must not say "signed out" for a
  `probing` row: the welcome, the setup cards and the drawer say "Checking…",
  and the Agents page's dot stays idle (README, "ACP").
- **Nothing is installed into an agent's configuration.** text-to-cad's skills
  and its tools are given to each session — the skills root as an additional
  directory on `session/new` and `session/load` (both spellings) plus a
  preamble for the agents that ignore it, the MCP server in `mcpServers`, the
  runtime in front of the session's `PATH` (README, "Skills and tools in a
  session"). There is no plugin, no marketplace, no write to `~/.claude` or
  `~/.codex`, and no first-launch install step. Do not add one back: a
  person's own agent configuration is theirs, and an app that edits it is an
  app they cannot uninstall cleanly.
  (`tests/unit/main/agent-config-untouched.test.ts`.)
- **Adapter versions are pinned exactly.** `CLAUDE_ADAPTER` and
  `CODEX_ADAPTER` in `src/main/agents/registry.ts` name one version each,
  launched through `npm exec --yes --prefer-offline --no-audit --no-fund
  --no-update-notifier --package=<pkg>@<version>` and
  never a global install (`tests/unit/main/registry.test.ts`). Bump by the
  recipe: `npm view <package> version`, change the constant, run
  `scripts/acp-harness.mjs` for that agent in a scratch directory, re-record
  its fixture (README, "ACP").
- **The CAD runtime ships inside the app.** `resources/runtime/<os>-<arch>/`
  is a complete Python with cadgen installed (`scripts/bundle-runtime.mjs`),
  resolved right after an explicit override; a packaged app downloads and
  installs nothing, and `scripts/package.mjs` refuses to package without it.
  Do not add a first-launch install, a progress state, or a Settings page for
  it back: a runtime that is not there is a failure the CAD tab reports with
  the interpreter's words, not a state the person is asked to fix.
- **`package.json` stays at version `0.0.0`.** The repository's `VERSION` is
  the canonical release version; `scripts/app-version.mjs` reads it and both
  the build and `scripts/package.mjs` stamp it. Do not hand-edit it.
- **Exact dependency versions, no ranges.** Everything the later phases need is
  already installed, so a phase should not have to touch `package.json`. The
  one exception is the workspace links, `"@text-to-cad/core": "*"` and
  `"@text-to-cad/ui": "*"`: those resolve to the root workspace's packages,
  not to a registry, and `*` is how npm workspaces spell that.
  (`tests/unit/main/package-json.test.ts` holds this and the version above.)
- **No symlinks, ever** (repo-wide law: installers disagree about them and one
  drops them silently).
- **Nothing goes in the traffic lights' corner.** On macOS AppKit paints the
  close/minimise/zoom buttons over the top-left of the window, so the leftmost
  pane's strip reserves `--titlebar-inset` and no control may start inside it.
  The inset is measured from Chromium's window-controls overlay
  (`src/renderer/lib/titlebar.ts`), not typed into a stylesheet; the constant
  in `src/shared/titlebar.ts` is the fallback, and `tests/e2e/shell.spec.ts`
  fails when the two drift or when any state puts a control in the corner. A
  new full-window route reserves the room itself, the way Settings does.

- **A side pane is `{ collapsed, width }` and nothing else** — the sidebar's in
  `settings.layout`, the explorer's per session in `state/explorer.ts`. What is
  rendered, where each toggle is drawn and which pane reserves the traffic
  lights' corner are all derived from those two pairs, and **a collapsed pane is
  not rendered at all**, so a toggle exists in the document exactly once. Do not
  add a second collapse: a panel library with its own flag, or a width
  recomputed into shares behind the preference, is what made a drag under a
  minimum sometimes snap back and sometimes close a pane with no toggle left
  anywhere to reopen it. The geometry is `lib/panes.ts` (pure) and the drag is
  `app/PaneSeparator.tsx`; the session never collapses, and 40px past a
  minimum is the collapse (`PANE_LIMITS.overshoot`).
- **Every shortcut is a row in `src/renderer/lib/shortcuts.ts`, and every
  Application row with a modifier is a menu accelerator** in
  `src/main/menu.ts` — and every accelerator is a row
  (`tests/unit/main/shortcuts-menu.test.ts`). Add a key to both or to
  neither.
- **The docs point at things that exist.** Every backticked path under src,
  tests, scripts or docs in README.md, AGENTS.md, `docs/` and
  the headers of the modules `tests/unit/main/doc-paths.test.ts` lists names
  something on disk, and the README's screenshot paragraph and the e2e specs
  name the same shots (`tests/unit/main/readme-screenshots.test.ts`). Rename a file, fix
  the sentence.
- **No bottom panel.** The terminal is a fourth explorer tab kind. Everything
  secondary lives in the one strip.
- **Each session owns its explorer and tools.** New sessions start with no
  tabs. Every tab, retained strip, terminal and browser target is scoped to
  the session id; sharing a directory grants no access to another session's
  tabs. Background tools never change the selected session. Read
  [session workspaces](docs/session-workspaces.md) before changing ownership.
- **Projects are derived directory groups, not saved entities.** The session
  index owns the directory identity. A folder choice before the first prompt
  is a transient draft; archiving the last session hides its group without
  deleting session data. Never reintroduce a project-delete cascade.
- **The renderer never picks a session's working directory.** It sends a git
  mode; main resolves it (`src/main/projects/workspace.ts`), creates the
  worktree, and writes `cwd`, `branch` and `worktreePath` onto the row. The one
  exception is Settings' `New session in this worktree`, which names a directory
  that already exists — and main checks it is the project or one of that
  project's own worktrees before running anything in it.
- **A review's `Last turn` and `This session` are revisions, not times.** Main
  records HEAD when a session is created and again at the start of every turn
  (`sessions.sessionHead` / `turnHead`); the renderer sends the scope's *name*
  and main resolves it. Two commits can share a second, and `--before=` picks a
  commit rather than a moment, so a timestamp cannot do this job.

Domain MCP servers and focused skills are composed by `src/main/integrations/registry.mjs`. Read [the integration contract](docs/integrations.md) before adding session-to-app capabilities.
