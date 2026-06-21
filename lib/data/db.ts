import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const dbPath = path.join(process.cwd(), "data", "chargebi.sqlite");

export function getDb() {
  if (!fs.existsSync(dbPath)) {
    throw new Error("ChargeBI database is missing. Run `npm run db:generate` first.");
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

export function all<T extends Record<string, unknown>>(sql: string, params: string[] | number[] = []): T[] {
  const db = getDb();
  try {
    const stmt = db.prepare(sql);
    return stmt.all(...params) as T[];
  } finally {
    db.close();
  }
}

export function get<T extends Record<string, unknown>>(sql: string, params: string[] | number[] = []): T | undefined {
  const db = getDb();
  try {
    const stmt = db.prepare(sql);
    return stmt.get(...params) as T | undefined;
  } finally {
    db.close();
  }
}
