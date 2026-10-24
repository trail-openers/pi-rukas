/**
 * review-accept-guard — the PATH tripwire for the review findings store (#1105,
 * #1764 phase 2).
 *
 * Accepting a recorded finding suppresses it from every later round, so it stays a
 * human act: the operator runs `extension/scripts/review-accept.ts` in a terminal,
 * and that script refuses an agent context (`agentContext`). This hook is the
 * second layer: it refuses an agent bash command that NAMES the store's location,
 * and an agent edit / write / multiedit whose target resolves inside it.
 *
 * WHAT IT USED TO BE, AND WHY THAT IS GONE. Until #1764 this guard modelled shell
 * semantics: a tokeniser, a heredoc skipper, repo-location selectors, and eight
 * "arms" of allowlisted command shapes, with everything unmatched refused. On
 * fieldbox, 2026-10-21/22, it refused ~6,400 ordinary agent commands across 421
 * of 576 children — a `grep` whose pattern held a `$`, a heredoc with a quoted
 * tag, a prose `gh issue edit --title`. #1767 tried to narrow the parser; five
 * review rounds each found a new under-refusal. The store then moved out of the
 * repository entirely (`review-state-path.ts`), so its location is no longer
 * anything an agent is told, and the only decision left worth guarding is an agent
 * writing the path down or reading the file. Both are a string match.
 *
 * So: ONE rule for bash — the command text contains the state root (in any of the
 * spellings a command could use for it, after same-command variable substitution)
 * or the store's basename. NO other shell parsing: no arms, no segments, no
 * heredoc semantics, no read-tool lists, no allowlist. A command that spells
 * neither string runs, whatever else it is.
 *
 * THE OPERATOR PATH IS UNCHANGED. `extension/scripts/review-accept.ts` stays the
 * only way to accept a finding, and its agent-context refusal stays. This module
 * never refused the CLI by name and does not: the file lives in the repository, so
 * refusing it meant refusing the prose that discusses it (issue criterion 12).
 *
 * ADVISORY, NOT A SECURITY BOUNDARY. Every rule here is a substring test on text
 * the agent itself wrote, and agents run as the same UID as everything else: a
 * name assembled from expansions, or read out of a file, walks straight past it.
 * The real boundary is the tool-level one: the acceptance write has no caller in
 * `src/` (test-review-accept-layers.ts holds that) and the CLI refuses an agent
 * context. This guard exists so the honest-but-forgetful agent that pastes the
 * path into a `cat` is stopped and told where the acceptance actually happens.
 */

import { isAbsolute, normalize, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FINDINGS_FILE } from "./review-state-path.ts";
import { trace } from "./trace.ts";

/** The one source of truth for the CLI the refusal tells the operator to use. */
const ACCEPT_CLI = "extension/scripts/review-accept.ts";

/** The directory under the agent dir that holds every clone's state — the same
 * literal `review-state-path.ts` builds its keys under. */
const STATE_LEAF = "review-state";

/** The store's basename, so a test can name it without spelling it. */
export const REVIEW_STATE_FILE = FINDINGS_FILE;

/** The agent dir, in every spelling a command could carry for it. */
function agentDirSpellings(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const envForm = process.env.PI_AGENT_DIR?.trim();
  const out: string[] = [];
  // The resolved form first: what a real command carries when the agent read the
  // path out of a trace line or a tool result.
  if (envForm) out.push(envForm);
  else if (home) out.push(`${home}/.pi/agent`);
  // The textual spellings, which fire whether or not the environment agrees.
  // `~`, `$HOME` and `${HOME}` keep the `.pi/agent` prefix — that is how a human
  // or a script types the location. `PI_AGENT_DIR` IS the agent dir, so the
  // variable form hangs `review-state` straight off it: an agent that reads the
  // variable out of its own environment reaches the root that way, and a
  // `.pi/agent` left in the middle would match a path that does not exist.
  for (const prefix of ["~", "$HOME", "${HOME}"]) {
    out.push(`${prefix}/.pi/agent`);
  }
  for (const prefix of ["$PI_AGENT_DIR", "${PI_AGENT_DIR}"]) {
    out.push(prefix);
  }
  return out;
}

/** The literal spellings that must fire even with no environment set at all —
 * they are pure text, and a guard whose rules depended on the ambient HOME or
 * PI_AGENT_DIR would simply not fire in a process that has neither. */
const ALWAYS_MATCHED = ["~", "$HOME", "${HOME}", "$PI_AGENT_DIR", "${PI_AGENT_DIR}"];

/** `<agentDir>/review-state` resolved to an absolute path, or undefined when
 * neither PI_AGENT_DIR nor HOME is set. */
function resolveStateRoot(cwd: string | undefined): string | undefined {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const envForm = process.env.PI_AGENT_DIR?.trim();
  const agentDir = envForm || (home ? `${home}/.pi/agent` : "");
  if (!agentDir) return undefined;
  const joined = `${agentDir}/${STATE_LEAF}`;
  return isAbsolute(agentDir) ? normalize(joined) : resolve(cwd ?? process.cwd(), joined);
}

/** Every state root a command might name: the resolved one, and each textual
 * agent-dir spelling joined to `review-state`. The `~` / `$HOME` spellings are
 * always present — they are literal text, so a process with no HOME set still
 * refuses a command that names the root the way a human would type it. */
export function reviewStateRoots(cwd?: string): string[] {
  const roots: string[] = [];
  const push = (root: string): void => {
    const clean = root.endsWith("/") ? root.slice(0, -1) : root;
    if (clean && !roots.includes(clean)) roots.push(clean);
  };
  const resolvedRoot = resolveStateRoot(cwd);
  if (resolvedRoot) push(resolvedRoot);
  for (const dir of agentDirSpellings()) push(`${dir}/${STATE_LEAF}`);
  // The variable's own ROOT spelling: `PI_AGENT_DIR` is the agent dir, so the
  // state root sits directly under it. Always present, so a process with no
  // PI_AGENT_DIR set still refuses a command that names the root through it.
  for (const prefix of ["$PI_AGENT_DIR", "${PI_AGENT_DIR}"]) {
    push(`${prefix}/${STATE_LEAF}`);
  }
  return roots;
}

/** `VAR=value` / `export VAR=value` assignments appearing in a command, as
 * (name, value) pairs (#1764 criterion 6). A command that builds the path in a
 * variable and then names `$VAR` spells nothing until the shell expands it, so
 * the substitution happens here, on the text, before the match.
 *
 * Deliberately literal: only what the text plainly assigns. One assignment
 * appearing EARLIER in the command than the use — a `VAR=` to the right of the
 * use is a different statement's business, and substituting it would be guessing.
 * No arithmetic, no subshells, no quoting rules beyond stripping one matching
 * pair of quotes. */
function sameCommandAssignments(text: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const re = /(?:^|[;&|\n]\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=([^\s;&|]+)/g;
  for (const m of text.matchAll(re)) {
    const name = m[1] as string;
    let value = m[2] as string;
    const quote = value[0];
    if ((quote === "'" || quote === '"') && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    pairs.push([name, value]);
  }
  return pairs;
}

/** The command text with every same-command assignment's `$NAME` / `${NAME}`
 * replaced by its value. */
export function withAssignmentsExpanded(text: string): string {
  let out = text;
  for (const [name, value] of sameCommandAssignments(text)) {
    out = out.split(`\${${name}}`).join(value);
    out = out.split(`$${name}`).join(value);
  }
  return out;
}

/** What a refused command matched, so the refusal can name it. */
export type ReviewStateMatch =
  | { kind: "state-root"; matched: string }
  | { kind: "store-file"; matched: string };

/** A shell-escaped word is the word with its backslashes gone: the shell removes
 * `\` before the program ever sees the argument, so `re\view-findings.json` IS the
 * store's name by the time anything reads it. Asked in addition to the raw text
 * (never instead of it), and cheap: one strip per command. Without it the store's
 * name hides behind backslashes, which was a real refusal in the frozen corpus. */
function eraseBackslashes(text: string): string {
  // `\\` + newline is a LINE CONTINUATION: the shell deletes both characters and
  // joins the halves, so the store's name can hide across a line break. Erasing
  // the backslash alone would leave the newline between the two halves.
  return text.replace(/\\[\r\n]/g, "").replace(/\\/g, "");
}

/** Does a piece of text name the store's location? Asked of the RAW text (quotes
 * intact — a quoted path is still a path an agent typed), of the same text with
 * its own assignments substituted, and of both with backslashes erased. */
export function namesReviewState(
  text: string,
  roots: string[] = reviewStateRoots(),
  storeName: string = FINDINGS_FILE,
): ReviewStateMatch | undefined {
  if (!text) return undefined;
  const file = storeName.toLowerCase();
  const lowered = roots.map((r) => r.toLowerCase());
  const candidates = [text, withAssignmentsExpanded(text)];
  const haystacks = [...candidates, ...candidates.map(eraseBackslashes)].map((h) =>
    h.toLowerCase(),
  );
  for (const h of haystacks) {
    if (h.includes(file)) return { kind: "store-file", matched: storeName };
    for (let i = 0; i < lowered.length; i++) {
      if (h.includes(lowered[i] as string))
        return { kind: "state-root", matched: roots[i] as string };
    }
  }
  return undefined;
}

/** The refusal text: what matched, and the operator's remedy. */
function refusal(match: ReviewStateMatch): string {
  const what =
    match.kind === "state-root"
      ? `the review findings state root (${match.matched})`
      : `the review findings store file name (${match.matched})`;
  return `The review findings store is not agent-reachable: this call names ${what}. Accepting a finding is an operator act — run ${ACCEPT_CLI} from a terminal. This is a tripwire on the store's location, not a permission: an ordinary command is never refused for naming a tool, an expansion, or a heredoc.`;
}

/** Edit tools whose `path` argument is checked against the store's location. */
const FILE_TOOLS = new Set(["edit", "write", "multiedit"]);

/** The target path when an edit-style call would land inside the review-state
 * root, else undefined.
 *
 * A SOURCE file is never a target: `extension/src/review-findings-store.ts` and
 * every `review-accept-*.ts` module are ordinary code an agent edits routinely, so
 * only the data file's own basename and a path under the state root refuse. The
 * raw text is asked before normalisation, so a `../..` walk into the store's
 * directory is caught by the walk itself and not only by its destination.
 */
export function editsReviewState(
  toolName: string,
  input: unknown,
  roots: string[] = reviewStateRoots(),
  storeName: string = FINDINGS_FILE,
): string | undefined {
  if (!FILE_TOOLS.has(toolName)) return undefined;
  const obj = (input ?? {}) as Record<string, unknown>;
  if (!("path" in obj)) return undefined;
  let target: unknown;
  try {
    target = obj.path;
  } catch (err) {
    // An unreadable `path` is a target the guard cannot rule out, so it is
    // refused rather than read as "nothing to block".
    trace(
      `review-state-guard: ${toolName} path threw (${err instanceof Error ? err.message : String(err)})`,
    );
    return "<unreadable path>";
  }
  if (target === undefined || target === null) return undefined;
  if (typeof target !== "string") return "<non-string path>";
  const asked = [target, eraseBackslashes(target)];
  for (const t of asked) {
    if (t.toLowerCase().split(/[\\/]/).includes(storeName.toLowerCase())) return target;
  }
  const abs = isAbsolute(target) ? normalize(target) : resolve(process.cwd(), target);
  for (const root of roots) {
    const r = normalize(root);
    if (abs === r || abs.startsWith(`${r}/`)) return target;
  }
  return undefined;
}

/** The refusal for one tool call, or undefined to let it run. Exported for the
 * suite; `registerReviewAcceptGuard` is the only caller in src. */
export function reviewStateRefusal(
  toolName: string,
  input: unknown,
  cwd?: string,
): string | undefined {
  const roots = reviewStateRoots(cwd);
  if (toolName === "bash") {
    const raw = (input as { command?: unknown } | null)?.command;
    if (raw === undefined || raw === null) return undefined;
    // A `command` that is present but not a string cannot be scanned, and a scan
    // that cannot run is not a pass.
    if (typeof raw !== "string") return refusal({ kind: "store-file", matched: FINDINGS_FILE });
    const match = namesReviewState(raw, roots);
    return match ? refusal(match) : undefined;
  }
  const target = editsReviewState(toolName, input, roots);
  return target === undefined ? undefined : refusal({ kind: "state-root", matched: target });
}

export function registerReviewAcceptGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const cwd = (ctx as { cwd?: unknown } | undefined)?.cwd;
    let reason: string | undefined;
    try {
      reason = reviewStateRefusal(
        event.toolName,
        event.input,
        typeof cwd === "string" ? cwd : undefined,
      );
    } catch (err) {
      // A scan that throws is not a pass: the guard fails closed on its own bug.
      trace(
        `review-state-guard: scan threw, refusing fail-open (${err instanceof Error ? err.message : String(err)})`,
      );
      reason = refusal({ kind: "store-file", matched: FINDINGS_FILE });
    }
    if (!reason) return;
    trace(`review-state-guard: BLOCKED ${event.toolName} naming the review findings store`);
    return { block: true, reason };
  });
}
