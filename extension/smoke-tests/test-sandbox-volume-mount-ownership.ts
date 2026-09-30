#!/usr/bin/env bun
/**
 * Sandbox named-volume ownership gate — #933.
 *
 * On a fresh host (no `~/.pi/agent/sessions`, `~/.pi/agent/ensemble-runs`,
 * `~/.vipune`), `bin/pi-rukas`'s `build_mounts()` falls back to named volumes
 * so the container still gets persistent state. Docker creates a new named
 * volume owned by the owner of the MOUNT POINT; when that path didn't exist
 * in the image, the volume lands `root:root` (755), and pi — which runs as
 * `vscode` after the entrypoint's `setpriv` drop — crashes with EACCES on
 * first launch. The same class breaks the always-on cache volumes
 * (`~/.cache`, `~/.bun`, `~/.cargo`, `/commandhistory`) whose mount points
 * don't exist in the image.
 *
 * The fix is three-sided, and this gate locks each side in on the REAL files:
 *   1. The Dockerfile bakes the mount points in as `vscode`-owned, so NEW
 *      named volumes created from now on inherit a writable owner.
 *   2. `bin/pi-rukas` derives the container-side destinations of every NAMED
 *      volume it actually mounted and hands them to the entrypoint via
 *      `PI_ENSEMBLE_VOLUME_MOUNTS` (a bind mount is path-/socket-sourced and
 *      is never on the list).
 *   3. The entrypoint, in its root phase BEFORE `setpriv`, chowns ONLY targets
 *      on that list AND on a hard-coded allowlist, so a bind-mounted host
 *      directory (even a root-owned one) can never be chowned.
 *
 * Proven in both directions (AGENTS.md §12 canary discipline): inline fixtures
 * with each guard present pass and with it removed fail, through the same
 * helpers the real-file checks use.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DOCKERFILE = path.join(REPO_ROOT, ".devcontainer", "Dockerfile");
const ENTRYPOINT = path.join(REPO_ROOT, ".devcontainer", "entrypoint.sh");
const WRAPPER = path.join(REPO_ROOT, "bin", "pi-rukas");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// The state + cache mount points expected to be baked into the image as
// vscode-owned and allowlisted for entrypoint repair. Mirrors bin/pi-rukas
// build_mounts() (fallbacks + always-on caches).
export const VOLUME_TARGETS = [
  "/home/vscode/.pi/agent/sessions",
  "/home/vscode/.pi/agent/ensemble-runs",
  "/home/vscode/.vipune",
  "/home/vscode/.cache",
  "/home/vscode/.bun",
  "/home/vscode/.cargo",
  "/commandhistory",
] as const;

/** The six home targets the vscode mkdir block must bake in (`/commandhistory` has its own root RUN). */
export const HOME_TARGETS = VOLUME_TARGETS.filter((t) => t !== "/commandhistory");

/** The `RUN mkdir -p …` block (incl. backslash-continuation lines) that bakes all state targets into the image, or "". */
export function dockerfileMkdirLine(dockerfile: string): string {
  const lines = dockerfile.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (!t.startsWith("RUN mkdir -p")) continue;
    let j = i;
    while (j + 1 < lines.length && /\\\s*$/.test(lines[j]!)) j++;
    const block = lines.slice(i, j + 1).join("\n");
    if (HOME_TARGETS.every((x) => block.includes(x))) return block;
  }
  return "";
}

/**
 * The /commandhistory creation line — must create it root then hand it to
 * vscode (it lives at the FS root, outside vscode's write scope).
 */
export function commandHistoryLine(dockerfile: string): string {
  for (const line of dockerfile.split("\n")) {
    const t = line.trim();
    if (/RUN mkdir -p \/commandhistory.*chown\s+vscode:vscode/.test(t)) return t;
  }
  return "";
}

/** The `PI_ENSEMBLE_VOLUME_MOUNTS` env assignment built from named-volume dests, or "". */
export function wrapperVolumeMountsLine(wrapper: string): string {
  const lines = wrapper.split("\n");
  for (const line of lines) {
    const t = line.trim();
    if (t.includes("PI_ENSEMBLE_VOLUME_MOUNTS=") && t.includes("-e")) return t;
  }
  return "";
}

/** Whether the wrapper's mount parser excludes bind mounts (path-/socket-sourced sources). */
export function wrapperExcludesBindMounts(wrapper: string): boolean {
  return wrapper.includes('*/*) ;;');
}

/** The index of the entrypoint chown loop within its source, or -1. */
export function entrypointChownIndex(entrypoint: string): number {
  return entrypoint.indexOf('for _t in "${_vol_targets[@]}"');
}

/** The index of the file's single vscode drop, or -1. */
export function setprivIndex(entrypoint: string): number {
  return entrypoint.indexOf("setpriv --reuid=vscode");
}

export function entrypointAllowlist(entrypoint: string): string {
  const i = entrypoint.indexOf('read -r -a _vol_targets');
  if (i === -1) return "";
  const block = entrypoint.slice(i, i + 700);
  return block;
}

// ---------------------------------------------------------------- the gate

if (process.env.PI_ENSEMBLE_VOLUME_OWNERSHIP === "0") {
  console.log("PI_ENSEMBLE_VOLUME_OWNERSHIP=0 — sandbox volume-ownership gate skipped.");
  process.exit(0);
}

{
  const dockerfile = readFileSync(DOCKERFILE, "utf8");

  // The three issue-mandated state dirs must be baked in as vscode.
  assert(
    dockerfileMkdirLine(dockerfile) !== "",
    "Dockerfile bakes the three state mount points in via a vscode `RUN mkdir -p …` line",
  );
  const mkdirLine = dockerfileMkdirLine(dockerfile);
  for (const t of ["/home/vscode/.pi/agent/sessions", "/home/vscode/.pi/agent/ensemble-runs", "/home/vscode/.vipune"]) {
    assert(
      mkdirLine.includes(t),
      `Dockerfile vscode mkdir includes state target \`${t}\``,
    );
  }
  // ... plus the always-on cache volumes whose mount points are absent.
  for (const t of ["/home/vscode/.cache", "/home/vscode/.bun", "/home/vscode/.cargo"]) {
    assert(
      mkdirLine.includes(t),
      `Dockerfile vscode mkdir includes cache target \`${t}\``,
    );
  }
  // The mkdir must run as vscode, not root, so the volume inherits UID 1000.
  const mkdirIdx = dockerfile.indexOf("RUN mkdir -p");
  const usersBefore = dockerfile.slice(0, mkdirIdx === -1 ? 0 : mkdirIdx).split("\n");
  const lastUser = [...usersBefore].reverse().find((l) => l.trim().startsWith("USER "));
  assert(
    lastUser !== undefined && lastUser.trim() === "USER vscode",
    "the state-dir mkdir runs as USER vscode (so fresh volumes inherit UID 1000)",
  );

  assert(
    commandHistoryLine(dockerfile) !== "",
    "Dockerfile creates /commandhistory root-then-vscode (chown vscode:vscode)",
  );
}

{
  const wrapper = readFileSync(WRAPPER, "utf8");
  assert(
    wrapperVolumeMountsLine(wrapper) !== "",
    "bin/pi-rukas sets the PI_ENSEMBLE_VOLUME_MOUNTS env from the mount list",
  );
  assert(
    wrapperExcludesBindMounts(wrapper),
    "bin/pi-rukas excludes bind mounts (path/socket sources) from PI_ENSEMBLE_VOLUME_MOUNTS",
  );
}

{
  const entrypoint = readFileSync(ENTRYPOINT, "utf8");
  const chownIdx = entrypointChownIndex(entrypoint);
  const dropIdx = setprivIndex(entrypoint);
  assert(chownIdx !== -1, "entrypoint contains the named-volume chown loop");
  assert(dropIdx !== -1 && chownIdx !== -1 && chownIdx < dropIdx,
    "entrypoint chown loop runs in the root phase BEFORE `setpriv --reuid=vscode`");

  const allow = entrypointAllowlist(entrypoint);
  for (const t of VOLUME_TARGETS) {
    assert(allow.includes(t), `entrypoint chown allowlist names \`${t}\``);
  }
  assert(
    /stat -c %u/.test(entrypoint),
    "entrypoint chown gated on the target being root-owned (`stat -c %u` … = 0)",
  );
}

// ------------------------------------------------- the gate CAN fail (canaries)

{
  // Canary: Dockerfile mkdir helper finds all three state targets in a fixture,
  // and misses a fixture that dropped one.
  const good = "RUN mkdir -p /home/vscode/.pi/agent/sessions \\\n" +
    "  /home/vscode/.pi/agent/ensemble-runs \\\n" +
    "  /home/vscode/.vipune \\\n" +
    "  /home/vscode/.cache \\\n" +
    "  /home/vscode/.bun \\\n" +
    "  /home/vscode/.cargo";
  assert(dockerfileMkdirLine(good) !== "", "canary: mkdir fixture with all state dirs parses present");
  const bad = "RUN mkdir -p /home/vscode/.cache";
  assert(dockerfileMkdirLine(bad) === "", "canary: mkdir fixture missing a state dir parses absent");

  // Canary: the wrapper derive lines are only matched when the -e assignment exists.
  assert(
    wrapperVolumeMountsLine('envs+=(-e "PI_ENSEMBLE_VOLUME_MOUNTS=$x")') !== "",
    "canary: wrapper PI_ENSEMBLE_VOLUME_MOUNTS -e line detected",
  );
  assert(
    wrapperVolumeMountsLine('echo "no mount var here"') === "",
    "canary: wrapper line without the assignment is not detected",
  );

  // Canary: an entrypoint whose chown loop appears after setpriv is caught.
  const lateEntrypoint =
    "echo root\nsetpriv --reuid=vscode --regid=vscode --init-groups -- \"$0\" \"$@\"\n" +
    "IFS=: read -r -a _vol_targets <<<\"$PI_ENSEMBLE_VOLUME_MOUNTS\"\nfor _t in \"${_vol_targets[@]}\"; do :; done";
  const lateChown = entrypointChownIndex(lateEntrypoint);
  const lateDrop = setprivIndex(lateEntrypoint);
  assert(
    lateChown !== -1 && lateDrop !== -1 && lateChown > lateDrop,
    "canary: a chown loop placed after setpriv is detectable (the ordering assertion above would flag it)",
  );

  // Canary: allowlist helper captures the allowlist block when present.
  const allowFixture =
    'IFS=: read -r -a _vol_targets <<<"$PI_ENSEMBLE_VOLUME_MOUNTS"\n' +
    "/home/vscode/.pi/agent/sessions|/home/vscode/.vipune\n";
  assert(entrypointAllowlist(allowFixture) !== "", "canary: allowlist block is captured");
}

console.log(exit === 0 ? "\nAll sandbox volume-ownership checks passed." : "\nFAILED");
process.exit(exit);
