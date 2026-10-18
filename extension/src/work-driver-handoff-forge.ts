/** work-driver-handoff-forge — the forge the Step 7g handoff posts through. */
import { detectForge } from "./forge-detect.ts";
import { type Forge, createForge } from "./forge.ts";

export function handoffForge(repoRoot: string): Promise<Forge | undefined> {
  if (process.env.PI_ENSEMBLE_FORGE === "none") return Promise.resolve(undefined);
  return detectForge(repoRoot, {})
    .then((det) => (det.forge === "unknown" ? undefined : createForge(det, { cwd: repoRoot })))
    .catch(() => undefined);
}
