import { randomUUID } from "node:crypto";
import type { AccountSummary, SessionStatus } from "../shared/types";
import { AuthService } from "./auth";
import { BookingExecutor } from "./booking";
import { adoptOrphanPlans, deleteAccount, getAccount, listAccounts } from "./db";
import { listPlanItems } from "./plans";
import { Scheduler } from "./scheduler";

export type AccountContext = {
  id: string;
  auth: AuthService;
  booking: BookingExecutor;
  scheduler: Scheduler;
};

type LoginResult = { success: boolean; message: string; accountId?: string; session?: SessionStatus };

/**
 * 多账户运行时：每个已保存的账户拥有独立的 Cookie、调度器、预锁状态与任务锁，
 * 20:00 抢座和签到轮询在各账户间并行执行。
 *
 * 登录（密码或扫码）总是先在临时 AuthService 中进行，成功后再落库：
 *  - 同一 UID / 学号已存在 → 合并到原账户（视为重新登录）
 *  - 否则新建账户并立即启动它的调度器
 */
export class AccountManager {
  private readonly contexts = new Map<string, AccountContext>();
  private readonly qrOwners = new Map<string, AuthService>();
  /** 临时登录 id → 最终账户 id（扫码状态会被多次轮询，需要幂等）。 */
  private readonly committed = new Map<string, string>();
  private started = false;

  constructor() {
    for (const row of listAccounts()) this.attach(new AuthService(row.id));
  }

  private attach(auth: AuthService): AccountContext {
    const booking = new BookingExecutor(auth.client, undefined, auth.accountId);
    const context: AccountContext = { id: auth.accountId, auth, booking, scheduler: new Scheduler(auth, booking) };
    this.contexts.set(context.id, context);
    if (this.started) context.scheduler.start();
    return context;
  }

  start(): void {
    this.started = true;
    for (const context of this.contexts.values()) {
      context.scheduler.start();
      void context.auth.restore();
    }
  }

  get(id?: string | null): AccountContext | undefined {
    if (id && this.contexts.has(id)) return this.contexts.get(id);
    // 未指定账户（旧版前端或首次打开）时回退到第一个账户。
    if (!id) return this.contexts.values().next().value;
    return undefined;
  }

  all(): AccountContext[] { return [...this.contexts.values()]; }

  summaries(): AccountSummary[] {
    return this.all().map(({ id, auth, scheduler }) => {
      const row = getAccount(id);
      const enabled = listPlanItems(id).find((item) => item.enabled);
      const status = scheduler.status();
      return {
        id,
        uid: auth.client.uid || undefined,
        name: auth.client.name || row?.name || undefined,
        studentId: row?.studentId || undefined,
        authenticated: auth.authenticated,
        state: status.state,
        lastMessage: status.lastMessage,
        autoCheckIn: Boolean(row?.autoCheckIn),
        enabledPlan: enabled ? (enabled.kind === "group" ? enabled.name : `${enabled.floorName || ""} ${enabled.seatNum}`.trim()) : undefined,
      };
    });
  }

  private commit(auth: AuthService): string {
    const known = this.committed.get(auth.accountId);
    if (known) return known;
    if (this.contexts.get(auth.accountId)?.auth === auth) return auth.accountId;

    const duplicate = this.all().find((context) =>
      (auth.client.uid && context.auth.client.uid === auth.client.uid) ||
      (auth.studentId && context.auth.studentId === auth.studentId) ||
      (auth.client.uid && getAccount(context.id)?.uid === auth.client.uid));
    let id: string;
    if (duplicate) {
      duplicate.auth.adopt(auth);
      deleteAccount(auth.accountId);
      id = duplicate.id;
    } else {
      if (this.contexts.size === 0) adoptOrphanPlans(auth.accountId);
      this.attach(auth);
      id = auth.accountId;
    }
    this.committed.set(auth.accountId, id);
    return id;
  }

  async login(studentId: string, password: string): Promise<LoginResult> {
    const auth = new AuthService(`acc-${randomUUID()}`);
    const result = await auth.login(studentId, password);
    if (!result.success) return result;
    const accountId = this.commit(auth);
    return { ...result, accountId, session: this.get(accountId)?.auth.status() };
  }

  async createQrLogin() {
    const auth = new AuthService(`acc-${randomUUID()}`);
    const result = await auth.createQrLogin();
    this.qrOwners.set(result.uuid, auth);
    if (this.qrOwners.size > 50) {
      const oldest = this.qrOwners.keys().next().value;
      if (oldest) this.qrOwners.delete(oldest);
    }
    return result;
  }

  pollQrLogin(uuid: string) {
    const auth = this.qrOwners.get(uuid);
    if (!auth) return { status: "error" as const, message: "二维码已失效，请刷新", ttlSeconds: 90 };
    const result = auth.pollQrLogin(uuid);
    if (result.status !== "confirmed") return result;
    const accountId = this.commit(auth);
    return { ...result, session: this.get(accountId)?.auth.status() };
  }

  remove(id: string): boolean {
    const context = this.contexts.get(id);
    if (!context) return false;
    context.scheduler.stop();
    this.contexts.delete(id);
    deleteAccount(id);
    return true;
  }
}
