#!/usr/bin/env bun
/**
 * The GitLab MR create's body must stay under Linux's per-argument ceiling.
 *
 * `glab mr create` takes the body as ONE argv element of `-d`, and Linux caps a
 * single argv string at `MAX_ARG_STRLEN` = 131072 BYTES. A body at or over that
 * ceiling therefore makes the exec itself fail with E2BIG and the create dies
 * before `glab` starts — where the file transport the argv path replaced survived
 * any size. `prCreateCmd` clips the body on the argv arm alone, below GitHub's own
 * 65,536-character PR-body limit, so no driver body any forge legitimately accepts
 * is affected.
 *
 * The ceiling is measured in BYTES, so the clip counts bytes: a body of CJK text
 * is three UTF-8 bytes per character, and a cap on the character count would let a
 * body 1.4× over the exec ceiling through. The kept text is therefore the longest
 * prefix whose UTF-8 encoding fits the budget, cut on a whole code point — never a
 * surrogate pair, which would put a lone surrogate into the published description.
 *
 * Split from `test-glab-mr-create-argv.ts` at that seam: this file is the clip and
 * the two file transports it must NOT touch; that one is the argv shape, the reply
 * read, the refusals, and the switch.
 */

import { createForge } from "../src/forge.ts";
import { GLAB_MR_CREATE_BODY_MAX_BYTES } from "../src/forge-commands-pr.ts";
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

/** The truncation note, as the builder words it. It travels in the same argv element. */
const note = (dropped: number): string => `[pi-rukas: body truncated, ${dropped} characters dropped]`;
// The note is not free, so the budget is what leaves room for the longest note a
// body can produce (a 1_000_000-char body is longer than any body here can be).
const NOTE_ROOM = note(1_000_000).length;

/** Count unpaired surrogate halves — the marker of a clip that split a code point. */
function loneSurrogates(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else n++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      n++;
    }
  }
  return n;
}

// ── 1. the argv arm clips, and says it did ─────────────────────────────────

{
  // The cap is one named constant, and its unit is part of the contract: the exec
  // ceiling is in bytes, so a cap on the character count would not be a cap. Under
  // both ceilings, so a bump that would let a body reach E2BIG fails here.
  assert(
    Number.isInteger(GLAB_MR_CREATE_BODY_MAX_BYTES) &&
      GLAB_MR_CREATE_BODY_MAX_BYTES > 0 &&
      GLAB_MR_CREATE_BODY_MAX_BYTES <= 60_000,
    `the cap is a positive integer at most 60,000 BYTES (got ${GLAB_MR_CREATE_BODY_MAX_BYTES})`,
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
  const sentBytes = Buffer.byteLength(sent);
  assert(
    sentBytes <= GLAB_MR_CREATE_BODY_MAX_BYTES + NOTE_ROOM,
    `-d is at most the byte cap plus the note (got ${sentBytes})`,
  );
  assert(
    sentBytes < 131_072,
    `-d stays under MAX_ARG_STRLEN — the whole point of the clip (${sentBytes} bytes)`,
  );
  assert(
    sentBytes < Buffer.byteLength(HUGE),
    `-d is shorter than the body it was given (${sentBytes} < ${Buffer.byteLength(HUGE)} bytes)`,
  );
  // The kept text is the largest whole-code-point prefix that leaves room for its
  // own note under the BYTE budget. The note counts CHARACTERS and the budget
  // counts BYTES, so neither number is derivable from the other by the test — what
  // is pinned is that the pair is self-consistent and maximal.
  const kept = sent.slice(0, sent.lastIndexOf("\n["));
  const dropped = Number(/, (\d+) characters dropped\]$/.exec(sent)?.[1]);
  assert(
    Number.isFinite(dropped) && dropped > 0,
    `the note names a dropped count (${sent.slice(-60)})`,
  );
  assert(
    Buffer.byteLength(HUGE, "utf8") - Buffer.byteLength(kept, "utf8") >= dropped,
    `the note's count is covered by what is missing from the kept text (${dropped} claimed)`,
  );
  assert(
    Buffer.byteLength(kept, "utf8") + Buffer.byteLength(`\n${note(dropped)}`, "utf8") <=
      GLAB_MR_CREATE_BODY_MAX_BYTES,
    `the note it printed is one the budget affords (${Buffer.byteLength(kept, "utf8")} kept + note of ${Buffer.byteLength(`\n${note(dropped)}`, "utf8")} bytes)`,
  );
  // Maximality is judged against the note the clip actually printed, so it is not
  // confabulated from a digit count the note never had. The element is at or under
  // the byte budget with at most slack than the next character's widest encoding,
  // so no longer prefix of this body could have been exec'd.
  assert(
    Buffer.byteLength(sent, "utf8") <= GLAB_MR_CREATE_BODY_MAX_BYTES &&
      GLAB_MR_CREATE_BODY_MAX_BYTES - Buffer.byteLength(sent, "utf8") < 4,
    "one code point more would have overflowed the byte budget — the kept text is the longest prefix that fits",
  );
  assert(
    HUGE.startsWith(kept),
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
  await edgeForge.prCreate(TITLE, BRANCH, "y".repeat(GLAB_MR_CREATE_BODY_MAX_BYTES), {});
  const edgeArgv = edge[0]?.argv ?? [];
  assert(
    edgeArgv[edgeArgv.indexOf("-d") + 1] === "y".repeat(GLAB_MR_CREATE_BODY_MAX_BYTES),
    "a body of exactly the byte cap is not clipped",
  );
  await edgeForge.prCreate(
    TITLE,
    BRANCH,
    "y".repeat(GLAB_MR_CREATE_BODY_MAX_BYTES + 1),
    {},
  );
  const overArgv = edge[1]?.argv ?? [];
  const overSent = overArgv[overArgv.indexOf("-d") + 1] ?? "";
  const overKept = overSent.slice(0, overSent.lastIndexOf("\n["));
  const overDropped = Number(/, (\d+) characters dropped\]$/.exec(overSent)?.[1]);
  assert(
    overSent === `${overKept}\n${note(overDropped)}` &&
      Buffer.byteLength(overKept, "utf8") >= GLAB_MR_CREATE_BODY_MAX_BYTES - 54 &&
      Buffer.byteLength(overKept, "utf8") < GLAB_MR_CREATE_BODY_MAX_BYTES,
    `one byte over the cap keeps as much as the budget affords and says what it dropped (${Buffer.byteLength(overKept, "utf8")} kept, ${overDropped} dropped)`,
  );
  assert(
    Buffer.byteLength(overKept, "utf8") + 1 + Buffer.byteLength(note(1), "utf8") <=
      GLAB_MR_CREATE_BODY_MAX_BYTES,
    `the kept prefix is as long as the budget allows (${Buffer.byteLength(overKept, "utf8")} bytes kept)`,
  );
}

// ── 2b. the cap is in BYTES, and the cut lands on a code point ─────────────

{
  // The defect this section exists for: a cap that counts UTF-16 units lets a
  // 59,999-character CJK body through at 179,997 UTF-8 bytes, which is over
  // MAX_ARG_STRLEN and dies with E2BIG — exactly the failure the clip replaced.
  const cjkSeen: { argv?: string[] }[] = [];
  const cjkFn: ForgeExecFn = async (_cmd, opts) => {
    cjkSeen.push({ argv: opts?.argv });
    return { stdout: MR_URL };
  };
  const cjkForge = createForge(glDetection("acme", "widget"), { execFn: cjkFn });
  const CJK = "中".repeat(59_999); // 3 UTF-8 bytes per char, UNDER the old char cap
  assert(
    Buffer.byteLength(CJK) > 131_072,
    `the fixture is a body that could never have been exec'd (${Buffer.byteLength(CJK)} bytes)`,
  );
  await cjkForge.prCreate(TITLE, BRANCH, CJK, { baseBranch: "main" });
  const cjkArgv = cjkSeen[0]?.argv ?? [];
  const cjkSent = cjkArgv[cjkArgv.indexOf("-d") + 1] ?? "";
  const cjkBytes = Buffer.byteLength(cjkSent);
  assert(
    cjkBytes <= GLAB_MR_CREATE_BODY_MAX_BYTES + note(1_000_000).length,
    `a 59,999-char CJK body is clipped: its -d is ≤ the byte cap plus the note (got ${cjkBytes})`,
  );
  assert(cjkBytes < 131_072, `the clipped CJK -d could actually be exec'd (${cjkBytes} bytes)`);
  assert(
    CJK.startsWith(cjkSent.slice(0, cjkSent.lastIndexOf("\n["))),
    "the kept CJK text is still a prefix of the body it was given",
  );
  assert(
    /\d+ characters dropped\]/.test(cjkSent),
    `the note names the dropped count for the multibyte body (${cjkSent.slice(-56)})`,
  );

  // Four-byte emoji: the budget boundary falls inside a surrogate pair, so the
  // cut must back off to the previous whole code point rather than emit half a
  // character into the published description.
  const emojiSeen: { argv?: string[] }[] = [];
  const emojiFn: ForgeExecFn = async (_cmd, opts) => {
    emojiSeen.push({ argv: opts?.argv });
    return { stdout: MR_URL };
  };
  const emojiForge = createForge(glDetection("acme", "widget"), { execFn: emojiFn });
  const EMOJI = "😀".repeat(30_000) + "TAIL";
  await emojiForge.prCreate(TITLE, BRANCH, EMOJI, {});
  const emojiArgv = emojiSeen[0]?.argv ?? [];
  const emojiSent = emojiArgv[emojiArgv.indexOf("-d") + 1] ?? "";
  const emojiKept = emojiSent.slice(0, emojiSent.lastIndexOf("\n["));
  assert(
    Buffer.byteLength(emojiSent) <= GLAB_MR_CREATE_BODY_MAX_BYTES + note(1_000_000).length,
    `the emoji body's -d is ≤ the byte cap plus the note (got ${Buffer.byteLength(emojiSent)})`,
  );
  assert(
    loneSurrogates(emojiKept) === 0,
    `no lone surrogate in the kept text (${loneSurrogates(emojiKept)}) — the cut is on a code point`,
  );
  assert(
    EMOJI.startsWith(emojiKept),
    `the kept emoji text is a prefix cut on a whole code point (${JSON.stringify(emojiKept.slice(-4))})`,
  );

  // Just under the budget on a multibyte body: nothing is touched, byte for byte.
  const fitSeen: { argv?: string[] }[] = [];
  const fitFn: ForgeExecFn = async (_cmd, opts) => {
    fitSeen.push({ argv: opts?.argv });
    return { stdout: MR_URL };
  };
  const FIT = "中".repeat(GLAB_MR_CREATE_BODY_MAX_BYTES / 3);
  await createForge(glDetection("acme", "widget"), { execFn: fitFn }).prCreate(
    TITLE,
    BRANCH,
    FIT,
    {},
  );
  const fitArgv = fitSeen[0]?.argv ?? [];
  assert(
    Buffer.byteLength(FIT) <= GLAB_MR_CREATE_BODY_MAX_BYTES,
    `the fitting fixture is under the byte budget (${Buffer.byteLength(FIT)} bytes)`,
  );
  assert(
    fitArgv[fitArgv.indexOf("-d") + 1] === FIT,
    `a multibyte body just under the byte budget is byte-identical (${String(fitArgv[fitArgv.indexOf("-d") + 1]).length} chars back)`,
  );
}

// ── 2c. the clipped multibyte argv survives a real exec ────────────────────

{
  // The rows above measure the clip against the constant; this one runs the
  // clipped argv through the same exec the adapter uses, so a clip that counted
  // the wrong unit would fail here with a real E2BIG rather than an assertion.
  const { execp } = await import("../src/exec.ts");
  const CLIPPED = "中".repeat(200_000);
  const seen: { argv?: string[] }[] = [];
  const fn: ForgeExecFn = async (_cmd, opts) => {
    seen.push({ argv: opts?.argv });
    return { stdout: MR_URL };
  };
  await createForge(glDetection("acme", "widget"), { execFn: fn }).prCreate(
    TITLE,
    BRANCH,
    CLIPPED,
    {},
  );
  const argv = seen[0]?.argv ?? [];
  const bodyElement = argv[argv.indexOf("-d") + 1] ?? "";
  const real = await execp("true", { argv });
  assert(
    real.stdout === "" &&
      Buffer.byteLength(bodyElement) <= GLAB_MR_CREATE_BODY_MAX_BYTES + note(1_000_000).length,
    `execp ran the clipped multibyte argv with no E2BIG (${Buffer.byteLength(bodyElement)} bytes in -d)`,
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
