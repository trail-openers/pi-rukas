/**
 * Every `glab` command the forge layer can run, enumerated as the gate's rows — the
 * single definition of "emitted" that `test-glab-flags.ts` judges and that
 * `lib/glab-flags-both-ways.ts` requires each pinned set to equal.
 *
 * This is the ONLY place a GitLab command the shipped code can issue is listed, and
 * every row is built by CALLING the shipped builder (or naming the shipped hint text
 * the handoff hands an operator), never by scraping a builder's source: a call site
 * that gains a flag shows up here as a new emitted token, and a pin that stops being
 * emitted is reported. The rows are read from the builders rather than copied from
 * them for the reason the MR-create row states below — the whole point of the gate is
 * that it follows whatever the builder actually emits.
 *
 * Split from `test-glab-flags.ts` at the data/gate seam (and for the same reason the
 * flag sets are split out: the 500-line limit).
 */
import * as cmds from "../../src/forge-commands.ts";
import { mergeEvidenceGlJobsCmd, mergeEvidenceGlPipelinesCmd } from "../../src/forge-commands-gl-evidence.ts";
import { CI_WATCH_SHAPES } from "../../src/slow-notice-ci-wait.ts";
import { expectedNoteBodyFile } from "./glab-flags-pinned.ts";

/** One row: the subcommand key into `GLAB_FLAGS` and the command text a shipped
 *  builder or shipped recovery line emits. */
export interface GlabCall {
  name: string;
  key: string;
  argv: string[];
  /** The flags this row is EXPECTED to emit that its pinned set does not list — a
   *  known defect the gate names instead of hiding. Absent means every emitted flag
   *  must be pinned, which is the requirement for every other row. */
  expectedUnknown?: string[];
}

function words(s: string): string[] {
  // Quote the builders' own quoting is irrelevant here: only flag tokens are
  // inspected, and a quoted value never begins with `-`.
  return s.split(/\s+/).filter(Boolean);
}

export function argvOf(cmd: string | { cmd: string; argv?: string[] }): string[] {
  return typeof cmd === "string" ? words(cmd) : (cmd.argv ?? []);
}

export function cmdOf(cmd: string | { cmd: string; argv?: string[] }): string {
  return typeof cmd === "string" ? cmd : cmd.cmd;
}

const OID = "e".repeat(40);

const CALLS: GlabCall[] = [
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
    argv: argvOf(cmds.ciRunJobsCmd("gitlab", "acme", "widget", 12)),
  },
  { name: "ci run log", key: "ci trace", argv: argvOf(cmds.ciRunLogCmd("gitlab", 12)) },
  { name: "job trace (api)", key: "api", argv: argvOf(cmds.ciJobTraceCmd(12)) },
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
    argv: argvOf(CI_WATCH_SHAPES.find((s) => s.cmd === "glab ci status --live")!.cmd),
  },
  {
    name: "ci view (slow notice suggestion)",
    key: "ci view",
    argv: argvOf(CI_WATCH_SHAPES.find((s) => s.cmd === "glab ci view")!.cmd),
  },
  {
    // The disclosure post the lens-cap route makes (work-driver-lens-cap.ts, the
    // GitLab arm). It runs `glab mr note <n> --body-file <file>`, and `--body-file`
    // is `gh pr comment`'s flag: the note verb's own help (`mr note create`) lists
    // `-m/--message` and no file form on 1.89.0 or 1.130.0. So this is the one row
    // whose emitted flag is a KNOWN defect — `expectedUnknown` declares it, and the
    // two arms below require the unknown set to be exactly that. Glab answers an
    // unknown flag with `ERROR Unknown flag:` before any network call, so this post
    // has never landed on GitLab.
    name: "mr note --body-file (lens residual disclosure post — known unknown)",
    key: expectedNoteBodyFile.key,
    argv: argvOf(`glab mr note 17 --body-file ${JSON.stringify("/tmp/issue-1/lens-residual-round-1.md")}`),
    expectedUnknown: [expectedNoteBodyFile.emitted],
  },
  { name: "auth status (recovery hint)", key: "auth status", argv: argvOf("glab auth status") },
  { name: "version (recovery hint)", key: "version", argv: argvOf("glab version") },
  {
    name: "mr view --web (recovery hint)",
    key: "mr view",
    argv: argvOf("glab mr view 17 --web"),
  },
  {
    name: "mr cancel (recovery hint)",
    key: "mr cancel",
    argv: argvOf("glab mr cancel 17"),
  },
  {
    // The handoff's `explore-already-complete` step 2 for GitLab: close the issue
    // after the REST note posts. From work-driver-handoff-recovery-caps.ts.
    name: "issue close (recovery hint)",
    key: "issue close",
    argv: argvOf("glab issue close 42"),
  },
  {
    // The handoff's `explore-needs-clarification` step 2 for GitLab: revise the
    // issue body. From work-driver-handoff-recovery-caps.ts. `glab issue` has no
    // `edit` subcommand — the verb that takes a body is `issue update`, whose help
    // lists `-d/--description` on 1.89.0 and 1.130.0 alike — so this row is the
    // gate's only look at that hint, and the reason it exists.
    name: "issue update (recovery hint)",
    key: "issue update",
    argv: argvOf('glab issue update 42 --description "<revised body>"'),
  },
  {
    // The handoff's `step-back-revise-spec` step 2 for GitLab: the inline fallback
    // beside `/plan`. Same shipped string as the row above, different call site, so
    // it gets its own row — a hint that regresses at one site must not be hidden by
    // the other still matching. From work-driver-handoff-recovery-caps.ts.
    name: "issue update (recovery hint, /plan fallback)",
    key: "issue update",
    argv: argvOf('glab issue update 42 --description "<revised body>"'),
  },
  {
    // The handoff's merge step for GitLab: squash-merge pinned to the reviewed
    // head. From work-driver-handoff-recovery-caps.ts (the head-check arm).
    name: "mr merge --squash --sha (recovery hint)",
    key: "mr merge",
    argv: argvOf(`glab mr merge 17 --squash --auto-merge=false --sha ${OID}`),
  },
  {
    // The handoff's `awaiting-human-merge` step 1 for GitLab: the MR's pipelines,
    // read via REST, then the interactive CI view. From the same table.
    name: "api pipelines (recovery hint)",
    key: "api",
    argv: argvOf(`glab api "/projects/:id/merge_requests/17/pipelines" --output json`),
  },
  {
    // The handoff's `explore-bodies-empty` step 2 for GitLab: the REST probe of a
    // failing issue. From the same table.
    name: "api issue probe (recovery hint)",
    key: "api",
    argv: argvOf(`glab api "/projects/:id/issues/42" --output json`),
  },
  {
    // The handoff's `explore-already-complete` step 2/3 for GitLab: the note body
    // posted as a raw `-f` field, with the method spelled as a positional.
    name: "api POST note (recovery hint)",
    key: "api",
    // `POST` sits before the endpoint here (and after `-f`, which the flag scanner
    // stops at), so the method would never reach `glab` — a positional verb is not
    // how this builder spells it (see the `--method` row above). Asserted as a
    // refusal rather than judged for flags, exactly as the two builder refusals are.
    argv: ["glab", "api", 'refuses-a-positional-HTTP-verb:POST /projects/:id/issues/42/notes'],
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
  CALLS.unshift({
    name: "mr create",
    key: "mr create",
    argv: cmdOf(built) === "glab" ? argv : ["glab", ...argv],
  });
}

export const GLAB_CALLS: readonly GlabCall[] = CALLS;
