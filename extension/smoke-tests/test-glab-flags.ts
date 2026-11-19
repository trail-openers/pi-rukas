#!/usr/bin/env bun
/**
 * Flag-existence gate for every `glab` subcommand the forge layer builds.
 *
 * The defect this closes: `glab mr create` was issued with a positional source
 * branch, `--description-file` and `--output json` — and no version has the
 * positional source or `--output` (verified on 1.130.0, which answers
 * `--output` with `unknown flag` and a bare branch with `unknown command`),
 * while `--description-file` exists only from 1.115.0. Every GitLab PR-create
 * step died on `ERROR Unknown flag:` before a network call. gh and glab spell
 * the same operations differently, and a flag one of them lacks is a
 * silent-for-years bug until someone runs the forge that needs it.
 *
 * Two arms, because the property lives in two places:
 *
 *   OFFLINE (always runs; CI has no glab) — every flag a GitLab builder emits is
 *   in that subcommand's pinned set, which was captured from real
 *   `glab <sub> --help` output. Short and long forms are distinct members, so a
 *   builder that reaches for the short spelling of a flag that exists only long
 *   is caught.
 *
 *   LIVE (only when glab is on PATH) — the pinned set is a subset of what the
 *   installed binary's own `--help` lists, and every flag the builder emits is
 *   looked up in that same set. The pinned set therefore cannot carry a flag the
 *   binary does not list, and the builder cannot carry one the pinned set does
 *   not. With no glab on PATH the arm prints a SKIP and counts as skipped: an
 *   unrun arm is never a passed arm.
 *
 * What the original gate missed, and the shape to keep: the help block is read
 * from its `FLAGS` header to the next two-column section header, and a row is
 * matched by its column layout (`-x  --long  description`) rather than by any
 * token starting with a dash. An indentation assumption silently matched zero
 * rows, the arm reported "no flag rows", skipped, and exited 0 — so the invented
 * `--description-file` was never checked against the real help, where it exists
 * only as an EXAMPLES line and a prose mention.
 */

import { spawnSync } from "node:child_process";
import * as cmds from "../src/forge-commands.ts";
import { argvOf, cmdOf, GLAB_CALLS } from "./lib/glab-calls.ts";
import { glabFlagCanaries, glabFloorCanaries } from "./lib/glab-flags-both-ways.ts";
import { expectedNoteBodyFile, GLAB_FLAGS, GLAB_MIN_VERSION } from "./lib/glab-flags-pinned.ts";

/** A full 40-char SHA — the shape the merge head pin requires of its OID. */
const OID = "e".repeat(40);

let exit = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

let skipped = 0;
function skip(msg: string) {
  console.log(`SKIP ${msg}`);
  skipped++;
}

/** Strip the `glab` word, drop any quoted endpoint (an argument, never a flag),
 *  and leave `<sub> <sub2> …`. */
function subcommandOf(argv: string[]): string {
  const parts: string[] = [];
  for (const a of argv) {
    if (a === "glab" || !a.startsWith("-") && parts.length < 2 && !a.includes("/") && !a.includes(":")) {
      if (a !== "glab") parts.push(a);
      continue;
    }
    if (a.startsWith("-")) break;
  }
  return parts.join(" ");
}

/** Every flag token in argv, with any `=value` suffix kept on the token (a
 *  builder that set a flag with `=` still needs that flag to exist). */
function flagsOf(argv: string[]): string[] {
  return argv.filter((a) => a.startsWith("-")).map((a) => a.split("=")[0]!);
}

/** Two flag lists holding the same members, in any order. */
function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

// ── Offline arm: every emitted flag is in the subcommand's pinned set ──────

for (const call of GLAB_CALLS) {
  const pinned = GLAB_FLAGS[call.key];
  if (!pinned) {
    assert(false, `${call.name}: no pinned flag set under key "${call.key}"`);
    continue;
  }
  const sub = subcommandOf(call.argv);
  const subOk =
    sub === call.key ||
    call.key === "api" ||
    sub.startsWith(call.key) ||
    // The note post runs the parent verb with the leaf's flag (`glab mr note 17
    // --body-file`), while the pinned set — and therefore this key — is the leaf
    // `mr note create`, the command whose help actually lists `-m/--message`.
    (call.expectedUnknown !== undefined && call.key.startsWith(`${sub} `));
  assert(subOk, `${call.name}: argv names ${call.key} (got "${sub}")`);
  const unknown = flagsOf(call.argv).filter((f) => !pinned.has(f));
  const expected = call.expectedUnknown ?? [];
  assert(
    sameMembers(unknown, expected),
    `every flag ${call.name} emits is in the pinned set for \`${call.key}\`${
      unknown.length ? ` — unknown: ${unknown.join(", ")}` : ""
    }${expected.length && !sameMembers(unknown, expected) ? ` — expected unknown: ${expected.join(", ")}` : ""}`,
  );
}

// Short and long forms are distinct: `-d` on `mr create` is the description,
// and `-F` is what `mr view` needs for json — the two are not interchangeable.
{
  // Two builders answer "this flag does not exist" by refusing, and both refusals
  // are load-bearing: without them the pre-fix builder emitted `--state closed`
  // and `--subject …` and every GitLab merge died on `ERROR Unknown flag:`. The
  // enumeration above cannot tell a refusal from a builder that quietly dropped the
  // flag, so each is asserted here against the thrown message.
  let listThrew = "";
  try {
    cmds.prListCmd("gitlab", { sourceBranch: "feature/x", state: "closed" });
  } catch (e) {
    listThrew = String((e as Error).message);
  }
  assert(
    listThrew.includes("no --state") && listThrew.includes("closed"),
    `mr list refuses a state glab spells only as -c/-M, naming it (${listThrew || "no throw"})`,
  );
  let mergeThrew = "";
  try {
    cmds.prMergeCmd("gitlab", 17, OID, "squash", "feat(x): y");
  } catch (e) {
    mergeThrew = String((e as Error).message);
  }
  assert(
    mergeThrew.includes("no --subject") && mergeThrew.includes("--squash-message"),
    `mr merge refuses a subject rather than dropping it, naming the flags glab does have (${mergeThrew || "no throw"})`,
  );
  // …and `open` is the state that needs no flag at all, so the common call works.
  assert(
    !argvOf(cmds.prListCmd("gitlab", { sourceBranch: "x", state: "open" })).includes("--state"),
    "mr list emits no --state for `open` — glab's own default",
  );

  assert(GLAB_FLAGS["mr create"]?.has("-d") === true, "mr create pins -d (the description)");
  // The builder uses `-d`, which every glab version lists, and never the file
  // form — `--description-file` exists only from 1.115.0, so a builder that
  // reached for it would break on older builds. It is NOT asserted absent from
  // the real help, where it is a listed flag.
  assert(
    !GLAB_FLAGS["mr create"].has("--description-file"),
    "mr create does not pin --description-file: the builder emits -d, which every version has",
  );
  assert(!GLAB_FLAGS["mr create"].has("--output"), "mr create does not pin --output");
  assert(
    GLAB_FLAGS["mr view"]?.has("-F") === true,
    "mr view pins the -F short form of --output",
  );

  // The one known defect, asserted from the data file's own naming so the flag, the
  // command and the replacement cannot drift apart. `--body-file` is what the
  // GitHub sibling of this post uses; the GitLab arm borrowed it, and glab answers
  // an unknown flag with `ERROR Unknown flag:` before any network call — so the
  // lens-residual disclosure has never landed on a GitLab MR.
  assert(
    !GLAB_FLAGS[expectedNoteBodyFile.key]?.has(expectedNoteBodyFile.emitted),
    `${expectedNoteBodyFile.key} does not pin ${expectedNoteBodyFile.emitted}: glab's note takes ${expectedNoteBodyFile.instead.join("/")}, so the emitted flag is unknown`,
  );
  assert(
    expectedNoteBodyFile.instead.every((f) => GLAB_FLAGS[expectedNoteBodyFile.key]?.has(f)),
    `${expectedNoteBodyFile.key} pins the ${expectedNoteBodyFile.instead.join("/")} pair that replaces the unknown flag`,
  );
}

// ── The floor: one literal, in the data file's header and in the docs ───────

// Judged in `lib/glab-flags-both-ways.ts`, beside the equality canaries and the data
// file whose header carries the literal.
glabFloorCanaries(GLAB_MIN_VERSION, assert);

// ── Both ways: a pin no row emits is dead data, an emitted flag no pin lists is unchecked ─

// The equality itself, and the two copies of the shipped flag text that prove both
// of its directions fail, live in `lib/glab-flags-both-ways.ts` — the same
// data/gate seam this file already splits at, held there by the 500-line limit.
glabFlagCanaries(GLAB_CALLS, GLAB_FLAGS, assert, {
  flagsOf,
  noteReplacement: { key: expectedNoteBodyFile.key, instead: expectedNoteBodyFile.instead },
});

// ── Live arm: the pinned set is a subset of the installed binary's own help ─

function helpFlags(sub: string): Set<string> | undefined {
  const parts = sub.split(" ");
  const res = spawnSync("glab", [...parts, "--help"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  if (res.error) return undefined;
  const found = new Set<string>();
  // Two columns matter, and both are observations of real `glab 1.130.0` output
  // rather than guesses: the section headers sit at two spaces (`  FLAGS`), and a
  // flag row at four — `-x<sp><sp>--long<sp><sp>description`, with the short column
  // dropped for a long-only flag. Matching the row by its column layout (not by any
  // dash-leading token) is what keeps an EXAMPLES line like
  // `glab mr create … --description-file description.md` and a prose mention out of
  // the set — and reading the block between `FLAGS` and the next header is what
  // stops the ARGUMENTS block below it from contributing noise.
  const lines = res.stdout.split("\n");
  // The scan starts at `USAGE`, not at the file's first two-column line: the
  // subcommand's own leading prose is indented two spaces too, so a header test of
  // "two spaces then text" also opens on that prose and closes FLAGS before it
  // begins. USAGE is the first header every subcommand's help prints, and every
  // section that follows — including FLAGS — is at the same indent.
  let started = false;
  let inFlags = false;
  for (const line of lines) {
    if (/^ {2}\S/.test(line)) {
      if (/^ {2}USAGE\b/.test(line)) started = true;
      inFlags = started && /^ {2}FLAGS\b/.test(line);
      continue;
    }
    if (!inFlags) continue;
    const m = /^ {4}(?:(-\w) +)?(--[A-Za-z][\w-]*)(?: +=)?\s{2,}\S/.exec(line);
    if (!m) continue;
    if (m[1]) found.add(m[1]);
    found.add(m[2]);
  }
  return found;
}

const glabPresent = (() => {
  const probe = spawnSync("glab", ["version"], { encoding: "utf8", timeout: 20_000 });
  return !probe.error && probe.status === 0;
})();

if (!glabPresent) {
  skip("live glab --help: glab not on PATH");
} else {
  const keys = [...new Set(GLAB_CALLS.map((c) => c.key))];
  for (const key of keys) {
    const help = helpFlags(key);
    if (!help || help.size === 0) {
      // Not a skip-worthy "nothing to check": the binary IS here, so zero rows
      // means this test's own parser stopped matching the help it was handed.
      // Skipping would be silence read as a pass — the exact shape that let the
      // invented flag through.
      assert(false, `\`glab ${key} --help\` yielded no flag rows — the FLAGS-block parser matched nothing`);
      continue;
    }
    const missing = [...(GLAB_FLAGS[key] ?? [])].filter((f) => !help.has(f) && !help.has(f.split("=")[0]!));
    assert(
      missing.length === 0,
      `every flag pinned for \`${key}\` is one the installed glab lists${missing.length ? ` — absent from its help: ${missing.join(", ")}` : ""}`,
    );
    // And the builder is checked against the binary directly, not only against
    // the pinned set: a flag the parser above never saw fails here even if a
    // hand-edited pinned set would have allowed it.
    const emitted = [
      ...new Set(
        GLAB_CALLS.filter((c) => c.key === key).flatMap((c) =>
          flagsOf(c.argv).filter((f) => !(c.expectedUnknown ?? []).includes(f)),
        ),
      ),
    ];
    const unlisted = emitted.filter((f) => !help.has(f) && !help.has(f.split("=")[0]!));
    assert(
      unlisted.length === 0,
      `every flag the \`${key}\` builders emit is listed in \`glab ${key} --help\`${unlisted.length ? ` — unknown: ${unlisted.join(", ")}` : ""}`,
    );
  }
}

console.log(
  `\n${exit === 0 ? "glab flags green" : "glab flags RED"} — ${String(GLAB_CALLS.length)} builders checked, ${String(skipped)} live arm(s) skipped — exit ${exit}`,
);
process.exit(exit);
