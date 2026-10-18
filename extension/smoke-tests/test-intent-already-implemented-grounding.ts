#!/usr/bin/env bun
/**
 * An `already-implemented` park must name a commit on the mainline (#1351).
 *
 * example-owner/orchard#127: the resolver wrote down that main had no trace of the
 * feature and that the work lived only on an open, conflicting PR, then parked
 * `already-implemented`. Nothing checked the claim against the mainline, so the
 * park stood. This test builds a real clone (origin with `main` and an unmerged
 * PR branch) and runs the grounding check against it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { groundAlreadyImplemented } from "../src/work-driver-intent-grounding.ts";
import { parkEvidence } from "../src/work-driver-intent-park-evidence.ts";
import { finaliseSpecVerdict } from "../src/work-driver-intent-finalise.ts";
import { parseNormalisedSpec } from "../src/work-driver-intent.ts";
import { inlineExplorePrompt } from "../src/work-driver-prompts-early.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "pi-1351-grounding-"));
const git = async (cwd: string, ...args: string[]) =>
  (
    await execp("git", {
      cwd,
      argv: ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    })
  ).stdout.trim();

const origin = path.join(tmp, "origin.git");
const clone = path.join(tmp, "clone");
await git(tmp, "init", "-q", "--bare", "-b", "main", origin);
await git(tmp, "clone", "-q", origin, clone);
await git(clone, "commit", "-q", "--allow-empty", "-m", "main: base");
const mainSha = await git(clone, "rev-parse", "HEAD");
await git(clone, "push", "-q", "origin", "main");
await git(clone, "checkout", "-q", "-b", "pr-214");
await git(clone, "commit", "-q", "--allow-empty", "-m", "pr: ORCHARD_WORK_FILES");
const prSha = await git(clone, "rev-parse", "HEAD");
await git(clone, "push", "-q", "origin", "pr-214");
await git(clone, "remote", "set-head", "origin", "main");

/** The orchard#127 shape: a park whose own evidence says the mainline lacks the work. */
const reply = (implementedAt: string | undefined, deliverables = true) =>
  [
    "INTENT-VERDICT: park",
    "PARK-REASON: already-implemented",
    ...(implementedAt ? [`IMPLEMENTED-AT: ${implementedAt}`] : []),
    "",
    "## Spec",
    "### Intent",
    "Add a ORCHARD_WORK_FILES switch.",
    "### Deliverables",
    ...(deliverables ? ["- d1: add the switch [paths: lib/attachments.sh]"] : []),
    "### Acceptance criteria",
    "- ORCHARD_WORK_FILES=1 attaches text-like files",
    "### Evidence",
    `- main has no ORCHARD_WORK_FILES — lib/attachments.sh — confirmed`,
    `- #127 exists only on PR #214 (open, CONFLICTING) — gh pr view 214 — confirmed`,
    "",
    "## Rationale",
    "The work exists on PR #214.",
  ].join("\n");

const run = async (text: string, exec: typeof execp = execp) => {
  const spec = parseNormalisedSpec(text);
  if (!spec) throw new Error("fixture did not parse");
  return finaliseSpecVerdict(await groundAlreadyImplemented(spec, text, clone, exec), "body");
};

// The reproduction: a commit that exists only on the PR branch.
{
  const s = await run(reply(prSha.slice(0, 7)));
  assert(
    s.verdict === "proceed-with-assumptions",
    `a park citing a PR-only commit is not accepted (got ${s.verdict}/${s.parkReason})`,
  );
  assert(
    s.assumptions.some((a) => a.text.includes(prSha.slice(0, 7)) && a.text.includes("origin/main")),
    "the refutation names the commit and the mainline ref",
  );
}

// A commit that is on the mainline grounds the park.
{
  const s = await run(reply(mainSha));
  assert(
    s.verdict === "park" && s.parkReason === "already-implemented",
    "a park citing a mainline commit stands",
  );
}

// A commit that is not in the clone at all is not on the mainline either.
{
  const s = await run(reply("deadbeefdeadbeef"));
  assert(s.verdict === "proceed-with-assumptions", "a park citing an unknown commit is refuted");
}

// Refuted with nothing to build: still parked, and not as already-implemented.
{
  const s = await run(reply(prSha, false));
  assert(
    s.verdict === "park" && s.parkReason === "underspecified",
    `a refuted park with no deliverables parks as underspecified (got ${s.parkReason})`,
  );
  // #1561's cap evidence is built from the FINAL spec, so it must describe the refutation.
  const headline = parkEvidence(s, 127, new Map([[214, "OPEN"]])).split("\n")[0] ?? "";
  assert(
    headline.startsWith("intent-park (underspecified):") &&
      headline.includes(`${prSha}, which is not on origin/main`) &&
      !headline.includes("awaiting review"),
    `the park evidence leads with the refutation, not the rejected claim (got ${headline})`,
  );
}

// No marker: a stated park is overturned only by positive evidence (#404).
{
  const s = await run(reply(undefined));
  assert(
    s.verdict === "park" && s.parkReason === "already-implemented",
    "a park with no IMPLEMENTED-AT line is left as stated",
  );
}

// An unreadable mainline leaves the park as stated.
{
  const failing = (async () => {
    throw new Error("no git");
  }) as unknown as typeof execp;
  const s = await run(reply(prSha), failing);
  assert(
    s.verdict === "park" && s.parkReason === "already-implemented",
    "an unreadable mainline leaves the park as stated",
  );
}

// Other parks are not touched, and run no git at all.
{
  let calls = 0;
  const counting = (async () => {
    calls++;
    throw new Error("unexpected");
  }) as unknown as typeof execp;
  const text = reply(prSha).replace("already-implemented", "too-large");
  const s = await run(text, counting);
  assert(
    s.parkReason === "too-large" && calls === 0,
    "a too-large park is untouched and runs no git",
  );
}

const prompt = inlineExplorePrompt([127], "/tmp/x", [], true);
assert(prompt.includes("IMPLEMENTED-AT: <sha>"), "the intent prompt asks for IMPLEMENTED-AT");
assert(
  /open PR or an unmerged branch is NOT already implemented/.test(prompt),
  "the prompt defines already-implemented against the mainline",
);

rmSync(tmp, { recursive: true, force: true });
process.exit(exit);
