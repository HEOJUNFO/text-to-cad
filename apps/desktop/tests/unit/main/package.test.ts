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

  describe("signingEnv", () => {
    const APPLE = {
      CSC_LINK: "apple.p12",
      CSC_KEY_PASSWORD: "pw",
      APPLE_ID: "id@example.invalid",
      APPLE_APP_SPECIFIC_PASSWORD: "app-pw",
      APPLE_TEAM_ID: "TEAM",
    };

    it("signs and notarises the Mac with the Apple credentials", async () => {
      const { signingEnv } = await import("../../../scripts/package.mjs");
      const { env, signed, notarize } = signingEnv(["--mac"], { PATH: "/bin", ...APPLE });
      expect({ signed, notarize }).toEqual({ signed: true, notarize: true });
      expect(env).toMatchObject(APPLE);
      expect(env.CSC_IDENTITY_AUTO_DISCOVERY).toBeUndefined();
    });

    it.each([["--win"], ["--linux"]])("never hands the Apple certificate to %s", async (flag) => {
      const { signingEnv } = await import("../../../scripts/package.mjs");
      const { env, signed, notarize } = signingEnv([flag], { PATH: "/bin", ...APPLE });
      expect({ signed, notarize }).toEqual({ signed: false, notarize: false });
      for (const name of Object.keys(APPLE)) {
        expect(env).not.toHaveProperty(name);
      }
      expect(env.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
      expect(env.PATH).toBe("/bin");
    });

    it("signs Windows with its own certificate only", async () => {
      const { signingEnv } = await import("../../../scripts/package.mjs");
      const { env, signed } = signingEnv(["--win"], { ...APPLE, WIN_CSC_LINK: "win.pfx", WIN_CSC_KEY_PASSWORD: "wpw" });
      expect(signed).toBe(true);
      expect(env).toMatchObject({ WIN_CSC_LINK: "win.pfx", WIN_CSC_KEY_PASSWORD: "wpw" });
      expect(env).not.toHaveProperty("CSC_LINK");
    });

    it("refuses to sign the Mac in the same run as another os", async () => {
      const { signingEnv } = await import("../../../scripts/package.mjs");
      expect(() => signingEnv(["--mac", "--win"], APPLE)).toThrow(/package --mac on its own/);
      expect(signingEnv(["--mac", "--win"], {}).signed).toBe(false);
    });
  });
});
