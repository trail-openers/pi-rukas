/**
 * public-hygiene-guard — the mode-independent `tool_call` hook that refuses an
 * agent command whose public text carries a private term (#1788).
 *
 * This repository is public. Agent-written issues, PR bodies, comments,
 * fixtures and commit messages carried private host names, addresses, private
 * project names and personal paths, and no mechanical check existed — AGENTS.md's
 * "Public repository hygiene" section is the prose rule, and prose is what
 * failed. This hook is the enforcement, in the same shape as `merge-guard.ts`
 * (#912) and `developer-push-guard.ts` (#1113): a `tool_call` hook registered
 * in `registerModeIndependentGuards`, ahead of every trust/sandbox bypass,
 * because a guard placed after them never runs in the modes that are the
 * default.
 *
 * ## What it refuses
 *
 * - `gh issue|pr|release create|edit|comment|review` — `--title`, `--body`,
 *   `--body-file`/`-F`, `--notes`/`--notes-file`, including inside `bash -c`;
 * - `gh api` writing to an `/issues`, `/pulls`, `/releases` or `/comments`
 *   path — `-f`/`-F` values, `@file` operands and `--input` files;
 * - `git commit -m`/`--message`/`-F`/`--file`;
 * - `git push` to a github.com remote — the outgoing commits' messages and
 *   ADDED diff lines, against the PRIVATE denylist only.
 *
 * ## What it never does
 *
 * Echo the term. Every refusal names a LINE NUMBER, a LOCATION or a CATEGORY
 * (see `public-hygiene-refusals.ts`), and the trace lines carry categories,
 * line numbers and lengths only. `traceWarn` is ungated stderr that the
 * headless console writer and the run transcript capture with no redaction in
 * front of it — #1417 learned that the hard way with a merge refusal that
 * quoted a held command. Here the quoted text would be the secret itself.
 *
 * ## Registration: exactly once per process
 *
 * Registered in `registerModeIndependentGuards` (subagent-guard-guards.ts) and
 * NOT in the parent-only direct list in `permission-guard.ts`. That block is
 * reached by every entry point — the companion (`child-guards.ts`, trust-mode
 * children) and `registerSubagentGuard` (strict/headless children), and the
 * parent reaches it through `registerPermissionGuard` — so one call there is
 * one hook per process. A second registration would run the push scan's git
 * calls twice per push, which is the failure mode #926's companion no-op
 * exists to prevent. `test-public-hygiene-guard.ts` pins the double-registration
 * case; `test-child-guards-extension.ts` pins the exact set.
 *
 * ## Exemptions by construction
 *
 * - The driver's own forge posts do not pass through this hook (they are
 *   in-process execs, like the #912 merge guard's mechanized merge). They are
 *   covered instead by `checkPublicText` at the `createForge` exec seam in
 *   `forge.ts`, which applies the same pure check to issue/PR titles and bodies
 *   before any command runs.
 * - A human typing `git push` in their own terminal is not a `tool_call`;
 *   `bin/pre-push-hygiene.sh` is the human-side counterpart, honouring the
 *   same escape hatch.
 * - Non-github.com remotes are not push-scanned (issue decision 3).
 *
 * ## Escape hatch
 *
 * `PI_ENSEMBLE_PUBLIC_HYGIENE=0` disables the guard, checked at registration
 * and returned before `pi.on`, exactly as `unreviewedMergeAllowed()` and
 * `developerPushAllowed()` do. Only `0` disables: any other value leaves the
 * guard on, so `PI_ENSEMBLE_PUBLIC_HYGIENE=false` is not an accidental off
 * switch.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExecFn } from "./worktree.ts";
import {
  publicTextProblem,
  readPublicDenylist,
  type DenylistRead,
} from "./public-denylist.ts";
import { scanPushRange } from "./public-hygiene-push.ts";
import {
  commandPushes,
  scanPublishSurfaces,
} from "./public-hygiene-scan.ts";
import type { PublishText, ScanProblem } from "./public-hygiene-types.ts";
import {
  denylistUnreadableRefusal,
  refusalFor,
  type DenylistHitLocation,
} from "./public-hygiene-refusals.ts";
import { trace, traceWarn } from "./trace.ts";

/**
 * The refusal a driver-authored publish carries when the forge exec seam
 * rejects it (#1788).
 *
 * Typed so the driver's existing error handling distinguishes "this text is
 * not publishable" from "`gh` failed" without parsing prose, and so a caller
 * that wants to surface the refusal verbatim has a named class to catch. The
 * message IS the refusal text and never contains the matched term.
 */
export class PublicHygieneError extends Error {
  /** Stable marker the driver's error paths match on, independent of the text. */
  readonly publicHygiene = true;

  constructor(message: string) {
    super(message);
    this.name = "PublicHygieneError";
  }
}

/** The operator's off switch — exactly `0`, read at registration. */
function hygieneGuardDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_ENSEMBLE_PUBLIC_HYGIENE === "0";
}

/**
 * Whether THIS process has already installed the hook.
 *
 * The guard has one intended registration per process, but two reachable
 * registration sites: the shared block (`subagent-guard-guards.ts`), which both
 * child entry points call, and the parent's direct list in
 * `permission-guard.ts` — which does NOT call the shared block, so without it
 * the parent session (the PM, the one who types `gh issue comment`) would run
 * unguarded, and PM is precisely the role that filed the issues this guard
 * exists to stop. A process that reaches both sites — a child loaded with the
 * companion AND the full pi-rukas extension — must still hold one hook, so the
 * flag is the structural guarantee rather than a convention in a comment. The
 * push scan makes git calls per push, so a duplicate is not merely redundant.
 */
let installedInThisProcess = false;

/** Test seam: forget that this process registered the guard. */
export function resetPublicHygieneRegistrationForTests(): void {
  installedInThisProcess = false;
}

/** Whether the hook is installed in this process (for the double-registration canary). */
export function publicHygieneInstalled(): boolean {
  return installedInThisProcess;
}

/** What the guard's git reads go through; tests inject a scripted executor. */
export interface PublicHygieneOpts {
  execFn?: ExecFn;
  /** Override for the denylist read (tests point it at a scratch file). */
  readDenylist?: (env?: NodeJS.ProcessEnv) => DenylistRead;
}

/** A verdict the guard reached, for the trace. Never carries text. */
type Verdict =
  | { kind: "clean"; texts: number }
  | { kind: "denylist"; location: string; line: number; length: number }
  | { kind: "generic"; location: string; category: string; length: number }
  | { kind: "unreadable"; location: string; length: number };

/**
 * Register the guard. Call from `registerModeIndependentGuards`, ahead of every
 * bypass, and exactly once per process.
 */
export function registerPublicHygieneGuard(
  pi: ExtensionAPI,
  opts: PublicHygieneOpts = {},
): void {
  if (hygieneGuardDisabled()) {
    trace("public-hygiene-guard: PI_ENSEMBLE_PUBLIC_HYGIENE=0 — publish checks disabled");
    return;
  }
  if (installedInThisProcess) {
    trace("public-hygiene-guard: already registered in this process — skipping the second hook");
    return;
  }
  installedInThisProcess = true;
  const exec = opts.execFn;
  const readDenylist = opts.readDenylist ?? readPublicDenylist;
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: string })?.command ?? "";
    if (command === "") return;
    const cwd = toolCwd(ctx);
    const decision = await inspectCommand(command, cwd, exec, readDenylist);
    if (!decision) return;
    const v = decision.verdict;
    // Categories, line numbers and lengths only — never the term, never a
    // surrounding excerpt.
    if (v.kind === "denylist") {
      traceWarn(
        `public-hygiene: BLOCKED publish denylist line=${v.line} location=${v.location} textLength=${v.length}`,
      );
    } else if (v.kind === "generic") {
      traceWarn(
        `public-hygiene: BLOCKED publish category=${v.category} location=${v.location} textLength=${v.length}`,
      );
    } else if (v.kind === "unreadable") {
      traceWarn(
        `public-hygiene: BLOCKED publish unreadable location=${v.location} textLength=${v.length}`,
      );
    } else {
      trace(`public-hygiene: publish clean (${v.texts} text surface(s) checked)`);
    }
    return { block: true, reason: decision.reason };
  });
}

/**
 * The tool call's own working directory, falling back to this process's.
 *
 * A `--body-file` is relative to the directory the command runs in, which for
 * a /work developer is its detached worktree and not the repo root
 * (AGENTS.md §7, `lensWorktree()`). Pi's tool_call context does not carry a
 * cwd, so the best available answer is this process's directory — the child's
 * own cwd, which is the worktree for a child — and the admissible-root rule
 * below is what makes a wrong guess refuse rather than publish.
 */
function toolCwd(_ctx: unknown): string {
  const maybeCtx = _ctx as { cwd?: unknown } | undefined;
  const fromCtx = typeof maybeCtx?.cwd === "string" ? maybeCtx.cwd : undefined;
  return fromCtx && fromCtx !== "" ? fromCtx : process.cwd();
}

/** A refusal and the trace label for it. */
interface Decision {
  reason: string;
  verdict: Verdict;
}

/**
 * The whole decision, pure apart from the two injected seams. Exported so the
 * smoke test drives it directly with a scratch denylist and a scripted
 * executor, without a real Pi process.
 */
export async function inspectCommand(
  command: string,
  cwd: string,
  exec?: ExecFn,
  readDenylist: (env?: NodeJS.ProcessEnv) => DenylistRead = readPublicDenylist,
): Promise<Decision | undefined> {
  const deny = readDenylist();
  // A configured denylist nobody could read is not a denylist: refuse rather
  // than fall back to the generic set and report the guard as working.
  if (deny.state === "unreadable") {
    return {
      reason: denylistUnreadableRefusal(deny.reason),
      verdict: { kind: "unreadable", location: "denylist", length: 0 },
    };
  }
  const scan = scanPublishSurfaces(command, cwd);
  const push = commandPushes(command);
  if (!scan.publishes && !push) return undefined;

  const texts = [...scan.texts];
  const problems: ScanProblem[] = [...scan.problems];
  if (push) {
    if (!exec) {
      // No executor to ask git: the push cannot be read, so it cannot pass.
      problems.push({ location: "push range", reason: "could not be read (no git executor)" });
    } else {
      const pushed = await scanPushRange({ exec, cwd });
      texts.push(...pushed.texts);
      problems.push(...pushed.problems);
    }
  }

  const problem = problems[0];
  if (problem) {
    return {
      reason: refusalFor(problem, undefined, undefined) ?? "",
      verdict: { kind: "unreadable", location: problem.location, length: 0 },
    };
  }
  const hit = firstHit(texts, deny);
  if (!hit) return undefined;
  const reason = refusalFor(undefined, hit.denylistHit, hit.genericHit);
  if (reason === undefined) return undefined;
  return { reason, verdict: hit.verdict };
}

/** The first dirty surface across every text this command would publish. */
export function firstHit(
  texts: readonly PublishText[],
  deny: DenylistRead,
): {
  denylistHit?: DenylistHitLocation;
  genericHit?: { location: string; category: "private-ipv4" | "home-path" };
  verdict: Verdict;
} | undefined {
  for (const text of texts) {
    const hit = publicTextProblem(text.text, deny, text.generic);
    if (!hit) continue;
    if (hit.kind === "unreadable") {
      return { verdict: { kind: "unreadable", location: text.location, length: text.text.length } };
    }
    if (hit.kind === "denylist") {
      return {
        denylistHit: { location: text.location, line: hit.line },
        verdict: {
          kind: "denylist",
          location: text.location,
          line: hit.line,
          length: text.text.length,
        },
      };
    }
    return {
      genericHit: { location: text.location, category: hit.category },
      verdict: {
        kind: "generic",
        location: text.location,
        category: hit.category,
        length: text.text.length,
      },
    };
  }
  return undefined;
}

/**
 * The pure text check the driver's own forge posts go through (#1788, PM
 * decision 1): issue and PR titles and bodies checked before the forge adapter
 * execs anything. The generic set applies to every public text surface,
 * including the driver's in-process writes; only the `git push` DIFF scan is
 * private-denylist-only.
 *
 * Returns a refusal string, or undefined when the text is clean. It never
 * contains the matched term.
 */
export function publicTextRefusal(
  label: string,
  text: string,
  deny: DenylistRead = readPublicDenylist(),
): string | undefined {
  if (hygieneGuardDisabled()) return undefined;
  const hit = publicTextProblem(text, deny, true);
  if (!hit) return undefined;
  if (hit.kind === "unreadable") return denylistUnreadableRefusal(hit.reason);
  if (hit.kind === "denylist") {
    return refusalFor(undefined, { location: label, line: hit.line }, undefined);
  }
  return refusalFor(undefined, undefined, { location: label, category: hit.category });
}
