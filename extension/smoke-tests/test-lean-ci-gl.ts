#!/usr/bin/env bun
/**
 * lean/ci — the step reading a GitLab merge request (#2224).
 *
 * The step was GitHub-only by construction: `ghReads` spelled both forge reads
 * with `gh` and a `"github"` literal, and the step's own URL parser matched only
 * `/pull/N`, so a run whose publish step recorded
 * `https://gitlab.example.com/group/sub/-/merge_requests/17` never got an MR
 * number and died with the "no PR to read CI for" infrastructure throw — exit 10
 * with a draft MR on a project whose pipeline was green.
 *
 * **Why this suite builds the real adapter.** `lib/lean-ci-recorder.ts` dispatches
 * its forge answers through the adapter shape, so a case that answered with a
 * hand-rolled object would be graded on a seam shaped to match the parser. Every
 * case here injects `createForge(glDetection(…))` with the `GL_MR` / `GL_JOBS`
 * fixtures behind the exec fake, so the readiness composition, the pipelines
 * lookup and the job mapping are the production ones and the pinned argv is the
 * adapter's. The witness that "never a hardcoded gh command" is true is
 * `Ran.cmds` — what the step actually issued.
 *
 *   (g1) a green pipeline -> green, the full tier exactly once, and the commands
 *        the step issued are glab only — none starts with `gh `;
 *   (g2) an MR whose pipelines read is empty -> the existing pinned no-checks RED,
 *        not an infra throw (absence of evidence is a refusal, not a fault);
 *   (g3) `forgeFor` answers undefined -> the infra throw naming that, and no `gh`
 *        command issued: the GitHub path must not survive a failed detection by
 *        silently falling back to `gh`;
 *   (g4) readiness `checking` (UNKNOWN) -> waited like a pending row, then green;
 *   (g5) a failed job -> red naming it, tier never run;
 *   (g6) `skipped`/`manual` never read as green; `running` is waited and the
 *        expired wait hands back;
 *   (g7) an absent or malformed `diff_refs.head_sha` -> infra throw;
 *   (g8) self-hosted detection through the REAL seam: `.pi/forge`
 *        (type=gitlab, host=gitlab.example.com) plus an SSH remote on that host.
 *
 * Offline throughout: the forge is the adapter over the exec fake, the tier is an
 * `sh` command, no MR and no merge exist.
 */

import { VerifyInfraError } from "../src/lean/verify-types.ts";
import { cleanUp, glMrChecking, glMrHeadless, glMrShortHead, run } from "./lib/lean-ci-recorder.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** One GitLab job row, in the snake_case shape the REST API answers with. */
const job = (status: string, name = "build"): Record<string, unknown> => ({ name, status });

// ── (g1) a green pipeline -> green, tier once, glab only ─────────────────
{
  const r = await run({ full: "true", forge: "gitlab" });
  assert(
    r.outcome?.kind === "green",
    `(g1) a green GitLab pipeline -> ci green (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
  );
  assert(
    r.cmds.some((c) => c.startsWith("glab ")),
    `(g1) the step read the MR through glab (${JSON.stringify(r.cmds)})`,
  );
  assert(
    !r.cmds.some((c) => c.startsWith("gh ")),
    `(g1) and issued no gh command at all (${JSON.stringify(r.cmds.filter((c) => c.startsWith("gh ")))})`,
  );
  assert(r.tierRuns === 1, `(g1) the full tier ran exactly once (${String(r.tierRuns)})`);
}

// ── (g2) no pipeline at all -> the pinned no-checks RED ──────────────────
{
  const r = await run({ full: "true", forge: "gitlab", pipelines: [] });
  assert(
    r.threw === undefined,
    `(g2) an MR with no pipeline is a verdict, not an infra throw (${String(r.threw?.message)})`,
  );
  assert(r.outcome?.kind === "red", `(g2) and it is red (${JSON.stringify(r.outcome)})`);
  assert(
    (r.outcome?.reason ?? "").includes(
      "no checks reported — refusing to read the absence of evidence as green",
    ),
    `(g2) with the pinned no-checks reason (${r.outcome?.reason})`,
  );
  assert(r.tierRuns === 0, "(g2) and no tier ran on the strength of it");
}

// ── (g3) no forge adapter -> infra throw, and no gh command ──────────────
{
  const r = await run({ full: "true", forge: "none" });
  assert(
    r.threw instanceof VerifyInfraError,
    `(g3) no forge adapter THROWS (${String(r.threw?.message)})`,
  );
  assert(
    (r.threw?.message ?? "").includes("no forge adapter"),
    `(g3) and the throw names that no forge adapter could be resolved (${String(r.threw?.message)})`,
  );
  assert(
    !r.cmds.some((c) => c.startsWith("gh ")),
    `(g3) and no gh command was issued (${JSON.stringify(r.cmds.filter((c) => c.startsWith("gh ")))})`,
  );
  assert(r.outcome === undefined, "(g3) and it produces no verdict the machine could route");
}

// ── (g4) readiness `checking` -> polled, then green ──────────────────────
{
  const r = await run({
    full: "true",
    forge: "gitlab",
    clockMs: 0,
    waitTimeoutMs: 120_000,
    mrAtReads: (head) => [glMrChecking(head), undefined],
  });
  assert(
    r.outcome?.kind === "green",
    `(g4) checking readiness is waited, then green (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
  );
  assert(
    r.slept.length === 1 && r.slept[0] === 60_000,
    `(g4) one wait of a minute between the two MR reads (${JSON.stringify(r.slept)})`,
  );
  assert(r.tierRuns === 1, `(g4) and the tier still ran exactly once (${String(r.tierRuns)})`);
  assert(
    !r.cmds.some((c) => c.startsWith("gh ")),
    `(g4) and the whole wait stayed on glab (${JSON.stringify(r.cmds.filter((c) => c.startsWith("gh ")))})`,
  );
}

// ── (g5) a failed job -> red, tier never run ─────────────────────────────
{
  const r = await run({ full: "true", forge: "gitlab", jobs: [job("failed", "test")] });
  assert(
    r.outcome?.kind === "red",
    `(g5) a failed job -> red (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("test"),
    `(g5) and the red names the job (${r.outcome?.reason})`,
  );
  assert(r.tierRuns === 0, "(g5) the tier was not run over a red pipeline");
}

// ── (g6) `skipped`/`manual` never green; `running` is waited and bounded ─
for (const status of ["skipped", "manual"]) {
  const r = await run({
    full: "true",
    forge: "gitlab",
    jobs: [job(status)],
    clockMs: 0,
    waitTimeoutMs: 60_000,
  });
  assert(
    r.outcome?.kind !== "green",
    `(g6) a job in "${status}" is never green (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
  );
  assert(r.tierRuns === 0, `(g6) and "${status}" runs no full tier`);
}
{
  const r = await run({
    full: "true",
    forge: "gitlab",
    jobs: [job("running")],
    clockMs: 0,
    waitTimeoutMs: 120_000,
  });
  assert(
    r.threw instanceof VerifyInfraError && (r.threw.message ?? "").includes("still pending"),
    `(g6) a running job is waited and the expired wait hands back (${String(r.threw?.message)})`,
  );
  assert(r.tierRuns === 0, "(g6) and no tier ran on it");
}
// The states gh's lists never named: they are GitLab's own, and a word no list
// matches used to be waited forever here. Now the shared table calls them
// pending, so they wait on the same bound — and `created`/`scheduled` etc. are
// named states, not `unknown` guesses.
for (const status of ["created", "waiting_for_resource", "preparing", "scheduled"]) {
  const r = await run({
    full: "true",
    forge: "gitlab",
    jobs: [job(status)],
    clockMs: 0,
    waitTimeoutMs: 120_000,
  });
  assert(
    r.threw instanceof VerifyInfraError && (r.threw.message ?? "").includes("still pending"),
    `(g6) a "${status}" job is a pending state, waited to the bound (${String(r.threw?.message)})`,
  );
}

// ── (g7) head sha absent / malformed -> infra throw ──────────────────────
for (const [label, row] of [
  ["absent", glMrHeadless()],
  ["not a full sha", glMrShortHead()],
] as const) {
  const r = await run({ full: "true", forge: "gitlab", mr: row });
  assert(
    r.threw instanceof VerifyInfraError,
    `(g7) an MR read whose head sha is ${label} THROWS (${String(r.threw?.message)})`,
  );
  assert(
    (r.threw?.message ?? "").includes("head"),
    `(g7) and the throw names the head it could not read (${String(r.threw?.message)})`,
  );
  assert(r.tierRuns === 0, `(g7) and ${label} runs no tier`);
}

// ── (g8) self-hosted: .pi/forge type=gitlab + host= + an SSH remote ─────
{
  const r = await run({ full: "true", forge: "self-hosted" });
  assert(
    r.outcome?.kind === "green",
    `(g8) self-hosted .pi/forge detection reaches the glab read (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
  );
  assert(
    !r.cmds.some((c) => c.startsWith("gh ")),
    `(g8) and the self-hosted path issued no gh command (${JSON.stringify(r.cmds.filter((c) => c.startsWith("gh ")))})`,
  );
  assert(
    r.cmds.some((c) => c.includes("glab ")),
    `(g8) and it read the MR through glab (${JSON.stringify(r.cmds)})`,
  );
}

cleanUp();
process.exit(exit);
