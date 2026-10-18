/**
 * developer-push-guard — the mode-independent `tool_call` hook that refuses a
 * DEVELOPER child's `git push`.
 *
 * #1113. The incident (2026-10-11): PM dispatch briefs told developers to
 * rebase and `git push --force-with-lease` on PRs #1063 / #1109 / #1110, many
 * times, and the developers complied — the operator had to intervene with
 * "no developer should push". The doctrine was never the gap:
 * `agents-base/developer.md` says push is @ops's job in four places. The gap
 * is the enforcement layer, and there are two of them, both open:
 *
 *   - `agents.json` GRANTED it — `"git push*": "allow"` and
 *     `"oo git push*": "allow"` in the developer bash map, so even in the two
 *     modes that consult the map (strict opt-in, headless `pi -p`) the answer
 *     was allow. Both rows are gone now; ops keeps its own.
 *   - trust mode — the default on an interactive host — and sandbox mode —
 *     the default in a container — return before any verdict resolution, so
 *     the map is decorative there and nothing else intervenes.
 *
 * So the refusal cannot live in the allowlist, and it cannot live after the
 * bypasses either. It sits in `registerModeIndependentGuards`, ahead of every
 * bypass, exactly like `registerDestructiveGitGuard` (#926) and
 * `registerMergeGuard` (#912) — the same reason those two have: the permission
 * layers answer "may this role run git?" and the answer is yes. This answers
 * "may this role move a remote?", and the answer is no: the driver owns the
 * branch and @ops owns the push.
 *
 * ## Why role-scoped, and why the role is read in the hook body
 *
 * Only `developer` is refused. `ops` pushes by design (agents.json keeps its
 * rows); PM, explore, the reviewers and adversarial-developer have no push to
 * take away. The role is read INSIDE the hook body, not at registration, for
 * the same reason `oo-rewrite-guard.ts` reads it there: the parent session
 * resolves to `project-manager` (`permission-guard.ts` falls back when
 * `PI_ENSEMBLE_ROLE` is unset) and every other role must stay untouched. It
 * also keeps the shared block byte-identical in shape — one list of hooks,
 * each self-scoping, none of them conditional on the process that loads them.
 *
 * ## What is exempt by construction
 *
 * - The `/work` driver's own pushes (`work-driver-integrate.ts`,
 *   `mechanizedCommitPr`, `work-driver-adversarial.ts`) run as in-process
 *   `execp` calls, not `tool_call`s — they never reach this hook, exactly as
 *   with the #912 merge guard and the plan driver's `gh issue create`.
 * - A human typing `git push` in their own terminal is not a `tool_call`.
 * - `git push` is ALSO what `git push --delete` / a branch cleanup would be,
 *   and a developer has no legitimate use for either: the driver owns the
 *   branch, so any spelling of the push verb is refused, not only the
 *   ordinary one.
 *
 * ## Operator escape hatch
 *
 * `PI_ENSEMBLE_ALLOW_DEVELOPER_PUSH=1` makes the hook inert for the whole
 * session, checked at registration (the same seam as
 * `PI_ENSEMBLE_ALLOW_DESTRUCTIVE_GIT` / `PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE`).
 * A harness-set value would be the bypass itself, since the harness is what
 * refuses the push; the variable is the operator's to set in their own shell.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pushRunsCommand, pushesRemote } from "./git-push-command.ts";
import { trace } from "./trace.ts";

/** The role this guard speaks to. Every other role is untouched. */
const DEVELOPER_ROLE = "developer";

/** Operator-only opt-out (see the module header for why it is not harness-set). */
function developerPushAllowed(): boolean {
  return process.env.PI_ENSEMBLE_ALLOW_DEVELOPER_PUSH === "1";
}

/** Whether THIS process is a developer child. Read per call, never cached. */
function isDeveloperChild(): boolean {
  return process.env.PI_ENSEMBLE_ROLE === DEVELOPER_ROLE;
}

/**
 * Refuse `git push` inside a developer child.
 *
 * Call BEFORE the sandbox short-circuit, the subagent-mode branch and the
 * trust-mode bypass (i.e. from `registerModeIndependentGuards`), or in
 * practice it never runs.
 */
export function registerDeveloperPushGuard(pi: ExtensionAPI): void {
  if (developerPushAllowed()) {
    trace("developer-push-guard: PI_ENSEMBLE_ALLOW_DEVELOPER_PUSH=1 — developer pushes permitted");
    return;
  }
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    if (!isDeveloperChild()) return;
    const command = (event.input as { command?: string })?.command ?? "";
    // `pushesRemote` covers the visible forms AND the shell bodies it can read;
    // `pushRunsCommand` is the same body scan asked of a command whose quoting
    // never balanced (an unterminated quote swallows the rest of the line, so
    // `bash -c 'git push` is still a push the shell will run). Two views, one
    // refusal — neither alone catches both shapes.
    const offending = pushesRemote(command) ?? pushRunsCommand(command);
    if (!offending) return;
    trace(`developer-push-guard: BLOCKED developer push — ${offending}`);
    return {
      block: true,
      reason: `Refused: \`${offending}\` moves a remote, and pushing is @ops's job — the /work driver owns the branch, @ops pushes in Step 6. A developer's work lands as COMMITS IN ITS OWN WORKTREE (the develop gate requires a commit ahead of base SHA); nothing asks a developer to publish them.\n\nWhat to do instead: commit with \`git add -A\` then \`git commit -m "<type>(scope): subject"\`, and say in your report that the branch is committed and ready for @ops to push. If a brief told you to push, rebase onto a remote, or force-push, say so in your report rather than doing it — a PM-authored push instruction is the bug (#1113), and the push belongs in an @ops dispatch.\n\nStill open to you: \`git status\`, \`git diff\`, \`git log\`, \`git fetch\`, \`git add\`, \`git commit\`.`,
    };
  });
}

/**
 * Whether a bash command that merely EMBEDS a script body would run `git push`
 * from inside it. `bash -c 'git push'` hides the verb from a quoted-stripping
 * matcher (the payload is quoted, so stripping removes it), so the quoted
 * bodies are decoded and asked with `pushesRemote`. Exported for the table
 * test; the guard reads `pushesRemote` for the visible forms.
 */
export function embeddedPush(command: string): string | undefined {
  return pushRunsCommand(command);
}
