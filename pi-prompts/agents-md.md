---
description: Idempotently create / update / check the marker-managed sections of this repo's AGENTS.md via the agents_md_run tool. The tool runs a pure TypeScript renderer in-process; the file surgery is deterministic and byte-preserving for anything outside the managed markers.
argument-hint: "<create|update|check> [--deep]"
---

# /agents-md: idempotent AGENTS.md management

**Verb**: first argument of `$ARGUMENTS` (default `update`). `--deep` turns
on real execution of the gate commands during `check` only.

This command is executed by the **`agents_md_run` tool**, which runs the
compiled TypeScript core (`extension/src/agents-md/`) in-process. The core is
a pure-function renderer whose idempotency is *proven by a test* (double-render
`Buffer.equals`), and whose splice touches **only** the bytes between its own
marker pairs. Your job as the PM here is to call the tool, interpret its
structured result, show the operator the diff it renders, and ask — not to
edit the file yourself.

You MUST NOT hand-edit `AGENTS.md` for this command. Every byte change goes
through the tool. This is the difference between a tool whose correctness is a
theorem and a tool whose correctness is a hope.

---

## The state machine

Before doing anything, classify the target file (`<repoRoot>/AGENTS.md`). The
`create`/`update` results carry `plan.state` (`no-file` / `no-markers` /
`has-markers`) — use that when you already have a result, otherwise classify
yourself:

| State | Meaning | Action |
|-------|---------|--------|
| `no-file` | no `AGENTS.md` | `create` is automatic (reads + a create-when-absent write); show the diff, write |
| `no-markers` | file exists but has no pi-rukas markers | **brownfield wrap** (see below) — WRAPPING ONLY |
| `has-markers` | managed sections present | `update` (no-op when current) |
| `markers-stale` | managed sections present but drift detected | `update` to re-derive; show diff, ask |
| `ambiguous-corruption` | markers present but unparseable (nested/dup/mismatch/orphan) | **STOP.** Report the corruption verbatim. Never guess a repair.

Then overlay the **git-dirty** state: if `git status --porcelain -- AGENTS.md`
is non-empty, say so up front. The core never auto-resolves a dirty file — it
splices from the bytes on disk, so a dirty working tree means the diff is
against an uncommitted baseline. Surface that; let the operator decide.

---

## Pre-pass: dispatch an explore child for agent-derived facts

Before calling `agents_md_run` with `create` or `update`, **first check the
trigger condition** and, if it fires, dispatch a read-only explore-role child
to produce `AgentFacts`.

### Trigger condition

Dispatch the pre-pass **when either**:
1. The repo has **no recognised manifest** (`package.json`, `Cargo.toml`,
   `go.mod`, or `pyproject.toml` at the root) — i.e. `detectFacts(root)`
   would return `manifest: undefined` (Ruby/Gemfile, true greenfield,
   unrecognised ecosystems), **OR**
2. The current `AGENTS.md` has **no `code-style` managed section** (no
   `<!-- pi-rukas:agents-md:begin code-style v1 -->` marker pair).

**Skip the dispatch entirely** only when BOTH conditions are false: the
manifest is recognised AND the code-style section already exists.

### The dispatch

Use `dispatch_specialist` with `role: "explore"` (structurally denied
write/edit via role-tools). The prompt should demand **dense, specific**
facts — exact shell lines, not narrative. Reference the `oo/AGENTS.md`
quality bar: exact command lines, no filler.

The dispatch prompt must include:

> You have the `report_facts` tool. Read the repository's source files,
> build system, CI workflows, and any existing style documentation to derive
> the project's facts. Call `report_facts` EXACTLY ONCE with the facts you
> found. Rules:
> - `commands`: exact shell lines (the command that goes into AGENTS.md),
>   each with `kind` (test|lint|format|typecheck|build) and a `name` label.
> - `ciWorkflows`: RAW FILENAMES ONLY (e.g. "ci.yml") — do NOT include the
>   `.github/workflows/` prefix; the renderer applies it.
> - `codeStyleBullets`: dense, specific bullets (exact rules, no prose).
>   Each bullet is one concrete rule, not a paragraph.
> - `language`, `packageManager`, `manifest`: only if you can confirm them
>   from files in the repo. Do not guess.

**Companion extension load (FACTS_EXTRA_ARGS)**: the dispatch must pass
`--no-skills --extension <facts-reporter-path>` as extra args to the child,
where `<facts-reporter-path>` is the path to `extension/src/facts-reporter.ts`
(relative to the Pi extension install dir). This follows the exact pattern of
`PLAN_EXTRA_ARGS` in `plan-investigate.ts`. The child sees both its role
prompt AND the `report_facts` tool.

### Scoping rule (rich-manifest repos)

When the repo **has** a recognised manifest (`detectFacts(root).manifest`
≠ `undefined`) AND the only reason the dispatch fires is that the code-style
section is absent: the caller passes **only `codeStyleBullets`** into
`agentOverride`. The child's `commands`/`manifest`/`language`/`packageManager`
fields are **ignored** for the fact sections — this prevents a routine
code-style-only dispatch from silently converting a rich project's
`[auto,...]` provenance rows to `[detected:agent,...]`.

### Refresh framing

When the operator triggers a refresh (e.g. `/agents-md update --refresh` or
an explicit "refresh the agent-derived sections" request), re-dispatch the
**same** pre-pass with a prompt framed for refresh:

> You have the `report_facts` tool. Re-read the repository's current state
> and report updated facts via `report_facts` (exactly once call). Only the
> sections that were previously agent-derived (provenance `detected` in the
> sidecar at `.pi/agents-md-state.json`) will be re-written; sections with
> `[auto,...]` or `[asked:operator,...]` provenance are never overwritten. Report all fields you can derive; the
> provenance gate in the tool handles which ones actually land.

After conversion, call `agents_md_run` with `update`, the new
`agentOverride`, and `refresh: true`. This goes through the **same**
ask-before-write flow (dryRun first, show the real diff, operator confirms).

### Graceful failure

If the pre-pass dispatch **fails**, **times out**, or returns **no
`report_facts` tool call** (i.e. the child's `toolUses` array contains no entry
with `name === "report_facts"`), treat it exactly like
`extractPolicyAnswer`'s absent-call handling: **proceed by calling
`agents_md_run` WITHOUT an `agentOverride` parameter at all**. This falls
back entirely to B1's existing deterministic/omission behavior.

A **partial** `report_facts` call (e.g. `codeStyleBullets` present but
`commands` absent) applies **only the populated fields** — the conversion
function's total/lossless contract handles absent fields as
undefined/empty naturally. A partial reply is not a failure.

---

## Call the tool

Use the **`agents_md_run` tool**:

```
agents_md_run(verb: "create" | "update" | "check",
              deep?: boolean,      // check only; rejected with a structured
                                   // error on create/update
              scaffold?: boolean,  // append 7 boilerplate sections (default ON for create)
              answers?: {           // operator interview answers (4 Qs)
                coverageThreshold?: string,
                reviewBlockingSeverity?: string,
                mergeAuthority?: string,
                projectConstraints?: string,
              },
              dryRun?: boolean,     // plan is computed, no write is performed
              agentOverride?: {     // B1↔B2 seam (update only): agent-derived facts
                facts?: AgentFacts, // raw wire format (language?, packageManager?,
                                    //   manifest?, commands?, codeStyleBullets?,
                                    //   ciWorkflows?) — converted internally
                codeStyleBullets?: string[], // dense bullets for code-style section
              },
              refresh?: boolean)    // update only: when true + agentOverride,
                                    // directly replace [detected:agent] sections
```

The tool resolves the repo root itself; you pass no paths. The `agentOverride`
parameter (when supplied) carries the raw `AgentFacts` from the pre-pass —
the tool converts it to `DetectedFacts` internally. You pass the wire format
directly; no conversion function call is needed.

The result is structured — do not parse prose:

- `create`/`update` results: `exitCode` plus
  `plan: { state, newBytes, oldBytes, wouldWrite, managedIds, omitted, drift, scaffoldedIds }`
- `check` results: `exitCode` plus
  `check: { code, findings: [{kind, message}[]], corrupt }` — on the
  `no-file` case `check` is absent and `error` is present; render `error`
- a `dryRun: true` create/update returns the full plan (including `newBytes`)
  without writing anything
- `agentOverride` is only honoured on the has-markers `update` path; it is
  silently ignored on create and no-markers (wrap) paths

The tool also renders a human-readable summary in its `text` output: for
create/update, the CLI-style report (would-write vs no-op, managed ids,
omitted sections, drift) PLUS a unified diff of `plan.oldBytes` →
`plan.newBytes` (truncated to 200 lines); for check, one line per finding.
Read it; that IS the plan.

**The exit code is the contract**:

- `0` clean — markers valid, nothing referenced is missing
- `1` findings / drift — the file parses, but a referenced path is gone, a
  gate command's tool is off PATH, or a ledger row drifted from its derivation
- `2` refuse / corrupt / invalid — unparseable markers, empty managed section,
  or a `create` on an existing file

**`exitCode` 2 → stop.** Do not continue the verb. Report the reason and, for
corruption, the exact message the result carries.

**`exitCode` 1 with no write** (e.g. a brownfield classification finding) →
run the numbered-list protocol below to resolve the decision, then call the
tool again.

---

## The auto-vs-ask rule

These are **automatic** (no question, no confirmation gate):
- every read, every `check`
- a no-op `update` (`plan.wouldWrite` is false — the write codepath is
  provably not entered)
- `create` when the file is absent

Everything else is **ask**:
- any `create`/`update` with `plan.wouldWrite: true` that would replace or
  insert bytes the operator authored — show the unified diff from the tool
  result first, then ask for explicit go-ahead before calling the tool again
  (without `dryRun`) to perform the write.
- a brownfield wrap (it inserts marker lines into a human file).

When you are going to ask, call the tool with `dryRun: true` first — the
result carries the exact bytes that would be written, so the diff you show
is real, not projected.

The ask is a numbered list, per the protocol below. Never write foreign bytes
replaced without a shown diff and an explicit answer.

---

## Numbered-list question protocol

When a decision genuinely cannot be derived, ask in this exact shape — 2–4
options, the **default is the lowest-consequence choice**, and pressing Enter
accepts the default:

```
1. [DEFAULT] <lowest-consequence option — e.g. "omit the section and record it in the sidecar">
2. <alternative A>
3. <alternative B>
```

Rules:
- The default MUST be the option that changes the fewest bytes and the least
  state (usually "omit + ledger row", never "write a guessed value").
- Record the operator's answer **in the same transaction as the write** — the
  answer becomes an `[asked:operator,<date>]` row in the sidecar (`.pi/agents-md-state.json`)
  that the write records, so the decision and its effect land together or not at all.
- If the operator is absent (headless), see the headless clause.

---

## Greenfield interview (before tool call)

When `scaffold` is passed to a `create` (no-file) verb — or omitted, since
scaffolding is ON BY DEFAULT for create — the tool
applies the scaffold post-pass, which appends 7 boilerplate sections
(6 static + the answer-aware `testing-standards`)
and optionally an `operator-choices` section (from interview answers).
Pass `scaffold: false` to create a plain managed-only file.

Ask these 4 questions BEFORE calling the tool:

1. **Coverage threshold** — what test coverage is required? (default: the Testing Standards section renders the ≥80% opinionated default)
2. **Review-blocking severity** — which severity blocks merge? (default: omit)
3. **Merge authority** — who/what can merge PRs? (default: omit)
4. **Project-specific constraints** — any additional rules? (default: omit)

Protocol:
- 2–4 options per question, default is the lowest-consequence choice
- If the operator is absent (headless), see the headless clause
- Unanswered → the Testing Standards section renders the ≥80% opinionated default (the other 3 interview questions keep the omit-on-unanswered rule)
- Answered → `operator-choices` section + `[asked:operator]` ledger rows (the coverage value itself lives ONLY in the Testing Standards section; operator-choices omits its coverage bullet)

---

## The headless clause (no UI)

If there is no interactive UI (headless / `pi -p` / a driver dispatch):
- **`dryRun` is always permitted** — this is a carve-out from the no-write
  rule. `dryRun: true` computes the full plan and is safe to call headless.
- **Show the advisory diff.** Run the verb with `dryRun: true` and surface
  the rendered diff. For scaffolded creates, the Testing Standards section
  renders its ≥80% opinionated default coverage line; the other 3 interview
  questions remain unanswered (no operator-choices section is written).
- **Write nothing.** A headless run must not auto-adopt a human file or
  write any assumed-answer ledger rows. The `operator-choices` section and
  `[asked:operator]` rows are NEVER written headless.
- **Re-ask next interactive run.** Report that the run is gated on a human.
  The next interactive session will re-ask the 4 interview questions and
  produce the real write.

Never auto-adopt a brownfield file headless.

---

## Brownfield adoption = WRAPPING ONLY, plus scaffold-append when scaffold is set

For a file that exists but has no markers, the ONLY permitted change is to
**wrap** (doctrine-untouched) **plus scaffold-append when scaffold is set**:

**Wrap** (always permitted): the tool parses the existing `## ` sections,
classifies each as `machine` (facts the core can re-derive: commands,
environment) / `doctrine` (human rules, taste, machine-read sentences like
merge authority) / `add` (a managed section that is absent), and produces a
per-section plan. The default plan is **doctrine-untouched**: every existing
section is left exactly where it is, with its heading and bytes intact; the
core inserts its marker pairs and appends only the managed sections it can
derive.

**Scaffold-append** (when `scaffold: true`): after the wrap, 7 boilerplate
sections are appended. These are universal text — language
specifics come from the managed fact sections. The refusal condition becomes
`machineByLine.size === 0 && appended.length === 0 && scaffoldBodies.length === 0`
so a repo with no machine sections can still wrap if scaffold boilerplate
will be appended.

Assert, before the write: the diff in the tool result is
**insertions-only** (new marker lines + appended managed sections). No line
of the original file is deleted or reworded. If the plan would delete or
rename anything — or the result reports a classification ambiguity — it is not
a wrap you may take; stop and ask (the ambiguity result exits `1` with one
finding per ambiguous section; a reword/delete or nothing-classifiable result
exits `2`).

---

## Refusals (never, under any verb)

- ❌ Never edit bytes **outside** the marker pairs. The splice keeps the
  original prefix and suffix verbatim; a diff that shows changes there is a
  bug, not a result.
- ❌ Never rename a human heading.
- ❌ Never delete a human section or line.
- ❌ Never `git commit` or push — that is @ops, and this command leaves the
  file uncommitted by design.
- ❌ No side-effectful execution during `check` (the default checks are
  existence-level only: paths exist, `command -v`, `bash -n`). `deep: true`
  runs the commands (subprocess execution, up to 60s each — potentially
  long-running), but only on explicit opt-in, and only for `check`.
- ❌ No LLM fallback for content. A section the core cannot derive is **omitted**
  and recorded as an `[auto] section omitted: <reason>` row in the sidecar
  (`.pi/agents-md-state.json`) — never invented.
- ❌ Never operate on unparseable markers. Corruption is a stop, not a guess.
- ❌ Never auto-adopt a brownfield file headless.
- ❌ Never fall back to shelling out to the core (e.g. `bun
  extension/src/agents-md/agents-md.ts …`) — that path does not exist on host
  repos. The tool is the only execution path for this command.

---

## Report back

Your final message must state: the verb, the exit code, the managed section
ids, any omitted sections and why, any drift, and — when a write happened —
the exact diff you showed and the operator's answer. If you stopped (exit 2
or a headless ask-case), state the exact reason and the verbatim error or
finding the tool result carried.
