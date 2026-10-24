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
 * THE ROOTS ARE NOT COPIED HERE. `reviewStateRoots` builds every spelling from
 * `agentDir()` and `STATE_LEAF` in `review-state-path.ts` — the same two symbols
 * that decide where the store actually lands. A guard with its own literals is a
 * second source of truth, and the two drift exactly when it matters.
 *
 * A ROOT MATCHES AT A PATH BOUNDARY. A root is a directory, so it names the store
 * only when the character after it is a path separator, a quote, whitespace, or
 * nothing. Without that rule `$PI_AGENT_DIR` would fire on a substring inside a
 * longer word, and `~/.pi/agent/review-statestuff` would be refused for a
 * directory that is not the store's.
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

import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FINDINGS_FILE, STATE_LEAF, agentDir } from "./review-state-path.ts";
import { trace, traceWarn } from "./trace.ts";

/** The one source of truth for the CLI the refusal tells the operator to use. */
const ACCEPT_CLI = "extension/scripts/review-accept.ts";

/** The characters that end a directory name in command text: a separator, a
 * quote, whitespace, or the end of the text. Anything else (an identifier
 * character, a letter) means the match was a substring, not this path. */
const BOUNDARY_RE = /^[/\\\s"'`]/;

/** The default HOME-relative agent dir, spelled for the textual roots. */
const HOME_LEAF = ".pi/agent";

/** The env var Pi reads for its agent dir, in the two forms a command carries. */
const AGENT_DIR_VAR = "PI_AGENT_DIR";

/** Every state root a command might name, as literal text.
 *
 * The resolved absolute root always. The textual spellings are what a command
 * carries when the agent wrote the path by hand rather than read it out of a
 * result, and they fire whether or not the environment agrees — a refusal is
 * asked of the text:
 *   - `~/.pi/agent/review-state`, `$HOME/…` and `${HOME}/…`, added only when the
 *     agent dir really IS the default under HOME (an operator who moved the agent
 *     dir has no store under HOME, and refusing HOME paths would be a misfire);
 *   - `$PI_AGENT_DIR/review-state` and `${PI_AGENT_DIR}/review-state`, added while
 *     the default agent dir is in play: when `PI_AGENT_DIR` is set, or when it is
 *     unset and the agent dir is therefore HOME's default (where the store really
 *     does sit under that variable's name). Unset AND relocated, the expansion
 *     reaches no store and is not refused.
 *
 * Documented simplification: the `$PI_AGENT_DIR` spellings are dropped when the
 * variable is unset and the agent dir has been relocated off HOME's default, and
 * the `$HOME`-relative spellings are dropped whenever `PI_AGENT_DIR` points away
 * from HOME's default. In both cases the spelling describes a location that holds
 * no store. A command that hardcodes the old default anyway is outside this
 * tripwire's reach, as every purely-textual dodge is. */
export function reviewStateRoots(cwd?: string): string[] {
  const roots: string[] = [];
  const push = (root: string | undefined): void => {
    if (!root) return;
    const clean = root.endsWith("/") ? root.slice(0, -1) : root;
    if (clean && !roots.includes(clean)) roots.push(clean);
  };
  const dir = agentDir();
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  // The state root is the agent dir PLUS the state leaf: the resolved spelling is
  // where the store actually sits, so it carries the leaf like every other one.
  push(
    isAbsolute(dir)
      ? normalize(`${dir}/${STATE_LEAF}`)
      : resolve(cwd ?? process.cwd(), dir, STATE_LEAF),
  );
  const envForm = process.env[AGENT_DIR_VAR]?.trim();
  // The textual spellings are only worth refusing where they describe the store.
  if (home && normalize(dir) === normalize(`${home}/${HOME_LEAF}`)) {
    for (const prefix of ["~", "$HOME", "${HOME}"]) push(`${prefix}/${HOME_LEAF}/${STATE_LEAF}`);
  }
  // The variable spellings are emitted whenever the default agent dir is in play
  // — i.e. `PI_AGENT_DIR` is set, or the agent dir is HOME's default. Unset AND
  // relocated, a command that names `$PI_AGENT_DIR` names a variable that does not
  // exist, so it reaches no store; refusing it would be a misfire of the kind this
  // module was rewritten to end. When the variable IS set, a command that expands
  // it reaches wherever the store is, whatever its value.
  const defaultDir = home ? normalize(`${home}/${HOME_LEAF}`) : "";
  if (envForm || (defaultDir && normalize(dir) === defaultDir)) {
    for (const prefix of [`$${AGENT_DIR_VAR}`, `\${${AGENT_DIR_VAR}}`]) {
      push(`${prefix}/${STATE_LEAF}`);
    }
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
 * replaced by its value.
 *
 * THE ROOTS ARE BUILT PER BRANCH, not once for both (see `reviewStateRefusal`). A
 * fault inside `agentDir()` or the environment therefore costs the one call being
 * decided and nothing else: a guard that built its roots above the branch handlers
 * would throw for every tool call in the session on its own setup bug, which is the
 * global misfire this module exists to have ended.
 *
 * A substitution stops at an identifier character: `F=x` must not rewrite the
 * `$FOO` later in the same command, because that is a different variable's name
 * that merely starts with the assigned one. Substituting it would put text the
 * agent never wrote into the scanned command, and a refusal built on text nobody
 * typed is the misfire this module exists to have ended. The braced form has no
 * such problem — `\${F}` ends at its own `}` — so it is always substituted. */
export function withAssignmentsExpanded(text: string): string {
  let out = text;
  for (const [name, value] of sameCommandAssignments(text)) {
    out = out.split(`\${${name}}`).join(value);
    out = out
      .split(/\$/g)
      .flatMap((part, i) => {
        if (i === 0) return [part];
        if (part.startsWith(name) && !startsWithIdentifierChar(part, name.length)) {
          return [value, part.slice(name.length)];
        }
        return [`$${part}`];
      })
      .join("");
  }
  return out;
}

/** True when `text` still carries an identifier character at or after `from` —
 * the test that keeps `F=x` from rewriting `$FOO`. */
function startsWithIdentifierChar(text: string, from: number): boolean {
  for (let i = from; i < text.length; i++) {
    if (IDENTIFIER_CHAR_RE.test(text[i] as string)) return true;
  }
  return false;
}

const IDENTIFIER_CHAR_RE = /[A-Za-z0-9_]/;

/** What a refused command matched, so the refusal can name it. */
export type ReviewStateMatch =
  | { kind: "state-root"; matched: string }
  | { kind: "store-file"; matched: string };

/** A shell-escaped word is the word with its backslashes gone: the shell removes
 * `\` before the program ever sees the argument, so an escaped spelling IS the
 * store's name by the time anything reads it. Asked in addition to the raw text
 * (never instead of it), and only when the cheap pass misses. */
function eraseBackslashes(text: string): string {
  // `\\` + newline is a LINE CONTINUATION: the shell deletes both characters and
  // joins the halves, so the store's name can hide across a line break. Erasing
  // the backslash alone would leave the newline between the two halves.
  return text.replace(/\\[\r\n]/g, "").replace(/\\/g, "");
}

/** Does `haystack` carry `needle` as one whole path segment? The basename form of
 * the containment rule: `review-findings.json` inside `/repo/.git/` is the store,
 * and so is it inside a heredoc body that writes it — while a directory called
 * `review-statestuff` after the state root's own name is not the root. */
function containsPathSegment(haystack: string, needle: string): boolean {
  return haystack.split(/[\\/]/).includes(needle);
}

/** Does `haystack` contain `needle` at a path boundary? Case-insensitive: a shell
 * path an agent pasted is the same path whatever case it was typed in. */
function containsAtBoundary(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const after = haystack.slice(at + needle.length);
    if (after === "" || BOUNDARY_RE.test(after)) return true;
    from = at + 1;
  }
}

/** The views of a command worth asking, in cost order. The RAW lowercased text is
 * asked first: it catches almost every command, and the expensive views (an
 * assignment scan plus two regex strips) are built only when it misses AND the
 * text actually contains something they could change — an `=` for a substitution,
 * a backslash for an escape. A plain `git status` never allocates them. */
function commandViews(text: string): string[] {
  const views = [text.toLowerCase()];
  if (text.includes("=") || text.includes("\\")) {
    const expanded = withAssignmentsExpanded(text);
    for (const t of [expanded, text, eraseBackslashes(expanded), eraseBackslashes(text)]) {
      const lower = t.toLowerCase();
      if (!views.includes(lower)) views.push(lower);
    }
  }
  return views;
}

/** Does a piece of text name the store's location? Asked of the raw text (quotes
 * intact — a quoted path is still a path an agent typed), and, when it could
 * matter, of the same text with its own assignments substituted and with
 * backslashes erased.
 *
 * `roots` is REQUIRED on purpose: a default that read the ambient environment made
 * every fixture that moved `PI_AGENT_DIR` assert against the previous root, and a
 * guard that caches a root silently guards the wrong directory. `storeName` keeps
 * a default because it is the store's one true basename, imported — a test never
 * needs to name it.
 */
export function namesReviewState(text: string, roots: string[]): ReviewStateMatch | undefined {
  if (!text) return undefined;
  const file = FINDINGS_FILE.toLowerCase();
  const lowered = roots.map((r) => r.toLowerCase());
  for (const h of commandViews(text)) {
    if (h.includes(file)) return { kind: "store-file", matched: FINDINGS_FILE };
    for (let i = 0; i < lowered.length; i++) {
      if (containsPathSegment(h, file)) return { kind: "store-file", matched: FINDINGS_FILE };
      if (containsAtBoundary(h, lowered[i] as string))
        return { kind: "state-root", matched: roots[i] as string };
    }
  }
  return undefined;
}

/** The refusal for a bash match: what matched, and the operator's remedy. */
function bashRefusal(match: ReviewStateMatch): string {
  const what =
    match.kind === "state-root"
      ? `the review findings state root (${match.matched})`
      : `the review findings store file name (${match.matched})`;
  return refusalLead() + what + refusalTail();
}

/** The refusal for an edit-style match. The kind chooses the sentence: the two
 * real rules name what was hit, and `unreadable` says the guard could not read
 * the target — which an operator must be able to tell apart from a rule firing. */
function editRefusal(match: EditStateMatch): string {
  const what =
    match.kind === "state-root"
      ? `the review findings state root (${match.matched})`
      : match.kind === "store-file"
        ? `the review findings store file name (${match.matched})`
        : `a target whose path this guard could not read (${match.matched})`;
  return refusalLead() + what + refusalTail();
}

function refusalLead(): string {
  return "The review findings store is not agent-reachable: this call names ";
}

function refusalTail(): string {
  return `. Accepting a finding is an operator act — run ${ACCEPT_CLI} from a terminal. This is a tripwire on the store's location, not a permission: an ordinary command is never refused for naming a tool, an expansion, or a heredoc.`;
}

/** Edit tools whose `path` argument is checked against the store's location. */
const FILE_TOOLS = new Set(["edit", "write", "multiedit"]);

/** What an edit-style target matched, so the refusal can say WHY it refused. The
 * three kinds read differently to an operator: `state-root` and `store-file` are
 * the two real rules, and `unreadable` is the guard admitting it could not read
 * the target it was asked about. */
export type EditStateMatch =
  | { kind: "state-root" | "store-file"; matched: string }
  | { kind: "unreadable"; matched: string };

/** The target path when an edit-style call would land inside the review-state
 * root, else undefined.
 *
 * A SOURCE file is never a target: the store's own module and every accept module
 * are ordinary code an agent edits routinely, so only the data file's basename and
 * a path under the state root refuse. Both a NORMALISED absolute form and the raw
 * text are asked. The raw text catches a spelling the filesystem would never
 * resolve to (a `$HOME`-relative target is matched against the textual roots, which
 * resolve to nothing on disk); the normalised form catches the collapsed and
 * expanded shapes (`~/.pi/agent//review-state//x` normalises into the root, and a
 * `../..` walk that climbs out of the cwd and back down into it is refused because
 * containment is decided by where the path LANDS, not by how it was spelled on the
 * way there).
 *
 * A RELATIVE target resolves against the hook's cwd — the tree the tool call
 * actually runs in — not this process's directory: a Pi process started at the repo
 * root would otherwise resolve a worktree-relative path to the wrong place and let
 * a write through. */
export function editsReviewState(
  toolName: string,
  input: unknown,
  roots: string[],
  cwd?: string,
): EditStateMatch | undefined {
  if (!FILE_TOOLS.has(toolName)) return undefined;
  const obj = (input ?? {}) as Record<string, unknown>;
  if (!("path" in obj)) return undefined;
  let target: unknown;
  try {
    target = obj.path;
  } catch (err) {
    // An unreadable `path` is a target the guard cannot rule out, so it is
    // refused rather than read as "nothing to block". Operator-visible: a refusal
    // that reads like a real rule is otherwise indistinguishable from one.
    traceWarn(
      `review-state-guard: ${toolName} path threw, refusing that call (${err instanceof Error ? err.message : String(err)})`,
    );
    return { kind: "unreadable", matched: `<${toolName}: path could not be read>` };
  }
  if (target === undefined || target === null) return undefined;
  if (typeof target !== "string") {
    traceWarn(`review-state-guard: ${toolName} path was not a string, refusing that call`);
    return { kind: "unreadable", matched: `<${toolName}: path was not a string>` };
  }

  const base = cwd ?? process.cwd();
  // `~` is the home dir to a shell and to nothing else: a tool call that carries
  // it literally still means the operator's home, so it expands before resolving.
  const expanded = expandHome(target);
  const asked = [target, eraseBackslashes(target)];
  for (const t of asked) {
    if (t.toLowerCase().split(/[\\/]/).includes(FINDINGS_FILE.toLowerCase())) {
      return { kind: "store-file", matched: target };
    }
  }
  const normalised = normalize(expanded.replace(/\/{2,}/g, "/"));
  const abs = isAbsolute(normalised) ? normalised : resolve(base, normalised);
  // Containment is decided on the NORMALISED absolute path: collapsed slashes,
  // an expanded leading `~`, and a `../..` walk that climbs out of the cwd and
  // back down into the root all land in the same place, and that place is what
  // decides. The roots include the textual spellings, so the comparison is made
  // on their normalised form.
  for (const root of roots) {
    const r = normalize(root);
    if (abs === r || abs.startsWith(`${r}/`)) return { kind: "state-root", matched: target };
  }
  // The textual spellings (`~`, `$HOME`, `${HOME}`, `$PI_AGENT_DIR`) are not
  // directories anything resolves to, so containment can never see them: the raw
  // text is asked of the ROOTS, with the same path-boundary rule so a sibling
  // directory whose name merely starts with the root is not the root. Only the
  // roots — never the basename — because a source module's path ends in the
  // store module's stem, and an EXACT basename is what makes the data file the
  // data file.
  for (const t of asked) {
    const lower = t.toLowerCase();
    for (const r of roots) {
      const rr = r.toLowerCase();
      if (!lower.startsWith(rr)) continue;
      const after = lower.slice(rr.length);
      if (after === "" || BOUNDARY_RE.test(after)) {
        return { kind: "state-root", matched: target };
      }
    }
  }
  return undefined;
}

/** A leading `~` or `~/` is the home dir; anything else is already a path. */
function expandHome(target: string): string {
  if (target !== "~" && !target.startsWith("~/") && !target.startsWith("~\\")) {
    return target;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return target === "~" ? home : `${home}${target.slice(1)}`;
}

/** The refusal for one tool call, or undefined to let it run. Exported for the
 * suite; `registerReviewAcceptGuard` is the only caller in src.
 *
 * The two branches are wrapped SEPARATELY, and each fails closed only for itself:
 * a fault inside the edit scan must not refuse an unrelated `bash` call, and one
 * inside the bash scan must not refuse every `edit`. A guard that fails globally
 * on its own bug is the misfire this module exists to have ended. */
export function reviewStateRefusal(
  toolName: string,
  input: unknown,
  cwd?: string,
): string | undefined {
  if (toolName === "bash") {
    try {
      const roots = reviewStateRoots(cwd);
      const raw = (input as { command?: unknown } | null)?.command;
      if (raw === undefined || raw === null) return undefined;
      // A `command` that is present but not a string cannot be scanned, and a scan
      // that cannot run is not a pass.
      if (typeof raw !== "string")
        return bashRefusal({ kind: "store-file", matched: FINDINGS_FILE });
      const match = namesReviewState(raw, roots);
      return match ? bashRefusal(match) : undefined;
    } catch (err) {
      traceWarn(
        `review-state-guard: bash scan threw, refusing that call (${err instanceof Error ? err.message : String(err)})`,
      );
      return bashRefusal({ kind: "store-file", matched: FINDINGS_FILE });
    }
  }
  try {
    const match = editsReviewState(toolName, input, reviewStateRoots(cwd), cwd);
    return match === undefined ? undefined : editRefusal(match);
  } catch (err) {
    traceWarn(
      `review-state-guard: edit scan threw, refusing that call (${err instanceof Error ? err.message : String(err)})`,
    );
    return editRefusal({ kind: "unreadable", matched: `<${toolName}: the edit scan faulted>` });
  }
}

export function registerReviewAcceptGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    // `cwd` is declared non-optional on ExtensionContext, so a string test is a
    // no-op on typed input. It is kept deliberately: the hook also runs in a bare
    // `Agent` / test harness that hands a handler no context at all, and a
    // missing cwd must fall back to `process.cwd()` inside the scans rather than
    // throw its way into the outer catch and refuse an ordinary call.
    const cwd = ctx?.cwd;
    let reason: string | undefined;
    try {
      reason = reviewStateRefusal(event.toolName, event.input, cwd);
    } catch (err) {
      // `reviewStateRefusal` catches both branches, so reaching here means even
      // the refusal could not be built. Fail closed on the call that faulted.
      traceWarn(
        `review-state-guard: ${event.toolName} scan threw, refusing that call (${err instanceof Error ? err.message : String(err)})`,
      );
      reason = bashRefusal({ kind: "store-file", matched: FINDINGS_FILE });
    }
    if (!reason) return;
    trace(`review-state-guard: BLOCKED ${event.toolName} naming the review findings store`);
    return { block: true, reason };
  });
}
