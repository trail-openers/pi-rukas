import type { MergeMethod } from "./work-driver-merged-mechanized.ts";
import {
  assumptionsBlockOf,
  carriedFindingsSectionOf,
  companionLinesOf,
  fixesLinesOf,
} from "./work-driver-pr-body-definition.ts";

/**
 * /work driver — inline prompt builders for the late pipeline steps.
 *
 * Pure string-template builders (no `DriverContext`, no state-machine
 * logic) for Steps 6-9: commit-pr, lens-fix, merge, step-back, the
 * cap-hit handoff-ops comment, and ci monitoring — plus the shared
 * `scratchHygieneSection` helper appended to every inline prompt. Split
 * out of work-driver.ts per AGENTS.md §12 module-size hygiene (issue
 * #171) — these are called directly by the corresponding `run<Step>`
 * handlers in work-driver.ts.
 */

/**
 * Boilerplate appended to every inline prompt. Tells the subagent where
 * the project-local scratch dir is so they don't drop diffs, screenshots,
 * capture scripts, analysis files at the repo root (the empirical pollution
 * pattern from nessie issue #553 — 12 dot-prefixed diff files, 2 PNG
 * screenshots at root, scratch test_string_error.rs, etc).
 *
 * Both `./tmp/` (project-local, gitignored via .git/info/exclude) and
 * `/tmp/` (host-level) are acceptable. The driver creates and points at
 * the project-local path by default because it survives /tmp cleanup
 * policies and stays alongside the worktree for inspection on handoff.
 */
export function scratchHygieneSection(scratchDirAbs: string): string {
  return [
    "",
    "## Scratch files",
    "",
    "Write any ephemeral artefacts (diff snapshots between adversarial rounds,",
    "captured screenshots, analysis outputs, one-off verification scripts) under:",
    "",
    `  ${scratchDirAbs}`,
    "",
    "Do NOT write scratch to the repo root or any tracked directory. Acceptable",
    "alternatives are `/tmp/pi-rukas/...` (host-level). When this dispatch",
    "ends, leave the scratch dir in place — the work-driver removes it on a",
    "successful merge and keeps it on handoff for the user to inspect.",
  ].join("\n");
}

export function inlineCommitPrPrompt(
  issues: number[],
  droppedIssues: Array<{ issue: number; verdict: string; reason: string }>,
  worktrees: Record<string, string>,
  workstreams: Record<
    string,
    {
      id: string;
      scope: string;
      paths: string[];
      outOfScope: string[];
      /** #679 — optional; presence is informational, never read by this prompt. */
      dependsOn?: string[];
      /** #679 — optional; plan-quality declaration, never read by this prompt. */
      integrationTest?: string;
    }
  >,
  branchName: string,
  normalisedSpec:
    | import("./work-driver-pr-body-definition.ts").PipelineStateNormalisedSpec
    | undefined,
  eventLog: readonly import("./workflow-state-events.ts").WorkEvent[],
  scratchDirAbs: string,
  issueTitle?: string,
): string {
  const headline = issues.length === 1 ? `issue #${issues[0]}` : `issues #${issues.join(", #")}`;
  const fixesLines = issues.map((n) => `Fixes #${n}`).join("\\n");
  const fixesNote =
    issues.length === 1
      ? `body MUST include \`Fixes #${issues[0]}\` so merge auto-closes the issue.`
      : `body MUST include ONE \`Fixes #N\` line per active issue (\`${issues.map((n) => `Fixes #${n}`).join("\\n")}\`) so merge auto-closes them all.`;
  const companionLines = companionLinesOf(droppedIssues).join("\\n");
  const droppedNote =
    droppedIssues.length > 0
      ? [
          "",
          "  Multi-issue cycle: include a `Companion to` line in the PR body for each issue dropped by explore (these will NOT auto-close on merge — the operator handles them separately):",
          ...droppedIssues.map(
            (d) =>
              `    - Companion to #${d.issue} (${d.verdict}: ${d.reason || "no reason given"}; left untouched).`,
          ),
        ]
      : [];
  const assumptionsBlock = assumptionsBlockOf(normalisedSpec);
  const carriedFindings = carriedFindingsSectionOf(eventLog);
  const issueTitleLine = issueTitle
    ? `Authoritative issue title (data from the cached issue body): ${JSON.stringify(issueTitle)}`
    : `Issue title unavailable — run \`gh issue view ${issues[0] ?? "<issue>"}\` before writing PR prose.`;
  const scopeFence = Object.values(workstreams).map(
    (workstream) =>
      `  - \`${workstream.id}\`: ${
        workstream.outOfScope.length > 0
          ? `DO NOT STAGE these out-of-scope paths: ${workstream.outOfScope.join(", ")}`
          : "no out-of-scope paths declared; still stage only reviewed in-scope paths or developer-created new files"
      }`,
  );
  const stagingRule =
    "**STAGING FENCE:** Stage ONLY paths under the listed in-scope paths or new files the developers created — NEVER `git add -A` / `git add .`.";
  const proseRule =
    "**PR PROSE:** The PR title/body must describe the DIFF and the ISSUE; do not derive prose from the branch name.";

  // PR14 — multi-workstream cycles need explicit consolidation. Each
  // worktree has its own uncommitted slice of the work (developer prompt
  // Step 3 says "Do NOT commit"); ops's job here is to gather ALL of
  // them onto the integration branch before pushing. Pre-PR14 the prompt
  // was single-tree shaped, ops only committed the cwd's slice, and
  // sibling worktrees' changes were silently lost.
  const ids = Object.keys(worktrees).filter((id) => id !== "default" || worktrees[id]);
  const isMultiWorktree = ids.length > 1;

  if (isMultiWorktree) {
    const worktreeLines = ids.flatMap((id) => {
      const ws = workstreams[id];
      const path = worktrees[id] ?? "(no path)";
      const scope = ws?.scope ?? "(no scope captured)";
      const paths = ws?.paths.length ? ws.paths.join(", ") : "(no paths declared)";
      return [
        `  - **${id}** at \`${path}\``,
        `      scope: ${scope}`,
        `      in-scope paths: ${paths}`,
      ];
    });
    return [
      `/work ${headline} — Step 6 (Commit + PR). **Multi-workstream cycle** — ${ids.length} workstreams.`,
      "",
      "Each developer worked in its own worktree and committed the work there per Step 4 doctrine. Your job is to consolidate every worktree's committed slice onto the integration branch BEFORE pushing — otherwise the sibling workstreams' work is silently dropped (the v0.12.13 /work 577 failure mode).",
      "",
      `Integration branch: \`${branchName}\``,
      issueTitleLine,
      "",
      "Out-of-scope staging fences (these are DO-NOT-STAGE instructions):",
      ...scopeFence,
      "",
      stagingRule,
      proseRule,
      "",
      "Workstream worktrees (each contains the developer's committed slice):",
      ...worktreeLines,
      "",
      `  1. **Verify each worktree has commits ahead of the integration base.** For each of the ${ids.length} worktrees, run \`git -C <path> log --oneline ${branchName}..HEAD | head\`. If any workstream's log is empty, either the developer did not write OR the developer did not commit — STOP, report which workstream, and DO NOT proceed. A clean \`status --porcelain\` is EXPECTED here (committed work), not a failure signal.`,
      "",
      `  2. **Consolidate each worktree's diff onto the integration branch.** Capture each worktree's diff and apply it on the integration branch's working tree (the repo root if it's checked out on \`${branchName}\`, else \`cd\` into a worktree that is). Concrete recipe per workstream:`,
      "       ```",
      "       git -C <worktree-path> add -- <reviewed in-scope-paths-or-developer-created-new-files>",
      `       git -C <worktree-path> diff --cached --binary > tmp/issue-${issues[0]}/<workstream-id>.patch`,
      `       git apply --3way --binary --index tmp/issue-${issues[0]}/<workstream-id>.patch`,
      "       ```",
      `     Repeat for ALL ${ids.length} workstreams. Staging first is not optional: \`git diff HEAD\` omits untracked new files, which is how whole files were silently dropped. \`--binary\` carries blobs a text patch cannot, and \`--3way\` merges two workstreams that touched different regions of one file rather than rejecting the second outright.`,
      "",
      `     **If the repo root is dirty** (uncommitted changes from a prior cycle or a sibling's in-flight work): do NOT sweep them. Run \`git status\` first, stage ONLY the applied patch paths, and commit ONLY those — never bare \`git commit\` after \`add -A\`. The dirty paths may belong to another cycle; check \`.pi/work-state/\` before discarding.`,
      "",
      `  3. **Verify the staged set includes files from ALL ${ids.length} workstreams.** Run \`git diff --name-only --cached\` and confirm each workstream's in-scope paths appear. The driver re-runs this check after your dispatch via \`git diff --name-only origin/<base>..HEAD\` — if any workstream's paths are entirely absent, the cycle halts with cap \`commit-pr-incomplete-consolidation\` and the operator has to investigate. Catch it here first to save the round-trip.`,
      "",
      `  4. \`git commit -m "<concise subject>"\` with a meaningful message. Body should reference all active issues + summarise the ${ids.length} workstreams' contributions.`,
      `  5. \`git push -u origin ${branchName}\`.`,
      `  6. \`gh pr create --title "<title>" --body "...\\n\\n${fixesLines}${companionLines ? `\\n${companionLines}` : ""}\\n\\n${assumptionsBlock}\\n\\n${carriedFindings}"\` — ${fixesNote}`,
      "  7. End your reply with `pr: <PR-number>` so the driver can capture it.",
      ...droppedNote,
      "",
      "If you need a longer PR body, write it to a file under the scratch dir and pass via `gh pr create --body-file <path>` — DO NOT write the body file to the repo root.",
      scratchHygieneSection(scratchDirAbs),
    ].join("\n");
  }

  // N=1 (or no worktrees populated): existing single-tree flow. No churn
  // for the common case.
  return [
    `/work ${headline} — Step 6 (Commit + PR).`,
    "",
    issueTitleLine,
    "",
    "Out-of-scope staging fences (these are DO-NOT-STAGE instructions):",
    ...scopeFence,
    "",
    stagingRule,
    proseRule,
    "",
    "  1. `git status --porcelain` to confirm the developer left uncommitted changes.",
    "  2. `git add` the changed files (avoid `git add -A` — keep the staged set explicit).",
    "     **If the tree is dirty with untracked residue** from a prior cycle or a sibling's in-flight work: do NOT sweep it. Stage ONLY the applied patch paths, commit ONLY those — never bare `git commit` after `add -A`. The dirty paths may belong to another cycle; check `.pi/work-state/` before discarding.",
    '  3. `git commit -m "<concise subject>"` with a meaningful message. Body should reference the active issue(s).',
    `  4. \`git push -u origin ${branchName}\`.`,
    `  5. \`gh pr create --title \"<title>\" --body \"...\\n\\n${fixesLines}${companionLines ? `\\n${companionLines}` : ""}\\n\\n${assumptionsBlock}\\n\\n${carriedFindings}\"\` — ${fixesNote}`,
    "  6. End your reply with `pr: <PR-number>` so the driver can capture it.",
    ...droppedNote,
    "",
    "If you need a longer PR body, write it to a file under the scratch dir and pass via `gh pr create --body-file <path>` — DO NOT write the body file to the repo root.",
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}

export function inlineLensFixPrompt(findings: string, scratchDirAbs: string): string {
  return [
    "Address the six-pass review findings below against the diff currently on this worktree.",
    "",
    "  - Make the minimal change per finding. Group by file.",
    "  - Run local quality gates before declaring complete.",
    "  - Do NOT touch unrelated code.",
    // #543 F5 — same seam-commit clause as the develop prompt: the driver's
    // cap-checkpoint (F5(2)) commits the worktree at natural seams, so a
    // cap kill never leaves only a failure message. Read-only roles get no
    // such line; this one is the developer (write-gated off, worktree cwd).
    // #621 — same explicit git command + gate-requirement wording as
    // inlineDevelopPrompt: the lens-fix worktree is the same tree the
    // develop gate (and later the adversarial diff) reads, so committed
    // work is what the downstream steps expect.
    '  - Commit your work in the worktree at natural seams (a clean build, a passing test suite): run `git add -A` followed by `git commit -m "<type>(scope): concise subject"`. The driver\'s gate REJECTS uncommitted-only work — no commit ahead of base SHA means the step fails. Do NOT push — the driver owns the branch.',
    "",
    "Findings (JSON-encoded array of {path, line, severity, title, suggestion}):",
    "```json",
    findings,
    "```",
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}

/**
 * Step 9 (Merge) ops prompt — fallback path when mechanized merge
 * can't execute (derive fallback, infra failure, or mechanized ops
 * disabled).
 *
 * Merge method is derived from GitHub repo settings; the resolved
 * method is passed as a parameter and this prompt must NOT instruct
 * the agent to choose or override it.
 */
export function inlineMergePrompt(
  issues: number[],
  prNumber: number,
  mergeMethod: MergeMethod,
  scratchDirAbs: string,
): string {
  const issueList = issues.map((n) => `#${n}`).join(", ");
  const issueLines = issues
    .map((n) => `  - issue #${n} (auto-closes via the PR's Fixes line)`)
    .join("\n");
  return [
    `/work issue(s) ${issueList} — Step 9 (Merge).`,
    "",
    "CI is green and lens-review APPROVED. Merge the PR:",
    "",
    `  1. \`gh pr merge ${prNumber} --${mergeMethod} --delete-branch\` — use the specified merge method. Do NOT change it.`,
    "  2. On success, `gh pr merge` prints the merge commit SHA. End your reply with `merge-commit: <sha>` so the driver captures it on the merged event.",
    "  3. If the merge fails (auth, branch protection, conflicts, missing required review), report the gh error verbatim and end with `merge-commit: FAILED — <one-line reason>` — DO NOT retry. The driver routes failures through cap-hit handoff.",
    "",
    "Active issues that will auto-close on merge:",
    issueLines,
    "",
    "After the merge succeeds, the driver runs no further steps — the cycle terminates with status='merged'.",
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}

export function inlineStepBackPrompt(
  issue: number,
  findings: string,
  scratchDirAbs: string,
): string {
  return [
    `Don't review THIS diff. Take a step back and consider whether the SPEC for issue #${issue} has a problem.`,
    "",
    `Original issue: gh issue view ${issue} (read it).`,
    "Recurring rejection pattern across multiple lens-review rounds:",
    "```",
    findings.slice(0, 4000),
    "```",
    "",
    "Which of these six SDD spec elements appears underspecified?",
    '  1. Outcomes — acceptance criteria, what "done" looks like',
    "  2. Scope boundaries — what's in / out of scope",
    "  3. Constraints — technical / system / invariants",
    "  4. Prior decisions — why X was chosen over Y; what previous decisions this depends on",
    "  5. Task breakdown — sub-task structure, ordering, dependencies",
    "  6. Verification criteria — what proves it's done",
    "",
    "Return:",
    "  - `sddElement:` <one of the six>",
    "  - `diagnosis:` <one-sentence>",
    "  - `proposedRevision:` <verbatim text to add to the issue body>",
    "  - `alternativeApproach:` <optional>",
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}

/**
 * Step 7g handoff dispatch prompt. PR4 completes the v1 skeleton: the
 * driver builds the handoff markdown body (renderHandoffMarkdown) and
 * writes it to a scratch file; ops invokes `gh pr comment` / `gh issue
 * comment` against that file, applies the `needs-human-attention` label
 * (creating it if absent), and returns the comment URL.
 */
export function inlineHandoffOpsPrompt(
  issue: number,
  prNumber: number | undefined,
  bodyPath: string,
  scratchDirAbs: string,
): string {
  const target = prNumber ? `pr ${prNumber}` : `issue ${issue}`;
  const commentCmd = prNumber
    ? `gh pr comment ${prNumber} --body-file ${bodyPath}`
    : `gh issue comment ${issue} --body-file ${bodyPath}`;
  const editCmd = prNumber
    ? `gh pr edit ${prNumber} --add-label needs-human-attention`
    : `gh issue edit ${issue} --add-label needs-human-attention`;
  return [
    `/work issue #${issue} — Step 7g (Cap-hit handoff). The driver hit a deterministic loop cap and is handing off to the user. Post the structured comment + apply the label.`,
    "",
    "  1. Ensure the `needs-human-attention` label exists in this repo. If not, create it:",
    '     `gh label create needs-human-attention --color FFAA00 --description "Agent loop hit a cap; human review required"`',
    '     (skip if already exists; ignore the "already exists" error)',
    "",
    `  2. Post the handoff comment on ${target}:`,
    `     \`${commentCmd}\``,
    "",
    "  3. Apply the label:",
    `     \`${editCmd}\``,
    "",
    `  4. The body file is at: \`${bodyPath}\` (already populated by the driver — DO NOT modify or regenerate).`,
    "",
    "  5. Verify the label is on the target with a single unchained command (do NOT chain it to anything else):",
    `     \`${prNumber ? `gh pr view ${prNumber}` : `gh issue view ${issue}`} --json labels\``,
    "",
    "  6. End your reply with the GitHub URL of the comment you just created (the canonical `…#issuecomment-<id>` form `gh` prints when posting succeeds), then on the final line a marker of EXACTLY this shape (the driver parses it mechanically):",
    "     `HANDOFF-RESULT: comment=<the comment URL, or none> label=<applied|not-applied>`",
    "     (use `applied` only if the verification in step 5 showed the label is present on the target)",
    "",
    "On any failure (gh auth, network, label-create), surface the error verbatim and continue with whatever steps are still possible — report what you actually verified, never a status you did not check.",
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}

export function inlineCiPrompt(
  issue: number,
  branchOrScratchDir: string | undefined,
  scratchDirMaybe?: string,
): string {
  // Keep the pre-#284 two-argument shape working for callers that only need
  // the scratch section; the new three-argument shape supplies branchName.
  const branchName = scratchDirMaybe === undefined ? undefined : branchOrScratchDir;
  const scratchDirAbs = scratchDirMaybe ?? branchOrScratchDir ?? "";
  const branchInstruction = branchName
    ? `  1. Find the latest workflow run for the captured feature branch \`${branchName}\` — \`gh run list --branch ${branchName} --limit 1 --json status,conclusion,databaseId,url\`.`
    : "  1. Note: branch not captured — discover via `git branch --show-current` to identify the feature branch, then find its latest workflow run with `gh run list --branch <discovered-branch> --limit 1 --json status,conclusion,databaseId,url`.";
  return [
    `/work issue #${issue} — Step 8 (CI monitoring).`,
    "",
    branchInstruction,
    '  2. If the run is still in progress: prefer `gh run watch <id>` (blocks until CI completes). PR15 — the driver now allows this dispatch up to 30 min by default (env-tunable via `PI_ENSEMBLE_CI_WATCH_TIMEOUT_MS`); pre-PR15 the ops 10-min cap SIGTERM\'d `gh run watch` mid-stream for real CI runs. If `gh run watch` fails or the run needs longer than the cap, fall back to a bounded poll: `while true; do status=$(gh run view <id> --json status,conclusion --jq \'.status + ":" + (.conclusion // "")\'); case $status in completed:success|completed:failure|completed:cancelled) break;; esac; sleep 30; done`.',
    "  3. On success: end your reply with the line `ci-status: success` (driver routes to merge).",
    "  4. On failure: end your reply with `ci-status: failure` AND include the failing-job summary so the developer round that follows has the failure context.",
    "",
    "The driver parses the last line of your reply for the `ci-status:` token — keep it exact.",
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}
