import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk";
import type { ClawClampConfig, ClawClampMode, RiskLevel } from "./types.js";

const DEFAULT_RISK_OVERRIDES: Record<string, RiskLevel> = {
  read: "low",
  memory_get: "low",
  memory_search: "low",
  sessions_list: "low",
  sessions_history: "low",
  session_status: "low",
  agents_list: "low",
  web_search: "medium",
  web_fetch: "medium",
  image: "medium",
  tts: "medium",
  canvas: "medium",
  browser: "high",
  write: "high",
  edit: "high",
  apply_patch: "high",
  exec: "high",
  process: "high",
  message: "high",
  cron: "high",
  gateway: "high",
  nodes: "high",
  sessions_send: "high",
  sessions_spawn: "high",
  subagents: "high",
};

export const DEFAULT_CLAWCLAMP_CONFIG: ClawClampConfig = {
  enabled: true,
  mode: "gray",
  principalId: "openclaw",
  policyFailOpen: false,
  risk: {
    default: "high",
    overrides: DEFAULT_RISK_OVERRIDES,
  },
  grants: {
    defaultTtlSeconds: 900,
    maxTtlSeconds: 3600,
  },
  audit: {
    maxEntries: 500,
    includeParams: true,
    maxParamLength: 2048,
  },
};

const RISK_LEVELS = ["low", "medium", "high"] as const;

const CEDAR_GUARD_CONFIG_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean", default: DEFAULT_CLAWCLAMP_CONFIG.enabled },
    mode: {
      type: "string",
      enum: ["enforce", "gray"],
      default: DEFAULT_CLAWCLAMP_CONFIG.mode,
    },
    principalId: { type: "string", default: DEFAULT_CLAWCLAMP_CONFIG.principalId },
    policyStoreUri: { type: "string" },
    policyStoreLocal: { type: "string" },
    uiToken: { type: "string" },
    policyFailOpen: { type: "boolean", default: DEFAULT_CLAWCLAMP_CONFIG.policyFailOpen },
    risk: {
      type: "object",
      additionalProperties: false,
      properties: {
        default: {
          type: "string",
          enum: [...RISK_LEVELS],
          default: DEFAULT_CLAWCLAMP_CONFIG.risk.default,
        },
        overrides: {
          type: "object",
          additionalProperties: {
            type: "string",
            enum: [...RISK_LEVELS],
          },
          default: DEFAULT_CLAWCLAMP_CONFIG.risk.overrides,
        },
      },
    },
    grants: {
      type: "object",
      additionalProperties: false,
      properties: {
        defaultTtlSeconds: {
          type: "number",
          minimum: 60,
          maximum: 86_400,
          default: DEFAULT_CLAWCLAMP_CONFIG.grants.defaultTtlSeconds,
        },
        maxTtlSeconds: {
          type: "number",
          minimum: 60,
          maximum: 86_400,
          default: DEFAULT_CLAWCLAMP_CONFIG.grants.maxTtlSeconds,
        },
      },
    },
    audit: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxEntries: {
          type: "number",
          minimum: 50,
          maximum: 10_000,
          default: DEFAULT_CLAWCLAMP_CONFIG.audit.maxEntries,
        },
        includeParams: {
          type: "boolean",
          default: DEFAULT_CLAWCLAMP_CONFIG.audit.includeParams,
        },
        maxParamLength: {
          type: "number",
          minimum: 256,
          maximum: 32_000,
          default: DEFAULT_CLAWCLAMP_CONFIG.audit.maxParamLength,
        },
      },
    },
  },
} as const;

export const clawClampConfigSchema: OpenClawPluginConfigSchema = {
  safeParse(value: unknown) {
    if (value === undefined) {
      return { success: true, data: undefined };
    }
    try {
      return { success: true, data: resolveClawClampConfig(value) };
    } catch (error) {
      return {
        success: false,
        error: {
          issues: [{ path: [], message: error instanceof Error ? error.message : String(error) }],
        },
      };
    }
  },
  jsonSchema: CEDAR_GUARD_CONFIG_JSON_SCHEMA,
};

function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === "string" && (RISK_LEVELS as readonly string[]).includes(value);
}

function isMode(value: unknown): value is ClawClampMode {
  return value === "enforce" || value === "gray";
}

export function resolveClawClampConfig(input: unknown): ClawClampConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...DEFAULT_CLAWCLAMP_CONFIG };
  }

  const raw = input as Record<string, unknown>;
  const riskOverrides = { ...DEFAULT_CLAWCLAMP_CONFIG.risk.overrides };

  if (raw.risk && typeof raw.risk === "object" && !Array.isArray(raw.risk)) {
    const risk = raw.risk as Record<string, unknown>;
    if (risk.overrides && typeof risk.overrides === "object" && !Array.isArray(risk.overrides)) {
      for (const [tool, level] of Object.entries(risk.overrides)) {
        if (isRiskLevel(level)) {
          riskOverrides[tool] = level;
        }
      }
    }
  }

  const resolved: ClawClampConfig = {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CLAWCLAMP_CONFIG.enabled,
    mode: isMode(raw.mode) ? raw.mode : DEFAULT_CLAWCLAMP_CONFIG.mode,
    principalId:
      typeof raw.principalId === "string" && raw.principalId.trim()
        ? raw.principalId.trim()
        : DEFAULT_CLAWCLAMP_CONFIG.principalId,
    policyStoreUri:
      typeof raw.policyStoreUri === "string" && raw.policyStoreUri.trim()
        ? raw.policyStoreUri.trim()
        : undefined,
    policyStoreLocal:
      typeof raw.policyStoreLocal === "string" && raw.policyStoreLocal.trim()
        ? raw.policyStoreLocal.trim()
        : undefined,
    uiToken:
      typeof raw.uiToken === "string" && raw.uiToken.trim()
        ? raw.uiToken.trim()
        : undefined,
    policyFailOpen:
      typeof raw.policyFailOpen === "boolean"
        ? raw.policyFailOpen
        : DEFAULT_CLAWCLAMP_CONFIG.policyFailOpen,
    risk: {
      default:
        raw.risk && typeof raw.risk === "object" && !Array.isArray(raw.risk)
          ? isRiskLevel((raw.risk as Record<string, unknown>).default)
            ? ((raw.risk as Record<string, unknown>).default as RiskLevel)
            : DEFAULT_CLAWCLAMP_CONFIG.risk.default
          : DEFAULT_CLAWCLAMP_CONFIG.risk.default,
      overrides: riskOverrides,
    },
    grants: {
      defaultTtlSeconds:
        raw.grants && typeof raw.grants === "object" && !Array.isArray(raw.grants)
          ? Number((raw.grants as Record<string, unknown>).defaultTtlSeconds) ||
            DEFAULT_CLAWCLAMP_CONFIG.grants.defaultTtlSeconds
          : DEFAULT_CLAWCLAMP_CONFIG.grants.defaultTtlSeconds,
      maxTtlSeconds:
        raw.grants && typeof raw.grants === "object" && !Array.isArray(raw.grants)
          ? Number((raw.grants as Record<string, unknown>).maxTtlSeconds) ||
            DEFAULT_CLAWCLAMP_CONFIG.grants.maxTtlSeconds
          : DEFAULT_CLAWCLAMP_CONFIG.grants.maxTtlSeconds,
    },
    audit: {
      maxEntries:
        raw.audit && typeof raw.audit === "object" && !Array.isArray(raw.audit)
          ? Number((raw.audit as Record<string, unknown>).maxEntries) ||
            DEFAULT_CLAWCLAMP_CONFIG.audit.maxEntries
          : DEFAULT_CLAWCLAMP_CONFIG.audit.maxEntries,
      includeParams:
        raw.audit && typeof raw.audit === "object" && !Array.isArray(raw.audit)
          ? (raw.audit as Record<string, unknown>).includeParams === true
          : DEFAULT_CLAWCLAMP_CONFIG.audit.includeParams,
      maxParamLength:
        raw.audit && typeof raw.audit === "object" && !Array.isArray(raw.audit)
          ? Number((raw.audit as Record<string, unknown>).maxParamLength) ||
            DEFAULT_CLAWCLAMP_CONFIG.audit.maxParamLength
          : DEFAULT_CLAWCLAMP_CONFIG.audit.maxParamLength,
    },
  };

  resolved.grants.defaultTtlSeconds = Math.min(
    Math.max(60, resolved.grants.defaultTtlSeconds),
    resolved.grants.maxTtlSeconds,
  );
  resolved.grants.maxTtlSeconds = Math.max(60, resolved.grants.maxTtlSeconds);

  resolved.audit.maxEntries = Math.max(50, resolved.audit.maxEntries);
  resolved.audit.maxParamLength = Math.max(256, resolved.audit.maxParamLength);

  return resolved;
}
