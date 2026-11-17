#!/usr/bin/env bun
/**
 * Flag-existence gate for every `glab` subcommand the forge layer builds.
 *
 * The defect this closes: `glab mr create` was issued with `--description-file`
 * and `--output json` — flags that subcommand does not have — and every GitLab
 * PR-create step died on `ERROR Unknown flag:` before a network call. gh and
 * glab spell the same operations differently, and a flag one of them lacks is a
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
import { ciJobTraceCmd, ciRunJobsCmd, ciRunLogCmd } from "../src/forge-commands.ts";
import * as cmds from "../src/forge-commands.ts";
import { mergeEvidenceGlJobsCmd, mergeEvidenceGlPipelinesCmd } from "../src/forge-commands-gl-evidence.ts";

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

// ── The pinned flag sets, captured from `glab 1.130.0 <sub> --help` ────────
// Each set lists BOTH spellings the help prints for the flags this layer uses.
// A flag the forge layer does not need is deliberately absent: the offline arm
// asks only "does every flag we emit appear here", so a set may hold a subset.

/** The flag rows of a `--help` FLAGS block: `--long` and `-x` spellings only. */
export const GLAB_FLAGS: Record<string, ReadonlySet<string>> = {
  "mr create": new Set([
    "-s",
    "--source-branch",
    "-b",
    "--target-branch",
    "-t",
    "--title",
    "-d",
    "--description",
    "--draft",
    "-y",
    "--yes",
    "-f",
    "--fill",
    "--web",
    "-R",
    "--repo",
  ]),
  "mr update": new Set(["--draft", "--ready", "--wip", "-t", "--title", "-y", "--yes", "--description", "-R", "--repo"]),
  "mr merge": new Set([
    "--squash",
    "-s",
    "--rebase",
    "-r",
    "--yes",
    "-y",
    "--auto-merge=false",
    "--auto-merge",
    "--sha",
    "-m",
    "--message",
    "--squash-message",
    "-d",
    "--remove-source-branch",
    "-R",
    "--repo",
  ]),
  "mr view": new Set(["-F", "--output", "-p", "--page", "-P", "--per-page", "-R", "--repo", "-w", "--web"]),
  "mr list": new Set([
    "-F",
    "--output",
    "-P",
    "--per-page",
    "-s",
    "--source-branch",
    "-t",
    "--target-branch",
    "-c",
    "--closed",
    "-M",
    "--merged",
    "-A",
    "--all",
  ]),
  "mr diff": new Set(["-R", "--repo", "--raw", "--color"]),
  "mr cancel": new Set(["-R", "--repo", "-h", "--help"]),
  "issue view": new Set(["-F", "--output", "-p", "--page", "-P", "--per-page", "-R", "--repo", "-w", "--web"]),
  "issue create": new Set(["-t", "--title", "-d", "--description", "-l", "--label", "-y", "--yes", "-m", "--milestone"]),
  "issue list": new Set([
    "--search",
    "--all",
    "-A",
    "-P",
    "--per-page",
    "-O",
    "--output",
    "-p",
    "--page",
    "-F",
    "--output-format",
  ]),
  "issue close": new Set(["-R", "--repo"]),
  "issue edit": new Set(["-d", "--description", "-t", "--title", "-l", "--label", "-y", "--yes"]),
  "label list": new Set(["-g", "--group", "-F", "--output", "-p", "--page", "-P", "--per-page", "-R", "--repo"]),
  api: new Set([
    "-X",
    "--method",
    "-H",
    "--header",
    "-f",
    "--raw-field",
    "-F",
    "--field",
    "--output",
    "--paginate",
    "--silent",
    "--input",
    "--form",
    "--hostname",
    "--placeholder",
  ]),
  "ci trace": new Set(["-b", "--branch", "-p", "--pipeline-id", "-R", "--repo"]),
  "ci status": new Set(["-l", "--live", "-b", "--branch", "-c", "--compact", "-F", "--output", "-w", "--wait", "-R", "--repo"]),
  "ci view": new Set(["-b", "--branch", "-p", "--pipelineid", "-R", "--repo", "-w", "--web"]),
  "ci lint": new Set(["--dry-run", "--include-jobs", "--ref", "-R", "--repo"]),
  "auth status": new Set(["-a", "--all", "--hostname", "-F", "--output", "-t", "--show-token"]),
  version: new Set(["-h", "--help"]),
};

/** One row per GitLab command the forge layer can issue: its subcommand key and
 *  the command text the builders emit. */
interface GlabCall {
  name: string;
  key: string;
  argv: string[];
}

function words(s: string): string[] {
  // Quote the builders' own quoting is irrelevant here: only flag tokens are
  // inspected, and a quoted value never begins with `-`.
  return s.split(/\s+/).filter(Boolean);
}

function argvOf(cmd: string | { cmd: string; argv?: string[] }): string[] {
  return typeof cmd === "string" ? words(cmd) : (cmd.argv ?? []);
}

function cmdOf(cmd: string | { cmd: string; argv?: string[] }): string {
  return typeof cmd === "string" ? cmd : cmd.cmd;
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

// ── The builders, enumerated ───────────────────────────────────────────────

const OID = "e".repeat(40);
const GLAB_CALLS: GlabCall[] = [
  { name: "mr view", key: "mr view", argv: argvOf(cmds.prViewCmd("gitlab", 17)) },
  {
    name: "mr list",
    key: "mr list",
    argv: argvOf(cmds.prListCmd("gitlab", { sourceBranch: "feature/x" })),
  },
  {
    name: "mr list (open is glab's default)",
    key: "mr list",
    argv: argvOf(cmds.prListCmd("gitlab", { sourceBranch: "feature/x", state: "open" })),
  },
  {
    name: "mr list refuses a state glab cannot spell",
    key: "mr list",
    // The refusal is part of the gate: a state with no `-c`/`-M` spelling must not
    // be answered with the open list. `closed` is the call the pre-fix builder
    // emitted `--state closed` for.
    argv: (() => {
      try {
        return argvOf(cmds.prListCmd("gitlab", { sourceBranch: "feature/x", state: "closed" }));
      } catch (e) {
        // The refusal IS the expected shape, so it is asserted on its own below
        // and carries no flag for this gate to judge.
        return ["mr list", String((e as Error).message)];
      }
    })(),
  },
  { name: "mr update --ready", key: "mr update", argv: argvOf(cmds.prReadyCmd("gitlab", 7)) },
  { name: "mr update --draft", key: "mr update", argv: argvOf(cmds.prDraftCmd("gitlab", 7)) },
  {
    name: "mr merge",
    key: "mr merge",
    argv: argvOf(cmds.prMergeCmd("gitlab", 17, OID, "squash")),
  },
  {
    name: "mr merge refuses a subject glab cannot spell",
    key: "mr merge",
    // `--subject` is a gh flag; `glab mr merge` has none. The builder refuses
    // rather than silently dropping a subject the driver already composed and
    // would report as the merge commit message.
    argv: (() => {
      try {
        return argvOf(cmds.prMergeCmd("gitlab", 17, OID, "squash", "feat(x): y"));
      } catch (e) {
        // The refusal IS the expected shape, so it is asserted on its own below
        // and carries no flag for this gate to judge.
        return ["mr merge", String((e as Error).message)];
      }
    })(),
  },
  { name: "mr diff", key: "mr diff", argv: argvOf(cmds.prDiffCmd("gitlab", 17)) },
  { name: "mr checks (api)", key: "api", argv: argvOf(cmds.prChecksCmd("gitlab", 17)) },
  { name: "mr approvals (api)", key: "api", argv: argvOf(cmds.prReviewsCmd("gitlab", 17)) },
  { name: "issue view", key: "issue view", argv: argvOf(cmds.issueViewCmd("gitlab", 42)) },
  {
    name: "issue create",
    key: "issue create",
    argv: argvOf(cmds.issueCreateCmd("gitlab", "T", "/tmp/b", ["bug", "kind: x"])),
  },
  {
    name: "issue comment (api)",
    key: "api",
    argv: argvOf(cmds.issueCommentCmd("gitlab", 42, "/tmp/c")),
  },
  { name: "issue notes (api)", key: "api", argv: argvOf(cmds.issueCommentsCmd("gitlab", 42)) },
  {
    name: "pr comment (api)",
    key: "api",
    argv: argvOf(cmds.prCommentCmd("gitlab", 17, "/tmp/c")),
  },
  { name: "pr notes (api)", key: "api", argv: argvOf(cmds.prCommentsCmd("gitlab", 17)) },
  {
    name: "issue list --search",
    key: "issue list",
    argv: argvOf(cmds.issueSearchCmd("gitlab", "bug", { allStates: true })),
  },
  {
    name: "issue list",
    key: "issue list",
    argv: argvOf(cmds.issueListCmd("gitlab", { state: "all" })),
  },
  {
    name: "issue edit (api)",
    key: "api",
    argv: argvOf(cmds.issueEditCmd("gitlab", 42, "/tmp/x/body.md")),
  },
  { name: "pipelines (api)", key: "api", argv: argvOf(cmds.pipelineViewCmd(5001)) },
  { name: "pipeline list (api)", key: "api", argv: argvOf(cmds.pipelineListCmd(20)) },
  { name: "label list", key: "label list", argv: argvOf(cmds.labelListCmd("gitlab")) },
  { name: "label create (api)", key: "api", argv: argvOf(cmds.labelCreateCmd("gitlab", "bug", "FF0000")) },
  { name: "label add (api)", key: "api", argv: argvOf(cmds.labelAddCmd("gitlab", "issue", 42, "bug")) },
  {
    name: "label remove (api)",
    key: "api",
    argv: argvOf(cmds.labelRemoveCmd("gitlab", "mr", 17, "bug")),
  },
  { name: "repo view (api)", key: "api", argv: argvOf(cmds.repoSettingsCmd("gitlab")) },
  {
    name: "run jobs (api)",
    key: "api",
    argv: argvOf(ciRunJobsCmd("gitlab", "acme", "widget", 12)),
  },
  { name: "ci run log", key: "ci trace", argv: argvOf(ciRunLogCmd("gitlab", 12)) },
  { name: "job trace (api)", key: "api", argv: argvOf(ciJobTraceCmd(12)) },
  {
    name: "evidence pipelines",
    key: "api",
    argv: argvOf(mergeEvidenceGlPipelinesCmd(17)),
  },
  {
    name: "evidence jobs",
    key: "api",
    argv: argvOf(mergeEvidenceGlJobsCmd(5001)),
  },
  {
    name: "ci status --live (slow notice suggestion)",
    key: "ci status",
    argv: ["glab", "ci", "status", "--live"],
  },
  {
    name: "ci view (slow notice suggestion)",
    key: "ci view",
    argv: ["glab", "ci", "view"],
  },
  { name: "auth status (recovery hint)", key: "auth status", argv: ["glab", "auth", "status"] },
  { name: "version (recovery hint)", key: "version", argv: ["glab", "version"] },
  {
    name: "mr view --web (recovery hint)",
    key: "mr view",
    argv: ["glab", "mr", "view", "17", "--web"],
  },
  {
    name: "mr cancel (recovery hint)",
    key: "mr cancel",
    argv: ["glab", "mr", "cancel", "17"],
  },
];

/**
 * The MR-create call, read from the live builder rather than hard-coded, so the
 * gate follows whatever transport that builder is on. Its argv is the whole
 * point of the gate: it is the call whose invented flags broke every GitLab
 * cycle.
 */
{
  const built = cmds.prCreateCmd("gitlab", "T", "feature/x", "the body", {
    baseBranch: "main",
    draft: true,
  });
  const argv = argvOf(built);
  GLAB_CALLS.unshift({
    name: "mr create",
    key: "mr create",
    argv: cmdOf(built) === "glab" ? argv : ["glab", ...argv],
  });
}

// ── Offline arm: every emitted flag is in the subcommand's pinned set ──────

for (const call of GLAB_CALLS) {
  const pinned = GLAB_FLAGS[call.key];
  if (!pinned) {
    assert(false, `${call.name}: no pinned flag set under key "${call.key}"`);
    continue;
  }
  const sub = subcommandOf(call.argv);
  assert(sub === call.key || call.key === "api" || sub.startsWith(call.key), `${call.name}: argv names ${call.key} (got "${sub}")`);
  const unknown = flagsOf(call.argv).filter((f) => !pinned.has(f));
  assert(
    unknown.length === 0,
    `every flag ${call.name} emits is in the pinned set for \`${call.key}\`${unknown.length ? ` — unknown: ${unknown.join(", ")}` : ""}`,
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
  assert(
    !GLAB_FLAGS["mr create"].has("--description-file"),
    "mr create does not pin --description-file: it is not a flag that subcommand has",
  );
  assert(!GLAB_FLAGS["mr create"].has("--output"), "mr create does not pin --output");
  assert(GLAB_FLAGS["mr view"]?.has("-F") === true, "mr view pins the -F short form of --output");
}

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
        GLAB_CALLS.filter((c) => c.key === key).flatMap((c) => flagsOf(c.argv)),
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
