import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CLAWCLAMP_CONFIG } from "./config.js";
import { createClawClampService } from "./guard.js";
import { readAuditEntries } from "./audit.js";

const getCedarlingMock = vi.fn();

vi.mock("./cedarling.js", () => ({
  getCedarling: getCedarlingMock,
}));

describe("ClawclampService", () => {
  let stateDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawclamp-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("blocks tool execution when Cedar initialization fails and policyFailOpen is false", async () => {
    getCedarlingMock.mockRejectedValue(new Error("fetch failed"));

    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const service = createClawClampService({
      api: { logger } as any,
      config: {
        ...DEFAULT_CLAWCLAMP_CONFIG,
        mode: "enforce",
        policyFailOpen: false,
      },
      stateDir,
    });

    const result = await service.handleBeforeToolCall(
      {
        toolName: "browser",
        params: { action: "open", url: "https://example.com" },
        toolCallId: "call-1",
        runId: "run-1",
      },
      {
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        agentId: "main",
      } as any,
    );

    expect(result).toEqual({ block: true, blockReason: "fetch failed" });
    expect(logger.error).toHaveBeenCalledWith(
      "Clawclamp authorization failed for browser: fetch failed",
    );

    const auditEntries = await readAuditEntries(stateDir, 10);
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]).toMatchObject({
      toolName: "browser",
      cedarDecision: "error",
      decision: "error",
      reason: "fetch failed",
    });
  });
});
