import { describe, expect, it } from "vitest";

import { appVersion, releaseVersion } from "../../../scripts/app-version.mjs";

describe("the release version", () => {
  it("is the checkout's VERSION", () => {
    expect(releaseVersion()).toBe(appVersion());
    expect(appVersion()).not.toBe("0.0.0");
  });

  it("refuses the 0.0.0 stand-in a missing VERSION file answers, so packaging cannot ship it", () => {
    expect(() => releaseVersion("0.0.0")).toThrow(/no release version/);
    expect(releaseVersion("1.2.3")).toBe("1.2.3");
  });
});
