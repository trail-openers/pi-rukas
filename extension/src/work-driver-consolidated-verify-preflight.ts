/**
 * work-driver-consolidated-verify-preflight — #1421: the repoRoot preflight of
 * the consolidated verify, split out of `work-driver-consolidated-verify.ts`.
 *
 * The consolidated verify mutates repoRoot's checkout, so before it does it
 * asks the same question `integrate()` asks: is the root clean? Historically
 * that was one answer — anything outside the driver-managed and
 * configured-exempt prefixes refused the batch and the cycle parked as
 * `verify-failed:develop`, the cap reserved for a gate that judged the code.
 * Live cycle 248-261016-102836 (janit/tehas#248) parked a complete, reviewed
 * change on five cargo lock files. This module splits the question in two, on
 * git's own opinion rather than on the shape of the porcelain output:
 *
 *   - **refuse** (`dirty-root`) — dirt the gate must not sweep: a tracked
 *     modification, a staged entry, a rename, an unignored untracked file.
 *   - **decline** (`build-residue`) — the root held a tool's output and
 *     nothing else. The batch runs anyway (build output is neither content a
 *     checkout can move nor something `git add .` can sweep), but the outcome
 *     is REPORTED so the cycle's cap can tell an environment refusal from a
 *     code verdict.
 *   - **clean** — nothing charged, no residue either: run the verify and say
 *     nothing. A repo with no build output must not acquire a label.
 *
 * Where residue sat beside dirt the project's exemptions dropped,
 * `buildResidueOnly` is NOT set and the caller falls through silently: the
 * exemption — not the residue — is what unblocked the run, and labelling it
 * would credit the residue with a pass it did not enable (#1421 fix round).
 */

import { trace } from "./trace.ts";
import type { ConsolidatedVerifyResult } from "./work-driver-consolidated-verify-types.ts";
import {
  buildResidueFailure,
  classifyRootDirt,
  probeIgnored,
  readIgnoredPaths,
  residuePathText,
} from "./work-driver-dirty-root-classify.ts";
import { normaliseRepoPath } from "./work-driver-dirty-root-exempt.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * Read repoRoot's status, classify it against git's own ignore opinion, and
 * return the refusal/decline the caller must report — or `undefined` when the
 * root is clean enough to consolidate into.
 *
 * `exempt` is the cycle's `.pi/dirty-root-exempt` list (#1362), threaded from
 * the driver context; `undefined` means only the built-in prefixes are dropped.
 */
export async function readRepoRootPreflight(
  execFn: ExecFn,
  repoRoot: string,
  exempt: readonly string[] | undefined,
): Promise<ConsolidatedVerifyResult | undefined> {
  // `.worktrees/` and `.pi/` scaffolding are not dirt; untracked `??` IS dirt
  // (see the integrate() preflight comment for the reasoning).
  // #746 AC5 — `-uall`, same as the branch-step early gate's read
  // (readRepoRootDirt): plain --porcelain collapses an untracked directory tree
  // to its top-level entry, so an operator would see a bare `?? extension/` and
  // have to go hunting; -uall names the exact files, which is what the
  // dirty-root message is for.
  const { stdout: rootStatus } = await execFn("git status --porcelain -uall", {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
  });
  const candidateLines = rootStatus.split("\n");
  // #1421 — git's own opinion about which of these paths are ignored output.
  // `undefined` (the read failed) classifies every path as dirt, so a gate
  // that cannot tell still refuses: the fail-closed direction is the pre-#1421
  // behaviour, never "nothing is ignored".
  const ignored = await readIgnoredPaths(execFn, repoRoot);
  // #1421 fix round — the direct per-path probe, whose three answers (a set /
  // an empty set / undefined) the classifier reads separately. The candidates
  // are the status lines PLUS the directory paths the ignored listing named:
  // with `-uall` git never walks into a wholly-ignored directory, so the
  // descendants of `!! target/` are absent from `rootStatus` and the listing is
  // the only witness to them — the exact question the probe answers. The FILE
  // forms are not asked: a path git already printed as `!!` needs no second
  // opinion, and asking anyway would let one artifact whose status git will not
  // report (a lock file, a nested path it never listed) fail the whole probe
  // and turn a root of pure build output into a refusal on a technicality.
  const probeLines = [
    ...candidateLines,
    ...[...(ignored ?? [])].filter((p) => p.endsWith("/")).map((p) => `?? ${p}`),
  ];
  const probeResult = await probeIgnored(execFn, repoRoot, probeLines);
  // The candidate LINES the classifier adjudicates: what the status read
  // produced, plus one line for every ignored DIRECTORY that read did not
  // mention — the descendant of a collapsed directory
  // (`target/debug/.cargo-lock`, the incident's shape), which the status read
  // never walks into and which would otherwise leave the gate with "no dirt,
  // no residue": a pass with nothing classified. `!!` lines git printed itself
  // need no addition; the classifier already honours them.
  const listedPaths = new Set(
    candidateLines.filter((l) => l.trim().length > 0).map((l) => normaliseRepoPath(l.slice(2))),
  );
  const classifiedLines = [
    ...candidateLines,
    ...[...(ignored ?? [])]
      .filter((p) => p.endsWith("/"))
      .map((p) => `${p.replace(/\/$/, "")}/driver-observed-residue`)
      .filter((p) => p.length > 0 && !listedPaths.has(p))
      .map((p) => `?? ${p}`),
  ];
  const classified = classifyRootDirt(classifiedLines, ignored, exempt, probeResult);
  if (classified.dirt.length > 0) {
    trace("work-driver: consolidated verify — repoRoot dirty, refusing to consolidate");
    const residueNote =
      classified.residue.length > 0
        ? `; ${classified.residue.length} ignored build artifact(s) also present and not counted`
        : "";
    // #1421 fix round — when the probe could not answer, NOTHING was exempted,
    // and a bare "repoRoot is dirty" would have the operator deleting files git
    // had already declared output. The trace goes to stderr; the refusal is
    // what gets read.
    const unknownNote = probeResult === undefined ? "; the ignored-status probe could not run" : "";
    return {
      status: "conflict",
      kind: "dirty-root",
      detail: `repoRoot is dirty (${classified.dirt
        .slice(0, 5)
        .map((l) => l.slice(3))
        .join(
          ", ",
        )}${residueNote}${unknownNote}; consolidated verify skipped — the combination is unverifiable until the root is clean`,
    };
  }
  // A decline is reported only for a root that held a tool's output and nothing
  // the gate charged (`dirt` empty, residue present, and the classifier's own
  // `buildResidueOnly` — never the caller's optimism). It is reported HERE,
  // before the checkout, because everything below mutates repoRoot and a
  // decline is not a verdict on the code, so it must not cost a checkout, a
  // cherry-pick or a verify run.
  if (classified.buildResidueOnly === true && classified.residue.length > 0) {
    trace(
      `work-driver: consolidated verify — repoRoot held ${classified.residue.length} ignored build artifact(s), not dirt: ${classified.residue
        .slice(0, 5)
        .map((r) => r.line.slice(3))
        .join(", ")}`,
    );
    const residuePaths = classified.residue.map((r) => residuePathText(r.line));
    // The paths shown to the operator are stripped of brackets: this text is
    // interpolated into the labelled failure string, and a path spelled
    // `build/[build-residue].log` would otherwise re-create a routing tag
    // inside the prose a reader (or a later matcher) sees. The cap decision
    // never reads this string — it reads the structured `buildResidueOnly`.
    return {
      status: "conflict",
      kind: "build-residue",
      buildResidueOnly: true,
      residuePaths,
      residueReasons: classified.residue.map((r) => r.reason),
      detail: buildResidueFailure(
        residuePaths,
        "the consolidated verify was declined because the repo root is not clean",
      ),
    };
  }
  return undefined;
}
