/**
 * A branch prefix git refuses, stored before the check existed, reads as the
 * default (`SettingsSchema`). That fallback is said once in main's log, stays
 * stored until a prefix is set — a write of some other setting does not
 * replace it behind the person's back — and `settings.fallbacks` names it so
 * the Git page can say so.
 */
import { afterEach, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => new Map<string, string>());
vi.mock("@main/db/index", () => ({
  db: () => ({
    prepare: () => ({
      all: () => [...rows].map(([key, value]) => ({ key, value })),
      run: (key: string, value: string) => void rows.set(key, value),
    }),
    transaction: (write: () => void) => write,
  }),
}));

import { settings } from "@main/db/repositories";

afterEach(() => {
  rows.clear();
  vi.restoreAllMocks();
});

it("reads a refused stored prefix as the default, logs it once, and keeps it until a prefix is set", () => {
  rows.set("branchPrefix", JSON.stringify("a b/"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  expect(settings.get().branchPrefix).toBe("text-to-cad/");
  settings.get();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]!.join(" ")).toContain("“a b/”");
  expect(settings.fallbacks()).toEqual({ branchPrefix: "a b/" });

  settings.set({ theme: "dark" });
  expect(settings.fallbacks()).toEqual({ branchPrefix: "a b/" });

  settings.set({ branchPrefix: "me/" });
  expect(settings.fallbacks()).toEqual({});
  expect(settings.get().branchPrefix).toBe("me/");
});
