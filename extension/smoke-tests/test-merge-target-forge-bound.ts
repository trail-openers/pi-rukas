#!/usr/bin/env bun
/**
 * #926 — the merge guard's bounded forge decision (merge-target.ts).
 *
 * readMergeTarget and resolvePrNumber call detectForge internally. Their
 * detectForge call MUST run with allowProbe: false: the guard's tool_call
 * hook already spends its 30s exec budget on gh/git reads, and an unbounded
 * API probe against a non-github/gitlab host would eat the whole budget and
 * could hang the child's turn.
 *
 * The seam: both functions accept an optional DetectForgeOpts argument, and
 * the probe that detectForge would use is taken from that argument. This
 * test injects a canary probe that WOULD classify the unknown host and
 * asserts it is never called — through the guard's own functions, not a
 * detached counter. The control case proves the canary WOULD be called when
 * detectForge is invoked directly with allowProbe: true, so the zero in the
 * guard path is meaningful.
 *
 * Fully offline: git output is injected via `opts.execFn`; the canary probe
 * replaces the network probe wholesale.
 */

import type { DetectForgeOpts, ProbeFn, ProbeKind } from "../src/forge-detect.ts";
import { detectForge } from "../src/forge-detect.ts";
import { readMergeTarget, resolvePrNumber } from "../src/merge-target.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Stub git execFn: a single remote on an unknown (non-github/gitlab) host. */
const stubGit: DetectForgeOpts["execFn"] = async (cmd: string): Promise<{ stdout: string }> => {
  if (cmd === "git config --get remote.origin.url") {
    return { stdout: "git@selfhosted.example.com:owner/repo.git\n" };
  }
  if (cmd === "git config --get remote.upstream.url") {
    return { stdout: "" };
  }
  if (cmd === "git remote") {
    return { stdout: "origin\n" };
  }
  throw new Error(`unexpected exec: ${cmd}`);
};

/** A probe that counts its own calls and WOULD classify the unknown host. */
function makeCanary(count: { calls: number }): ProbeFn {
  return async (_host: string, _kind: ProbeKind) => {
    count.calls += 1;
    return "gitlab";
  };
}

const noEnv: Record<string, string | undefined> = { PI_ENSEMBLE_FORGE: undefined };

const forgeOpts: DetectForgeOpts = {
  execFn: stubGit,
  env: noEnv,
  forgeConfigContent: "",
};

// ---------------------------------------------------------------------------
// 1. readMergeTarget: an unknown-host remote refuses (fail-closed) and the
//    canary probe is never invoked — allowProbe: false inside the guard.
// ---------------------------------------------------------------------------
{
  const count = { calls: 0 };
  forgeOpts.probe = makeCanary(count);
  const r = await readMergeTarget(stubGit, import.meta.dirname, 123, forgeOpts);
  assert(r.ok === false, "#926: readMergeTarget on an unknown-host remote refuses (fail-closed)");
  if (r.ok === false) {
    assert(
      /could not determine the forge/.test(r.reason),
      "#926: the refusal is the forge-unknown refusal, not a PR-read failure",
    );
  }
  assert(
    count.calls === 0,
    `#926: readMergeTarget never invokes the probe (allowProbe: false; got ${count.calls})`,
  );
}

// ---------------------------------------------------------------------------
// 2. resolvePrNumber: an unknown-host remote resolves to undefined
//    (fail-closed) and the canary probe is never invoked.
// ---------------------------------------------------------------------------
{
  const count = { calls: 0 };
  forgeOpts.probe = makeCanary(count);
  const n = await resolvePrNumber(stubGit, import.meta.dirname, undefined, forgeOpts);
  assert(
    n === undefined,
    "#926: resolvePrNumber is undefined on an unknown-host remote (fail-closed)",
  );
  assert(
    count.calls === 0,
    `#926: resolvePrNumber never invokes the probe (allowProbe: false; got ${count.calls})`,
  );
}

// ---------------------------------------------------------------------------
// 3. Control: the same canary WOULD be called when detectForge is invoked
//    directly with allowProbe: true — proving the zero above is the guard's
//    bound, not a broken probe seam.
// ---------------------------------------------------------------------------
{
  const count = { calls: 0 };
  const detection = await detectForge(import.meta.dirname, {
    ...forgeOpts,
    probe: makeCanary(count),
    allowProbe: true,
  });
  assert(
    count.calls === 1,
    `control: detectForge with allowProbe: true DOES invoke the canary (got ${count.calls})`,
  );
  assert(detection.forge === "gitlab", "control: the canary classifies the unknown host as gitlab");
  assert(detection.source === "probe", "control: the forge decision came from the probe");
}

// ---------------------------------------------------------------------------
// 4. Control: allowProbe: false on detectForge itself never invokes the
//    canary — the bound is the one under test, applied by the guard.
// ---------------------------------------------------------------------------
{
  const count = { calls: 0 };
  const detection = await detectForge(import.meta.dirname, {
    ...forgeOpts,
    probe: makeCanary(count),
    allowProbe: false,
  });
  assert(
    count.calls === 0,
    `control: detectForge with allowProbe: false does not invoke the canary (got ${count.calls})`,
  );
  assert(
    detection.forge === "unknown",
    "control: without the probe the unknown host stays unknown",
  );
  assert(detection.source === "unknown", "control: the source is the fail-closed unknown");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
