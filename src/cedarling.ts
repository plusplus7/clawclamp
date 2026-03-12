import initWasm, { init } from "@janssenproject/cedarling_wasm";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

export type CedarlingConfig = Record<string, string | number | boolean>;

export type CedarlingAuthorizeResult = {
  json_string: () => string;
};

export type CedarlingInstance = {
  authorize_unsigned: (request: unknown) => Promise<CedarlingAuthorizeResult>;
  pop_logs: () => unknown[];
};

const require = createRequire(import.meta.url);
let cedarlingPromise: Promise<CedarlingInstance> | null = null;
let wasmInitPromise: Promise<void> | null = null;

export async function getCedarling(config: CedarlingConfig): Promise<CedarlingInstance> {
  if (!cedarlingPromise) {
    cedarlingPromise = createCedarling(config);
  }
  return cedarlingPromise;
}

export function resetCedarlingInstance(): void {
  cedarlingPromise = null;
}

async function ensureWasmInitialized(): Promise<void> {
  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      const wasmPath = require.resolve("@janssenproject/cedarling_wasm/cedarling_wasm_bg.wasm");
      const wasmBytes = await readFile(wasmPath);
      await initWasm(wasmBytes);
    })();
  }
  return wasmInitPromise;
}

async function createCedarling(config: CedarlingConfig): Promise<CedarlingInstance> {
  await ensureWasmInitialized();
  const instance = await init(config);
  return instance as CedarlingInstance;
}
