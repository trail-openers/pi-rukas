#!/usr/bin/env bun
/**
 * #1471 — `pi-rukas-headless plan` as a session of turns, with stub dispatch
 * and a stub forge (no model call, no issue created):
 *
 *   --start, too-thin descriptor  → 11, the questions and the session id, nothing dispatched
 *   --resume --answer             → the same session; the answer reaches the pipeline;
 *                                   a fileable draft → 12, the spec and its digest
 *   --resume --confirm            → 0, the shown bytes filed once
 *   a second --confirm            → 0, `alreadyFiled`, the forge not called again
 *   --confirm with nothing shown  → 40 `nothing-to-confirm`, nothing filed
 *   a cut-off filing              → the next confirm finds the issue, files nothing
 *   a session that is gone        → 41, `"lost": true`
 *   a CRITICAL open point         → 12, the open point as a question
 *   a live lock                   → 40 `session-busy`
 *   bad arguments                 → 40 `bad-arguments`
 *
 * Every run must hold the S6 output contract: one JSON document on stdout and
 * at least one NDJSON v1 line on stderr.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { issueSearchCmd } from "../src/forge-commands.ts";
import type { Forge } from "../src/forge.ts";
import { readSession, writeSession } from "../src/headless/plan-session.ts";
import { setPlanForge } from "../src/plan-filing.ts";
import { makeAssert, runVerb } from "./headless-verb-harness.ts";
import {
  DESC,
  DUP_NONE,
  GAP_CRITICAL,
  GAP_HIGH,
  REPO,
  installNoPlanCacheStub,
  installOfflineVipuneStub,
  setPlanDispatch,
} from "./plan-test-stubs.ts";

const { assert, state } = makeAssert();
installNoPlanCacheStub();
installOfflineVipuneStub();

const dir = await mkdtemp(path.join(os.tmpdir(), "plan-sessions-"));
process.env.PI_ENSEMBLE_PLAN_SESSION_DIR = dir;

const prompts: string[] = [];
let gateReply = GAP_HIGH;
let dupReply = DUP_NONE;
setPlanDispatch(((_pi: unknown, spec: { role: string; prompt: string }) => {
  prompts.push(spec.prompt);
  const base = { ok: true, toolUses: [], ms: 1, exitCode: 0 };
  if (spec.role === "adversarial-developer")
    return Promise.resolve({ ...base, role: spec.role, text: gateReply });
  if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
    return Promise.resolve({ ...base, role: "explore", text: dupReply });
  }
  return Promise.resolve({
    ...base,
    role: "explore",
    text: "summary prose",
    toolUses: [
      {
        name: "report_plan_item",
        arguments: { kind: "acceptance-criterion", text: "the tool registers", angle: "x" },
      },
    ],
  });
}) as never);

const forge = {
  created: [] as { title: string; body: string }[],
  /** Issues the search finds: number, title and the body issueView returns. */
  found: [] as { number: number; title: string; body: string }[],
  searches: [] as { q: string; allStates?: boolean }[],
  searchFails: false,
  resolves: true,
};
const forgeStub = {
  issueCreate: (title: string, body: string) => {
    forge.created.push({ title, body });
    return Promise.resolve({ url: "https://github.com/test/test/issues/7", number: 7 });
  },
  issueSearch: (q: string, opts?: { allStates?: boolean }) => {
    forge.searches.push({ q, allStates: opts?.allStates });
    if (forge.searchFails) return Promise.reject(new Error("gh: HTTP 502"));
    return Promise.resolve(
      forge.found.map((f) => ({ number: f.number, title: f.title, url: urlOf(f.number) })),
    );
  },
  issueView: (n: number) => {
    const f = forge.found.find((x) => x.number === n);
    return Promise.resolve({
      number: n,
      title: f?.title ?? "",
      body: f?.body ?? "",
      url: urlOf(n),
    });
  },
};
const urlOf = (n: number) => `https://github.com/test/test/issues/${n}`;
setPlanForge(() => Promise.resolve(forge.resolves ? (forgeStub as unknown as Forge) : undefined));

function reset() {
  prompts.length = 0;
  gateReply = GAP_HIGH;
  dupReply = DUP_NONE;
  forge.created.length = 0;
  forge.found.length = 0;
  forge.searches.length = 0;
  forge.searchFails = false;
  forge.resolves = true;
}

/** Start a session whose first turn shows a plan, and mark a filing as cut off. */
async function cutOffSession(
  digest?: string,
): Promise<{ id: string; title: string; spec: string }> {
  const r = await runVerb("plan", [DESC, "--start"], REPO);
  const sid = (r.doc.session as Session).id ?? "";
  const s = await readSession(dir, sid);
  if (typeof s === "object") {
    const filing = { startedAt: new Date().toISOString(), digest: digest ?? s.shown?.digest ?? "" };
    await writeSession(dir, { ...s, filing });
  }
  return { id: sid, title: String(r.doc.title), spec: String(r.doc.spec) };
}

async function answerFile(text: string): Promise<string> {
  const f = path.join(dir, `answer-${Math.random().toString(36).slice(2)}.md`);
  await writeFile(f, text);
  return f;
}

const ANSWER =
  "The login form on /signin rejects valid passwords since the session cookie change in auth.ts";

type Session = { id?: string; turn?: number };
type Question = { id?: string; question?: string; options?: unknown[] };

// A thin descriptor: the first turn asks, and nothing is dispatched.
reset();
const first = await runVerb("plan", ["fix login bug", "--start", "--json"], REPO);
const id = (first.doc.session as Session | undefined)?.id ?? "";
{
  assert(first.violations.length === 0, `start: output contract (${first.violations.join("; ")})`);
  assert(first.code === 11, `a turn that asks exits 11 (got ${first.code})`);
  assert(first.doc.status === "question" && first.doc.mode === "turn", "start: status question");
  assert(/^[0-9a-f-]{36}$/.test(id), "start: the session id is in the JSON");
  assert((first.doc.session as Session).turn === 1, "start: turn 1");
  const q = first.doc.questions as Question[];
  assert(
    Array.isArray(q) && q.length > 0 && q[0]?.id === "q1" && typeof q[0]?.question === "string",
    "start: the questions are in the JSON, numbered",
  );
  assert(Array.isArray(q[0]?.options), "start: every question carries its options");
  assert(prompts.length === 0 && forge.created.length === 0, "start: nothing dispatched or filed");
}

// The answer continues the same session and reaches the pipeline.
reset();
const second = await runVerb("plan", ["--resume", id, "--answer", await answerFile(ANSWER)], REPO);
{
  assert(
    second.violations.length === 0,
    `answer: output contract (${second.violations.join("; ")})`,
  );
  assert(second.code === 12, `a shown plan exits 12 (got ${second.code})`);
  assert(second.doc.status === "shown", "answer: status shown");
  const s = second.doc.session as Session;
  assert(s.id === id && s.turn === 2, "answer: the same session, turn 2");
  assert(
    prompts.some((p) => p.includes(ANSWER)),
    "answer: the answer reached the pipeline",
  );
  assert(
    typeof second.doc.spec === "string" && typeof second.doc.reviewedDigest === "string",
    "answer: spec and digest",
  );
  assert(forge.created.length === 0, "answer: nothing filed without a confirm");
}

// Confirm files exactly the shown bytes, once.
reset();
const confirm = await runVerb("plan", ["--resume", id, "--confirm"], REPO);
{
  assert(
    confirm.violations.length === 0,
    `confirm: output contract (${confirm.violations.join("; ")})`,
  );
  assert(confirm.code === 0, `confirm exits 0 (got ${confirm.code})`);
  assert(
    confirm.doc.status === "filed" && confirm.doc.url === "https://github.com/test/test/issues/7",
    "confirm: filed, url",
  );
  assert(forge.created.length === 1, "confirm: exactly one issue created");
  assert(
    forge.created[0]?.body === second.doc.spec,
    "confirm: the body is the spec that was shown",
  );
  assert(prompts.length === 0, "confirm: no pipeline stage ran again");
}

reset();
const again = await runVerb("plan", ["--resume", id, "--confirm"], REPO);
{
  assert(again.code === 0 && again.doc.alreadyFiled === true, "second confirm: 0, alreadyFiled");
  assert(again.doc.url === "https://github.com/test/test/issues/7", "second confirm: the same url");
  assert(forge.created.length === 0, "second confirm: the forge was not called again");
}

reset();
const late = await runVerb(
  "plan",
  ["--resume", id, "--answer", await answerFile("one more thing")],
  REPO,
);
assert(
  late.code === 40 && (late.doc.error as { code?: string })?.code === "already-filed",
  "an answer after filing: 40 already-filed",
);

// A confirm before anything was shown is refused.
reset();
const thin = await runVerb("plan", ["fix login bug", "--start"], REPO);
const thinId = (thin.doc.session as Session).id ?? "";
const early = await runVerb("plan", ["--resume", thinId, "--confirm"], REPO);
{
  assert(
    early.violations.length === 0,
    `early confirm: output contract (${early.violations.join("; ")})`,
  );
  assert(early.code === 40, `confirm with nothing shown exits 40 (got ${early.code})`);
  assert(
    (early.doc.error as { code?: string })?.code === "nothing-to-confirm",
    "early confirm: nothing-to-confirm",
  );
  assert(forge.created.length === 0, "early confirm: nothing filed");
}

// A filing cut off after the forge call: the next confirm finds the issue.
reset();
{
  const c = await cutOffSession();
  forge.found.push({ number: 9, title: c.title, body: c.spec });
  forge.found.push({ number: 3, title: c.title, body: `mentions ${c.id} in passing` });
  const r = await runVerb("plan", ["--resume", c.id, "--confirm"], REPO);
  assert(r.code === 0 && r.doc.recovered === true, "cut-off: confirm exits 0, recovered");
  assert(r.doc.url === urlOf(9), "cut-off: the issue whose body carries the session marker");
  assert(
    forge.searches.some((x) => x.q.includes(c.id) && x.allStates === true),
    "cut-off: the forge was searched for the session, closed issues included",
  );
  assert(forge.created.length === 0, "cut-off: no second issue");
}

// The search cannot run: fail closed, keep the marker, and recover later.
reset();
{
  const c = await cutOffSession();
  forge.searchFails = true;
  const r = await runVerb("plan", ["--resume", c.id, "--confirm"], REPO);
  const reason = (r.doc.failure as { reason?: string } | undefined)?.reason;
  assert(r.code === 40 && reason === "filing-unverified", "search failed: 40 filing-unverified");
  assert(forge.created.length === 0, "search failed: nothing filed");
  forge.searchFails = false;
  forge.resolves = false;
  const r2 = await runVerb("plan", ["--resume", c.id, "--confirm"], REPO);
  const reason2 = (r2.doc.failure as { reason?: string } | undefined)?.reason;
  assert(r2.code === 40 && reason2 === "filing-unverified", "no forge: 40 filing-unverified");
  forge.resolves = true;
  forge.found.push({ number: 9, title: c.title, body: c.spec });
  const r3 = await runVerb("plan", ["--resume", c.id, "--confirm"], REPO);
  assert(
    r3.code === 0 && r3.doc.recovered === true,
    "the marker survived: a later confirm recovers",
  );
  assert(forge.created.length === 0, "the marker survived: still no second issue");
}

// Searched and nothing found: the cut-off filing never reached the forge, so file.
reset();
{
  const c = await cutOffSession();
  const r = await runVerb("plan", ["--resume", c.id, "--confirm"], REPO);
  assert(r.code === 0 && r.doc.recovered === undefined, "nothing found: filed");
  assert(forge.created.length === 1, "nothing found: exactly one issue created");
}

// The issue found belongs to an earlier plan of the session: refuse, never report it as this one.
reset();
{
  const c = await cutOffSession("an-earlier-digest");
  forge.found.push({ number: 9, title: c.title, body: c.spec });
  const r = await runVerb("plan", ["--resume", c.id, "--confirm"], REPO);
  const code = (r.doc.error as { code?: string } | undefined)?.code;
  assert(r.code === 40 && code === "earlier-plan-filed", "earlier plan: 40 earlier-plan-filed");
  assert(r.doc.url === urlOf(9), "earlier plan: names the issue found");
  assert(forge.created.length === 0, "earlier plan: nothing filed");
}

// The search command includes closed issues on both forges.
assert(
  issueSearchCmd("github", "x", { allStates: true }).includes("--state all"),
  "gh search: --state all",
);
assert(issueSearchCmd("gitlab", "x", { allStates: true }).includes("--all"), "glab search: --all");
assert(!issueSearchCmd("github", "x").includes("--state"), "gh search: open issues by default");

// A session that is gone is lost, never a fresh one.
reset();
const lost = await runVerb(
  "plan",
  ["--resume", "00000000-0000-4000-8000-000000000000", "--answer", await answerFile("hello")],
  REPO,
);
{
  assert(lost.violations.length === 0, `lost: output contract (${lost.violations.join("; ")})`);
  assert(lost.code === 41, `a lost session exits 41 (got ${lost.code})`);
  assert(lost.doc.lost === true && lost.doc.status === "lost", "lost: lost true");
  assert(prompts.length === 0, "lost: nothing dispatched");
}

// A CRITICAL gap the gate could not close is shown as a question.
reset();
gateReply = GAP_CRITICAL;
const crit = await runVerb("plan", [DESC, "--start"], REPO);
{
  assert(crit.code === 12, `open point: the plan is still shown (got ${crit.code})`);
  const q = crit.doc.questions as Question[];
  assert(
    q.some((x) => String(x.question).includes("retry cap of 3")),
    "open point: asked as a question",
  );
}

// Duplicate risk ends the turn with nothing shown.
reset();
dupReply = "DUPLICATE_RISK: high — duplicates #5 which is still open";
const dup = await runVerb("plan", [DESC, "--start"], REPO);
assert(dup.code === 10 && dup.doc.status === "duplicate-risk", "duplicate risk: 10");

// --retry runs the turn again in the same session, with no new answer.
reset();
const retry = await runVerb("plan", ["--resume", thinId, "--retry"], REPO);
assert(retry.violations.length === 0, `retry: output contract (${retry.violations.join("; ")})`);
assert(
  retry.code === 11 && (retry.doc.session as Session).turn === 2,
  "retry: the same session asks again, turn 2",
);
assert(prompts.length === 0, "retry: still nothing to dispatch on a thin descriptor");

// A lock held by a live run refuses the run; a stale one is taken over.
const lockFile = path.join(dir, `${thinId}.lock`);
const host = os.hostname();
for (const [lock, busyExpected, what] of [
  [{ pid: process.ppid, host, at: Date.now() }, true, "a live process on this host"],
  [{ pid: process.pid, host, at: Date.now() }, false, "our own pid, reused by a fresh container"],
  [{ pid: 999_999_999, host, at: Date.now() }, false, "a process that is gone"],
  [{ pid: 1, host: "elsewhere", at: Date.now() }, true, "another host, recent"],
  [{ pid: 1, host: "elsewhere", at: Date.now() - 3 * 3_600_000 }, false, "another host, hours old"],
  ["7", false, "an unreadable lock"],
] as const) {
  reset();
  await writeFile(lockFile, typeof lock === "string" ? lock : JSON.stringify(lock));
  const r = await runVerb("plan", ["--resume", thinId, "--retry"], REPO);
  const busy = r.code === 40 && (r.doc.error as { code?: string })?.code === "session-busy";
  assert(busy === busyExpected, `lock held by ${what}: ${busyExpected ? "busy" : "taken over"}`);
  await rm(lockFile, { force: true });
}

for (const argv of [
  ["--resume", "../etc", "--confirm"],
  ["--resume", id],
  ["--resume", id, "--confirm", "--answer", "x"],
  ["--resume", id, "--answer", path.join(dir, "missing.md")],
  [DESC, "--start", "--dry-run"],
  [DESC, "--start", "--confirm"],
  ["--resume", id, DESC, "--confirm"],
]) {
  reset();
  const r = await runVerb("plan", argv, REPO);
  assert(
    r.code === 40 && (r.doc.error as { code?: string })?.code === "bad-arguments",
    `bad arguments [${argv.join(" ")}] → 40`,
  );
  assert(
    prompts.length === 0 && forge.created.length === 0,
    "bad arguments: nothing dispatched or filed",
  );
}

setPlanDispatch(null);
setPlanForge(null);
await rm(dir, { recursive: true, force: true });
process.exit(state.exit);
