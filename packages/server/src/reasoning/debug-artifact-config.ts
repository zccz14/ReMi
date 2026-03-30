import { resolve } from "node:path";

export function resolveReasoningDebugArtifactRootDir(): string {
  return resolve(process.cwd());
}
