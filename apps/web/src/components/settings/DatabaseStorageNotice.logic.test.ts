import { describe, expect, it } from "vite-plus/test";
import { isDatabaseNoticeDismissed } from "./DatabaseStorageNotice.logic";

const GiB = 1024 ** 3;

describe("isDatabaseNoticeDismissed", () => {
  it.each([
    ["never dismissed", {}, 2 * GiB, false],
    ["dismissed at this amount", { env: 2 * GiB }, 2 * GiB, true],
    ["grown by less than 1 GiB", { env: 2 * GiB }, 2.9 * GiB, true],
    ["grown by another 1 GiB", { env: 2 * GiB }, 3 * GiB, false],
  ])("%s", (_name, dismissed: Record<string, number>, reclaimableBytes, expected) => {
    expect(isDatabaseNoticeDismissed(dismissed, "env", reclaimableBytes)).toBe(expected);
  });
});
