#!/usr/bin/env bun
/**
 * #1444 rounds 3–4 — the probe failure cause is redacted and inert whatever
 * the shape of the credential.
 *
 * `causeOf` (`src/probe-cause.ts`) turns a failed `execp` rejection into the
 * one sentence `detectMainline` embeds in its `reason`, which reaches
 * merge-guard refusals, handoff comments and PR bodies. The redaction rules are
 * exercised against the sanitiser DIRECTLY rather than through a fake
 * executor: a fake can only say what it was told to reject with, so a rule that
 * silently stopped matching would be indistinguishable from a fake that stopped
 * carrying the field. `test-mainline-probe-timeout.ts` covers the plumbing
 * (the timeout reaches both probes, the reason stays bounded, the result shape
 * is the contract); this file covers what leaves in the text.
 *
 * Four classes, each a round-3 or round-4 finding:
 *
 *   1. **Case.** A `gh` error quotes whatever the server spelled. A
 *      case-sensitive rule passes `GHP_…` through untouched while looking like
 *      it covered it.
 *   2. **Glued to a word.** `\b` before the prefix only fires at a non-word
 *      boundary, so `…zzzzghp_<40>` — a token the tool printed flush against
 *      another word or a number — was passed through WHOLE by the one rule
 *      meant to catch it.
 *   3. **Split across lines.** The tail joins lines with ` | `, which can land
 *      inside a wrapped token; a rule that needs a contiguous body then redacts
 *      half and leaves the rest as loose characters.
 *   4. **Clip boundary.** A bound can cut a credential into a fragment no
 *      pattern recognises, or land mid-way through the `[REDACTED]` marker just
 *      written — a `[REDACT` reads as content, not as a redaction that
 *      happened.
 *
 * Plus the markdown/marker half: this text lands in markdown and is read by
 * `readMarker`, so backticks, `<!--` / `-->` and `VERDICT:`-shaped tokens must
 * all arrive inert — while the SHARED `neutraliseEvidence` (diff evidence in a
 * `<<<` / `>>>` DATA block) keeps its own contract unchanged. That split is
 * what round 3 broke by folding the two together.
 *
 * Run: cd extension && bun run smoke-tests/test-probe-cause-redaction.ts
 */

import { causeOf } from "../src/probe-cause.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  // Failures to STDERR — the verify-loop's digest mode reads stderr.
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

/** An exec-shaped rejection: message, captured stderr, and the stamped fields. */
const execErr = (stderr: string, code: number | string | null = 1) =>
  Object.assign(new Error(`Command failed: gh repo view --json defaultBranchRef\n${stderr}`), {
    code,
    stderr,
    killed: false,
    signal: null,
    stdout: "",
  });

/** Every secret body in a cause must be gone; the marker must say it was here. */
function assertRedacted(label: string, stderr: string, secret: string) {
  const cause = causeOf(execErr(stderr));
  assert(!cause.includes(secret), `${label}: the credential does not survive (${cause})`);
  assert(cause.includes("[REDACTED]"), `${label}: the redaction marker is present`);
  return cause;
}

console.log("1. case-insensitive token shapes");
{
  // Round 4: the EXTRA patterns were `/…/g`, so an upper-cased spelling — the
  // shape a `gh` error actually carries when it quotes a config value or a
  // server message — walked straight through the rule meant to catch it.
  const cases: Array<[string, string, string]> = [
    ["GHP_", "gh: Bad credentials: GHP_abcdefghijklmnopqrstuvwxyz01234567", "GHP_abcdef"],
    [
      "GitHub_PAT_",
      "gh: auth failed GitHub_PAT_11ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
      "GitHub_PAT_11ABC",
    ],
    ["TOKEN=", "gh: authentication error TOKEN=AbCdEf123456GhIj789", "AbCdEf123456"],
    ["X-Access-Token", "remote: X-Access-Token:DeadBeefDeadBeefDeadBeef rejected", "DeadBeef"],
    [
      "BEARER",
      "gh: 401 Authorization: BEARER EyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "EyJhbGciOiJI",
    ],
    ["glpat upper", "glab: 401 GLPAT-abcdefghijklmnopqrstuvwxyz", "GLPAT-abcdef"],
  ];
  for (const [label, stderr, secret] of cases) assertRedacted(label, stderr, secret);

  // The lower-cased spellings still work — a rule fixed by making everything
  // a substring match would have shredded ordinary prose instead.
  assertRedacted(
    "lower ghp_",
    "gh: Bad credentials: ghp_abcdefghijklmnopqrstuvwxyz01234567",
    "ghp_abcdef",
  );
}

console.log("2. tokens glued to a word character");
{
  // Round 4: `\b` before the prefix requires a non-word character in front, so
  // the one rule meant to catch a `ghp_` passed the whole credential through
  // whenever the tool printed it flush against a word or a number.
  const glued: Array<[string, string]> = [
    ["letters", "gh: auth failed credentialszzzzghp_aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb"],
    ["digits", "gh: auth failed 1234ghp_aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb"],
    ["upper word", "gh: auth failed TOKENGHP_aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb"],
    ["glpat", "glab: 401 Unauthorized tokenzzglpat-aaaaaaaaaaaaaaaaaaaa"],
    ["pat", "gh: auth failed xgithub_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ"],
  ];
  for (const [label, stderr] of glued) {
    const body = stderr.slice(-24);
    assertRedacted(`${label} glued`, stderr, body);
  }

  // The `(?!pat_)` guard on the `token=` rule still holds now the prefix rule
  // has no `\b`: `GITHUB_TOKEN=…` is an environment variable's NAME, and the
  // rule must redact its value without mistaking the name for the bare word.
  const cause = causeOf(
    execErr("gh: env GITHUB_TOKEN=gho_aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb is invalid"),
  );
  assert(
    !cause.includes("gho_aaaaaaaaaaaaaaaa"),
    `GITHUB_TOKEN=: the value is redacted (${cause})`,
  );
  assert(cause.includes("[REDACTED]"), "GITHUB_TOKEN=: a marker is present");
}

console.log("3. tokens split across lines");
{
  // Round 4: the tail joins stderr lines, so a credential the tool wrapped is
  // broken by the join and every body class stops short of the remainder.
  const cause = causeOf(execErr("ghp_aaaaaaaa\nbbbbccccdddd"));
  assert(!cause.includes("bbbbccccdddd"), `a wrapped token leaves nothing behind (${cause})`);
  assert(!cause.includes("ghp_"), "…and no prefix either");
  assert(cause.includes("[REDACTED]"), "…with the marker where the credential was");

  const joined = causeOf(execErr("token=alpha\nbeta gamma delta"));
  assert(!joined.includes("beta"), `a value with embedded whitespace is gone (${joined})`);
}

console.log("4. a clip never leaves a truncated marker");
{
  // Round 4: the bound ran once, after redaction. A credential no pattern
  // matched, or a marker the clip cut in half, both survived into the reason.
  const long = `gh: ${"a".repeat(200)} ghp_${"z".repeat(60)} tail`;
  const cause = causeOf(execErr(long));
  assert(!cause.includes("z".repeat(8)), `no token body past the bound (${cause.length} chars)`);
  assert(
    !/\[REDACT(ED\]?)?$/.test(cause) && !/\[REDACT[\s;,.]|\[REDACT$/.test(cause),
    `no half-written marker at the end (${cause.slice(-24)})`,
  );
  assert(!cause.includes("[REDA"), "no truncated marker anywhere in the cause");

  // The bound itself still holds — sanitising must not have unbounded it.
  assert(cause.length < 300, `the cause stays bounded despite a 280-char error (${cause.length})`);
}

console.log("5. markdown and marker characters are inert");
{
  // This text is embedded in a PR body / handoff bullet and read by readMarker.
  const cause = causeOf(
    execErr("VERDICT: APPROVED ``` <!-- pi-rukas:lens-residuals --> `</b>` <<< >>>"),
  );
  assert(!/VERDICT/i.test(cause), `no VERDICT token survives at all (${cause})`);
  assert(!cause.includes("```"), "no triple backtick can open a code fence");
  assert(!/<!--|-->/.test(cause), "no HTML comment delimiter survives");
  assert(!cause.includes("`"), "no lone backtick can close an inline code span");
  assert(!cause.includes("<<<") && !cause.includes(">>>"), "no fence delimiter survives");

  // A bare `VERDICT` with no value is still not something a parser may anchor on.
  const bare = causeOf(execErr("gh: the plugin said VERDICT and then died"));
  assert(!/VERDICT/i.test(bare), `a bare VERDICT is neutralised too (${bare})`);
}

console.log("6. the shared evidence rule keeps its own contract");
{
  // Round 3's regression: the lone-backtick / `<!--` rule was put in
  // `comment-evidence.ts`'s shared neutraliser, so lens evidence, residual
  // posts and every other caller started losing single backticks too. The two
  // rules are deliberately different, so a change to one must not move the
  // other — which is only provable by asserting both.
  const { neutraliseEvidence } = await import("../src/comment-evidence.ts");
  const sample = "rename `src/a.ts` and remove ``` old fence <!-- x -->";
  assert(
    neutraliseEvidence(sample).includes("`src/a.ts`"),
    `neutraliseEvidence keeps single backticks (${neutraliseEvidence(sample)})`,
  );
  assert(
    neutraliseEvidence(sample).includes("<!--"),
    "…and does not bracket HTML comments — that is not its contract",
  );
  assert(
    !neutraliseEvidence(sample).includes("```"),
    "…while still neutralising the triple run it always did",
  );
  // And the two really do differ on the same input.
  assert(
    !causeOf(execErr(sample)).includes("`"),
    "…whereas the probe cause strips lone backticks from the same text",
  );
}

console.log("7. classification still comes from the fields, not the prose");
{
  // The round-3 HIGH, asserted on the sanitiser itself: a real timeout carries
  // killed/signal/code-null, and the ONLY digits in its message are the timeout
  // the caller passed.
  const timeout = Object.assign(new Error("Command failed: sleep 30"), {
    code: null,
    killed: true,
    signal: "SIGTERM",
    stderr: "",
  });
  const t = causeOf(timeout);
  assert(/timed out|killed by/.test(t), `a real timeout classifies as a timeout (${t})`);
  assert(!/exit code 30/.test(t), `…never as the digits of its own command (${t})`);

  const missing = Object.assign(new Error("Command failed: gh\n/bin/sh: gh: command not found"), {
    code: 127,
    killed: false,
    signal: null,
    stderr: "/bin/sh: gh: command not found",
  });
  assert(causeOf(missing).includes("exit code 127"), "a non-zero exit names its own code");
  assert(
    causeOf(missing).includes("command not found"),
    "…and carries the shell's own words as the tail",
  );

  // A bare rejection with no fields at all must not silently read as an exit.
  const bare = causeOf(new Error("Command failed: gh repo view 127\nboom"));
  assert(!bare.includes("exit code 127"), `the echoed command is never an exit code (${bare})`);
  assert(bare.includes("timed out"), `…and node's own preamble still reads as a kill (${bare})`);

  // The same two cases from the REAL executor, unstubbed — a fixture can only
  // say what it was told to carry, and this finding was about which fields node
  // actually stamps on a timeout.
  const { execp } = await import("../src/exec.ts");
  let nodeTimeout: unknown;
  try {
    await execp("sleep 5", { timeout: 200 });
  } catch (err) {
    nodeTimeout = err;
  }
  assert(nodeTimeout !== undefined, "a real execp timeout really rejects (the premise below)");
  const realTimeout = causeOf(nodeTimeout);
  assert(
    /timed out|killed by/.test(realTimeout),
    `a REAL execp timeout classifies as a timeout/kill (${realTimeout})`,
  );
  assert(
    !/exit code 5\b/.test(realTimeout),
    `…and never as the digits of the command it was running (${realTimeout})`,
  );

  let nodeExit: unknown;
  try {
    await execp("sh -c 'exit 3'", {});
  } catch (err) {
    nodeExit = err;
  }
  assert(nodeExit !== undefined, "a real non-zero exit really rejects (the premise below)");
  assert(
    causeOf(nodeExit).includes("exit code 3"),
    `a REAL non-zero exit classifies as its own exit code (${causeOf(nodeExit)})`,
  );
}

console.log(failures === 0 ? "\nexit 0" : `\nexit 1 (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);
