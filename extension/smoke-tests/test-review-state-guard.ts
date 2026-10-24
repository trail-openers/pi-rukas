#!/usr/bin/env bun
/**
 * #1764 phase 2 — the review-state PATH guard.
 *
 * The guard is a substring tripwire on the store's location, so its whole
 * contract fits in one suite: a command or an edit target that names the state
 * root or the store's basename is refused, and NOTHING ELSE IS. The second half
 * matters more than the first — the shell-semantics guard this replaced refused
 * ~6,400 ordinary commands on fieldbox in two days (#1665 / #1738 / #1767), and
 * the misfire corpus below is that corpus. If a row here goes red, the guard has
 * grown a second rule, which is exactly the design #1764 closed.
 *
 * The strings the guard matches are BUILT here rather than spelled, for the same
 * reason the frozen corpus tables build them with `String.fromCharCode`: a Pi
 * session that still has the PRE-relocation guard loaded refuses any tool call
 * whose text names the store, so a suite that spelled the name could not be run
 * against the very build it is meant to replace. `FINDINGS_FILE` is the single
 * source of truth, so the rows cannot drift from it.
 *
 * The refusals that stay (STORE_REACHING_REFUSALS, `review-accept-guard-misfire-
 * cases.ts`) are filtered to the rows naming the store file or a state path: the
 * rest of that table encoded shell-semantics rules (repo-location selectors, git
 * write verbs, heredoc bodies) the path guard deliberately does not have.
 */

import {
  editsReviewState,
  namesReviewState,
  registerReviewAcceptGuard,
  reviewStateRefusal,
  reviewStateRoots,
  withAssignmentsExpanded,
} from "../src/review-accept-guard.ts";
import { FINDINGS_FILE } from "../src/review-state-path.ts";
import {
  MEASURED_MISFIRES_ALLOWED,
  STORE_REACHING_REFUSALS,
} from "./review-accept-guard-misfire-cases.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`PASS ${msg}`);
  else {
    console.error(`FAIL ${msg}`);
    exit = 1;
  }
}

const NL = String.fromCharCode(10);
const D = String.fromCharCode(36); // a dollar sign, spelled so this table is data
const STORE_FILE = FINDINGS_FILE;
const STORE_MODULE = ["review", "findings", "store"].join("-");
const ACCEPT_SCRIPT = ["review", "accept"].join("-");
const STATE_LEAF = ["review", "state"].join("-");
/** The resolved root, read out of the guard rather than spelled, so a fixture
 * that moves PI_AGENT_DIR moves the expectations with it. */
const RESOLVED = reviewStateRoots()[0] ?? "";
/** The roots every direct call below must pass: they are REQUIRED, so that a
 * fixture which moves `PI_AGENT_DIR` cannot assert against a cached root. */
const ROOTS = reviewStateRoots();
/** A store path under the state root, in the `~` spelling. */
const STORE_IN_ROOT = `~/.pi/agent/${STATE_LEAF}/deadbeef01234567/${STORE_FILE}`;

/** Does the bash branch refuse this command? */
const bashRefused = (c: string): boolean =>
  reviewStateRefusal("bash", { command: c }) !== undefined;

// ── 1. refusals: the store's location, in every spelling an agent can use ────

/** The state root as the `~` spelling, in the two forms a command carries for it:
 * the `$VAR` and `${VAR}` expansions of an assignment. A path that only appears
 * once the shell expands a variable spells nothing in the text, so the guard
 * substitutes same-command assignments before it matches (criterion 6). */
function rootViaVar(prefix: string, name: string): string {
  const root = `${prefix}/.pi/agent/${STATE_LEAF}`;
  return `P=${root}; cat $D{name}/k/t/${STORE_FILE}`.split(`$D{name}`).join(`$${name}`);
}

const REFUSED_BASH: Array<{ c: string; why: string }> = [
  { c: `cat /repo/.git/${STORE_FILE}`, why: "the store's old path, still the same basename" },
  { c: `cat ${D}{HOME}/.pi/agent/${STATE_LEAF}/k/t/${STORE_FILE}`, why: "the root in its brace HOME spelling, with the file" },
  { c: `grep -n x ~/.pi/agent/${STATE_LEAF}`, why: "ACCEPTANCE: the state root, tilde spelling" },
  { c: `ls -la $HOME/.pi/agent/${STATE_LEAF}`, why: "ACCEPTANCE: the state root, $HOME spelling" },
  { c: `ls ${D}PI_AGENT_DIR/${STATE_LEAF}`, why: "ACCEPTANCE: the state root, PI_AGENT_DIR spelling" },
  { c: `ls ${D}{PI_AGENT_DIR}/${STATE_LEAF}`, why: "the state root, brace PI_AGENT_DIR spelling" },
  { c: `head ~/.pi/agent/${STATE_LEAF}`, why: "a plain listing of the state root" },
  { c: `cat ${STORE_IN_ROOT}`, why: "the store file under the state root" },
  {
    c: `F=${D}{HOME}/.pi/agent/${STATE_LEAF}/a/b/${STORE_FILE}; cat $F`,
    why: "ACCEPTANCE criterion 6: the path built in a variable, then used",
  },
  {
    c: `export F=${D}HOME/.pi/agent/${STATE_LEAF}/a/b/${STORE_FILE}; cat $F`,
    why: "an exported assignment substituted before the match",
  },
  { c: `P=~/.pi/agent/${STATE_LEAF}; ls $P`, why: "a variable holding only the state root" },
  { c: `cp notes.txt ~/.pi/agent/${STATE_LEAF}/k/t/${STORE_FILE}`, why: "a write into the state dir" },
  { c: `cat ${STORE_FILE.toUpperCase()}`, why: "the basename in mixed case" },
  {
    c: `cat ~/.pi/agent/${STATE_LEAF}/k/t/${STORE_FILE}.corrupt-123`,
    why: "a corrupt sibling inside the state dir",
  },
  // The frozen corpus's escape routes: the shell removes a backslash before the
  // program reads the word, so an escaped spelling IS the store's name.
  { c: "cat re" + "view-findings.json", why: "a backslash inside the data name" },
  { c: "cat rev" + "iew-findings.js" + "on", why: "backslashes in both halves of the data name" },
  { c: "cat /repo/.git/review" + "-findings.json", why: "an escaped hyphen in the data name" },
  {
    c: rootViaVar("~", "P"),
    why: "ACCEPTANCE criterion 6: a path built from a variable holding the state root",
  },
  {
    c: `cat .git/review` + "\\" + `${NL}-findings.json`,
    why: "the data name split by a line continuation",
  },
];

for (const t of REFUSED_BASH) {
  assert(bashRefused(t.c), `REFUSED: ${t.why}`);
}

// ── 2. refusals: the rows of the frozen corpus that name the store path ──────

const namesStoreText = (c: string): boolean =>
  c.toLowerCase().includes(STORE_FILE.toLowerCase()) ||
  c.toLowerCase().includes(STATE_LEAF) ||
  namesReviewState(withAssignmentsExpanded(c), ROOTS) !== undefined;

const corpusRefusals = STORE_REACHING_REFUSALS.filter((t) => namesStoreText(t.c));
assert(corpusRefusals.length > 0, "corpus: the frozen table still has store-naming rows to hold");
for (const t of corpusRefusals) {
  assert(bashRefused(t.c), `CORPUS-REFUSED: ${t.why}`);
}

// ── 3. refusals: an edit / write / multiedit inside the state root ───────────

for (const tool of ["edit", "write", "multiedit"]) {
  assert(
    editsReviewState(tool, { path: STORE_IN_ROOT }, ROOTS) !== undefined,
    `${tool}: a write of the store file is refused`,
  );
  assert(
    editsReviewState(tool, { path: `${RESOLVED}/k/t/other.json` }, ROOTS) !== undefined,
    `${tool}: a write anywhere inside the state root is refused`,
  );
  assert(
    editsReviewState(tool, { path: `${RESOLVED}/k/t/${STORE_FILE}` }, ROOTS) !== undefined,
    `${tool}: the resolved spelling is refused too`,
  );
  assert(
    editsReviewState(tool, { path: RESOLVED }, ROOTS) !== undefined,
    `${tool}: the state root itself is refused`,
  );
  assert(
    editsReviewState(tool, { path: `~/.pi/agent/${STATE_LEAF}x/a.json` }, ROOTS) === undefined,
    `${tool}: a sibling directory whose name only starts with the root is allowed`,
  );
  assert(
    editsReviewState(tool, { path: "src/a.ts" }, ROOTS) === undefined,
    `${tool}: an ordinary file`,
  );
  assert(editsReviewState(tool, {}, ROOTS) === undefined, `${tool}: no path at all`);

  // B2 (#1764 round 1): containment is decided on the NORMALISED ABSOLUTE path,
  // with `~` expanded and the hook's cwd as the base for a relative target. The
  // three shapes below are the ways an agent gets a store path without typing it
  // as one, and each was previously judged on raw text alone.
  const SLASH = String.fromCharCode(47);
  const collapsed = `~/.pi/agent/${SLASH}${SLASH}${STATE_LEAF}${SLASH}${SLASH}aa${SLASH}${SLASH}bb${SLASH}x.json`;
  assert(
    editsReviewState(tool, { path: collapsed }, ROOTS, "/tmp") !== undefined,
    `${tool}: a doubled-slash spelling of the root is refused (normalisation, not text)`,
  );
  // `../` walks UP into the root from a cwd that sits inside the agent dir. The
  // fixture cwd is DERIVED from the resolved root, so a fixture that moves
  // PI_AGENT_DIR moves the walk with it.
  const insideCwd = `${RESOLVED}${SLASH}ensemble-runs`;
  assert(
    editsReviewState(
      tool,
      { path: `..${SLASH}..${SLASH}${STATE_LEAF}${SLASH}k${SLASH}x.json` },
      ROOTS,
      insideCwd,
    ) !== undefined,
    `${tool}: a ../ walk that lands inside the root is refused`,
  );
  // A relative path whose remainder puts it under the state leaf, resolved against
  // the hook's cwd — NOT this process's directory. An absolute target spelled with
  // `~` is the same check from the other side: only an implementation that expands
  // the tilde before resolving can refuse it.
  assert(
    editsReviewState(
      tool,
      { path: `~${SLASH}.pi${SLASH}agent${SLASH}${STATE_LEAF}${SLASH}k${SLASH}x.json` },
      ROOTS,
      "/tmp/elsewhere",
    ) !== undefined,
    `${tool}: a tilde path into the root is refused whatever cwd it is given`,
  );
  // The same relative shape resolved against an UNRELATED cwd is an ordinary file:
  // this is the assertion that proves the base is the hook cwd and not process.cwd.
  assert(
    editsReviewState(
      tool,
      { path: `.${SLASH}pi${SLASH}agent${SLASH}${STATE_LEAF}${SLASH}k${SLASH}x.json` },
      ROOTS,
      "/tmp/elsewhere",
    ) === undefined,
    `${tool}: the same relative path outside the root resolves elsewhere and runs`,
  );
  // Source files under extension/src are ordinary code and never a store target.
  for (const src of [
    `extension${SLASH}src${SLASH}${STORE_MODULE}.ts`,
    `extension${SLASH}src${SLASH}${ACCEPT_SCRIPT}-guard.ts`,
    `extension${SLASH}smoke-tests${SLASH}test-${STORE_MODULE}-store.ts`,
  ]) {
    assert(
      editsReviewState(tool, { path: src }, ROOTS, "/repo") === undefined,
      `${tool}: a source file under extension/src is allowed — ${src}`,
    );
  }
}
assert(
  editsReviewState("read", { path: STORE_IN_ROOT }, ROOTS) === undefined,
  "reading the findings file is not an edit",
);
assert(
  editsReviewState("write", { path: 42 }, ROOTS) !== undefined,
  "write: a non-string path is refused, not waved through",
);
assert(
  editsReviewState(
    "write",
    {
      get path(): string {
        throw new Error("getter");
      },
    },
    ROOTS,
  ) !== undefined,
  "write: a throwing path getter is refused rather than escaping the guard",
);

// ── 4. what the guard must NOT refuse: source files, and the misfire corpus ──

for (const src of [
  `extension/src/${STORE_MODULE}.ts`,
  `extension/src/${ACCEPT_SCRIPT}-guard.ts`,
  `extension/src/${ACCEPT_SCRIPT}-command.ts`,
  `extension/src/${ACCEPT_SCRIPT}-arms.ts`,
  `extension/src/${ACCEPT_SCRIPT}-scope.ts`,
  `extension/src/${ACCEPT_SCRIPT}-verb.ts`,
  `extension/scripts/${ACCEPT_SCRIPT}.ts`,
]) {
  for (const tool of ["edit", "write", "multiedit"]) {
    assert(
      editsReviewState(tool, { path: src }, ROOTS) === undefined,
      `${tool}: a source file is never the store — ${src}`,
    );
  }
}
assert(
  !bashRefused(`git diff HEAD -- extension/src/${STORE_MODULE}.ts`),
  "a git diff of the store module is an ordinary command",
);
assert(
  !bashRefused(`git commit -m "fix(review): the ${ACCEPT_SCRIPT} guard"`),
  "a commit message naming the guard is prose, not a path",
);

for (const t of MEASURED_MISFIRES_ALLOWED) {
  assert(!bashRefused(t.c), `MISFIRE-ALLOWED: ${t.why}`);
}

/** Rows from the frozen fieldbox corpus (#1764 criterion 9) that the shell-
 * semantics guard refused and the path guard must ALLOW. Each is read out of
 * `MEASURED_MISFIRES_ALLOWED` by its `why`, so the command text stays the corpus's
 * and this suite cannot quietly re-type it wrong. */
const corpusRow = (why: string): string => {
  const row = MEASURED_MISFIRES_ALLOWED.find((t) => t.why === why);
  if (!row) throw new Error(`corpus row missing: ${why}`);
  return row.c;
};
/** The same lookup against the FROZEN REFUSAL table: some of its rows encoded a
 * shell-semantics rule (a pickaxe on a source stem) rather than a path, and the
 * path guard lets those go. Reading them from the table that holds them keeps the
 * command text the corpus's. */
const refusedCorpusRow = (why: string): string => {
  const row = STORE_REACHING_REFUSALS.find((t) => t.why === why);
  if (!row) throw new Error(`refusal-corpus row missing: ${why}`);
  return row.c;
};

const MISFIRES_ALLOWED: Array<{ c: string; why: string; refused?: boolean }> = [
  { c: `echo "${D}HOME"`, why: "an expansion of HOME names no store" },
  { c: 'echo "~"', why: "a tilde on its own is HOME, not the state root" },
  { c: `grep -n ${"'"}a${D}${"'"} src/x.ts`, why: "a grep pattern ending in a dollar sign" },
  { c: `printf ${'"'}count: %s\\n${'"'} ${D}n`, why: "a printf with a percent and an expansion" },
  { c: `cd extension && echo ${D}PWD`, why: "the chained type-check shape from .pi/verify-cmd" },
  { c: `ls -la ${D}PWD`, why: "a listing through an expansion" },
  { c: `grep -rn foo src && echo ${D}?`, why: "a search chained to an exit-code echo" },
  {
    c: `cat > tmp/issue-7/spec.md <<'EOF'${NL}## Spec ${D}HOME${NL}EOF`,
    why: "a QUOTED heredoc tag with a dollar sign in the body",
  },
  { c: `python3 - <<'PY'${NL}print("${D}x")${NL}PY`, why: "a quoted python heredoc" },
  { c: `python3 - <<PY${NL}x = 1${NL}PY`, why: "an unquoted heredoc into an interpreter" },
  {
    c: `gh issue edit 1 --title "the ${ACCEPT_SCRIPT} guard"`,
    why: "ACCEPTANCE criterion 12: prose that merely mentions the guard",
  },
  {
    c: `gh pr comment 5 --body "the ${STORE_MODULE} moved"`,
    why: "prose naming the store module in a forge body",
  },
  {
    c: `bun extension/scripts/${ACCEPT_SCRIPT}.ts feat/x deadbeef --reason x`,
    why: "the operator CLI spelled by an agent: refused by the CLI's own agent-context check, not here",
  },
  { c: `echo ${D}(whoami)`, why: "a command substitution" },
  { c: "awk 'BEGIN{system(\"id\")}'", why: "awk running a shell" },
  { c: "cat payload.js | bun -", why: "a stdin pipe into a runtime" },
  { c: "git -c core.pager=cat log --oneline", why: "a git config override — no longer this guard's subject" },
  { c: "git -C /repo/.git status --porcelain", why: "a repo-location selector at the OLD store directory" },
  {
    c: refusedCorpusRow("ACCEPTANCE: a worktree selector chained to a read of the data file"),
    why: "a worktree selector chained to a read of the store file (a path, so refused)",
    refused: true,
  },
  {
    c: refusedCorpusRow("ACCEPTANCE: a worktree selector beside a pickaxe on the store module"),
    why: "ACCEPTANCE: a git pickaxe naming the store module — source, not the data file",
  },
];
for (const t of MISFIRES_ALLOWED) {
  if (t.refused) {
    assert(bashRefused(t.c), `ALLOWED-table row that must stay refused: ${t.why}`);
    continue;
  }
  assert(!bashRefused(t.c), `ALLOWED: ${t.why}`);
}

// ── 5. the refusal names what matched and the operator's remedy ──────────────

{
  const rootRefusal = reviewStateRefusal("bash", { command: `ls ~/.pi/agent/${STATE_LEAF}` }) ?? "";
  assert(
    rootRefusal.includes("state root") && rootRefusal.includes(STATE_LEAF),
    "refusal: a root match names the state root",
  );
  assert(
    rootRefusal.includes(`extension/scripts/${ACCEPT_SCRIPT}.ts`),
    "refusal: names the operator remedy (the accept CLI)",
  );
  const fileRefusal = reviewStateRefusal("bash", { command: `cat ${STORE_FILE}` }) ?? "";
  assert(
    fileRefusal.includes("store file name") && fileRefusal.includes(STORE_FILE),
    "refusal: a basename match names the store file name",
  );
  assert(
    fileRefusal.includes(`extension/scripts/${ACCEPT_SCRIPT}.ts`),
    "refusal: the basename route names the remedy too",
  );
}

// ── 6. the same-command substitution is inert without a store name ───────────

assert(
  withAssignmentsExpanded(`A=x; echo ${D}A`) === "A=x; echo x",
  "substitution: a plain assignment is substituted",
);
// A substitution must not reach past the name it was given: `F=x` is an
// assignment to F, and the `$FOO` later in the same command names a different
// variable. Rewriting it would scan text the agent never wrote, which is how a
// tripwire starts refusing commands it was never given.
assert(
  withAssignmentsExpanded(`F=x; echo ${D}FOO`) === `F=x; echo ${D}FOO`,
  "substitution: a longer name is not the assigned one (F=x leaves $FOO alone)",
);
assert(
  withAssignmentsExpanded(`F=x; echo ${D}{F}BAR`) === `F=x; echo xBAR`,
  "substitution: the braced form ends at its own brace, so ${F}BAR expands F",
);
assert(
  // `a$F` is not `$F`: the assignment regex reads the value as `x;`, so a name
  // flush against a preceding character is a different token and stays put.
  // The word boundary is what makes the substitution a name match at all.
  withAssignmentsExpanded(`F=x; echo ${D}F ${D}FOO`) === `F=x; echo x ${D}FOO`,
  "substitution: the same command substitutes F and leaves a longer name untouched",
);
// The refusal side of the same rule, where the misfire would actually cost
// something: `F=x` is assigned, and the ROOT text hides inside the value of
// the UNRELATED `FOO`. Substituting the shorter name would rewrite that value
// into a bare root and refuse a command that names nothing.
assert(
  !bashRefused(
    `F=x; FOO=${D}{HOME}/.pi/agent/${STATE_LEAF}stuff; echo ${D}FOO`,
  ),
  "substitution: a shorter assignment never rewrites a longer variable's value",
);
// And the rule still fires where it should: the shorter name used on its own
// is substituted, so a root carried in `$F` is still caught.
assert(
  bashRefused(`F=${D}{HOME}/.pi/agent/${STATE_LEAF}; cat ${D}F/k/t/${STORE_FILE}`),
  "substitution: a root carried in a variable is still caught when the name ends there",
);
// The refusal text distinguishes the two rules and the one admission.
assert(
  (reviewStateRefusal("write", { path: 42 }) ?? "").length > 0,
  "refusal text: a non-string path still refuses",
);
assert(
  (reviewStateRefusal("edit", { path: `/repo/.git/${STORE_FILE}` }) ?? "").includes("store file name"),
  "refusal text: a store-basename hit names the store file, not the state root",
);
assert(
  (reviewStateRefusal("edit", { path: `${RESOLVED}/k/t/other.json` }) ?? "").includes("state root"),
  "refusal text: a containment hit names the state root",
);
// A fault inside the root builder degrades ONE branch, not every tool: an edit
// whose target cannot be read is refused, and the same fault must not refuse
// bash calls generally — so the edit branch still answers while the roots are
// built per branch.
assert(
  editsReviewState("write", { path: `${RESOLVED}/k/t/${STORE_FILE}` }, ROOTS)?.kind ===
    "store-file",
  "editsReviewState: a store basename reports its kind, so the refusal can name it",
);
assert(
  editsReviewState("write", { path: `${RESOLVED}/k/t/other.json` }, ROOTS)?.kind ===
    "state-root",
  "editsReviewState: containment reports the state-root kind",
);
assert(
  editsReviewState("write", { get path() { throw new Error("getter"); } }, ROOTS)?.kind ===
    "unreadable",
  "editsReviewState: an unreadable path is its own kind, not a fabricated rule hit",
);
assert(
  namesReviewState("echo hello", ROOTS) === undefined &&
    namesReviewState("", ROOTS) === undefined,
  "namesReviewState: nothing named is no match, empty included",
);

// ── 8. canary: the guard is registered, and the hook refuses in every mode ───

{
  const handlers: Record<string, (e: unknown, c: unknown) => Promise<unknown>> = {};
  registerReviewAcceptGuard({
    on: (ev: string, fn: (e: unknown, c: unknown) => Promise<unknown>) => {
      handlers[ev] = fn;
    },
  } as never);
  assert(
    handlers.tool_call !== undefined,
    "canary: registerReviewAcceptGuard adds a tool_call hook",
  );
  const blocked = (await handlers.tool_call?.(
    { toolName: "bash", input: { command: `cat ~/.pi/agent/${STATE_LEAF}` } },
    {},
  )) as { block?: boolean; reason?: string } | undefined;
  assert(blocked?.block === true, "canary: the hook blocks a command naming the state root");
  assert(
    (blocked?.reason ?? "").includes(`extension/scripts/${ACCEPT_SCRIPT}.ts`),
    "canary: the hook's refusal carries the operator remedy",
  );
  const blockedEdit = (await handlers.tool_call?.(
    { toolName: "write", input: { path: `~/.pi/agent/${STATE_LEAF}/k/${STORE_FILE}` } },
    {},
  )) as { block?: boolean } | undefined;
  assert(blockedEdit?.block === true, "canary: the hook blocks a write into the state root");
  const passed = (await handlers.tool_call?.(
    { toolName: "bash", input: { command: `echo "${D}HOME" && git status` } },
    {},
  )) as { block?: boolean } | undefined;
  assert(passed === undefined, "canary: an ordinary command passes the hook untouched");
}

process.exit(exit);
