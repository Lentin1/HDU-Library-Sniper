import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

process.env.HDU_SNIPER_HOME = join(mkdtempSync(join(tmpdir(), "hdu-sniper-lock-")), "home");

describe("per-account job lock", () => {
  test("different accounts can hold the booking lock at the same time", async () => {
    const { tryAcquireJobLock } = await import("../src/server/lock");
    const a = tryAcquireJobLock("booking", "acc-a");
    const b = tryAcquireJobLock("booking", "acc-b");
    expect(a).toBeTypeOf("function");
    expect(b).toBeTypeOf("function");
    expect(tryAcquireJobLock("check-in", "acc-a")).toBeUndefined();
    a!(); b!();
    expect(tryAcquireJobLock("booking", "acc-a")).toBeTypeOf("function");
  });
});
