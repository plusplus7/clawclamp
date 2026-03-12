import fs from "node:fs/promises";
import path from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk";
import type { ClawClampMode, ModeState } from "./types.js";
import { withStateFileLock } from "./storage.js";

const MODE_FILE = "mode.json";

function resolveModePath(stateDir: string): string {
  return path.join(stateDir, "clawclamp", MODE_FILE);
}

async function readModeState(stateDir: string): Promise<ModeState> {
  const filePath = resolveModePath(stateDir);
  const { value } = await readJsonFileWithFallback(filePath, {} as ModeState);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as ModeState;
}

async function writeModeState(stateDir: string, state: ModeState): Promise<void> {
  const filePath = resolveModePath(stateDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeJsonFileAtomically(filePath, state);
}

export async function getModeOverride(stateDir: string): Promise<ClawClampMode | undefined> {
  return withStateFileLock(stateDir, "mode", async () => {
    const state = await readModeState(stateDir);
    return state.modeOverride;
  });
}

export async function setModeOverride(
  stateDir: string,
  mode: ClawClampMode | undefined,
): Promise<void> {
  return withStateFileLock(stateDir, "mode", async () => {
    const state = await readModeState(stateDir);
    const next: ModeState = {
      ...state,
      modeOverride: mode,
      updatedAt: new Date().toISOString(),
    };
    await writeModeState(stateDir, next);
  });
}
