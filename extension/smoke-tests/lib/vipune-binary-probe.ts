/**
 * The shared probe behind every vipune-binary-backed smoke gate.
 *
 * Two states used to look identical: "no vipune on this host" and "vipune is
 * here but `--help` broke". Both returned null, and every caller treats null as
 * "skip" — so a vipune upgrade that stopped printing `Commands:` or `Options:`
 * turned the set-equation gates off instead of failing them. That is the
 * fail-open shape #1437 is about, in the gate that polices it.
 *
 * The rule this module enforces: absence is established by `command -v vipune`
 * and nothing else. Once that says present, a failed `--help` or a missing
 * heading THROWS — it is a broken gate, not a host without vipune.
 */

import { execFileSync } from "node:child_process";

let binaryPresent: boolean | undefined;

/** Is the vipune binary on PATH? Probed ONCE per process; `command -v` is the only absence signal. */
export function vipuneInstalled(): boolean {
  if (binaryPresent !== undefined) return binaryPresent;
  try {
    execFileSync("command", ["-v", "vipune"], { encoding: "utf8", timeout: 5_000, shell: true });
    binaryPresent = true;
  } catch {
    binaryPresent = false;
  }
  return binaryPresent;
}

/**
 * Why a binary-backed gate was skipped. Named in the output rather than silent,
 * because an unannounced skip is indistinguishable from a gate that ran and passed.
 */
export function skipBinaryGate(what: string): void {
  console.log(`- ${what}: SKIPPED — no vipune binary on PATH (\`command -v vipune\` found none)`);
}

/**
 * `vipune --help` on a host the probe says has the binary.
 *
 * Throws when the invocation fails or the expected heading is missing, so a
 * broken binary cannot quietly disable a gate. Returns null only when the binary
 * is absent — the caller's cue to print `skipBinaryGate` and move on.
 */
export function vipuneHelpOrSkip(heading: string, gateName: string): string | null {
  if (!vipuneInstalled()) {
    skipBinaryGate(gateName);
    return null;
  }
  const help = execFileSync("vipune", ["--help"], { encoding: "utf8", timeout: 10_000 });
  if (!help.includes(heading)) {
    throw new Error(
      `\`vipune --help\` printed no \`${heading}\` heading — ${gateName} has nothing to compare against`,
    );
  }
  return help;
}
