#!/usr/bin/env bun
/**
 * #798 — dual-target handoff labelling, end-to-end: with `prNumber` set,
 * `runHandoff` verifies the `needs-human-attention` label on BOTH the issue
 * (the entry-gate target) and the PR (the review target), each independently,
 * and the handoff-emitted event records the explicit target + per-target
 * state (`issueLabelApplied` / `prLabelApplied` / `targetType` /
 * `targetNumber`).
 *
 * Covers: (1) both targets verified → labelApplied true; (2) partial
 * failure (issue verified, PR not) → the split is recorded, not collapsed;
 * (3) the no-PR path (prNumber undefined) is unchanged — single-target issue
 * labeling, `prLabelApplied` absent, target is the issue;
 * (4) the host handoff channel never triggers the #798 issue-label write
 * (`applyIssueLabelDualTarget`), which stays outside the fallback try/catch
 * and behind the `!host` guard.
 *
 * Split from `test-work-driver-handoff-event-provenance.ts` (§12 file-size
 * limit): these three cases are self-contained end-to-end `runHandoff`
 * blocks; they share `mkFakeForge` / `cappedState` / `fakePi` via
 * `lib/handoff-provenance-fixtures.ts` (single copy, no drift).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runHandoff } from "../src/work-driver-handoff.ts";
import { cappedState, fakePi, mkFakeForge } from "./lib/handoff-provenance-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// #798 — dual-target (option a) when prNumber is set: the label is verified
// on BOTH the issue (entry-gate target) and the PR (review target), each
// independently, and the event records the explicit target + per-target state.
{
  const dir = mkdtempSync(path.join(tmpdir(), "issue798-dual-"));
  try {
    const { forge } = mkFakeForge({
      issueLabels: ["needs-human-attention"],
      prLabels: ["needs-human-attention"],
    });
    const ctx: DriverContext = {
      host: fakePi,
      repoRoot: dir,
      issue: 782,
      dispatchFn: async () => ({
        role: "ops",
        ok: true,
        text: "posted.\nHANDOFF-RESULT: comment=https://github.com/acme/widget/pull/796#issuecomment-5765303101 label=applied",
        toolUses: [],
        ms: 10,
        exitCode: 0,
        transcriptPath: "/tmp/stub.json",
      }),
      forge,
    };
    const next = await runHandoff(ctx, cappedState(782, 796), Date.now());
    const emitted = next.eventLog.find((e) => e.kind === "handoff-emitted");
    assert(
      emitted?.kind === "handoff-emitted" && emitted.targetType === "pr" && emitted.targetNumber === 796,
      "#798 dual: the event records the explicit target object (pr #796) — no URL parsing needed",
    );
    assert(
      emitted?.kind === "handoff-emitted" &&
        emitted.issueLabelApplied === true &&
        emitted.prLabelApplied === true,
      "#798 dual: the issue label is verified on the ISSUE and the PR label on the PR (per-target, not one boolean)",
    );
    assert(
      emitted?.kind === "handoff-emitted" && emitted.labelApplied === true,
      "#798 dual: both verified → labelApplied: true",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// #798 — partial failure: the issue label verifies, the PR label does not.
// The event must distinguish that from full success AND from the no-PR path
// (where prLabelApplied is absent, not false).
{
  const dir = mkdtempSync(path.join(tmpdir(), "issue798-partial-"));
  try {
    const { forge } = mkFakeForge({
      issueLabels: ["needs-human-attention"],
      prLabels: [], // the PR label is NOT on the PR
    });
    const ctx: DriverContext = {
      host: fakePi,
      repoRoot: dir,
      issue: 782,
      dispatchFn: async () => ({
        role: "ops",
        ok: true,
        text: "posted.\nHANDOFF-RESULT: comment=https://github.com/acme/widget/pull/796#issuecomment-1 label=applied",
        toolUses: [],
        ms: 10,
        exitCode: 0,
        transcriptPath: "/tmp/stub.json",
      }),
      forge,
    };
    const next = await runHandoff(ctx, cappedState(782, 796), Date.now());
    const emitted = next.eventLog.find((e) => e.kind === "handoff-emitted");
    assert(
      emitted?.kind === "handoff-emitted" &&
        emitted.issueLabelApplied === true &&
        emitted.prLabelApplied === false,
      "#798 partial: issue verified, PR NOT — the event records the split (not collapsed into one boolean)",
    );
    assert(
      emitted?.kind === "handoff-emitted" && emitted.labelApplied === false,
      "#798 partial: partial success → labelApplied: false (honest, never a false true)",
    );
    assert(
      emitted?.kind === "handoff-emitted" &&
        emitted.prLabelApplied === false &&
        emitted.issueLabelApplied === true &&
        emitted.targetType === "pr",
      "#798 partial: the per-target fields + explicit target are present (distinguishes this from the no-PR path, where prLabelApplied is absent)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// #798 — no-PR path (prNumber undefined) is unchanged: single-target issue
// labeling, no prLabelApplied field, target is the issue.
{
  const dir = mkdtempSync(path.join(tmpdir(), "issue798-nopr-"));
  try {
    const { forge } = mkFakeForge({ issueLabels: ["needs-human-attention"] });
    const ctx: DriverContext = {
      host: fakePi,
      repoRoot: dir,
      issue: 626,
      dispatchFn: async () => ({
        role: "ops",
        ok: true,
        text: "posted.\nHANDOFF-RESULT: comment=https://github.com/acme/widget/issues/626#issuecomment-1 label=applied",
        toolUses: [],
        ms: 10,
        exitCode: 0,
        transcriptPath: "/tmp/stub.json",
      }),
      forge,
    };
    const next = await runHandoff(ctx, cappedState(626), Date.now());
    const emitted = next.eventLog.find((e) => e.kind === "handoff-emitted");
    assert(
      emitted?.kind === "handoff-emitted" && emitted.targetType === "issue" && emitted.targetNumber === 626,
      "#798 no-PR: target is the issue (explicit, not inferred)",
    );
    assert(
      emitted?.kind === "handoff-emitted" &&
        emitted.issueLabelApplied === true &&
        emitted.prLabelApplied === undefined,
      "#798 no-PR: issueLabelApplied true, prLabelApplied ABSENT (not false) — pre-#798 no-PR shape preserved",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The #798 issue-label write (`applyIssueLabelDualTarget` + fresh read-back)
// was moved into `deliverHandoff` by the §12 code-split — inside the fallback's
// swallow-all try/catch, and with the `!host` guard dropped. On the host
// channel (#1327) that meant the driver labelled the issue the host owns.
// `prLabelApplied` is false in this fixture, so the fallback always enters and
// would reach the label write on its own: only the `!host` guard keeps it out.
{
  const dir = mkdtempSync(path.join(tmpdir(), "issue798-host-"));
  const env = "PI_ENSEMBLE_HANDOFF_CHANNEL";
  const saved = process.env[env];
  try {
    process.env[env] = "host";
    const { forge, calls } = mkFakeForge({
      issueLabels: [],
      prLabels: [],
    });
    // `scratchDir`/handoff body are absent on the host path; make the body
    // file real so the fallback leg runs to the point the label write sat at.
    mkdirSync(path.join(dir, "tmp", "issue-799"), { recursive: true });
    writeFileSync(path.join(dir, "tmp", "issue-799", "handoff-comment.md"), "# body", "utf8");
    const ctx: DriverContext = {
      host: fakePi,
      repoRoot: dir,
      issue: 799,
      dispatchFn: async () => ({
        role: "ops",
        ok: true,
        text: "posted.\nHANDOFF-RESULT: comment=https://github.com/acme/widget/pull/800#issuecomment-1 label=applied",
        toolUses: [],
        ms: 10,
        exitCode: 0,
        transcriptPath: "/tmp/stub.json",
      }),
      forge,
    };
    const next = await runHandoff(ctx, cappedState(799, 800), Date.now());
    const labelWrites = calls.filter((c) => c.method === "labelCreate" || c.method === "labelAdd");
    assert(
      labelWrites.length === 0,
      `#798 host channel: with host true the driver makes NO issue-label write — applyIssueLabelDualTarget is not called (saw: ${labelWrites.map((c) => `${c.method}(${c.args.join(",")})`).join(", ") || "none"})`,
    );
    const emitted = next.eventLog.find((e) => e.kind === "handoff-emitted");
    assert(
      emitted?.kind === "handoff-emitted" && emitted.delivery === "host",
      "#798 host channel: the handoff still records the host delivery",
    );
  } finally {
    if (saved === undefined) delete process.env[env];
    else process.env[env] = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
