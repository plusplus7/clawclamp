import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk";
import type { ClawClampConfig } from "./types.js";
import { withStateFileLock } from "./storage.js";
import { buildDefaultPolicyStore } from "./policy.js";

const POLICY_FILE = "policy-store.json";

export type PolicyEntry = { id: string; content: string };

type PolicyRecord = {
  cedar_version?: string;
  name?: string;
  description?: string;
  policy_content: string;
};

type PolicyStoreBody = {
  name?: string;
  description?: string;
  schema?: EncodedContent;
  trusted_issuers?: Record<string, unknown>;
  policies?: Record<string, PolicyRecord>;
};

type EncodedContent = {
  encoding?: "none" | "base64";
  content_type?: "cedar" | "cedar-json";
  body?: string;
};

export type PolicyStoreSnapshot = {
  cedar_version: string;
  policy_stores: Record<string, PolicyStoreBody>;
};

const POLICY_STORE_ID = "clawclamp";

function resolvePolicyPath(stateDir: string): string {
  return path.join(stateDir, "clawclamp", POLICY_FILE);
}

function decodeBase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

function encodeBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
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
  const existing = store.policy_stores?.[POLICY_STORE_ID];
  if (existing) {
    return existing;
  }
  const fallback = buildDefaultPolicyStore() as PolicyStoreSnapshot;
  const created = fallback.policy_stores[POLICY_STORE_ID] ?? {
    policies: {},
    schema: undefined,
    trusted_issuers: {},
  };
  if (!store.policy_stores) {
    store.policy_stores = {};
  }
  store.policy_stores[POLICY_STORE_ID] = created;
  return created;
}

export async function ensurePolicyStore(params: {
  stateDir: string;
  config: ClawClampConfig;
}): Promise<{ json: string; readOnly: boolean } | { json?: undefined; readOnly: true }> {
  if (params.config.policyStoreUri) {
    return { readOnly: true };
  }
  return withStateFileLock(params.stateDir, "policy-store", async () => {
    const filePath = resolvePolicyPath(params.stateDir);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return { json: raw, readOnly: false };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }

    const initial = params.config.policyStoreLocal
      ? (JSON.parse(params.config.policyStoreLocal) as PolicyStoreSnapshot)
      : (buildDefaultPolicyStore() as PolicyStoreSnapshot);
    await writePolicyStore(params.stateDir, initial);
    return { json: JSON.stringify(initial), readOnly: false };
  });
}

export async function listPolicies(params: {
  stateDir: string;
}): Promise<{ policies: PolicyEntry[] }> {
  return withStateFileLock(params.stateDir, "policy-store", async () => {
    const store = await readPolicyStore(params.stateDir);
    const policyStore = getWritableStore(store);
    const policies: PolicyEntry[] = Object.entries(policyStore.policies ?? {}).map(([id, payload]) => ({
      id,
      content: decodeBase64(payload.policy_content ?? ""),
    }));
    return { policies };
  });
}

export async function createPolicy(params: {
  stateDir: string;
  id?: string;
  content: string;
}): Promise<PolicyEntry> {
  return withStateFileLock(params.stateDir, "policy-store", async () => {
    const store = await readPolicyStore(params.stateDir);
    const policyStore = getWritableStore(store);
    const id = params.id?.trim() || `clawclamp-${randomUUID()}`;
    if (!policyStore.policies) {
      policyStore.policies = {};
    }
    if (policyStore.policies[id]) {
      throw new Error("policy id already exists");
    }
    policyStore.policies[id] = {
      ...normalizePolicyRecord(
        id,
        { policy_content: encodeBase64(params.content) },
        store.cedar_version,
        "Created from Clawclamp UI.",
      ),
    };
    await writePolicyStore(params.stateDir, store);
    return { id, content: params.content };
  });
}

export async function updatePolicy(params: {
  stateDir: string;
  id: string;
  content: string;
}): Promise<PolicyEntry> {
  return withStateFileLock(params.stateDir, "policy-store", async () => {
    const store = await readPolicyStore(params.stateDir);
    const policyStore = getWritableStore(store);
    if (!policyStore.policies?.[params.id]) {
      throw new Error("policy id not found");
    }
    policyStore.policies[params.id] = {
      ...normalizePolicyRecord(
        params.id,
        { policy_content: encodeBase64(params.content) },
        store.cedar_version,
        "Updated from Clawclamp UI.",
      ),
    };
    await writePolicyStore(params.stateDir, store);
    return { id: params.id, content: params.content };
  });
}

export async function deletePolicy(params: { stateDir: string; id: string }): Promise<boolean> {
  return withStateFileLock(params.stateDir, "policy-store", async () => {
    const store = await readPolicyStore(params.stateDir);
    const policyStore = getWritableStore(store);
    if (!policyStore.policies?.[params.id]) {
      return false;
    }
    delete policyStore.policies[params.id];
    await writePolicyStore(params.stateDir, store);
    return true;
  });
}
