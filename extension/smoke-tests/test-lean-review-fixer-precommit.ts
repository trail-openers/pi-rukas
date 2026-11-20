#!/usr/bin/env bun
/**
 * `developer-session-continuation` — the two refusals that must land BEFORE a child exists.
 *
 * Sibling of `test-lean-review-fixer-bound.ts`, split out for the 500-line gate (AGENTS §12) and
 * sharing its harness through `lib/lean-continuation-child.ts`. That file pins the child that comes
 * UP; this one pins the two directions on which nothing must come up at all, because both are cheap
 * to delete by accident and neither leaves a symptom downstream:
 *
 *   (7a) the guard-companion preflight — the argv names `CHILD_GUARDS_PATH`, so a companion that
 *        cannot be resolved must be a NAMED failure and NO child, exactly as `spawnSpecialistInner`
 *        refuses rather than starting an unguarded specialist. A resumed child with no companion
 *        would run with none of the mode-independent guards while looking, to the wave, like a
 *        continuation that ran.
 *   (7b) the role gate — the step hands this module `DispatchResult.role`, a field of a CHILD-AUTHORED
 *        record, so anything other than the fixer's own role is refused with no spawn and an outcome
 *        that says so, traced with the role it was handed. A child that claimed a reviewer role would
 *        otherwise resume the session with the developer's write tools and the developer's fence.
 *
 * The companion is made unresolvable the way `test-adversarial-verdict-reask-spawn-failure.ts` makes
 * ITS targets unreachable: a subprocess moves it aside and restores it around the call, so the real
 * `statSync` of the real path fails for the real reason — no `node:fs` mock, whose ESM namespace is
 * read-only under bun and which would report a pass for the wrong reason.
 *
 * No child spawned, no token spent.
 */

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CHILD_GUARDS_PATH } from "../src/child-guards.ts";
import {
  CONTINUATION_SOURCE_TAG,
  type ContinuationOutcome,
  spawnDeveloperContinuationChild,
} from "../src/developer-session-continuation.ts";
import { FIXER_ROLE } from "../src/lean/step-budget.ts";
import {
  FENCE,
  agentEnd,
  child,
  disposables,
  scratch,
} from "./lib/lean-continuation-child.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { cleanupRoots } from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

const baseArgs = (transcriptPath: string) => ({
  transcriptPath,
  role: "developer",
  cwd: FENCE.root,
  writeFence: { ...FENCE },
  boundMs: 60_000,
  prompt: "Your previous turn was cut off — go straight to the edit.",
});

// ── (7a) THE GUARD-COMPANION PREFLIGHT ────────────────────────────────────────
{
  // The canary that the arm below is not vacuous: with the companion on disk — the state every other
  // test file in this run depends on, and the state it is in for the case after this one — the SAME
  // call does spawn its child. Without it, a preflight that simply never ran would read as a pass.
  const present = child([agentEnd({ text: "done", stopReason: "end_turn" })]);
  const okOut = await spawnDeveloperContinuationChild(
    baseArgs(scratch("fixer-session-preflight.json")),
    { spawn: present.spawn },
  );
  assert(
    okOut.ok === true && present.seen().argv.length > 0,
    `(7a) precondition: with the companion on disk the same call spawns its child (${JSON.stringify(okOut)})`,
  );

  // The probe is run as a FILE by the same interpreter, the way its sibling runs a fault-injection
  // child. The companion path is passed IN rather than re-imported, so the file the probe moves is
  // byte-identical to the one `CHILD_GUARDS_PATH` names here — the probe cannot move a file this
  // process then checks for.
  const probe = join(import.meta.dirname, "lib", "lean-continuation-preflight-probe.ts");
  const moved = spawnSync(process.execPath, [probe, CHILD_GUARDS_PATH], {
    encoding: "utf8",
    timeout: 60_000,
  });
  // The probe answers with one JSON line on stdout and nothing else; anything else is the arm NOT
  // having run, which must fail loudly rather than read as a missing-companion pass.
  let probed: {
    spawned: boolean;
    ok: boolean;
    reason?: string;
    preflightNamed: boolean;
    crashed: boolean;
  } = { spawned: false, ok: true, preflightNamed: false, crashed: true };
  try {
    probed = JSON.parse(moved.stdout.trim()) as typeof probed;
  } catch {
    /* left as the sentinel — the assertions below name the arm instead */
  }
  assert(
    isAbsolute(CHILD_GUARDS_PATH) && moved.status === 0 && probed.crashed === false,
    `(7a) the probe ran to completion, so the companion was unresolvable for its duration and restored after (${moved.status}; ${moved.stderr.slice(0, 160)})`,
  );
  assert(
    probed.preflightNamed === true,
    `(7a) a missing guard companion is a NAMED failure — the trace carried the preflight's own error with its remedy, so an operator can tell a wedged install from any other preparation fault (${JSON.stringify(probed)})`,
  );
  assert(
    probed.spawned === false,
    `(7a) and the refusal spawned NOTHING — an unresolvable companion never produces an unguarded child (${JSON.stringify(probed)})`,
  );
  assert(
    probed.ok === false && probed.reason === "spawn-failed",
    `(7a) and the outcome the step reads is a failure, not a silently-continued wave (${JSON.stringify(probed)})`,
  );
  assert(
    existsSync(CHILD_GUARDS_PATH),
    "(7a) and the companion is back where it was — the probe restores it, so no later test in this run sees a missing file",
  );
}

// ── (7b) THE ROLE GATE ────────────────────────────────────────────────────────
{
  // A child that reports a role other than the fixer's is refused with no spawn and a named outcome,
  // and the trace names the role it was handed. The trace is captured by replacing this process's
  // stderr writer for the duration of the one call: `trace()` gates on the env switch it reads per
  // call, so the switch is set here and put back exactly.
  const refused = child([agentEnd({ text: "done", stopReason: "end_turn" })]);
  const priorDebug = process.env.PI_ENSEMBLE_DEBUG;
  process.env.PI_ENSEMBLE_DEBUG = "1";
  const errLines: string[] = [];
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string | Uint8Array) => {
    errLines.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  let unknown: ContinuationOutcome;
  try {
    unknown = await spawnDeveloperContinuationChild(
      { ...baseArgs(scratch("fixer-session-unknown-role.json")), role: "not-a-role" },
      { spawn: refused.spawn },
    );
  } finally {
    process.stderr.write = writeErr;
    if (priorDebug === undefined) delete process.env.PI_ENSEMBLE_DEBUG;
    else process.env.PI_ENSEMBLE_DEBUG = priorDebug;
  }
  assert(
    unknown.ok === false && unknown.reason === "unverified-role",
    `(7b) an unknown role is refused as “unverified-role”, never as a role this module can continue (${JSON.stringify(unknown)})`,
  );
  assert(
    refused.seen().argv.length === 0,
    "(7b) and the refusal spawned nothing — a refused role never reaches the child",
  );
  assert(
    errLines.some((l) => l.includes(CONTINUATION_SOURCE_TAG) && l.includes('"not-a-role"')),
    `(7b) and the trace names the role it refused, so a log says WHO was refused (${JSON.stringify(errLines)})`,
  );
  // The gate is on the fixer's role, not on "is this a role at all": a real, known role that is not
  // the fixer's is refused exactly the same way. That is the arm the reviewer-exclusion strip in
  // `continuationChildArgs` cannot cover on its own — with the strip deleted, a claimed reviewer role
  // would still spawn a developer-tooled child.
  const knownRole = child([agentEnd({ text: "done", stopReason: "end_turn" })]);
  const reviewer = await spawnDeveloperContinuationChild(
    { ...baseArgs(scratch("fixer-session-reviewer-role.json")), role: "adversarial-developer" },
    { spawn: knownRole.spawn },
  );
  assert(
    reviewer.ok === false && reviewer.reason === "unverified-role",
    `(7b) and a REAL role that is not ${FIXER_ROLE} is refused too — the record's role is the child's own claim, not a validated one (${JSON.stringify(reviewer)})`,
  );
  assert(
    knownRole.seen().argv.length === 0,
    "(7b) and no reviewer child was started either, with its write tools restored",
  );
}

for (const dir of disposables) rmSync(dir, { recursive: true, force: true });
cleanupRoots();
process.exit(failures());
