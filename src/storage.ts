import path from "node:path";
import type { FileLockOptions } from "openclaw/plugin-sdk";
import { withFileLock } from "openclaw/plugin-sdk";

export const DEFAULT_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: 8,
    factor: 1.5,
    minTimeout: 50,
    maxTimeout: 500,
    randomize: true,
  },
  stale: 10_000,
};

export async function withStateFileLock<T>(
  stateDir: string,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(stateDir, "clawclamp", `${name}.lockfile`);
  return withFileLock(lockPath, DEFAULT_LOCK_OPTIONS, fn);
}
