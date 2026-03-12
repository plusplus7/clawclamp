import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { listGrants, createGrant, revokeGrant } from "./grants.js";
import { readAuditEntries } from "./audit.js";
import { getModeOverride, setModeOverride } from "./mode.js";
import { createPolicy, deletePolicy, listPolicies, updatePolicy } from "./policy-store.js";
import type { ClawClampConfig, ClawClampMode } from "./types.js";

const API_PREFIX = "/plugins/clawclamp/api";
const ASSET_PREFIX = "/plugins/clawclamp/assets";
const ROOT_PATH = "/plugins/clawclamp";

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function setSharedHeaders(res: ServerResponse, contentType: string): void {
  res.setHeader("cache-control", "no-store, max-age=0");
  res.setHeader("content-type", contentType);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  setSharedHeaders(res, "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.statusCode = status;
  setSharedHeaders(res, "text/plain; charset=utf-8");
  res.end(text);
}

function parseUrl(rawUrl?: string): URL | null {
  if (!rawUrl) {
    return null;
  }
  try {
    return new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return null;
  }
}

function decodePathComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return undefined;
}

function getBearerToken(req: IncomingMessage): string | undefined {
  const raw = getHeader(req, "authorization")?.trim() ?? "";
  if (!raw.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }
  const token = raw.slice(7).trim();
  return token || undefined;
}

function hasProxyForwardingHints(req: IncomingMessage): boolean {
  const headers = req.headers ?? {};
  return Boolean(
    headers["x-forwarded-for"] ||
      headers["x-real-ip"] ||
      headers.forwarded ||
      headers["x-forwarded-host"] ||
      headers["x-forwarded-proto"],
  );
}

function normalizeRemoteClientKey(remoteAddress: string | undefined): string {
  const normalized = remoteAddress?.trim().toLowerCase();
  if (!normalized) {
    return "unknown";
  }
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}

function isLoopbackClientIp(clientIp: string): boolean {
  return clientIp === "127.0.0.1" || clientIp === "::1";
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const remoteKey = normalizeRemoteClientKey(req.socket?.remoteAddress);
  return isLoopbackClientIp(remoteKey) && !hasProxyForwardingHints(req);
}

function resolveAuthToken(params: {
  req: IncomingMessage;
  parsed: URL;
}): string | undefined {
  const queryToken = params.parsed.searchParams.get("token")?.trim();
  if (queryToken) {
    return queryToken;
  }
  const headerToken = getHeader(params.req, "x-openclaw-token")?.trim();
  if (headerToken) {
    return headerToken;
  }
  return getBearerToken(params.req);
}

function isAuthorizedRequest(params: {
  req: IncomingMessage;
  parsed: URL;
  config: ClawClampConfig;
  gatewayToken?: string;
}): boolean {
  if (isLoopbackRequest(params.req)) {
    return true;
  }
  const token = resolveAuthToken({ req: params.req, parsed: params.parsed });
  if (!token) {
    return false;
  }
  if (params.config.uiToken && token === params.config.uiToken) {
    return true;
  }
  if (params.gatewayToken && token === params.gatewayToken) {
    return true;
  }
  return false;
}

async function readJsonBody(req: IncomingMessage, limit = 64_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return undefined;
  }
  return JSON.parse(raw);
}

async function serveAsset(
  req: IncomingMessage,
  res: ServerResponse,
  assetsDir: string,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith(ASSET_PREFIX)) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "Method not allowed");
    return true;
  }
  const relative = pathname.slice(ASSET_PREFIX.length).replace(/^\//, "");
  const resolved = path.resolve(assetsDir, relative);
  if (!resolved.startsWith(assetsDir)) {
    sendText(res, 404, "Not found");
    return true;
  }
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      sendText(res, 404, "Not found");
      return true;
    }
    const ext = path.extname(resolved).toLowerCase();
    const contentType = MIME_BY_EXT[ext] ?? "application/octet-stream";
    const body = await fs.readFile(resolved);
    res.statusCode = 200;
    setSharedHeaders(res, contentType);
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  } catch {
    sendText(res, 404, "Not found");
    return true;
  }
}

export function createClawClampHttpHandler(params: {
  stateDir: string;
  config: ClawClampConfig;
  assetsDir: string;
  gatewayToken?: string;
  onPolicyUpdate?: () => Promise<void>;
}) {
  const assetsDir = path.resolve(params.assetsDir);

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const parsed = parseUrl(req.url);
    if (!parsed) {
      return false;
    }

    if (!isAuthorizedRequest({ req, parsed, config: params.config, gatewayToken: params.gatewayToken })) {
      if (parsed.pathname.startsWith(API_PREFIX)) {
        sendJson(res, 401, { error: "unauthorized" });
      } else {
        sendText(res, 401, "Unauthorized");
      }
      return true;
    }

    if (await serveAsset(req, res, assetsDir, parsed.pathname)) {
      return true;
    }

    if (parsed.pathname === ROOT_PATH || parsed.pathname === `${ROOT_PATH}/`) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendText(res, 405, "Method not allowed");
        return true;
      }
      const indexPath = path.join(assetsDir, "index.html");
      try {
        const body = await fs.readFile(indexPath, "utf8");
        res.statusCode = 200;
        setSharedHeaders(res, "text/html; charset=utf-8");
        res.end(req.method === "HEAD" ? undefined : body);
        return true;
      } catch {
        sendText(res, 500, "Failed to load UI");
        return true;
      }
    }

    if (!parsed.pathname.startsWith(API_PREFIX)) {
      return false;
    }

    const apiPath = parsed.pathname.slice(API_PREFIX.length).replace(/^\//, "");

    if (apiPath === "state" && req.method === "GET") {
      const modeOverride = await getModeOverride(params.stateDir);
      sendJson(res, 200, {
        enabled: params.config.enabled,
        mode: modeOverride ?? params.config.mode,
        modeOverride: modeOverride ?? null,
        configMode: params.config.mode,
        grants: {
          defaultTtlSeconds: params.config.grants.defaultTtlSeconds,
          maxTtlSeconds: params.config.grants.maxTtlSeconds,
        },
        audit: {
          maxEntries: params.config.audit.maxEntries,
        },
      });
      return true;
    }

    if (apiPath === "mode" && req.method === "POST") {
      try {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const mode = body?.mode;
        if (mode !== "enforce" && mode !== "gray") {
          sendJson(res, 400, { error: "mode must be enforce or gray" });
          return true;
        }
        await setModeOverride(params.stateDir, mode as ClawClampMode);
        sendJson(res, 200, { ok: true, mode });
        return true;
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return true;
      }
    }

    if (apiPath === "logs" && req.method === "GET") {
      const pageParam = parsed.searchParams.get("page");
      const pageSizeParam = parsed.searchParams.get("pageSize");
      const page = Math.max(1, Number(pageParam) || 1);
      const pageSize = Math.min(
        Math.max(1, Number(pageSizeParam) || 50),
        params.config.audit.maxEntries,
      );
      const result = await readAuditEntries(params.stateDir, page, pageSize);
      sendJson(res, 200, {
        entries: result.entries.reverse(),
        total: result.total,
        page: result.page,
        pageSize,
      });
      return true;
    }

    if (apiPath === "policies" && req.method === "GET") {
      if (params.config.policyStoreUri) {
        sendJson(res, 200, { readOnly: true, policies: [] });
        return true;
      }
      const { policies } = await listPolicies({ stateDir: params.stateDir });
      sendJson(res, 200, { readOnly: false, policies });
      return true;
    }

    if (apiPath === "policies" && req.method === "POST") {
      if (params.config.policyStoreUri) {
        sendJson(res, 400, { error: "policyStoreUri is read-only" });
        return true;
      }
      try {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const content = typeof body?.content === "string" ? body.content : "";
        const id = typeof body?.id === "string" ? body.id : undefined;
        if (!content.trim()) {
          sendJson(res, 400, { error: "content is required" });
          return true;
        }
        const policy = await createPolicy({ stateDir: params.stateDir, id, content });
        if (params.onPolicyUpdate) {
          await params.onPolicyUpdate();
        }
        sendJson(res, 200, { policy });
        return true;
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return true;
      }
    }

    if (apiPath.startsWith("policies/") && req.method === "PUT") {
      if (params.config.policyStoreUri) {
        sendJson(res, 400, { error: "policyStoreUri is read-only" });
        return true;
      }
      try {
        const id = decodePathComponent(apiPath.slice("policies/".length));
        if (!id) {
          sendJson(res, 400, { error: "policy id required" });
          return true;
        }
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const content = typeof body?.content === "string" ? body.content : "";
        if (!content.trim()) {
          sendJson(res, 400, { error: "content is required" });
          return true;
        }
        const policy = await updatePolicy({ stateDir: params.stateDir, id, content });
        if (params.onPolicyUpdate) {
          await params.onPolicyUpdate();
        }
        sendJson(res, 200, { policy });
        return true;
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return true;
      }
    }

    if (apiPath.startsWith("policies/") && req.method === "DELETE") {
      if (params.config.policyStoreUri) {
        sendJson(res, 400, { error: "policyStoreUri is read-only" });
        return true;
      }
      const id = decodePathComponent(apiPath.slice("policies/".length));
      if (!id) {
        sendJson(res, 400, { error: "policy id required" });
        return true;
      }
      const ok = await deletePolicy({ stateDir: params.stateDir, id });
      if (params.onPolicyUpdate) {
        await params.onPolicyUpdate();
      }
      sendJson(res, 200, { ok });
      return true;
    }

    if (apiPath === "grants" && req.method === "GET") {
      const grants = await listGrants(params.stateDir);
      sendJson(res, 200, { grants });
      return true;
    }

    if (apiPath === "grants" && req.method === "POST") {
      try {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const toolName = typeof body?.toolName === "string" ? body.toolName.trim() : "";
        if (!toolName) {
          sendJson(res, 400, { error: "toolName is required" });
          return true;
        }
        const ttlSeconds =
          typeof body?.ttlSeconds === "number" ? body.ttlSeconds : undefined;
        const note = typeof body?.note === "string" ? body.note : undefined;
        const grant = await createGrant({
          stateDir: params.stateDir,
          config: params.config,
          toolName,
          ttlSeconds,
          note,
        });
        if (params.onPolicyUpdate) {
          await params.onPolicyUpdate();
        }
        sendJson(res, 200, { grant });
        return true;
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return true;
      }
    }

    if (apiPath.startsWith("grants/") && req.method === "DELETE") {
      const grantId = decodePathComponent(apiPath.slice("grants/".length));
      if (!grantId) {
        sendJson(res, 400, { error: "grant id required" });
        return true;
      }
      const removed = await revokeGrant(params.stateDir, grantId);
      if (params.onPolicyUpdate) {
        await params.onPolicyUpdate();
      }
      sendJson(res, 200, { ok: removed });
      return true;
    }

    sendJson(res, 404, { error: "Not found" });
    return true;
  };
}
