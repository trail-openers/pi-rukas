#!/usr/bin/env bun
/**
 * #1809 fix round — the collected and consulted base-health channels are TWO
 * channels, and this file is the lock that keeps them that way.
 *
 * The background base probe reports to the develop gate through one call site
 * (`aggregateVerifyOutcome`) and two callbacks:
 *
 *   - **collected** (`onBaseHealthCollected`) — the verdict the gate read, which
 *     the caller persists through `recordDevelopGateEvents` onto
 *     `pipelineState.baseHealthProbe`. That field SURVIVES a develop round (and a
 *     resume in a new process), which is exactly what makes it valuable and what
 *     makes a RED dangerous: the rule "a RED is never cached across rounds" is a
 *     rule about this field.
 *   - **consulted** (`onBaseHealthConsulted`) — the record of the consultation
 *     itself (colour + measured ms), appended as a `driver:base-health` event. It
 *     is a log entry: it states what the gate saw and is never read back as a
 *     verdict.
 *
 * Nothing tested the split until now. A future cleanup that merged the two
 * callbacks — one obvious refactor, since both fire from the same place with the
 * same verdict — would persist a consulted RED into `pipelineState.baseHealthProbe`,
 * and `compareWithBaseline` (which reuses any non-`unknown` cached verdict whose
 * key matches) would then let a later develop round, or a resumed cycle, stand on
 * a red it never ran for.
 *
 * So three things are pinned, and the third is the one a type can carry:
 *
 *  1. a consulted RED leaves `result.baseHealthProbe` UNSET and the state's
 *     `pipelineState.baseHealthProbe` UNSET, while `baseHealthConsulted.status`
 *     says "red" — the colour is reported, not persisted;
 *  2. the converse for a collected GREEN: the verdict reaches the state through
 *     the real recorder, because that reuse is the whole cost argument;
 *  3. `compareWithBaseline` reuses an in-state RED only when it came from this
 *     gate pass's own in-flight probe (`fromInFlightProbe`) — an in-state red
 *     re-probes. The flag lives in the type, so merging the channels in (1) stops
 *     compiling rather than quietly widening what a red may do.
 *
 * Offline: temp git repos for the gate runs only, no dispatch, no spawn, no model.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  awaitInflightBaseHealth,
  clearBaseHealthInflight,
  peekBaseHealthProbe,
  startBaseHealthProbe,
} from "../src/work-driver-base-health-inflight.ts";
import { aggregateVerifyOutcome } from "../src/work-driver-verify-aggregate.ts";
import {
  type BaseHealthConsulted,
  type BaseHealthReport,
  mergeBaseHealthReport,
} from "../src/work-driver-verify-base-health-channels.ts";
import type { BaseHealthProbeOutcome } from "../src/work-driver-verify-base-health.ts";
import { BASELINE_RED_MARKER } from "../src/work-driver-verify-baseline.ts";
import { compareWithBaseline } from "../src/work-driver-verify-baseline-compare.ts";
import { recordDevelopGateEvents } from "../src/work-driver-verify-events.ts";
import { verifyStepOutcome } from "../src/work-driver-verify-pr17.ts";
import type { BaseHealthKey, BaseHealthVerdict } from "../src/workflow-state-schema-base-health.ts";
import {
  CMD,
  aggregateWithProbe,
  changeFailure,
  verdict,
} from "./lib/base-health-channel-harness.ts";
import { RED_GATE, branchState, keyFor } from "./lib/base-health-probe-fixture.ts";
import { realExec } from "./lib/restore-start-ref-fixtures.ts";
import { redGateFixture } from "./lib/verify-baseline-probe-harness.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-bh-channels-"));

try {
  // ── 1 — a CONSULTED RED: reported as a consultation, never collected, never
  // reaches the reusable state field.
  {
    clearBaseHealthInflight();
    const f = await redGateFixture(root, "consulted-red", RED_GATE, {
      "notes.md": "x\n",
      "extra.md": "y\n",
    });
    const bound = (await keyFor(f.repo, f.baseSha, CMD)).tierBoundMs;
    const key: BaseHealthKey = { baseSha: f.baseSha, command: CMD, tierBoundMs: bound };
    startBaseHealthProbe(key, async () => ({
      ran: true,
      ms: 512,
      verdict: verdict(f.baseSha, "red", bound),
      notes: [],
    }));
    const failures = [changeFailure(CMD)];
    const notes: string[] = [];
    let collected: BaseHealthVerdict | undefined;
    let consulted: BaseHealthConsulted | undefined;
    let consultedSeen = false;
    const attributed = await aggregateVerifyOutcome({
      execFn: realExec as never,
      ctx: { host: {}, repoRoot: f.repo, issue: 1809 } as never,
      cmd: CMD,
      baseSha: f.baseSha,
      suiteTimeoutMs: bound,
      cons: {
        status: "failed",
        detail: failures[0],
        rawFailure: failures[0],
        timedOut: false,
      } as never,
      perWorktreeVerifyFailures: [],
      failures,
      notes,
      onBaseHealth: (report) => {
        collected = report.collected;
        consulted = report.consulted;
        consultedSeen = report.consulted !== undefined;
      },
    });
    assert(attributed === false, "consulted red: no #1349 excuse from a colour with no stream");
    assert(
      consultedSeen && consulted?.status === "red",
      `consulted red: baseHealthConsulted.status is "red" (got ${consulted?.status ?? "unset"})`,
    );
    assert(
      collected === undefined,
      `consulted red: the COLLECTED channel carries nothing (got ${collected?.status ?? "unset"}) — this is the split`,
    );
    // And the caller's half: recording a result that collected nothing leaves the
    // state's reusable field untouched.
    const withRed = recordDevelopGateEvents(branchState(f.baseSha), {
      baseHealthConsulted: { status: "red", baseSha: f.baseSha, ms: 512, ran: true },
    } as never);
    assert(
      withRed.pipelineState.baseHealthProbe === undefined,
      "consulted red: the recorder leaves pipelineState.baseHealthProbe UNSET",
    );
    assert(
      withRed.eventLog.some(
        (e) =>
          e.kind === "dispatch-completed" &&
          (e as { label?: string }).label === "driver:base-health" &&
          (e as { summary?: string }).summary?.includes("RED"),
      ),
      "consulted red: the consultation is still RECORDED — as an event naming the colour",
    );
  }

  // ── 2/3 — both colours driven through the aggregate leg, then recorded by the
  // real recorder. GREEN is collected into the reusable state field; RED is not, and
  // the consultation that names it still is.
  for (const colour of ["green", "red"] as const) {
    const g = await aggregateWithProbe(
      root,
      `agg-${colour}`,
      // The verdict must speak for the gate's OWN base and bound — a verdict for
      // some other commit matches nothing and is read as "no probe ran", which is
      // how a case of this shape goes vacuous while still printing its assertions.
      (baseSha, tierBoundMs) => ({
        ran: true,
        ms: 512,
        verdict: verdict(baseSha, colour, tierBoundMs),
        notes: [],
      }),
    );
    assert(
      g.probeStarted === 1,
      `${colour}: the gate consulted the registry for its own key (probeStarted=${g.probeStarted}) — without this the assertions below pass on a gate that never got that far`,
    );
    if (colour === "green") {
      assert(
        g.collected?.status === "green",
        `collected green: the collected channel carries the GREEN (got ${g.collected?.status ?? "unset"}) — the converse of the red case`,
      );
      assert(
        g.consulted?.status === "green",
        "collected green: the consultation is reported alongside the verdict",
      );
      assert(
        g.recorded.pipelineState.baseHealthProbe?.status === "green",
        "collected green: the real recorder writes it to pipelineState.baseHealthProbe — that reuse is the point of the field",
      );
    } else {
      assert(
        g.collected === undefined,
        `consulted red: the collected channel carries NOTHING (got ${g.collected?.status ?? "unset"}) — the split, at the producer`,
      );
      assert(
        g.consulted?.status === "red",
        `consulted red: the consultation still says RED (got ${g.consulted?.status ?? "unset"})`,
      );
      assert(
        g.recorded.pipelineState.baseHealthProbe === undefined,
        "consulted red: the recorder leaves pipelineState.baseHealthProbe UNSET — a later round re-probes",
      );
      assert(
        g.failures.some((x) => x.startsWith(BASELINE_RED_MARKER)),
        "consulted red: the [baseline-red] finding still leads — keeping it out of state does not lose the park",
      );
    }
  }

  // ── 4 — the reuse rule itself: an in-state RED is unreusable, an in-state
  // GREEN and an in-flight RED both skip the second suite run.
  {
    const base = "c".repeat(40);
    const key: BaseHealthKey = { baseSha: base, command: CMD, tierBoundMs: 1_000 };
    const probeCalls: string[] = [];
    // A RED base: the executor's failure carries a `FAILED:` line, which is the
    // dialect the assertion extractor reads. A resolved run means green, so an
    // (a)-style case that returned `{stdout: ""}` would "pass" by judging the
    // base green and (d)'s anti-vacuity would be the only honest assertion left.
    const redExec = (async (cmd: string, o?: { argv?: string[] }) => {
      const line = o?.argv ? [cmd, ...o.argv].join(" ") : cmd;
      probeCalls.push(line);
      if (line.includes("worktree add")) return { stdout: "" };
      if (line.includes("worktree remove")) return { stdout: "" };
      const e = new Error(`Command failed: ${cmd}`) as Error & {
        stdout?: string;
        stderr?: string;
        code?: number;
      };
      e.stdout = "FAILED: tests/test-red.ts: expected 1, got 2";
      e.stderr = "";
      e.code = 1;
      throw e;
    }) as never;
    const common = {
      repoRoot: "/nonexistent",
      baseSha: base,
      issue: 1809,
      cmd: CMD,
      timeoutMs: key.tierBoundMs,
      changeFailures: [{ text: "1 failed", timedOut: false }],
    };

    // (a) an in-state RED: no reuse, so the probe runs (the worktree add proves it).
    const notes: string[] = [];
    const failures: string[] = [];
    const v1 = await compareWithBaseline(redExec, {
      ...common,
      failures,
      notes,
      cachedVerdict: verdict(base, "red", key.tierBoundMs),
    });
    assert(
      probeCalls.some((l) => l.includes("git worktree add")),
      "in-state red: NOT reused — the comparison paid for its own probe run",
    );
    assert(
      !notes.some((n) => n.includes("reused the cycle's RED")),
      "in-state red: no reuse note — nothing was reused",
    );
    assert(v1 !== undefined, "in-state red: the fresh probe still judged the base red");

    // (b) the same RED, flagged as this gate pass's in-flight probe: reused, and
    // no second suite run.
    probeCalls.length = 0;
    const notes2: string[] = [];
    const v2 = await compareWithBaseline(redExec, {
      ...common,
      failures: [],
      notes: notes2,
      // The flag itself, not the `verdict()` helper plus a spread: a helper that
      // returned `BaseHealthVerdict` would widen the literal to the un-flagged
      // type and the case would silently stop exercising the in-flight arm.
      cachedVerdict: {
        status: "red",
        baseSha: base,
        command: CMD,
        tierBoundMs: key.tierBoundMs,
        fromInFlightProbe: true,
      },
    });
    assert(
      !probeCalls.some((l) => l.includes("git worktree add")),
      "in-flight red: reused — no throwaway tree was built for a verdict this pass earned",
    );
    assert(
      notes2.some((n) => n.includes("reused the background base probe's RED")),
      "in-flight red: the note names the channel it came from",
    );
    assert(v2?.status === "red", "in-flight red: the reused colour is still reported to the cap");

    // (c) an in-state GREEN: reused from the state, as a resumed cycle needs.
    probeCalls.length = 0;
    const notes3: string[] = [];
    const v3 = await compareWithBaseline(redExec, {
      ...common,
      failures: [],
      notes: notes3,
      cachedVerdict: verdict(base, "green", key.tierBoundMs),
    });
    assert(
      !probeCalls.some((l) => l.includes("git worktree add")),
      "in-state green: reused — a resumed cycle does not re-pay for a green it judged",
    );
    assert(v3 === undefined, "in-state green: a green base excuses nothing and fails nothing");

    // (d) anti-vacuity: with no cached verdict at all the probe runs.
    probeCalls.length = 0;
    await compareWithBaseline(redExec, { ...common, failures: [], notes: [] });
    assert(
      probeCalls.some((l) => l.includes("git worktree add")),
      "anti-vacuity: with no cached verdict the probe runs — so the (b)/(c) passes above mean reuse happened",
    );
  }

  // ── 5 — a consulted RED's colour reaches the operator: the finding leads the
  // failures whether it came from a fresh probe or from this pass's registry read.
  {
    const f = await redGateFixture(root, "red-finding", RED_GATE, {
      "notes.md": "x\n",
      "extra.md": "y\n",
    });
    const bound = (await keyFor(f.repo, f.baseSha, CMD)).tierBoundMs;
    startBaseHealthProbe({ baseSha: f.baseSha, command: CMD, tierBoundMs: bound }, async () => ({
      ran: true,
      ms: 300,
      verdict: verdict(f.baseSha, "red", bound),
      notes: [],
    }));
    const failures = [changeFailure(CMD)];
    let established = false;
    await aggregateVerifyOutcome({
      execFn: realExec as never,
      ctx: { host: {}, repoRoot: f.repo, issue: 1809 } as never,
      cmd: CMD,
      baseSha: f.baseSha,
      suiteTimeoutMs: bound,
      cons: {
        status: "failed",
        detail: failures[0],
        rawFailure: failures[0],
        timedOut: false,
      } as never,
      perWorktreeVerifyFailures: [],
      failures,
      notes: [],
      onBaselineRedEstablished: (e) => {
        established = e;
      },
    });
    assert(
      failures[0]?.startsWith(BASELINE_RED_MARKER) === true,
      "consulted red: the [baseline-red] finding still leads the failures",
    );
    assert(
      established,
      "consulted red: the cap's claim is raised — keeping it out of state does not lose the park",
    );
  }
  // ── 6 — the consultation event's `ms` IS the probe's measured time (#1809 fix
  // round). The recorder used to derive it from a `baseHealthStartedAt` no
  // production caller supplied, so every consultation logged as `ms: 0` and the
  // operator read a probe that ran a nine-minute suite as though it had run
  // nothing. The duration now comes from the consultation's own `ms`.
  {
    const PROBED_MS = 4321;
    for (const ms of [PROBED_MS, undefined]) {
      const logged = recordDevelopGateEvents(branchState("a".repeat(40)), {
        baseHealthConsulted: {
          status: "green",
          baseSha: "a".repeat(40),
          ...(ms === undefined ? {} : { ms }),
        },
      } as never);
      const ev = logged.eventLog.find(
        (e) =>
          e.kind === "dispatch-completed" &&
          (e as { label?: string }).label === "driver:base-health",
      ) as { ms?: number; summary?: string } | undefined;
      assert(
        ev !== undefined && ev.ms === (ms ?? 0),
        `event ms: a probe that measured ${ms ?? "nothing"} ms logs ${ev?.ms} ms, not 0 by default (${JSON.stringify(ev?.ms)})`,
      );
      assert(
        ev?.summary?.includes(ms === undefined ? "no suite run of its own" : `${ms} ms`) === true,
        `event ms: the note states the probe's own measured cost (${ev?.summary})`,
      );
    }
  }

  // ── 7 — the ONE channel shape carries both halves when they arrive apart.
  //
  // `verifyStepOutcome`'s receiver used to assign both halves unconditionally from
  // a two-positional-parameter callback, so the second call (`consulted` alone)
  // overwrote the first (`collected` alone) and the gate result reported a
  // consultation with no verdict — the same erasure the aggregate leg had fixed one
  // layer below. `mergeBaseHealthReport` is the fold every receiver now applies;
  // these are the cases that make the erasure fail loudly instead of quietly.
  {
    const green = verdict("b".repeat(40), "green", 1_000);
    const record: BaseHealthConsulted = { status: "green", baseSha: "b".repeat(40), ms: 500 };
    // (a) the erasure shape: two calls, each carrying one half.
    let acc: BaseHealthReport = {};
    acc = mergeBaseHealthReport(acc, { collected: green });
    acc = mergeBaseHealthReport(acc, { consulted: record });
    assert(
      acc.collected?.status === "green" && acc.consulted?.status === "green",
      `fold: two separate calls leave BOTH halves (collected=${acc.collected?.status ?? "unset"}, consulted=${acc.consulted?.status ?? "unset"}) — the exact shape that used to erase`,
    );
    // (b) the reverse order, because the erasure did not care which half came first.
    let acc2: BaseHealthReport = {};
    acc2 = mergeBaseHealthReport(acc2, { consulted: record });
    acc2 = mergeBaseHealthReport(acc2, { collected: green });
    assert(
      acc2.collected?.status === "green" && acc2.consulted?.status === "green",
      "fold: the order of the two calls does not decide which half survives",
    );
    // (c) the anti-vacuity: a report that carries NEITHER half must not invent one,
    // so (a) is not passing because the fold defaults everything to something.
    let acc3: BaseHealthReport = {};
    acc3 = mergeBaseHealthReport(acc3, {});
    assert(
      acc3.collected === undefined && acc3.consulted === undefined,
      "fold: an empty report adds nothing — so (a) means the fold kept what was given",
    );
    // (d) a real report replaces the half it carries and keeps the other.
    const later = mergeBaseHealthReport(acc, {
      consulted: { status: "red", baseSha: "b".repeat(40) },
    });
    assert(
      later.collected?.status === "green" && later.consulted?.status === "red",
      "fold: a later report updates only the half it carries",
    );
  }
  // ── 8 — the consultation is the DEVELOP step's, not commit-pr's (#1809 fix
  // round). `verifyStepOutcome` answers for both steps, and only develop has a
  // probe to consult. The assertion is about the WAIT, which is what a commit-pr
  // consultation would cost: `awaitInflightBaseHealth` is the sole reader of the
  // single-flight registry — the aggregate leg, and only the aggregate leg, calls
  // it — so a commit-pr that consulted would take the entry, run the probe thunk,
  // and settle the entry. A probe that is still PENDING after the step returned
  // is therefore proof the step never awaited it, and unlike the settled-entry
  // counter (which a probe that auto-settles clears whatever happened) this one
  // cannot be satisfied by a step that did consult.
  {
    clearBaseHealthInflight();
    const f = await redGateFixture(root, "commit-pr-no-probe", RED_GATE, { "notes.md": "x\n" });
    mkdirSync(path.join(f.repo, ".pi"), { recursive: true });
    writeFileSync(path.join(f.repo, ".pi", "verify-cmd"), `${CMD}\n`);
    const bound = (await keyFor(f.repo, f.baseSha, CMD)).tierBoundMs;
    const key = { baseSha: f.baseSha, command: CMD, tierBoundMs: bound };
    // A probe that NEVER settles: the only way to tell "the step never awaited it"
    // from "the step awaited it and it answered", because an auto-settling probe
    // clears the registry on its own the instant it is registered.
    startBaseHealthProbe(key, () => new Promise<BaseHealthProbeOutcome>(() => {}));
    const st = branchState(f.baseSha);
    st.pipelineState.worktrees = { default: f.worktrees.a };
    st.pipelineState.workstreams = {
      default: { id: "default", scope: "s", paths: [], outOfScope: [] },
    };
    const ctx = {
      host: { sendUserMessage: () => {} } as never,
      repoRoot: f.repo,
      issue: 1809,
      verifyExecFn: realExec as never,
    } as never;
    const gate = await verifyStepOutcome(ctx, st, "commit-pr");
    assert(
      peekBaseHealthProbe(key) !== undefined,
      "commit-pr: the probe was STILL UNANSWERED when the step returned — the step never awaited it, which is the wait commit-pr must not pay for",
    );
    assert(
      gate.baseHealthConsulted === undefined && gate.baseHealthProbe === undefined,
      `commit-pr: the gate result carries NEITHER half of a report (consulted=${gate.baseHealthConsulted?.status ?? "unset"}, collected=${gate.baseHealthProbe?.status ?? "unset"}) — nothing to record`,
    );
    // The paired control: a develop-shaped lookup on the SAME entry does reach it,
    // so the assertion above is about the step and not about an unreadable registry.
    const developed = await awaitInflightBaseHealth(key, 50);
    assert(
      developed === undefined,
      "commit-pr control: the bounded develop-shaped read of a probe that never answers is 'nothing' — the registry itself is readable, so commit-pr's non-await above is the gate's own choice",
    );
  }
} finally {
  clearBaseHealthInflight();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
