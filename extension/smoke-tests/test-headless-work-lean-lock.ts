#!/usr/bin/env bun
/**
 * epic #1883 — the two `work-lean` verb behaviours that reach beyond the verb's
 * own document: the LOCK refusal and the HEADLESS TRUST thread. Split from
 * `test-headless-work-lean.ts` (AGENTS.md §12 size limit) because these are the
 * cases that drive the real engine, the real lock and the real dispatch seam,
 * while the sibling file drives the verb through an injected `run`.
 *
 *   a held lock / an unreadable lock path → 40, error.code "refused"
 *   a schema violation                    → 30, error.code "crash"
 *   the type, not the wording              → LeanLockError is the whole test
 *   headless children                      → workCycleTrust, threaded per run
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { mock } from "bun:test";
import os from "node:os";
import path from "node:path";
import { runWorkLeanVerb } from "../src/headless/work-lean.ts";
import { buildDeps } from "../src/lean/build.ts";
import { challengeDeps } from "../src/lean/challenge.ts";
import { leanChildOpts } from "../src/lean/child-opts.ts";
import { runWorkLean, specifyDeps } from "../src/lean/command.ts";
import { acquireLock, LeanLockError } from "../src/lean/lock.ts";
import { leanLockFile } from "../src/lean/state.ts";
import { LeanStateError } from "../src/lean/state.ts";
import { makeAssert, runVerb } from "./headless-verb-harness.ts";
import { SRC, spawnProbe, verbThrowing } from "./lib/work-lean-verb-fixture.ts";

const { assert, state } = makeAssert();

// ── (a) a held lock is a refusal, not a crash — decided by the TYPE.
{
  const r = await verbThrowing(
    ["7"],
    new LeanLockError("run already in progress (host 1 2 3) for issue 7"),
  );
  assert(r.ran, "the run ran before it refused");
  assert(r.violations.length === 0, `held lock: output contract (${r.violations.join("; ")})`);
  assert(r.code === 40, `a held lock exits 40 (got ${r.code})`);
  assert((r.doc.error as { code?: string })?.code === "refused", "refused: error.code");
  assert(
    String((r.doc.error as { message?: string })?.message).includes("already in progress"),
    "refused: the lock's own message is kept",
  );
  // The class is the whole mechanism, so the wording does not have to be
  // recognised: a refusal carrying ANY message is still a refusal, because
  // `acquireLock` raises this class and nothing else raises it.
  const odd = await verbThrowing(["7"], new LeanLockError("EEXIST on the lock path"));
  assert(odd.code === 40, `a LeanLockError with any wording exits 40 (got ${odd.code})`);
  assert(
    (odd.doc.error as { code?: string })?.code === "refused",
    "a LeanLockError with any wording is still refused",
  );
  // The converse: wording alone is NOT a refusal any more. A plain Error that
  // quotes lock.ts's own words is not a lock refusal — the type is the answer,
  // and a reworded or wrapped refusal is reported as the crash the verb can
  // actually justify.
  const wording = await verbThrowing(
    ["7"],
    new Error("lock unreadable: /x/.pi/lean-state/7.json.lock"),
  );
  assert(
    wording.code === 30,
    `wording without the class is a crash, not a refusal (got ${wording.code})`,
  );
  assert(
    (wording.doc.error as { code?: string })?.code === "crash",
    "wording without the class reports error.code crash",
  );
  // A refusal is NOT traced: it is an expected answer a host re-runs around, and
  // a warning for it would train whoever reads stderr to ignore warnings.
  const refusedProbe = await spawnProbe(
    `const run = async () => { const e = new LeanLockError("run already in progress (host 1 2 3) for issue 7"); e.stack = "boom"; throw e; };`,
    true,
  );
  assert(
    !refusedProbe.includes("[pi-rukas] WARN"),
    "a lock refusal writes no warning trace — only a crash does",
  );
  assert(
    refusedProbe.includes("work-lean: #7 refused"),
    "a refusal still tells the host what happened, on the document's own channel",
  );
}

// ── (b) the refusals the REAL engine produces, through the verb.
{
  const repo = await mkdtemp(path.join(os.tmpdir(), "work-lean-lock-"));
  const holder = acquireLock(repo, 7);
  const locked = await runVerb("work-lean", ["7"], repo, (argv, ctx) =>
    runWorkLeanVerb(argv, ctx, (root, issue, opts) => runWorkLean(root, issue, opts)),
  );
  assert(locked.code === 40, `a held lock refuses the real engine at 40 (got ${locked.code})`);
  assert(
    (locked.doc.error as { code?: string })?.code === "refused",
    "the real lock refusal is reported as refused",
  );
  let typed = false;
  let liveMessage = "";
  try {
    acquireLock(repo, 7);
  } catch (err) {
    typed = err instanceof LeanLockError;
    liveMessage = err instanceof Error ? err.message : String(err);
  }
  assert(typed, "a live holder's refusal is a LeanLockError");
  assert(
    liveMessage.startsWith("run already in progress"),
    `a live holder names the holder (got ${JSON.stringify(liveMessage)})`,
  );
  holder();
  await rm(repo, { recursive: true, force: true });
}
{
  // The lock PATH is a directory: its bytes cannot be read at all, so this is
  // the branch `readLockBody` answers "unreadable" for — reached through the
  // engine and the verb, not through a message somebody typed.
  const dirLock = await mkdtemp(path.join(os.tmpdir(), "work-lean-dirlock-"));
  mkdirSync(path.join(dirLock, ".pi", "lean-state"), { recursive: true });
  mkdirSync(leanLockFile(dirLock, 7));
  assert(existsSync(leanLockFile(dirLock, 7)), "the fixture really has a directory at the lock path");
  const dirVerb = await runVerb("work-lean", ["7"], dirLock, (argv, ctx) =>
    runWorkLeanVerb(argv, ctx, (root, issue, opts) => runWorkLean(root, issue, opts)),
  );
  assert(dirVerb.code === 40, `a lock path that is a directory refuses at 40 (got ${dirVerb.code})`);
  assert(
    (dirVerb.doc.error as { code?: string })?.code === "refused",
    "a lock path that is a directory is reported as refused",
  );
  let dirTyped = false;
  let dirMessage = "";
  try {
    acquireLock(dirLock, 7);
  } catch (err) {
    dirTyped = err instanceof LeanLockError;
    dirMessage = err instanceof Error ? err.message : String(err);
  }
  assert(dirTyped, "a lock path that is a directory raises LeanLockError from acquireLock itself");
  assert(
    dirMessage.startsWith("lock unreadable:"),
    `the directory lock reaches the unreadable-body branch (got ${JSON.stringify(dirMessage)})`,
  );
  await rm(dirLock, { recursive: true, force: true });
}

// ── (c) a schema violation is NOT a refusal, even quoting every lock phrase.
{
  const schema = await verbThrowing(
    ["7"],
    new LeanStateError("/x/.pi/lean-state/7.json: outcome prUrl must be an https URL"),
  );
  assert(schema.code === 30, `a schema violation is a crash, not a refusal (got ${schema.code})`);
  assert(
    (schema.doc.error as { code?: string })?.code === "crash",
    "a schema violation reports error.code crash",
  );
  const lockWords = await verbThrowing(
    ["7"],
    new LeanStateError(
      "run already in progress: lock unreadable, cannot lock, cannot clear the stale lock",
    ),
  );
  assert(
    lockWords.code === 30,
    `a LeanStateError quoting every lock phrase is still a crash (got ${lockWords.code})`,
  );

  // Every message `acquireLock` raises, raised as the lock's own class, is a
  // refusal — including the two whose filesystem this test cannot arrange (a
  // `link` that failed for a reason other than EEXIST, and a stale lock that
  // could not be moved aside).
  for (const message of [
    "cannot clear the stale lock /x/.pi/lean-state/7.json.lock: EACCES",
    "cannot lock /x/.pi/lean-state/7.json.lock: EPERM",
  ]) {
    const r = await verbThrowing(["7"], new LeanLockError(message));
    assert(r.code === 40, `"${message.slice(0, 24)}…" exits 40 (got ${r.code})`);
    assert(
      (r.doc.error as { code?: string })?.code === "refused",
      `"${message.slice(0, 24)}…" is reported as refused`,
    );
  }
}

// ── (d) a headless lean run's children carry the /work-cycle trust stamp, and
// an interactive one's do not. The mode is a value threaded from `runWorkLean`
// through `phase1Handlers` into the three deps builders — never a flag on the
// process, because a second lean run in one host must not inherit the first's
// trust.
{
  const headless = leanChildOpts(true);
  assert(headless.workCycleTrust === true, "a headless lean dispatch carries workCycleTrust: true");
  const interactive = leanChildOpts(false);
  assert(interactive.workCycleTrust === false, "an interactive lean run's children carry no stamp");
  assert(Object.keys(interactive).length === 1, "the stamp is the only field it adds");

  const seen: Record<string, unknown>[] = [];
  // The stamp is asserted at the real boundary: `spawnSpecialist` is the only
  // thing a deps builder's `dispatch` calls after spreading the stamp, so
  // intercepting it proves the value reaches a CHILD's options rather than only
  // that some local closure was called with it. Three backticks, by code point.
  const FENCE = String.fromCharCode(0x60, 0x60, 0x60);
  const spawnUrl = new URL("../src/spawn.ts", import.meta.url).href;
  mock.module(spawnUrl, () => ({
    spawnSpecialist: async (_spec: unknown, opts: Record<string, unknown> = {}) => {
      seen.push(opts);
      return {
        role: "developer",
        ok: true,
        text: `SUBMIT_TESTS ${FENCE}json\n[]\n${FENCE}`,
        toolUses: [],
        ms: 1,
        exitCode: 0,
      };
    },
  }));
  for (const mode of [true, false]) {
    seen.length = 0;
    // The three dispatch sites ARE the deps builders' `dispatch`. Calling them
    // directly in both modes is the thread end to end: the value the run was
    // started with is the value the child's spawn options carry.
    const spec = { role: "developer", prompt: "p", cwd: "/wt" } as never;
    const o = { writeFence: undefined, extraArgs: undefined } as never;
    await buildDeps(mode).dispatch(spec, o);
    await challengeDeps(mode).dispatch(spec, o);
    await specifyDeps(mode).dispatch(spec, o);
    assert(
      seen.length === 3 && seen.every((x) => x.workCycleTrust === mode),
      `deps builders built in mode ${mode} stamp all three dispatch sites the same way (got ${JSON.stringify(seen.map((x) => x.workCycleTrust))})`,
    );
  }

  // And the thread is real at the source, not only in the deps builders: every
  // site spreads the call WITH an argument, the verb asks for headless, and the
  // interactive command does not. A site that dropped the argument is a type
  // error; one that passed a literal is caught here. The sources are read AFTER
  // the mock, so the audit cannot pass on a stubbed module.
  const read = (rel: string[]) => readFileSync(path.join(SRC, ...rel), "utf8");
  const sites = [read(["lean", "build.ts"]), read(["lean", "challenge.ts"]), read(["lean", "command.ts"])];
  assert(
    sites.every((src) => /\.\.\.leanChildOpts\(headless\)/.test(src)) &&
      !/\.\.\.leanChildOpts\(\)/.test(sites.join("")),
    "all three lean dispatch sites spread leanChildOpts(headless) with the threaded mode",
  );
  assert(
    /run\(ctx\.repoRoot, issue, \{ headless: true \}\)/.test(read(["headless", "work-lean.ts"])),
    "the headless verb passes { headless: true } to the run",
  );
  const commandBody = sites[2].split("registerWorkLeanCommand")[1] ?? "headless";
  assert(!/headless/.test(commandBody), "the interactive /work-lean command passes no headless option");
}

process.exit(state.exit);
