import { DatabaseSync, type StatementSync } from "node:sqlite";

export class Database {
  private readonly db: DatabaseSync;

  constructor(location: string) {
    this.db = new DatabaseSync(location);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  query(sql: string): StatementSync {
    return this.db.prepare(sql);
  }

  transaction<T extends unknown[], R>(fn: (...args: T) => R): (...args: T) => R {
    return (...args: T) => {
      this.db.exec("BEGIN");
      try {
        const result = fn(...args);
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}
