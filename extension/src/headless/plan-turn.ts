/**
 * headless/plan-turn — `pi-rukas-headless plan` as a session of turns (#1471).
 *
 *   plan <descriptor> --start [--type <t>] [--context <text>]
 *   plan --resume <session> --answer <file>
 *   plan --resume <session> --retry
 *   plan --resume <session> --confirm
 *
 * A turn runs the /plan pipeline as a dry run and exits when it has something
 * for the operator: questions (11), or a drafted plan to confirm (12). The
 * operator's answer starts the next turn in the same session; the answers so
 * far travel to the pipeline as context (plan-session.ts). `--retry` runs the
 * turn again with no new answer, after a failed one. Only `--confirm` files,
 * and it files the bytes the last turn showed, exactly once: a write-ahead
 * marker makes a confirm after a cut-off filing look for the issue first.
 *
 * Exit codes: 0 filed (or already filed), 10 duplicate-risk, 11 questions,
 * 12 shown, 40 refused or failed (`error.code` or `failure.reason`),
 * 41 the session is gone (`"lost": true`).
 */

import fs from "node:fs/promises";
import type { Forge } from "../forge.ts";
import { runPlanPipeline } from "../plan-driver.ts";
import { reviewedDigestOf } from "../plan-filing-claim.ts";
import { fileIssue, getPlanForge, planForgeFor } from "../plan-filing.ts";
import { precheckDescriptor } from "../plan-precheck.ts";
import { markerLineOf } from "../plan-provenance.ts";
import { type PlanResult, classifyPlanType } from "../plan-types.ts";
import { validateFinalSpec } from "../plan-validate.ts";
import { EXIT } from "./exit-code.ts";
import {
  type PlanQuestion,
  type PlanSession,
  type TurnStatus,
  lockSession,
  newSession,
  planSessionDir,
  readSession,
  sessionContext,
  sessionProvenance,
  writeSession,
} from "./plan-session.ts";
import type { VerbContext, VerbOutcome } from "./verb.ts";

/** The most an answer file may hold. */
export const MAX_ANSWER_CHARS = 20_000;

export type TurnArgs =
  | { kind: "start"; descriptor: string; type?: PlanResult["type"]; context?: string }
  | { kind: "answer"; id: string; answer: string }
  | { kind: "retry"; id: string }
  | { kind: "confirm"; id: string };

const TURN_EXIT: Record<TurnStatus, number> = {
  question: EXIT.clarification,
  shown: EXIT.shown,
  "duplicate-risk": EXIT.handoff,
  failed: EXIT.refused,
};

function refused(code: string, message: string, extra: Record<string, unknown> = {}): VerbOutcome {
  return {
    exitCode: EXIT.refused,
    doc: {
      subcommand: "plan",
      mode: "turn",
      status: "refused",
      error: { code, message },
      ...extra,
    },
  };
}

function lost(id: string, why: string): VerbOutcome {
  return {
    exitCode: EXIT.lost,
    doc: {
      subcommand: "plan",
      mode: "turn",
      status: "lost",
      lost: true,
      session: { id },
      detail: why,
    },
  };
}

/** Read an answer file; undefined with a reason when it cannot be one. */
export async function readAnswer(file: string): Promise<{ text?: string; error?: string }> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    return { error: `cannot read the answer file: ${(err as Error).message}` };
  }
  if (text.trim() === "") return { error: "the answer file is empty" };
  if (text.length > MAX_ANSWER_CHARS)
    return { error: `the answer is over ${MAX_ANSWER_CHARS} characters` };
  return { text: text.trim() };
}

export async function runPlanTurn(args: TurnArgs, ctx: VerbContext): Promise<VerbOutcome> {
  const dir = await planSessionDir(ctx.repoRoot);
  if (!dir) {
    return refused(
      "no-session-dir",
      "no git directory and no PI_ENSEMBLE_PLAN_SESSION_DIR to keep the session in",
    );
  }
  const fresh =
    args.kind === "start" ? newSession(args.descriptor, args.type, args.context) : undefined;
  const sessionId = fresh ? fresh.id : (args as { id: string }).id;
  ctx.host.sendUserMessage(
    fresh
      ? `plan: session ${sessionId} started — ${fresh.descriptor}`
      : `plan: session ${sessionId} — ${args.kind}`,
    { deliverAs: "steer" },
  );
  // Lock before reading: a run that read first could act on a record another run has since changed.
  const release = await lockSession(dir, sessionId);
  if (!release) {
    return refused("session-busy", "another run holds this session", {
      session: { id: sessionId },
    });
  }
  try {
    let session: PlanSession;
    if (fresh) {
      session = fresh;
      await writeSession(dir, session);
    } else {
      const read = await readSession(dir, sessionId);
      if (read === "missing") return lost(sessionId, "no such session");
      if (read === "corrupt") return lost(sessionId, "the session record cannot be read");
      session = read;
    }
    if (args.kind === "confirm") return await confirm(dir, session, ctx);
    if (session.filed) {
      return refused("already-filed", `this session filed ${session.filed.url}`, {
        session: { id: session.id },
        url: session.filed.url,
      });
    }
    if (args.kind === "answer") {
      session.answers.push({
        turn: session.turn,
        at: new Date().toISOString(),
        asked: session.pending?.questions ?? [],
        shownTitle: session.pending?.status === "shown" ? session.shown?.title : undefined,
        text: args.answer,
      });
    }
    return await turn(dir, session, ctx);
  } finally {
    await release();
  }
}

/** Run one turn: a dry run of the pipeline with every answer so far. */
async function turn(dir: string, s: PlanSession, ctx: VerbContext): Promise<VerbOutcome> {
  s.turn += 1;
  s.shown = undefined;
  s.pending = undefined;
  await writeSession(dir, s);
  const context = sessionContext(s);
  const result = await runPlanPipeline(
    ctx.host,
    {
      descriptor: s.descriptor,
      type: s.type,
      context,
      dryRun: true,
      provenance: sessionProvenance(s.id),
    },
    ctx.repoRoot,
  );
  const { status, questions } = outcomeOf(result, s, context);
  s.pending = { status, questions };
  if (status === "shown" && result.reviewedDigest) {
    s.shown = {
      title: result.title,
      spec: result.spec,
      digest: result.reviewedDigest,
      turn: s.turn,
    };
  }
  await writeSession(dir, s);
  const exitCode = TURN_EXIT[status];
  ctx.host.sendUserMessage(`plan: turn ${s.turn} ${status} (exit ${exitCode})`, {
    deliverAs: "steer",
  });
  return {
    exitCode,
    doc: {
      subcommand: "plan",
      mode: "turn",
      exitCode,
      ...result,
      status,
      session: { id: s.id, turn: s.turn },
      text: textOf(status, result, questions),
      questions,
      ...(result.filingFailure ? { failure: result.filingFailure } : {}),
    },
  };
}

function outcomeOf(
  r: PlanResult,
  s: PlanSession,
  context: string | undefined,
): { status: TurnStatus; questions: PlanQuestion[] } {
  const reason = r.filingFailure?.reason;
  if (reason === "needs-clarification") {
    const pre = precheckDescriptor(classifyPlanType(s.descriptor, s.type), s.descriptor, context);
    return { status: "question", questions: numbered(pre.questions.map((q) => ({ question: q }))) };
  }
  if (reason === "duplicate-risk") return { status: "duplicate-risk", questions: [] };
  if (reason !== undefined || !r.reviewedDigest) return { status: "failed", questions: [] };
  // A shown plan asks what the gate left for the operator: CRITICAL gaps and either/or choices.
  const open = r.gaps.filter(
    (g) => g.severity === "CRITICAL" || g.resolutionType === "operator-decision",
  );
  return {
    status: "shown",
    questions: numbered(open.map((g) => ({ question: g.description, resolution: g.resolution }))),
  };
}

function numbered(qs: { question: string; resolution?: string }[]): PlanQuestion[] {
  return qs.map((q, i) => ({ id: `q${i + 1}`, options: [], ...q }));
}

function textOf(status: TurnStatus, r: PlanResult, questions: PlanQuestion[]): string {
  switch (status) {
    case "question":
      return `The plan needs answers before it can be drafted (${questions.length} question${questions.length === 1 ? "" : "s"}).`;
    case "shown":
      return questions.length > 0
        ? `Drafted plan: ${r.title}. It has ${questions.length} open point${questions.length === 1 ? "" : "s"}: answer them, ask for changes, or confirm to file it as it is.`
        : `Drafted plan: ${r.title}. Ask for changes, or confirm to file it.`;
    case "duplicate-risk":
      return "The plan looks like a duplicate of open work. Answer to explain why it is not, or stop here.";
    case "failed":
      return `The turn failed (${r.filingFailure?.reason ?? "no reviewed spec"}). Run it again with --retry.`;
  }
}

/** File the plan the last turn showed, once. */
async function confirm(dir: string, s: PlanSession, ctx: VerbContext): Promise<VerbOutcome> {
  const session = { id: s.id, turn: s.turn };
  if (s.filed) {
    return filedOutcome(s, { alreadyFiled: true });
  }
  const shown = s.shown;
  if (!shown || s.pending?.status !== "shown") {
    return refused("nothing-to-confirm", "the last turn showed no plan to confirm", { session });
  }
  const digest = reviewedDigestOf(shown.title, shown.spec, { provenance: sessionProvenance(s.id) });
  if (digest !== shown.digest) {
    return refused("shown-plan-changed", "the recorded plan no longer matches what was shown", {
      session,
    });
  }
  const check = validateFinalSpec(shown.title, shown.spec, sessionContext(s));
  if (!check.ok) {
    return failedOutcome(s, { reason: "draft-invalid", detail: check.problems.join("; ") });
  }
  const forge = await (getPlanForge() ?? (() => planForgeFor(ctx.repoRoot)))();
  if (s.filing) {
    // An earlier confirm was cut off and may have filed: look before filing again, and fail
    // closed when the forge cannot answer.
    const search = await filedBySession(forge, s.id);
    if ("error" in search) {
      return failedOutcome(s, {
        reason: "filing-unverified",
        detail: `an earlier confirm of this session may have filed it, and the forge could not be searched to check (${search.error}); nothing was filed`,
      });
    }
    const same = search.hits.find((h) => h.title === shown.title);
    if (same && s.filing.digest === digest) {
      s.filed = { url: same.url, number: same.number, at: new Date().toISOString(), digest };
      s.filing = undefined;
      await writeSession(dir, s);
      ctx.host.sendUserMessage(`plan: session ${s.id} had already filed ${same.url}`, {
        deliverAs: "steer",
      });
      return filedOutcome(s, { recovered: true });
    }
    const earlier = search.hits[0];
    if (earlier) {
      return refused(
        "earlier-plan-filed",
        `an earlier plan of this session was filed as ${earlier.url}; nothing was filed`,
        { session, url: earlier.url },
      );
    }
    s.filing = undefined;
  }
  if (!forge) {
    await writeSession(dir, s);
    return failedOutcome(s, { reason: "forge-unresolved" });
  }
  s.filing = { startedAt: new Date().toISOString(), digest };
  await writeSession(dir, s);
  const r = await fileIssue(shown.title, shown.spec, () => Promise.resolve(forge));
  if (r.url) {
    s.filed = { url: r.url, number: r.number, at: new Date().toISOString(), digest };
    s.filing = undefined;
    await writeSession(dir, s);
    ctx.host.sendUserMessage(`plan: session ${s.id} filed ${r.url}`, { deliverAs: "steer" });
    return filedOutcome(s, {});
  }
  // The create call failed, but it may have created the issue: the marker stays.
  return failedOutcome(s, r.failure ?? { reason: "empty-url" });
}

/**
 * The issues, open or closed, whose body carries this session's provenance
 * marker. The search finds candidates; each one's body is read to check the
 * marker, so an issue that only mentions the id in a comment does not count.
 */
async function filedBySession(
  forge: Forge | undefined,
  id: string,
): Promise<{ hits: { url: string; number: number; title: string }[] } | { error: string }> {
  if (!forge) return { error: "no forge resolved" };
  const marker = markerLineOf(sessionProvenance(id));
  try {
    const rows = await forge.issueSearch(id, { allStates: true });
    const hits: { url: string; number: number; title: string }[] = [];
    for (const row of rows) {
      const issue = await forge.issueView(row.number);
      if (issue.body?.includes(marker) && issue.url) {
        hits.push({ url: issue.url, number: issue.number, title: issue.title });
      }
    }
    return { hits };
  } catch (err) {
    return { error: (err as Error).message.split("\n")[0] ?? "search failed" };
  }
}

function filedOutcome(s: PlanSession, extra: Record<string, unknown>): VerbOutcome {
  return {
    exitCode: EXIT.merged,
    doc: {
      subcommand: "plan",
      mode: "turn",
      exitCode: EXIT.merged,
      status: "filed",
      filed: true,
      session: { id: s.id, turn: s.turn },
      title: s.shown?.title,
      url: s.filed?.url,
      issueUrl: s.filed?.url,
      ...(s.filed?.number !== undefined ? { issueNumber: s.filed.number } : {}),
      ...extra,
    },
  };
}

function failedOutcome(s: PlanSession, failure: { reason: string; detail?: string }): VerbOutcome {
  return {
    exitCode: EXIT.refused,
    doc: {
      subcommand: "plan",
      mode: "turn",
      exitCode: EXIT.refused,
      status: "failed",
      filed: false,
      session: { id: s.id, turn: s.turn },
      failure,
    },
  };
}
