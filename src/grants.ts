import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk";
import type { ClawClampConfig, GrantRecord } from "./types.js";
import { withStateFileLock } from "./storage.js";
import { buildDefaultPolicyStore } from "./policy.js";

const POLICY_FILE = "policy-store.json";
const POLICY_STORE_ID = "clawclamp";
const GRANT_POLICY_PREFIX = "grant:";

type PolicyRecord = {
  cedar_version?: string;
  name?: string;
  description?: string;
  policy_content: string;
};

type PolicyStoreBody = {
  name?: string;
  description?: string;
  schema?: unknown;
  trusted_issuers?: Record<string, unknown>;
  policies?: Record<string, PolicyRecord>;
};

type PolicyStoreSnapshot = {
  cedar_version: string;
  policy_stores: Record<string, PolicyStoreBody>;
};

function resolvePolicyPath(stateDir: string): string {
  return path.join(stateDir, "clawclamp", POLICY_FILE);
}

function encodeBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function decodeBase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

function normalizePolicyRecord(
  id: string,
  record: PolicyRecord,
  cedarVersion: string,
  fallbackDescription: string,
): PolicyRecord {
  return {
    cedar_version: record.cedar_version ?? cedarVersion,
    name: record.name ?? id,
    description: record.description ?? fallbackDescription,
    policy_content: record.policy_content,
  };
}

async function readPolicyStore(stateDir: string): Promise<PolicyStoreSnapshot> {
  const filePath = resolvePolicyPath(stateDir);
  const { value } = await readJsonFileWithFallback<PolicyStoreSnapshot>(
    filePath,
    buildDefaultPolicyStore() as PolicyStoreSnapshot,
  );
  const policyStore = value.policy_stores?.[POLICY_STORE_ID];
  if (policyStore?.policies) {
    for (const [id, record] of Object.entries(policyStore.policies)) {
      policyStore.policies[id] = normalizePolicyRecord(
        id,
        record,
        value.cedar_version,
        "Managed by Clawclamp.",
      );
    }
  }
  return value;
}

async function writePolicyStore(stateDir: string, store: PolicyStoreSnapshot): Promise<void> {
  const filePath = resolvePolicyPath(stateDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeJsonFileAtomically(filePath, store);
}

function getWritableStore(store: PolicyStoreSnapshot): PolicyStoreBody {
  const current = store.policy_stores?.[POLICY_STORE_ID];
  if (!current) {
    throw new Error("clawclamp policy store not found");
  }
  current.policies ??= {};
  return current;
}

function grantPolicyId(createdAtMs: number): string {
  return `${GRANT_POLICY_PREFIX}${createdAtMs}:${randomUUID()}`;
}

function buildGrantPolicy(toolName: string, expiresAtMs: number): string {
  const toolClause =
    toolName === "*" ? "true" : `resource.name == ${JSON.stringify(toolName)}`;
  return `permit(principal, action, resource)
when {
  action == Action::"Invoke" &&
  context.now < ${expiresAtMs} &&
  ${toolClause}
};`;
}

function parseGrantPolicy(id: string, record: PolicyRecord): GrantRecord | null {
  if (!id.startsWith(GRANT_POLICY_PREFIX)) {
    return null;
  }
  const content = decodeBase64(record.policy_content ?? "");
  const createdAtMatch = /^grant:(\d+):/.exec(id);
  const expiresAtMatch = /context\.now\s*<\s*(\d+)/.exec(content);
  const toolMatch = /resource\.name\s*==\s*"([^"]+)"/.exec(content);
  const createdAtMs = createdAtMatch ? Number(createdAtMatch[1]) : Date.now();
  const expiresAtMs = expiresAtMatch ? Number(expiresAtMatch[1]) : 0;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) {
    return null;
  }
  return {
    id,
    toolName: toolMatch?.[1] ?? "*",
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    note: record.description?.trim() || undefined,
  };
}

function sortNewestFirst(left: GrantRecord, right: GrantRecord): number {
  return Date.parse(right.createdAt) - Date.parse(left.createdAt);
}

function pruneExpiredPolicies(policies: Record<string, PolicyRecord>, nowMs: number): boolean {
  let changed = false;
  for (const [id, record] of Object.entries(policies)) {
    const grant = parseGrantPolicy(id, record);
    if (grant && Date.parse(grant.expiresAt) <= nowMs) {
      delete policies[id];
      changed = true;
    }
  }
  return changed;
}

export async function listGrants(stateDir: string): Promise<GrantRecord[]> {
  return withStateFileLock(stateDir, "policy-store", async () => {
    const store = await readPolicyStore(stateDir);
    const policyStore = getWritableStore(store);
    const nowMs = Date.now();
    const changed = pruneExpiredPolicies(policyStore.policies ?? {}, nowMs);
    if (changed) {
      await writePolicyStore(stateDir, store);
    }
    return Object.entries(policyStore.policies ?? {})
      .map(([id, record]) => parseGrantPolicy(id, record))
      .filter((grant): grant is GrantRecord => Boolean(grant))
      .sort(sortNewestFirst);
  });
}

export async function createGrant(params: {
  stateDir: string;
  config: ClawClampConfig;
  toolName: string;
  ttlSeconds?: number;
  note?: string;
}): Promise<GrantRecord> {
  return withStateFileLock(params.stateDir, "policy-store", async () => {
    const store = await readPolicyStore(params.stateDir);
    const policyStore = getWritableStore(store);
    const nowMs = Date.now();
    const ttlSeconds = Math.min(
      Math.max(60, params.ttlSeconds ?? params.config.grants.defaultTtlSeconds),
      params.config.grants.maxTtlSeconds,
    );
    const expiresAtMs = nowMs + ttlSeconds * 1000;
    const id = grantPolicyId(nowMs);
    policyStore.policies![id] = normalizePolicyRecord(
      id,
      {
        name: `Grant ${params.toolName}`,
        description: params.note?.trim() || "Temporary grant policy.",
        policy_content: encodeBase64(buildGrantPolicy(params.toolName, expiresAtMs)),
      },
      store.cedar_version,
      "Temporary grant policy.",
    );
    await writePolicyStore(params.stateDir, store);
    return {
      id,
      toolName: params.toolName,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      note: params.note?.trim() || undefined,
    };
  });
}

export async function revokeGrant(stateDir: string, grantId: string): Promise<boolean> {
  return withStateFileLock(stateDir, "policy-store", async () => {
    const store = await readPolicyStore(stateDir);
    const policyStore = getWritableStore(store);
    if (!policyStore.policies?.[grantId]) {
      return false;
    }
    delete policyStore.policies[grantId];
    await writePolicyStore(stateDir, store);
    return true;
  });
}
