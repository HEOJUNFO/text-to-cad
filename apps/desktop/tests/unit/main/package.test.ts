import type * as ChildProcess from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `scripts/package.mjs`, imported rather than run: every decision it makes
 * before handing over to electron-builder is a function of its arguments and
 * its environment, and a test that had to package to see one would take
 * minutes and a runtime. The child-process module is replaced, so nothing
 * here can start a build even if the script's guard were to fail.
 */
const spawned = vi.hoisted(() => ({ spawnSync: vi.fn(() => ({ status: 0 })) }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawnSync: spawned.spawnSync,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("package.mjs", () => {
  it("imports without packaging, exiting or spawning anything", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit during import");
    }) as never);
    await import("../../../scripts/package.mjs");
    expect(exit).not.toHaveBeenCalled();
    expect(spawned.spawnSync).not.toHaveBeenCalled();
  });

  it.each([
    [["--mac"], ["mac-arm64", "mac-x64"]],
    [["--mac", "--arm64"], ["mac-arm64"]],
    [["--mac", "--arm64", "--x64"], ["mac-arm64", "mac-x64"]],
    [["--win"], ["win-x64"]],
    [["--linux"], ["linux-x64"]],
    [["--dir"], []],
  ])("needs the runtimes %j -> %j", async (args, runtimes) => {
    const { runtimeTargetsFor } = await import("../../../scripts/package.mjs");
    expect(runtimeTargetsFor(args)).toEqual(runtimes);
  });

  it.each([
    // No arch flag: the config's own arch list, nothing to narrow.
    [["--mac"], ["--mac"]],
    [["--win"], ["--win"]],
    // An arch flag narrows only with target names beside it (app-builder-lib).
    [["--mac", "--arm64"], ["--mac", "dmg", "zip", "--arm64"]],
    [["--mac", "--arm64", "--x64"], ["--mac", "dmg", "zip", "--arm64", "--x64"]],
    [["--linux", "--x64"], ["--linux", "AppImage", "deb", "--x64"]],
    [["--win", "--x64"], ["--win", "nsis", "--x64"]],
    // Target names the caller already gave are theirs.
    [["--mac", "zip", "--arm64"], ["--mac", "zip", "--arm64"]],
  ])("hands electron-builder %j as %j", async (args, builder) => {
    const { builderArgsFor } = await import("../../../scripts/package.mjs");
    expect(builderArgsFor(args)).toEqual(builder);
  });
});
