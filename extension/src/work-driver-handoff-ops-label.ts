/**
 * #1472 — the @ops handoff prompt for a cycle parked because a person CLOSED
 * its issue. Split out of `work-driver-prompts-late.ts` to keep that file under
 * the 500-line limit (AGENTS.md §12), the same seam `workflow-state-schema-*`
 * files use.
 *
 * This is the fourth `needs-human-attention` writer and the only one that is a
 * *prompt* rather than a call: the @ops child runs the `gh ... --add-label`
 * commands we hand it, so no runtime guard downstream can suppress it. The
 * suppression has to happen here, at build time.
 */
export function handoffOpsPromptWithoutLabel(
  issue: number,
  prNumber: number | undefined,
  bodyPath: string,
  scratchDirAbs: string,
): string {
  const target = prNumber ? `pr ${prNumber}` : `issue ${issue}`;
  const commentCmd = prNumber
    ? `gh pr comment ${prNumber} --body-file ${bodyPath}`
    : `gh issue comment ${issue} --body-file ${bodyPath}`;
  return [
    `Post the handoff for issue #${issue} to ${target}:`,
    `  ${commentCmd}`,
    "",
    // The label is named so the child cannot mistake the omission for an
    // oversight — and the reason is stated, because a child that does not know
    // why will "helpfully" add it back.
    `Do NOT add the \`needs-human-attention\` label to #${issue} or to the PR, and do`,
    "not verify it. A person CLOSED this issue mid-cycle: they have already engaged,",
    "and the label would additionally block a legitimate reopen-and-rerun by",
    "stopping the next `/work` at the entry gate.",
    "",
    "The driver records the label as deliberately SKIPPED, not failed.",
    "",
    "Reply with the comment URL on the last line, prefixed HANDOFF_URL:",
    "",
    `Scratch dir for artifacts: ${scratchDirAbs}`,
  ].join("\n");
}
