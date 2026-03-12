export type RiskLevel = "low" | "medium" | "high";

export type ClawClampMode = "enforce" | "gray";

export type ClawClampConfig = {
  enabled: boolean;
  mode: ClawClampMode;
  principalId: string;
  policyStoreUri?: string;
  policyStoreLocal?: string;
  uiToken?: string;
  policyFailOpen: boolean;
  risk: {
    default: RiskLevel;
    overrides: Record<string, RiskLevel>;
  };
  grants: {
    defaultTtlSeconds: number;
    maxTtlSeconds: number;
  };
  audit: {
    maxEntries: number;
    includeParams: boolean;
    maxParamLength: number;
  };
};

export type ModeState = {
  modeOverride?: ClawClampMode;
  updatedAt?: string;
};

export type GrantRecord = {
  id: string;
  toolName: string;
  createdAt: string;
  expiresAt: string;
  note?: string;
};

export type AuditDecision = "allow" | "deny" | "allow_grayed" | "error";

export type AuditEntry = {
  id: string;
  timestamp: string;
  toolName: string;
  toolCallId?: string;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  risk: RiskLevel;
  cedarDecision?: "allow" | "deny" | "error";
  decision: AuditDecision;
  reason?: string;
  params?: Record<string, unknown> | string;
  grantId?: string;
  grantExpiresAt?: string;
  grayMode?: boolean;
  resultStatus?: "ok" | "error" | "pending";
  error?: string;
  durationMs?: number;
};
