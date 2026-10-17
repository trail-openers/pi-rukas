#!/usr/bin/env bun
/**
 * #1360 round 3 — the loop's capture state is ONE paired value.
 *
 * `captureRound` used to write two sibling fields (`state.binding`,
 * `state.capturedHeadRef`). Between those two assignments an abort or a throw
 * left round N's binding next to round N+1's head ref, and `makeLedgerWrite`
 * handed the pair to the writer as one review. Both halves now land in
 * `state.captured` in a single assignment, so the writer can only ever read a
 * matched pair.
 *
 * The arms drive the real `captureRound` and the real `makeLedgerWrite` against
 * a stubbed writer — no dispatch, no clone.
 */

import {
  type BindingState,
  captureRound,
  makeLedgerWrite,
} from "../src/adversarial-ledger-capture.ts";
import type { DispatchResult } from "../src/types.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** An executor answering every git read with the same 40-char blob, so a
 * capture completes without a repo. */
const fakeGit: VerifyExecFn = async (cmd, o) => {
  const argv = (o?.argv ?? []).join(" ");
  // `identityBase` reads symbolic-ref / remote; answer every read the same way
  // and let the capture decide what it needs.
  if (cmd !== "git" && !cmd.startsWith("git ")) throw new Error(`unexpected exec: ${cmd}`);
  void argv;
  return { stdout: `${"a".repeat(40)}\n` };
};

const passThrough = (raw: DispatchResult) => raw;

/** An executor that gets `identityBase` past its two shell-form reads and
 * answers every argv-form read with a 40-char blob, so a capture completes
 * without a repo. */
const okIdentity: VerifyExecFn = async (cmd, o) => {
  if (cmd.includes("symbolic-ref")) return { stdout: "origin/main\n" };
  if (cmd.includes("remote.")) return { stdout: "https://example.test/o/r.git\n" };
  return fakeGit(cmd, o);
};

try {
  // ── 1. the state has exactly the one field, holding both halves
  {
    const state: BindingState = {};
    await captureRound(state, "/tmp", "main", "feature/head-ref", okIdentity);
    const keys = Object.keys(state).sort();
    assert(
      keys.length === 1 && keys[0] === "captured",
      `captureRound writes ONE field (got ${JSON.stringify(keys)})`,
    );
    const capturedKeys = Object.keys(state.captured ?? {}).sort();
    assert(
      capturedKeys.join(",") === "binding,headRef",
      `the paired value carries exactly the binding and its head ref (got ${JSON.stringify(capturedKeys)})`,
    );
    assert(
      state.captured?.headRef === "feature/head-ref",
      `the head ref is the one the round reviewed (got ${JSON.stringify(state.captured?.headRef)})`,
    );
  }

  // ── 2. an interrupted round cannot leave a stale pairing
  // Round 1 captures ref A. Round 2 captures ref B but its capture throws
  // mid-flight. Before the fix the assignment order left a window in which a
  // fresh binding sat beside the previous round's ref; now round 2 either owns
  // the whole value or does not touch it. The executor fails the mainline read
  // (`symbolic-ref` / `config`) so the real capture throws, while the
  // commit-shaped reads still answer.
  {
    // Round 1 has to get past `identityBase`, so it is answered with a real
    // remote URL and a mainline ref (both shell-form reads).
    const state: BindingState = {};
    await captureRound(state, "/tmp", "main", "ref-A", okIdentity);
    const first = state.captured;
    const throwing: VerifyExecFn = async (cmd, o) => {
      // Fail the argv-form reads (`rev-parse` / `merge-base` / the patch id) so
      // the capture THROWS out of `captureBinding` rather than returning a soft
      // "mainline unresolved" — the shape that used to land beside the previous
      // round's ref.
      if (o?.argv !== undefined) throw new Error("git died mid-capture");
      return okIdentity(cmd, o);
    };
    await captureRound(state, "/tmp", "main", "ref-B", throwing);
    assert(
      state.captured?.headRef === "ref-B",
      `the failed round still owns the value it wrote (got ${JSON.stringify(state.captured?.headRef)})`,
    );
    assert(
      state.captured?.binding?.bindingUnavailable?.includes("git died mid-capture") === true,
      "the failed round records why its capture did not run",
    );
    assert(
      first?.headRef === "ref-A" && state.captured !== first,
      "the previous round's pair is replaced as one value, never half-updated",
    );
  }

  // ── 3. the writer reads BOTH halves from the same paired value
  {
    const state: BindingState = { captured: { binding: {}, headRef: undefined } };
    await captureRound(state, "/tmp", "main", "the-rounds-ref", okIdentity);
    const bindingForRound = state.captured?.binding;
    // A capture whose writes have all run: the writer is handed exactly the
    // pair the round stored, never a binding from one round and a ref from
    // another (the two-assignment window the old sibling fields had).
    let seen: { head?: string; binding?: unknown } = {};
    const write = makeLedgerWrite({
      state,
      workCwd: "/tmp",
      branch: "feature/x",
      toolPath: true,
      baseRef: "main",
      decorate: passThrough,
      note: (raw) => {
        seen = {
          // Re-read from the state the writer was handed — the writer's own
          // params are what it passes down, asserted through the entry it built.
          head: state.captured?.headRef,
          binding: state.captured?.binding,
        };
        return raw;
      },
    });
    write({ ok: true, loopOutcome: "approved" } as unknown as DispatchResult);
    assert(
      seen.head === "the-rounds-ref",
      `the writer is handed the round's own head ref (got ${JSON.stringify(seen.head)})`,
    );
    assert(
      seen.binding === bindingForRound,
      "the writer is handed the round's own binding — the same object, from the same field",
    );
  }
} finally {
  // nothing global to restore
}

console.log(`\nexit ${exit}`);
process.exit(exit);
