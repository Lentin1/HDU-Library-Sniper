import { Database } from "bun:sqlite";
import type { BookingPlan, Weekday } from "../shared/types";
import { databasePath } from "./config";

export const db = new Database(databasePath, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'single',
    name TEXT,
    room_type TEXT NOT NULL,
    room_query TEXT NOT NULL,
    floor_id INTEGER NOT NULL,
    floor_name TEXT NOT NULL DEFAULT '',
    seat_num TEXT NOT NULL,
    fallback_seats TEXT NOT NULL DEFAULT '[]',
    start_hour INTEGER NOT NULL,
    duration_hours INTEGER NOT NULL,
    weekdays TEXT NOT NULL DEFAULT '[1,2,3,4,5,6,7]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    uid TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    student_id TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL DEFAULT '',
    cookies TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    uid TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    student_id TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL DEFAULT '',
    cookies TEXT NOT NULL DEFAULT '[]',
    auto_checkin INTEGER NOT NULL DEFAULT 0,
    checkin_consented_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (group_id, plan_id),
    FOREIGN KEY (group_id) REFERENCES plans(id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
  );
`);
for (const statement of [
  "ALTER TABLE plans ADD COLUMN kind TEXT NOT NULL DEFAULT 'single'",
  "ALTER TABLE plans ADD COLUMN name TEXT",
  "ALTER TABLE session ADD COLUMN student_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE session ADD COLUMN password TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE plans ADD COLUMN account_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE audit ADD COLUMN account_id TEXT NOT NULL DEFAULT ''",
]) {
  try { db.exec(statement); } catch { /* column already exists */ }
}

// ---------------------------------------------------------------------------
// 多账户：每个图书馆账户一行，方案/审计按 account_id 归属。
// ---------------------------------------------------------------------------

export const LEGACY_ACCOUNT_ID = "default";

export type AccountRow = {
  id: string;
  uid: string;
  name: string;
  studentId: string;
  password: string;
  cookies: string;
  autoCheckIn: boolean;
  checkInConsentedAt?: string;
  createdAt: string;
  updatedAt: string;
};

const rowToAccount = (row: Record<string, unknown>): AccountRow => ({
  id: String(row.id),
  uid: String(row.uid || ""),
  name: String(row.name || ""),
  studentId: String(row.student_id || ""),
  password: String(row.password || ""),
  cookies: String(row.cookies || "[]"),
  autoCheckIn: Number(row.auto_checkin || 0) === 1,
  checkInConsentedAt: row.checkin_consented_at ? String(row.checkin_consented_at) : undefined,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

// 旧版单账户数据（session 表 + meta 里的自动签到开关）迁移为 id=default 的账户。
function migrateLegacySession(): void {
  const count = (db.query("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n;
  if (count > 0) return;
  const legacy = db.query("SELECT * FROM session WHERE id = 1").get() as Record<string, unknown> | null;
  if (!legacy || !(legacy.uid || legacy.student_id)) return;
  const now = new Date().toISOString();
  const meta = (key: string) => (db.query("SELECT value FROM meta WHERE key = ?1").get(key) as { value?: string } | null)?.value;
  db.query(`INSERT INTO accounts(id,uid,name,student_id,password,cookies,auto_checkin,checkin_consented_at,created_at,updated_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`).run(
    LEGACY_ACCOUNT_ID,
    String(legacy.uid || ""), String(legacy.name || ""), String(legacy.student_id || ""), String(legacy.password || ""),
    String(legacy.cookies || "[]"), meta("auto_checkin_enabled") === "1" ? 1 : 0, meta("auto_checkin_consented_at") || null,
    now, now,
  );
  db.query("UPDATE plans SET account_id = ?1 WHERE account_id = ''").run(LEGACY_ACCOUNT_ID);
  db.query("UPDATE audit SET account_id = ?1 WHERE account_id = ''").run(LEGACY_ACCOUNT_ID);
}
migrateLegacySession();

export function listAccounts(): AccountRow[] {
  return db.query("SELECT * FROM accounts ORDER BY created_at ASC").all().map((row) => rowToAccount(row as Record<string, unknown>));
}

export function getAccount(id: string): AccountRow | undefined {
  const row = db.query("SELECT * FROM accounts WHERE id = ?1").get(id);
  return row ? rowToAccount(row as Record<string, unknown>) : undefined;
}

/** 写入登录结果；账户不存在时创建。 */
export function upsertAccountLogin(id: string, values: { uid: string; name: string; studentId: string; password: string; cookies: string }): void {
  const now = new Date().toISOString();
  db.query(`INSERT INTO accounts(id,uid,name,student_id,password,cookies,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7)
    ON CONFLICT(id) DO UPDATE SET uid=excluded.uid,name=excluded.name,student_id=excluded.student_id,
    password=excluded.password,cookies=excluded.cookies,updated_at=excluded.updated_at`)
    .run(id, values.uid, values.name, values.studentId, values.password, values.cookies, now);
}

/** 仅更新已存在账户的 Cookie（未完成登录的临时账户不落库）。 */
export function updateAccountCookies(id: string, cookies: string): void {
  db.query("UPDATE accounts SET cookies = ?2, updated_at = ?3 WHERE id = ?1").run(id, cookies, new Date().toISOString());
}

export function clearAccountSession(id: string): void {
  db.query("UPDATE accounts SET uid = '', name = '', cookies = '[]', updated_at = ?2 WHERE id = ?1").run(id, new Date().toISOString());
}

export function setAccountAutoCheckIn(id: string, enabled: boolean, consentedAt?: string): void {
  db.query("UPDATE accounts SET auto_checkin = ?2, checkin_consented_at = COALESCE(?3, checkin_consented_at), updated_at = ?4 WHERE id = ?1")
    .run(id, enabled ? 1 : 0, consentedAt || null, new Date().toISOString());
}

/** 新建第一个账户时，把旧版本遗留的无主方案归给它。 */
export function adoptOrphanPlans(accountId: string): void {
  db.query("UPDATE plans SET account_id = ?1 WHERE account_id = ''").run(accountId);
}

export function deleteAccount(id: string): void {
  const transaction = db.transaction(() => {
    db.query("DELETE FROM plans WHERE account_id = ?1 AND kind = 'group'").run(id);
    db.query("DELETE FROM plans WHERE account_id = ?1").run(id);
    db.query("DELETE FROM accounts WHERE id = ?1").run(id);
  });
  transaction();
}

const rowToPlan = (row: Record<string, unknown>): BookingPlan => ({
  id: String(row.id),
  kind: "single",
  roomType: String(row.room_type),
  roomQuery: String(row.room_query),
  floorId: Number(row.floor_id),
  floorName: String(row.floor_name || ""),
  seatNum: String(row.seat_num),
  fallbackSeats: JSON.parse(String(row.fallback_seats || "[]")),
  startHour: Number(row.start_hour),
  durationHours: Number(row.duration_hours),
  weekdays: JSON.parse(String(row.weekdays || "[1,2,3,4,5,6,7]")) as Weekday[],
  enabled: Boolean(row.enabled),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

export function listPlans(accountId: string): BookingPlan[] {
  return db.query("SELECT * FROM plans WHERE kind = 'single' AND account_id = ?1 ORDER BY created_at ASC").all(accountId).map((row) => rowToPlan(row as Record<string, unknown>));
}

export function getPlan(accountId: string, id: string): BookingPlan | undefined {
  const row = db.query("SELECT * FROM plans WHERE id = ?1 AND kind = 'single' AND account_id = ?2").get(id, accountId);
  return row ? rowToPlan(row as Record<string, unknown>) : undefined;
}

export function savePlan(accountId: string, plan: BookingPlan): BookingPlan {
  const owner = db.query("SELECT account_id FROM plans WHERE id = ?1").get(plan.id) as { account_id?: string } | null;
  if (owner && owner.account_id !== accountId) throw new Error("方案不存在");
  db.query(`
    INSERT INTO plans (id, kind, room_type, room_query, floor_id, floor_name, seat_num, fallback_seats,
      start_hour, duration_hours, weekdays, enabled, created_at, updated_at, account_id)
    VALUES (?1, 'single', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
    ON CONFLICT(id) DO UPDATE SET kind='single', room_type=excluded.room_type, room_query=excluded.room_query,
      floor_id=excluded.floor_id, floor_name=excluded.floor_name, seat_num=excluded.seat_num,
      fallback_seats=excluded.fallback_seats, start_hour=excluded.start_hour,
      duration_hours=excluded.duration_hours, weekdays=excluded.weekdays, enabled=excluded.enabled,
      updated_at=excluded.updated_at
  `).run(
    plan.id, plan.roomType, plan.roomQuery, plan.floorId, plan.floorName || "", plan.seatNum,
    JSON.stringify(plan.fallbackSeats), plan.startHour, plan.durationHours,
    JSON.stringify(plan.weekdays), plan.enabled ? 1 : 0, plan.createdAt, plan.updatedAt, accountId,
  );
  return plan;
}

export function listGroups(accountId: string): Array<Record<string, unknown>> {
  return db.query("SELECT * FROM plans WHERE kind = 'group' AND account_id = ?1 ORDER BY created_at ASC").all(accountId) as Array<Record<string, unknown>>;
}

export function getGroupMembers(groupId: string): string[] {
  return (db.query("SELECT plan_id FROM group_members WHERE group_id = ?1 ORDER BY position ASC").all(groupId) as Array<{ plan_id: string }>).map((row) => row.plan_id);
}

export function saveGroup(accountId: string, group: { id: string; name: string; memberPlanIds: string[]; weekdays: Weekday[]; enabled: boolean; createdAt: string; updatedAt: string }): void {
  const transaction = db.transaction(() => {
    const owner = db.query("SELECT account_id FROM plans WHERE id = ?1").get(group.id) as { account_id?: string } | null;
    if (owner && owner.account_id !== accountId) throw new Error("组合方案不存在");
    db.query(`INSERT INTO plans (id, kind, name, room_type, room_query, floor_id, seat_num, start_hour, duration_hours, weekdays, enabled, created_at, updated_at, account_id)
      VALUES (?1, 'group', ?2, '', '', 0, '', 0, 0, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(id) DO UPDATE SET kind='group', name=excluded.name, weekdays=excluded.weekdays,
      enabled=excluded.enabled, updated_at=excluded.updated_at`).run(
      group.id, group.name, JSON.stringify(group.weekdays), group.enabled ? 1 : 0, group.createdAt, group.updatedAt, accountId,
    );
    db.query("DELETE FROM group_members WHERE group_id = ?1").run(group.id);
    group.memberPlanIds.forEach((planId, position) => db.query(
      "INSERT INTO group_members(group_id,plan_id,position) VALUES(?1,?2,?3)",
    ).run(group.id, planId, position));
  });
  transaction();
}

export function deleteGroup(accountId: string, id: string): boolean {
  return db.query("DELETE FROM plans WHERE id = ?1 AND kind = 'group' AND account_id = ?2").run(id, accountId).changes > 0;
}

export function referencedPlanIds(id: string): string[] {
  return (db.query("SELECT group_id FROM group_members WHERE plan_id = ?1").all(id) as Array<{ group_id: string }>).map((row) => row.group_id);
}

// 每个账户同一时间只启用一个方案；不同账户互不影响。
export function setOnlyEnabled(accountId: string, id: string, enabled: boolean): string[] {
  const transaction = db.transaction(() => {
    const disabled = enabled
      ? (db.query("SELECT id FROM plans WHERE enabled = 1 AND id <> ?1 AND account_id = ?2").all(id, accountId) as Array<{ id: string }>).map((row) => row.id)
      : [];
    if (enabled) db.query("UPDATE plans SET enabled = 0 WHERE id <> ?1 AND account_id = ?2").run(id, accountId);
    db.query("UPDATE plans SET enabled = ?1 WHERE id = ?2 AND account_id = ?3").run(enabled ? 1 : 0, id, accountId);
    return disabled;
  });
  return transaction();
}

export function deletePlan(accountId: string, id: string): boolean {
  return db.query("DELETE FROM plans WHERE id = ?1 AND kind = 'single' AND account_id = ?2").run(id, accountId).changes > 0;
}

export function setMeta(key: string, value: string): void {
  db.query("INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

export function getMeta(key: string): string | undefined {
  const row = db.query("SELECT value FROM meta WHERE key = ?1").get(key) as { value?: string } | null;
  return row?.value;
}

export function writeAudit(event: string, payload: Record<string, unknown>, accountId = ""): void {
  db.query("INSERT INTO audit(event,payload,created_at,account_id) VALUES(?1,?2,?3,?4)").run(
    event, JSON.stringify(payload), new Date().toISOString(), accountId,
  );
}

export type AuditRecord = {
  id: number;
  event: string;
  payload: Record<string, unknown>;
  createdAt: string;
  accountId?: string;
  accountName?: string;
};

/** accountId 为空时返回所有账户的事件（用于桌面通知）。 */
export function listAudit(limit = 20, accountId?: string): AuditRecord[] {
  const base = `SELECT audit.id, audit.event, audit.payload, audit.created_at, audit.account_id,
    COALESCE(NULLIF(accounts.name, ''), accounts.student_id, '') AS account_name
    FROM audit LEFT JOIN accounts ON accounts.id = audit.account_id`;
  const rows = (accountId
    ? db.query(`${base} WHERE audit.account_id = ?2 ORDER BY audit.created_at DESC, audit.id DESC LIMIT ?1`).all(limit, accountId)
    : db.query(`${base} ORDER BY audit.created_at DESC, audit.id DESC LIMIT ?1`).all(limit)) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: Number(row.id),
    event: String(row.event),
    payload: JSON.parse(String(row.payload || "{}")) as Record<string, unknown>,
    createdAt: String(row.created_at),
    accountId: String(row.account_id || "") || undefined,
    accountName: String(row.account_name || "") || undefined,
  }));
}
