import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ENV_BEGIN, ENV_END, captureLoginEnv, loginEnv, parseLoginOutput, processEnv } from "@main/agents/shell-env";

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A stand-in for `$SHELL`: called as `<shell> -ilc <command>`, it prints what
 * a chatty rc file would (a banner with no trailing newline), runs the command
 * with a known PATH, and prints more on the way out, as a .zlogout might.
 */
function fakeShell(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "text-to-cad-shell-"));
  temps.push(dir);
  const file = path.join(dir, "shell");
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

describe.skipIf(process.platform === "win32")("capturing the login shell", () => {
  it("keeps the first variable (PATH) when the rc files print before env, and ignores what follows", async () => {
    const shell = fakeShell(
      [
        "printf 'Welcome to your shell\\nlast login: today'",
        'env -i PATH=/fake/bin:/usr/bin:/bin HOME=/home/fake /bin/sh -c "$2"',
        "printf 'bye'",
      ].join("\n"),
    );
    const env = await captureLoginEnv(5_000, shell);
    expect(env.PATH).toBe("/fake/bin:/usr/bin:/bin");
    expect(env.HOME).toBe("/home/fake");
  });

  it("gives agents the login shell's PATH through $SHELL even when an rc file prints a banner first", async () => {
    // What the app calls: `loginEnv`, with the user's $SHELL. The banner has
    // no trailing newline, so without the sentinels it is glued onto the first
    // record (PATH) and the capture falls back to the Dock's environment.
    vi.stubEnv(
      "SHELL",
      fakeShell(
        [
          "printf 'Welcome to your shell\\nlast login: today'",
          'env -i PATH=/fake/bin:/usr/bin:/bin HOME=/home/fake /bin/sh -c "$2"',
          "printf 'bye'",
        ].join("\n"),
      ),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const env = await loginEnv({ force: true, timeoutMs: 5_000 });
      expect(env.PATH).toBe("/fake/bin:/usr/bin:/bin");
      expect(env.HOME).toBe("/home/fake");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("falls back to process.env with a warning when the shell is too slow", async () => {
    const shell = fakeShell("sleep 5");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = await loginEnv({ force: true, timeoutMs: 200, shell });
    expect(env.PATH).toBe(processEnv().PATH);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/login shell.*process environment/i));
  });
});

describe("the login shell's output", () => {
  it("reads only between the sentinels", () => {
    const output = `motd\nno newline${"\n"}${ENV_BEGIN}\nPATH=/a:/b\0HOME=/h\0${"\n"}${ENV_END}\ngoodbye`;
    expect(parseLoginOutput(output)).toEqual({ PATH: "/a:/b", HOME: "/h" });
  });

  it("reads plain env output between the sentinels", () => {
    expect(parseLoginOutput(`noise${"\n"}${ENV_BEGIN}\nPATH=/a\nHOME=/h\n${"\n"}${ENV_END}\n`)).toEqual({
      PATH: "/a",
      HOME: "/h",
    });
  });
});
