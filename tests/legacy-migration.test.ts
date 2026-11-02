import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";

const home = join(mkdtempSync(join(tmpdir(), "hdu-sniper-legacy-")), "home");
process.env.HDU_SNIPER_HOME = home;
mkdirSync(join(home, "data"), { recursive: true });
const legacy = new DatabaseSync(join(home, "data", "hdu-sniper.sqlite"));
legacy.exec(`
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE session (id INTEGER PRIMARY KEY CHECK (id = 1), uid TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
    student_id TEXT NOT NULL DEFAULT '', password TEXT NOT NULL DEFAULT '', cookies TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL);
  CREATE TABLE plans (id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'single', name TEXT, room_type TEXT NOT NULL, room_query TEXT NOT NULL,
    floor_id INTEGER NOT NULL, floor_name TEXT NOT NULL DEFAULT '', seat_num TEXT NOT NULL, fallback_seats TEXT NOT NULL DEFAULT '[]',
    start_hour INTEGER NOT NULL, duration_hours INTEGER NOT NULL, weekdays TEXT NOT NULL DEFAULT '[1,2,3,4,5,6,7]',
    enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  INSERT INTO session VALUES (1, '42', '老用户', 'stu42', 'pw', '[]', 'now');
  INSERT INTO meta VALUES ('auto_checkin_enabled', '1');
  INSERT INTO plans (id, room_type, room_query, floor_id, seat_num, start_hour, duration_hours, created_at, updated_at)
    VALUES ('old-plan', '自习室', 'q', 3, '101', 8, 4, 'now', 'now');
`);
legacy.close();

describe("legacy single-account migration", () => {
  test("turns the old session into the default account and keeps its plans", async () => {
    const { listAccounts, LEGACY_ACCOUNT_ID } = await import("../src/server/db");
    const { listPlanItems } = await import("../src/server/plans");
    const accounts = listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: LEGACY_ACCOUNT_ID, uid: "42", studentId: "stu42", autoCheckIn: true });
    expect(listPlanItems(LEGACY_ACCOUNT_ID).map((plan) => plan.id)).toEqual(["old-plan"]);
  });
});
