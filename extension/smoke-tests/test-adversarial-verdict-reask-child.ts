#!/usr/bin/env bun
/**
 * The adversarial verdict re-ask's CHILD side: how the second child is built,
 * and what is allowed to count as its answer.
 *
 * The loop-side behaviour lives in `test-adversarial-verdict-reask.ts`; this
 * file is about the child the loop spawns (AGENTS.md §12 splits the suite the
 * same way the feature is split — `adversarial-verdict-reask.ts` asks, and
 * `adversarial-verdict-reask-child.ts` runs). No `pi` is spawned here: a live
 * child is refused offline by `assertLiveSpawnAllowed`, so the child is pinned
 * through its pure seams — the argv it is launched with, the stream its answer
 * is extracted from, and the prompt file it is configured by.
 *
 * The three claims that make the child a follow-up rather than a second
 * reviewer, each pinned by value rather than by a string that merely mentions
 * the idea: it resumes the reviewer's OWN session on the reviewer's OWN model;
 * only the LAST `agent_end` answers (a resumed session replays the fenced report
 * it is being asked about); and the prompt file is not world-readable.
 */

import {
  reaskChildArgs,
  reaskReplyText,
  writeReaskPromptFile,
} from "../src/adversarial-verdict-reask-child.ts";
import { VERDICT_REASK_SOURCE_TAG } from "../src/adversarial-verdict-reask-constants.ts";
import { FENCE, TRANSCRIPT } from "./lib/adversarial-reask-fixtures.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

// ── (10) the child's argv: it resumes the reviewer, it does not restart it ──
{
  const argv = reaskChildArgs({
    transcriptPath: TRANSCRIPT,
    role: "adversarial-developer",
    promptFile: "/tmp/pi-rukas-reask-xyz/adversarial-developer.md",
    model: "reviewer-model-1",
    provider: "openrouter",
  });
  const at = (flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
  assert(
    at("--session") === TRANSCRIPT,
    `(10) the child resumes the reviewer's own session file (${String(at("--session"))})`,
  );
  assert(
    argv.includes("--mode") && at("--mode") === "rpc",
    "(10) and speaks the RPC stream the reply extractor reads",
  );
  assert(
    at("--model") === "reviewer-model-1" && at("--provider") === "openrouter",
    "(10) same model and provider as the review it is following up — otherwise a second opinion",
  );
  assert(
    at("--append-system-prompt")?.endsWith("adversarial-developer.md") === true,
    "(10) configured with the reviewer's own system prompt",
  );
  assert(
    argv.includes("--no-extensions") && !argv.includes("--skill"),
    "(10) no extensions and no skill: a one-line answer needs neither, and a skill would re-run the review",
  );
  assert(
    !argv.some((a) => a.includes("VERDICT")),
    "(10) and no argv carries a verdict value for the model to recite",
  );
}

// ── (11) only the LAST agent_end counts as the answer ───────────────────────
// A resumed session replays its earlier turns, so a reader that took any
// assistant text would read the reviewer's own fenced report back as the answer
// and "recover" the verdict it had just refused.
{
  const agentEnd = (text: string): string =>
    JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text }] }],
    });
  const replayed = [
    agentEnd(`Review report:\n${FENCE}\nVERDICT: APPROVED\n${FENCE}`),
    agentEnd("VERDICT: ISSUES_FOUND"),
  ].join("\n");
  assert(
    reaskReplyText(replayed).includes("ISSUES_FOUND") &&
      !reaskReplyText(replayed).includes("Review report"),
    `(11) the answer is the last turn's reply, not the replayed report (${JSON.stringify(reaskReplyText(replayed))})`,
  );
  assert(
    reaskReplyText([agentEnd("VERDICT: APPROVED"), agentEnd("   \n")].join("\n")).includes(
      "APPROVED",
    ),
    "(11) a trailing blank turn does not erase the answer",
  );
  assert(reaskReplyText("not json\n{}\n") === "", "(11) unparsable noise yields no answer at all");
  assert(
    reaskReplyText(
      JSON.stringify({
        type: "message_end",
        messages: [{ role: "assistant", content: [{ type: "text", text: "VERDICT: APPROVED" }] }],
      }),
    ) === "",
    "(11) and a non-agent_end event never counts as the answer",
  );
}

// ── (12) the child's prompt file is not world-readable ─────────────────────
{
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const file = await writeReaskPromptFile(
    "adversarial-developer",
    "system prompt bytes",
    await fs.mkdtemp(path.join(os.tmpdir(), "reask-root-")),
    path.join,
  );
  const mode = (await fs.stat(file)).mode & 0o777;
  const dirMode = (await fs.stat(path.dirname(file))).mode & 0o777;
  // The tree is read by owner AND mode, so the directory is 0700 — and the file
  // is written 0600 rather than left to the umask, because a prompt file is the
  // role's system prompt sitting in a shared /tmp and the harness's own cleanup
  // walks this tree by mode. An inherited 0664 is the failure this pins.
  assert(
    dirMode === 0o700 && mode === 0o600,
    `(12) dir 0700 and file 0600 regardless of umask (got dir 0o${dirMode.toString(8)}, file 0o${mode.toString(8)})`,
  );
  assert(
    path.basename(file) === "adversarial-developer.md",
    `(12) and the file carries the re-asked role's name (${path.basename(file)})`,
  );
  assert(
    (await fs.readFile(file, "utf8")) === "system prompt bytes",
    "(12) written byte for byte, so the child is configured as the reviewer was",
  );
}
console.log(`\nre-ask child ${failures() === 0 ? "green" : "RED"} (${String(failures())} failing)`);
process.exit(failures());
