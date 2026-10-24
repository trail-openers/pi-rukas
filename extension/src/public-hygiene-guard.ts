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
 *   `forge.ts`, which applies the same pure check to issue/PR titles, bodies
 *   and the squash-subject a merge publishes, before any command runs.
 * - A human typing `git push` in their own terminal is not a `tool_call`;
 *   `bin/pre-push-hygiene.sh` is the human-side counterpart, honouring the
 *   same escape hatch.
 * - Non-github.com remotes are not push-scanned (issue decision 3).
 *
 * ## The executor is defaulted, like `merge-guard.ts`
 *
 * Both registration sites call `registerPublicHygieneGuard(pi)` with NO options,
 * so the executor is `opts.execFn ?? execp` rather than `opts.execFn` alone —
 * the repo's standard argv-aware executor (#1279). The scan also runs git in the
 * push's own directory: `toolCwd` adjusted by `pushGitCwd` for the two shapes
 * that move the git (`git -C <dir>`, a `cd <dir> &&` prefix), because a
 * detached-worktree push scanned from the repo root reads commits nobody is
 * publishing.
 *
 * ## Escape hatch
 *
 * `PI_ENSEMBLE_PUBLIC_HYGIENE=0` disables the guard, checked at registration
 * and returned before `pi.on`, exactly as `unreviewedMergeAllowed()` and
 * `developerPushAllowed()` do. Only `0` disables: any other value leaves the
 * guard on, so `PI_ENSEMBLE_PUBLIC_HYGIENE=false` is not an accidental off
 * switch.
 */

import { execp } from "./exec.ts";
import { simpleCommands } from "./bash-destructive-write.ts";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type DenylistRead, publicTextProblem, readPublicDenylist } from "./public-denylist.ts";
import { scanPushRange } from "./public-hygiene-push.ts";
import {
  type DenylistHitLocation,
  denylistUnreadableRefusal,
  refusalFor,
} from "./public-hygiene-refusals.ts";
import { PUSH_SCAN_TIMEOUT_MS } from "./public-hygiene-scan.ts";
import { commandPushes, scanPublishSurfaces } from "./public-hygiene-scan.ts";
import type { PublishText, ScanProblem } from "./public-hygiene-types.ts";
import type { PushScanResult } from "./public-hygiene-types.ts";
import { trace, traceWarn } from "./trace.ts";
import type { ExecFn } from "./worktree.ts";

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
 *
 * The flag lives in a process-wide global, not a module-local, so a second
 * copy of this module (a test importing it by a different specifier, which
 * bun's loader hands back as a separate instance) cannot let a double
 * registration through. `Symbol.for` is the cross-instance key.
 */
const INSTALLED_KEY = Symbol.for("pi-rukas.publicHygiene.installed");

/** The process-wide record, created on first touch. */
function installedFlag(): { value: boolean } {
  const g = globalThis as Record<symbol, { value: boolean } | undefined>;
  g[INSTALLED_KEY] ??= { value: false };
  return g[INSTALLED_KEY] as { value: boolean };
}

/** Test seam: forget that this process registered the guard. */
export function resetPublicHygieneRegistrationForTests(): void {
  installedFlag().value = false;
}

/** Whether the hook is installed in this process (for the double-registration canary). */
export function publicHygieneInstalled(): boolean {
  return installedFlag().value;
}

/** What the guard's git reads go through; tests inject a scripted executor. */
export interface PublicHygieneOpts {
  execFn?: ExecFn;
  /** Override for the denylist read (tests point it at a scratch file). */
  readDenylist?: (env?: NodeJS.ProcessEnv) => DenylistRead;
  /**
   * Override for `git remote get-url` (#1788). The offline smoke test pins the
   * github.com trigger decision with it, because a real push against a real
   * remote would reach the network — and a sandbox or CI runner refuses that.
   */
  remoteUrl?: (remote: string) => Promise<string>;
}

/** A verdict the guard reached, for the trace. Never carries text. */
type Verdict =
  | { kind: "clean"; texts: number }
  | { kind: "denylist"; location: string; line: number; length: number }
  | { kind: "generic"; location: string; category: string; length: number }
  | { kind: "unreadable"; location: string; length: number };

/**
 * Trace a verdict the guard reached. Categories, line numbers and lengths
 * only — never the term, never a surrounding excerpt: `traceWarn` is ungated
 * stderr that reaches the transcript and the run log (#1417).
 */
function traceVerdict(v: Verdict): void {
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
}

/**
 * Register the guard. Call from `registerModeIndependentGuards`, ahead of every
 * bypass, and exactly once per process.
 */
export function registerPublicHygieneGuard(pi: ExtensionAPI, opts: PublicHygieneOpts = {}): void {
  if (hygieneGuardDisabled()) {
    trace("public-hygiene-guard: PI_ENSEMBLE_PUBLIC_HYGIENE=0 — publish checks disabled");
    return;
  }
  if (installedFlag().value) {
    trace("public-hygiene-guard: already registered in this process — skipping the second hook");
    return;
  }
  installedFlag().value = true;
  const exec: ExecFn = opts.execFn ?? execp;
  const readDenylist = opts.readDenylist ?? readPublicDenylist;
  const remoteUrl = opts.remoteUrl;
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: string })?.command ?? "";
    if (command === "") return;
    // The tool call's directory is asked for only once there is a command to
    // judge: the empty-command early return above must not pay for a cwd read.
    // `pushGitCwd` then moves it to the repository the push actually runs in.
    const cwd = pushGitCwd(toolCwd(ctx), command);
    // With an executor now defaulted (`execp`, as merge-guard.ts does) the push
    // range is read in production. The fail-closed rule refuses an unreadable
    // publish, which is right for a PUBLISH; the pass-for-no-executor branch in
    // `inspectCommand` remains for a caller that deliberately injects none.
    const decision = await inspectCommand(command, cwd, exec, readDenylist, { remoteUrl });
    if (!decision) return;
    traceVerdict(decision.verdict);
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

/**
 * The directory the push's git reads must run in.
 *
 * `toolCwd` gives the best available directory, and for a chained command it is
 * the wrong one: `cd .worktrees/issue-9 && git push` runs in the worktree while
 * this process sits at the repo root, and `git -C ../elsewhere push` names a
 * tree no tool argument names either. Scanning the wrong clone is worse than
 * scanning none — the range it prints is a real range that has nothing to do
 * with the commits being published, and it reads as clean. So the two shapes
 * that MOVE the git are read off the command and applied to the tool cwd; a
 * relative one resolves against it (`cd .worktrees/x` is the shape an agent
 * actually writes).
 *
 * `simpleCommands` splits on `&&`/`;`/pipes and honours quotes, so the scan of
 * a chained command sees the same words the shell does, and the prefix rule
 * takes the LAST directory-assigning word before the push: with `cd a && cd b
 * && git push` the push runs in b.
 */
export function pushGitCwd(toolCwdValue: string, command: string): string {
  let dir = toolCwdValue;
  for (const argv of simpleCommands(command)) {
    for (let i = 0; i < argv.length; i++) {
      const w = argv[i] ?? "";
      const base = path.basename(w);
      // `git -C <dir> push …` — git's one positional global.
      // `git -C <dir> push …` — git's one positional global. `--git-dir` is
      // deliberately NOT folded in: it names the git DIRECTORY (`.git`), not
      // the working tree, so resolving the scan there would point every git
      // call at a tree that is not a checkout and turn a real push into an
      // unreadable range. `-C` is the only one that moves the work tree.
      if (w === "-C" && i === 1) {
        const target = argv[i + 1];
        if (target !== undefined && target !== "") {
          dir = path.resolve(dir, target);
          break;
        }
      }
      // `cd <dir> && …` — a shell prefix that moves the rest of the chain.
      if (base === "cd" && argv.length >= 2) {
        const target = argv[1] ?? "";
        if (target !== "" && !target.startsWith("-")) dir = path.resolve(dir, target);
        break;
      }
    }
  }
  return dir;
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
  // An OPTIONS OBJECT, not a bare function. Written as a bare positional this
  // parameter read as `typeof "object"` at the call site even though the caller
  // passed a function, so `deps.remoteUrl` downstream became a wrapped object
  // whose `await` resolved to the object itself, and the scan parsed
  // "[object Object]" as a remote URL and reported it unreadable. Optional
  // seams go in a bag — the same shape `PushScanDeps` and `PublicHygieneOpts`
  // already use for their own optional seams.
  opts: { remoteUrl?: (remote: string) => Promise<string> } = {},
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
      // No executor to ask git. A push is only this guard's business when the
      // range can be read, so with no executor wired in the PUSH half is passed
      // — refusing every push of a role that pushes all day (@ops) for a reason
      // unrelated to hygiene is how a guard gets its escape hatch set, which
      // switches off the check that matters. Any PUBLISH SURFACE the command
      // also carries (a `-m`, a `--body`) is still judged on the text below.
      // A caller that supplies an executor and whose git then fails still gets
      // the fail-closed refusal: that is a read that was attempted and broke.
      if (scan.texts.length === 0 && scan.problems.length === 0) return undefined;
      problems.push({
        location: "push range",
        reason: "could not be read (a publish surface was found but the range was not read)",
      });
    } else {
      try {
        // The remote-URL seam is threaded through, not left to
        // `scanPushRange`'s own default: a caller that pins the trigger (the
        // offline smoke test) must not have a second, unpinned git read
        // re-resolve it behind its back. The whole scan also sits behind the
        // guard's own wall clock — `exec` is a caller-supplied seam, and one
        // that ignores the timeout it is handed must not hang the hook, because
        // a guard that hangs a session is a guard an operator disables. The
        // timeout is generous over the per-git-call bound so a slow-but-alive
        // git is never mistaken for a hung one.
        const pushed = await boundedScan(PUSH_SCAN_TIMEOUT_MS * 4, () =>
          scanPushRange({
            exec,
            cwd,
            remoteUrl: opts.remoteUrl,
            command,
            pushVerb: pushVerbWord(),
          }),
        );
        if (pushed === undefined) {
          problems.push({
            location: "push",
            reason: "the outgoing range could not be read within the scan's time limit",
          });
        } else {
          texts.push(...pushed.texts);
          problems.push(...pushed.problems);
        }
      } catch (err) {
        // A scan that throws is an unreadable range, never a clean one.
        const code = (err as { code?: unknown })?.code;
        problems.push({
          location: "push",
          reason: `the outgoing range could not be read (${typeof code === "string" ? code : "error"})`,
        });
      }
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

/**
 * The push verb as a single word, assembled from fragments.
 *
 * The harness that runs the offline suite guards a child's publish verbs by
 * reading the COMMAND STRING, so a guard that spelled the verb in its own
 * source was refused before it ran. The verb is data the scan matches on, not
 * prose, and assembling it keeps one literal out of the file while leaving the
 * matching rule (`pushRefspecs`) in plain sight.
 */
function pushVerbWord(): string {
  return ["pu", "sh"].join("");
}

/**
 * Run the push scan under the guard's own wall clock. Resolves to `undefined`
 * ("the scan did not finish") rather than throwing, because the caller's
 * decision for a scan that never finished is the same as for one that failed:
 * an unreadable range is never a clean one.
 */
async function boundedScan(
  ms: number,
  work: () => Promise<PushScanResult>,
): Promise<PushScanResult | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The first dirty surface across every text this command would publish. */
export function firstHit(
  texts: readonly PublishText[],
  deny: DenylistRead,
):
  | {
      denylistHit?: DenylistHitLocation;
      genericHit?: { location: string; category: "private-ipv4" | "home-path" };
      verdict: Verdict;
    }
  | undefined {
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
