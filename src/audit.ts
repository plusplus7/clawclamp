import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AuditEntry } from "./types.js";
import { withStateFileLock } from "./storage.js";

const AUDIT_FILE = "audit.jsonl";
const AUDIT_ROTATE_MAX_LINES = 5000;
const AUDIT_ROTATE_KEEP_LINES = 2500;

function resolveAuditPath(stateDir: string): string {
  return path.join(stateDir, "clawclamp", AUDIT_FILE);
}

function resolveAuditArchivePath(stateDir: string, timestamp: string): string {
  return path.join(stateDir, "clawclamp", `audit-${timestamp}.jsonl`);
}

export function createAuditEntryId(): string {
  return randomUUID();
}

export async function appendAuditEntry(stateDir: string, entry: AuditEntry): Promise<void> {
  await withStateFileLock(stateDir, "audit", async () => {
    const filePath = resolveAuditPath(stateDir);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    await rotateAuditLogIfNeeded(stateDir, filePath);
  });
}

async function rotateAuditLogIfNeeded(stateDir: string, filePath: string): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length <= AUDIT_ROTATE_MAX_LINES) {
    return;
  }
  const cutoff = Math.max(0, lines.length - AUDIT_ROTATE_KEEP_LINES);
  const archived = lines.slice(0, cutoff);
  const current = lines.slice(cutoff);
  const archivePath = resolveAuditArchivePath(stateDir, new Date().toISOString().replace(/[:.]/g, "-"));
  await fs.writeFile(archivePath, `${archived.join("\n")}\n`, "utf8");
  await fs.writeFile(filePath, current.length ? `${current.join("\n")}\n` : "", "utf8");
}

export async function readAuditEntries(
  stateDir: string,
  page: number,
  pageSize: number,
): Promise<{ entries: AuditEntry[]; total: number; page: number }> {
  return withStateFileLock(stateDir, "audit", async () => {
    const filePath = resolveAuditPath(stateDir);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT") {
        return { entries: [], total: 0, page: 1 };
      }
      throw error;
    }

    const lines = raw.trim().split("\n").filter(Boolean);
    const total = lines.length;
    const safePageSize = Math.max(1, pageSize);
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const start = Math.max(0, total - safePage * safePageSize);
    const end = total - (safePage - 1) * safePageSize;
    const recent = lines.slice(start, end);
    const entries: AuditEntry[] = [];
    for (const line of recent) {
      try {
        const parsed = JSON.parse(line) as AuditEntry;
        if (parsed && typeof parsed === "object") {
          entries.push(parsed);
        }
      } catch {
        // Ignore malformed lines.
      }
    }
    return { entries, total, page: safePage };
  });
}
