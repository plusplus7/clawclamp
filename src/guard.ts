import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
  PluginHookAfterToolCallEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookToolContext,
} from "openclaw/plugins/types";
import type { CedarlingConfig, CedarlingInstance } from "./cedarling.js";
import { getCedarling, resetCedarlingInstance } from "./cedarling.js";
import { appendAuditEntry, createAuditEntryId } from "./audit.js";
import { getModeOverride } from "./mode.js";
import { buildDefaultPolicyStore } from "./policy.js";
import { ensurePolicyStore } from "./policy-store.js";
import type { AuditEntry, ClawClampConfig, ClawClampMode, RiskLevel } from "./types.js";

type CedarDecision = "allow" | "deny" | "error";

type CedarEvaluation = {
  decision: CedarDecision;
  reason?: string;
  raw?: Record<string, unknown>;
};

function resolveRisk(toolName: string, config: ClawClampConfig): RiskLevel {
  const override = config.risk.overrides[toolName];
  return override ?? config.risk.default;
}

function summarizeParams(
  params: Record<string, unknown>,
  config: ClawClampConfig,
): Record<string, unknown> | string {
  if (!config.audit.includeParams) {
    return "(params omitted)";
  }
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      summary[key] =
        value.length > config.audit.maxParamLength
          ? `${value.slice(0, config.audit.maxParamLength)}...`
          : value;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      summary[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      summary[key] = `Array(${value.length})`;
      continue;
    }
    if (typeof value === "object" && value) {
      summary[key] = `Object(${Object.keys(value).length})`;
      continue;
    }
    summary[key] = String(value);
  }
  return summary;
}

function buildCedarlingConfig(params: {
  config: ClawClampConfig;
  policyStoreLocal?: string;
}): CedarlingConfig {
  const policyStoreLocal =
    params.policyStoreLocal ?? params.config.policyStoreLocal ?? JSON.stringify(buildDefaultPolicyStore());

  const cedarConfig: CedarlingConfig = {
    CEDARLING_APPLICATION_NAME: "openclaw-clawclamp",
    CEDARLING_USER_AUTHZ: "enabled",
    CEDARLING_WORKLOAD_AUTHZ: "disabled",
    CEDARLING_JWT_SIG_VALIDATION: "disabled",
    CEDARLING_LOG_TYPE: "std_out",
    CEDARLING_LOG_LEVEL: "WARN",
  };

  if (params.config.policyStoreUri) {
    cedarConfig.CEDARLING_POLICY_STORE_URI = params.config.policyStoreUri;
  } else {
    cedarConfig.CEDARLING_POLICY_STORE_LOCAL = policyStoreLocal;
  }

  return cedarConfig;
}

function parseDecisionValue(value: unknown, raw?: Record<string, unknown>): CedarEvaluation | null {
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized.includes("allow") || normalized.includes("permit")) {
      return { decision: "allow", raw };
    }
    if (normalized.includes("deny") || normalized.includes("forbid")) {
      return { decision: "deny", raw };
    }
  }
  if (typeof value === "boolean") {
    return { decision: value ? "allow" : "deny", raw };
  }
  return null;
}

function cedarEntityUid(type: string, id: string): string {
  return `${type}::${JSON.stringify(id)}`;
}

function parseCedarDecision(
  raw: unknown,
  principalType: string,
  principalId: string,
): CedarEvaluation {
  if (!raw || typeof raw !== "object") {
    return { decision: "error", reason: "Cedar response missing" };
  }
  const record = raw as Record<string, unknown>;
  const principals = record.principals;
  if (principals && typeof principals === "object" && !Array.isArray(principals)) {
    const principalRecord = principals as Record<string, unknown>;
    const exact = principalRecord[cedarEntityUid(principalType, principalId)];
    if (exact && typeof exact === "object") {
      const nested = parseDecisionValue((exact as Record<string, unknown>).decision, record);
      if (nested) {
        return nested;
      }
    }
    const typed = principalRecord[principalType];
    if (typed && typeof typed === "object") {
      const nested = parseDecisionValue((typed as Record<string, unknown>).decision, record);
      if (nested) {
        return nested;
      }
    }
  }
  const topLevel = parseDecisionValue(
    (record.decision as unknown) ?? (record.decisionId as unknown) ?? (record.result as unknown),
    record,
  );
  if (topLevel) {
    return topLevel;
  }
  return { decision: "error", reason: "Unknown Cedar decision", raw: record };
}

async function evaluateCedar(params: {
  api: OpenClawPluginApi;
  cedarling: CedarlingInstance;
  config: ClawClampConfig;
  toolName: string;
  risk: RiskLevel;
}): Promise<CedarEvaluation> {
  const now = Date.now();
  const request = {
    principals: [
      {
        type: "Jans::User",
        id: params.config.principalId,
        role: "operator",
      },
    ],
    action: 'Action::"Invoke"',
    resource: {
      type: "Tool",
      id: params.toolName,
      name: params.toolName,
      risk: params.risk,
    },
    context: {
      now,
      tool: params.toolName,
      risk: params.risk,
    },
  };
  params.api.logger.info(
    `[clawclamp] cedar request ${JSON.stringify(request)}`,
  );

  try {
    const result = await params.cedarling.authorize_unsigned(request);
    const jsonString = result.json_string();
    params.api.logger.info(
      `[clawclamp] cedar response ${JSON.stringify({ request, result: jsonString })}`,
    );
    const parsed = JSON.parse(jsonString) as unknown;
    return parseCedarDecision(parsed, "Jans::User", params.config.principalId);
  } catch (error) {
    return { decision: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}

export class ClawClampService {
  private readonly config: ClawClampConfig;
  private readonly stateDir: string;
  private readonly api: OpenClawPluginApi;
  private cedarlingPromise: Promise<CedarlingInstance> | null = null;
  private cedarlingPolicyStoreJson: string | null = null;

  constructor(params: { api: OpenClawPluginApi; config: ClawClampConfig; stateDir: string }) {
    this.api = params.api;
    this.config = params.config;
    this.stateDir = params.stateDir;
  }

  async handleBeforeToolCall(
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ): Promise<{ block?: boolean; blockReason?: string } | undefined> {
    const toolName = event.toolName;
    const risk = resolveRisk(toolName, this.config);
    const paramsSummary = summarizeParams(event.params, this.config);
    const auditId = createAuditEntryId();
    const mode = await this.getEffectiveMode();

    let cedarDecision: CedarEvaluation;
    if (this.config.enabled) {
      try {
        const cedarling = await this.getCedarlingInstance();
        cedarDecision = await evaluateCedar({
          api: this.api,
          cedarling,
          config: this.config,
          toolName,
          risk,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.api.logger.error(`Clawclamp authorization failed for ${toolName}: ${reason}`);
        cedarDecision = { decision: "error", reason };
      }
    } else {
      cedarDecision = { decision: "allow", reason: "Clawclamp disabled" };
    }

    let finalDecision: "allow" | "deny" | "allow_grayed" | "error" = "allow";
    let block = false;
    let reason: string | undefined;

    if (cedarDecision.decision === "error") {
      finalDecision = "error";
      reason = cedarDecision.reason ?? "Cedar evaluation failed";
      if (!this.config.policyFailOpen) {
        block = true;
      }
    } else if (cedarDecision.decision === "deny") {
      if (mode === "gray") {
        finalDecision = "allow_grayed";
      } else {
        finalDecision = "deny";
        block = true;
      }
      reason = cedarDecision.reason ?? "Denied by Cedar policy";
    } else {
      finalDecision = "allow";
    }

    const entry: AuditEntry = {
      id: auditId,
      timestamp: new Date().toISOString(),
      toolName,
      toolCallId: event.toolCallId,
      runId: event.runId,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
      agentId: ctx.agentId,
      risk,
      cedarDecision: cedarDecision.decision === "error" ? "error" : cedarDecision.decision,
      decision: finalDecision,
      reason,
      params: paramsSummary,
      grayMode: mode === "gray",
    };

    await appendAuditEntry(this.stateDir, entry);

    if (block) {
      return { block: true, blockReason: reason ?? "Tool call blocked" };
    }
    return undefined;
  }

  async handleAfterToolCall(
    event: PluginHookAfterToolCallEvent,
    ctx: PluginHookToolContext,
  ): Promise<void> {
    const entry: AuditEntry = {
      id: createAuditEntryId(),
      timestamp: new Date().toISOString(),
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      runId: event.runId,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
      agentId: ctx.agentId,
      risk: resolveRisk(event.toolName, this.config),
      decision: "allow",
      resultStatus: event.error ? "error" : "ok",
      error: event.error,
      durationMs: event.durationMs,
    };

    await appendAuditEntry(this.stateDir, entry);
  }

  async getEffectiveMode(): Promise<ClawClampMode> {
    const override = await getModeOverride(this.stateDir);
    return override ?? this.config.mode;
  }

  private async getCedarlingInstance(): Promise<CedarlingInstance> {
    const policyStore = await ensurePolicyStore({ stateDir: this.stateDir, config: this.config });
    if (
      !this.cedarlingPromise ||
      (!policyStore.readOnly && policyStore.json && policyStore.json !== this.cedarlingPolicyStoreJson)
    ) {
      const cedarConfig = buildCedarlingConfig({
        config: this.config,
        policyStoreLocal: policyStore.readOnly ? undefined : policyStore.json,
      });
      resetCedarlingInstance();
      this.cedarlingPromise = getCedarling(cedarConfig);
      this.cedarlingPolicyStoreJson = policyStore.readOnly ? null : (policyStore.json ?? null);
    }
    try {
      return await this.cedarlingPromise;
    } catch (error) {
      this.api.logger.error(`Failed to initialize Cedarling: ${String(error)}`);
      throw error;
    }
  }

  async resetCedarling(): Promise<void> {
    this.cedarlingPromise = null;
    this.cedarlingPolicyStoreJson = null;
    resetCedarlingInstance();
  }
}

export function createClawClampService(params: {
  api: OpenClawPluginApi;
  config: ClawClampConfig;
  stateDir: string;
}): ClawClampService {
  return new ClawClampService(params);
}
