#!/usr/bin/env bun
/**
 * The GitLab MR create's body must stay under Linux's per-argument ceiling.
 *
 * `glab mr create` takes the body as ONE argv element of `-d`, and Linux caps a
 * single argv string at `MAX_ARG_STRLEN` = 131072 bytes. A body at or over that
 * ceiling therefore makes the exec itself fail with E2BIG and the create dies
 * before `glab` starts — where the file transport the argv path replaced survived
 * any size. `prCreateCmd` clips the body on the argv arm alone, below GitHub's own
 * 65,536-character PR-body limit, so no driver body any forge legitimately accepts
 * is affected.
 *
 * Split from `test-glab-mr-create-argv.ts` at that seam: this file is the clip and
 * the two file transports it must NOT touch; that one is the argv shape, the reply
 * read, the refusals, and the switch.
 */

import { createForge } from "../src/forge.ts";
import { GLAB_MR_CREATE_BODY_MAX_CHARS } from "../src/forge-commands-pr.ts";
import { readFileSync } from "node:fs";
import type { ForgeExecFn } from "../src/forge-types.ts";
import type { ForgeDetection } from "../src/forge-detect.ts";
import { glDetection } from "./forge-fixtures.ts";
import { withEnv } from "./lib/env-scope.ts";

let exit = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * Undo `shq` on one emitted token: one it left bare IS the string; a quoted one is
 * the string with the `'\\''` escapes put back. `shq` leaves a path made of
 * `[A-Za-z0-9_@./:=,-]` BARE, so a body-file path arrives either way.
 */
function unshq(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  if (!token.startsWith("'")) return token;
  return token.slice(1, -1).replaceAll("'\\''", "'");
}

const TITLE = "feat(glab): create the merge request";
const BRANCH = "feature/issue-2342-glab-mr-create";
const BODY = "## Summary\n\n- a body with 'quotes', \"doubles\" and $(not-a-subshell)\n";
const MR_URL = "https://gitlab.com/acme/widget/-/merge_requests/17\n";
const HUGE = "x".repeat(200_000);

// ── 1. the argv arm clips, and says it did ─────────────────────────────────

{
  const note = (dropped: number): string =>
    `[pi-rukas: body truncated, ${dropped} characters dropped]`;
  // The note is not free: it travels in the same argv element, so the cap is what
  // leaves room for the longest note a body can produce.
  const NOTE_ROOM = note(1_000_000).length;

  // The cap is one named constant, and its value is part of the contract: under
  // both ceilings, so a bump that would let a body reach E2BIG fails here.
  assert(
    Number.isInteger(GLAB_MR_CREATE_BODY_MAX_CHARS) &&
      GLAB_MR_CREATE_BODY_MAX_CHARS > 0 &&
      GLAB_MR_CREATE_BODY_MAX_CHARS <= 60_000,
    `the cap is a positive integer at most 60,000 chars (got ${GLAB_MR_CREATE_BODY_MAX_CHARS})`,
  );

  const seen: { cmd: string; argv?: string[] }[] = [];
  const fn: ForgeExecFn = async (cmd, opts) => {
    seen.push({ cmd, argv: opts?.argv });
    return { stdout: MR_URL };
  };
  const forge = createForge(glDetection("acme", "widget"), { execFn: fn });
  const mr = await forge.prCreate(TITLE, BRANCH, HUGE, { baseBranch: "main" });
  const call = seen.find((c) => c.argv !== undefined);
  const argv = call?.argv ?? [];
  const at = (flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
  assert(call?.cmd === "glab", "the huge body still went down the argv arm");
  assert(mr.number === 17, `and the create still reported the MR (${mr.number})`);
  const sent = at("-d") ?? "";
  assert(
    sent.length <= GLAB_MR_CREATE_BODY_MAX_CHARS + NOTE_ROOM,
    `-d is at most the cap plus the note (got ${sent.length})`,
  );
  assert(
    sent.length < HUGE.length,
    `-d is shorter than the body it was given (${sent.length} < ${HUGE.length})`,
  );
  assert(
    sent.endsWith(note(HUGE.length - GLAB_MR_CREATE_BODY_MAX_CHARS)),
    `-d ends with the note naming how many chars were dropped (${sent.slice(-72)})`,
  );
  assert(
    sent
      .slice(GLAB_MR_CREATE_BODY_MAX_CHARS - 1, GLAB_MR_CREATE_BODY_MAX_CHARS + 1)
      .startsWith("x\n"),
    "the note sits on its own line, after a newline",
  );
  assert(
    sent.slice(0, GLAB_MR_CREATE_BODY_MAX_CHARS) ===
      HUGE.slice(0, GLAB_MR_CREATE_BODY_MAX_CHARS),
    "the kept text is the untouched prefix of the body — still covered by the public-text check",
  );
  assert(
    argv.filter((a) => a.startsWith("x")).length === 1,
    "the body still appears once and only as the -d value",
  );
}

// ── 2. the negative arms: under the cap, nothing is touched ────────────────

{
  const smallSeen: { argv?: string[] }[] = [];
  const smallFn: ForgeExecFn = async (_cmd, opts) => {
    smallSeen.push({ argv: opts?.argv });
    return { stdout: MR_URL };
  };
  const smallForge = createForge(glDetection("acme", "widget"), { execFn: smallFn });
  await smallForge.prCreate(TITLE, BRANCH, BODY, { baseBranch: "main" });
  const smallArgv = smallSeen[0]?.argv ?? [];
  assert(
    smallArgv[smallArgv.indexOf("-d") + 1] === BODY,
    `a body under the cap is byte-identical (got ${JSON.stringify(String(smallArgv[smallArgv.indexOf("-d") + 1]).slice(-40))})`,
  );

  // The exact boundary: a body of exactly the cap is NOT clipped, one character
  // over is. Otherwise the cap is off by one and the rows above pass on a body that
  // need not have been shortened.
  const edge: { argv?: string[] }[] = [];
  const edgeFn: ForgeExecFn = async (_cmd, opts) => {
    edge.push({ argv: opts?.argv });
    return { stdout: MR_URL };
  };
  const edgeForge = createForge(glDetection("acme", "widget"), { execFn: edgeFn });
  await edgeForge.prCreate(TITLE, BRANCH, "y".repeat(GLAB_MR_CREATE_BODY_MAX_CHARS), {});
  const edgeArgv = edge[0]?.argv ?? [];
  assert(
    edgeArgv[edgeArgv.indexOf("-d") + 1] === "y".repeat(GLAB_MR_CREATE_BODY_MAX_CHARS),
    "a body of exactly the cap is not clipped",
  );
  await edgeForge.prCreate(TITLE, BRANCH, "y".repeat(GLAB_MR_CREATE_BODY_MAX_CHARS + 1), {});
  const overArgv = edge[1]?.argv ?? [];
  assert(
    (overArgv[overArgv.indexOf("-d") + 1] ?? "").endsWith("[pi-rukas: body truncated, 1 characters dropped]"),
    `one char over the cap is clipped and says one was dropped (${String(overArgv[overArgv.indexOf("-d") + 1]).slice(-48)})`,
  );
}

// ── 3. the file transports are NOT clipped ─────────────────────────────────

{
  // The GitHub arm and the off arm carry the body in a FILE, which has no
  // per-argument ceiling, so neither may be clipped: a truncated body reaching the
  // file transport would silently publish less than the driver wrote.
  //
  // The body file is torn down in the adapter's own `finally`, so the bytes are
  // captured INSIDE the exec fake — while the create still holds the file. A read
  // after `prCreate` resolves finds the path already unlinked, and an empty read
  // would pass as "not clipped" for the wrong reason.
  const readBodyFile = async (
    det: ForgeDetection,
    flag: string,
    match: (cmd: string) => boolean,
  ): Promise<{ cmd: string; body: string | undefined }> => {
    const captured: { cmd: string; body: string | undefined }[] = [];
    const fn: ForgeExecFn = async (cmd) => {
      const file = unshq(cmd.match(new RegExp(`${flag} ('[^']+'|\\S+)`))?.[1]);
      captured.push({ cmd, body: file ? readFileSync(file, "utf8") : undefined });
      return { stdout: MR_URL };
    };
    // The forge is built HERE so the fake above is the one the create actually
    // calls: a fake handed to `createForge` elsewhere and a `prCreate` on a
    // different instance records nothing, and the empty result reads as "no clip".
    await createForge(det, { execFn: fn }).prCreate(TITLE, BRANCH, HUGE, {
      baseBranch: "main",
    });
    const hit = captured.find((c) => match(c.cmd));
    return hit ?? { cmd: "", body: undefined };
  };

  const gh = await readBodyFile(
    { ...glDetection("acme", "widget"), forge: "github" },
    "--body-file",
    (c) => c.includes("--body-file"),
  );
  assert(gh.cmd.includes("--body-file"), "GitHub still takes a body file");
  assert(gh.body !== undefined, `the command names the body file (${gh.cmd.slice(0, 80)})`);
  assert(
    gh.body === HUGE,
    `the GitHub body file carries ALL ${HUGE.length} characters, unclipped (got ${String(gh.body).length})`,
  );

  await withEnv({ PI_ENSEMBLE_GLAB_MR_CREATE: "0" }, async () => {
    const off = await readBodyFile(
      glDetection("acme", "widget"),
      " --description-file",
      (c) => c.startsWith("glab mr create "),
    );
    assert(
      !off.cmd.includes("[pi-rukas: body truncated") && off.cmd.includes("--description-file"),
      `the off arm still takes a body file and carries no truncation note (${off.cmd.slice(0, 90)})`,
    );
    assert(
      off.body === HUGE,
      "the off arm's body file is the whole body too — the clip belongs to the argv arm alone",
    );
  });
}

console.log(`\n${exit === 0 ? "glab mr create body clip green" : "glab mr create body clip RED"} — exit ${exit}`);
process.exit(exit);
