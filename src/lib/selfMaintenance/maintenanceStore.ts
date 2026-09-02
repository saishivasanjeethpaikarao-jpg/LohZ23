import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runtimeDataRoot } from "../runtimePaths";
import type { MaintenanceRecord } from "./types";

export interface MaintenanceHistoryStore { append(record: MaintenanceRecord): Promise<boolean>; list(ownerUid: string): Promise<MaintenanceRecord[]>; }
export class LocalMaintenanceHistoryStore implements MaintenanceHistoryStore {
  constructor(private readonly root = runtimeDataRoot("phase48-maintenance")) { fs.mkdirSync(root, { recursive: true }); }
  private file(uid: string): string { if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(uid)) throw new Error("invalid maintenance owner"); return path.join(this.root, `${Buffer.from(uid).toString("base64url")}.json`); }
  async append(record: MaintenanceRecord): Promise<boolean> { const file = this.file(record.ownerUid); const values = await this.list(record.ownerUid); if (values.some((item) => item.recordId === record.recordId)) return false; fs.writeFileSync(file, JSON.stringify([...values, structuredClone(record)].slice(-200))); return true; }
  async list(ownerUid: string): Promise<MaintenanceRecord[]> { const file = this.file(ownerUid); if (!fs.existsSync(file)) return []; try { const value = JSON.parse(fs.readFileSync(file, "utf8")); return Array.isArray(value) ? value.filter((item) => item?.ownerUid === ownerUid).map((item) => structuredClone(item)) : []; } catch { return []; } }
}
export function newMaintenanceRecord(ownerUid: string, diagnosis: MaintenanceRecord["diagnosis"], now = Date.now()): MaintenanceRecord { return { recordId: randomUUID(), ownerUid, incidentId: diagnosis.incidentId, diagnosis, affectedFiles: [], validation: [], approval: "PROPOSED", outcome: "open", createdAt: now, updatedAt: now }; }
