import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

let home: string;
let closeDb: (() => void) | undefined;

beforeAll(() => {
  home = join(mkdtempSync(join(tmpdir(), "hdu-sniper-test-")), "home");
  process.env.HDU_SNIPER_HOME = home;
});

afterAll(() => {
  closeDb?.();
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

describe("account credential persistence", () => {
  test("loads stored credentials for an account", async () => {
    const { db, upsertAccountLogin } = await import("../src/server/db");
    closeDb = () => db.close();
    const columns = db.query("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["student_id", "password", "cookies"]));

    const { AuthService } = await import("../src/server/auth");
    upsertAccountLogin("a1", { uid: "123", name: "测试", studentId: "stu001", password: "secret", cookies: "[]" });
    const auth = new AuthService("a1");
    expect((auth as unknown as { credentials?: { studentId: string; password: string } }).credentials).toEqual({
      studentId: "stu001",
      password: "secret",
    });
    expect(auth.status()).toMatchObject({ authenticated: true, accountId: "a1", uid: "123" });
  });

  test("logout clears session but keeps credentials", async () => {
    const { getAccount, upsertAccountLogin } = await import("../src/server/db");
    const { AuthService } = await import("../src/server/auth");
    upsertAccountLogin("a2", { uid: "456", name: "张三", studentId: "stu002", password: "secret2", cookies: "[]" });
    const auth = new AuthService("a2");

    auth.logout();

    expect(auth.status()).toEqual({ authenticated: false, accountId: "a2", refreshing: false });
    const row = getAccount("a2")!;
    expect(row.uid).toBe("");
    expect(row.name).toBe("");
    expect(JSON.parse(row.cookies)).toEqual([]);
    expect(row.studentId).toBe("stu002");
    expect(row.password).toBe("secret2");
    // 其它账户不受影响
    expect(getAccount("a1")?.uid).toBe("123");
  });

  test("plans and enable state are isolated per account", async () => {
    const { createPlan, enablePlanItem, listPlanItems } = await import("../src/server/plans");
    const base = { roomType: "自习室", roomQuery: "q", floorId: 3, seatNum: "101", fallbackSeats: [], startHour: 8, durationHours: 4, weekdays: [1, 2, 3, 4, 5, 6, 7] as Array<1 | 2 | 3 | 4 | 5 | 6 | 7> };
    const p1 = createPlan("a1", base);
    const p2 = createPlan("a2", { ...base, seatNum: "202" });
    enablePlanItem("a1", p1.id, true);
    enablePlanItem("a2", p2.id, true);
    expect(listPlanItems("a1").map((item) => item.id)).toEqual([p1.id]);
    expect(listPlanItems("a2").map((item) => item.id)).toEqual([p2.id]);
    // 启用 a2 的方案不会关闭 a1 的方案
    expect(listPlanItems("a1")[0]!.enabled).toBe(true);
    expect(() => enablePlanItem("a2", p1.id, true)).toThrow("方案不存在");
  });
});
