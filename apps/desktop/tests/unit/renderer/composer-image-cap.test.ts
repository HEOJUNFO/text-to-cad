import { toast } from "sonner";
import { beforeEach, expect, it, vi } from "vitest";

import { toPromptBlocks } from "@renderer/features/session/Composer";
import { screenAttachments } from "@renderer/features/session/composer/attachments";
import { MAX_IMAGE_BYTES } from "@shared/image-cap";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn(), info: vi.fn() } }));
const shrink = vi.hoisted(() => vi.fn());
vi.mock("@renderer/lib/shrink-image", () => ({ shrinkImage: shrink }));

const big = () => new File([new Uint8Array(10 * 1024 * 1024)], "photo.png", { type: "image/png" });

beforeEach(() => { shrink.mockReset(); vi.mocked(toast.error).mockClear(); });

it("an attached image over the model's cap that cannot be shrunk is refused, not attached", async () => {
  shrink.mockResolvedValue(null);
  const result = await screenAttachments([big()], null);
  expect(result.attach).toEqual([]);
  expect(result.refusals).toHaveLength(1);
  expect(result.refusals[0]).toMatch(/photo\.png is larger than the model takes/);
});

it("an attached image over the cap is redrawn under it", async () => {
  shrink.mockResolvedValue(new Blob([new Uint8Array(1024)], { type: "image/png" }));
  const result = await screenAttachments([big()], null);
  expect(result.refusals).toEqual([]);
  expect(result.attach).toHaveLength(1);
  expect(result.attach[0]!.size).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
});

it("an image at the cap goes through untouched", async () => {
  const file = new File([new Uint8Array(MAX_IMAGE_BYTES)], "ok.png", { type: "image/png" });
  const result = await screenAttachments([file], null);
  expect(result.attach).toEqual([file]);
  expect(shrink).not.toHaveBeenCalled();
});

it("the send backstop never builds an image block over 5 MiB of base64", async () => {
  const base64 = "A".repeat(6 * 1024 * 1024);
  const blocks = await toPromptBlocks("", [{ type: "file", mediaType: "image/png", filename: "huge.png", url: `data:image/png;base64,${base64}` }]);
  expect(blocks).toEqual([]);
  expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/huge\.png is larger than the model takes/));
});
