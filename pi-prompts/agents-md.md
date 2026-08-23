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
| `no-markers` | file exists but has no pi-ensemble markers | **brownfield wrap** (see below) — WRAPPING ONLY |
| `has-markers` | managed sections present | `update` (no-op when current) |
| `markers-stale` | managed sections present but drift detected | `update` to re-derive; show diff, ask |
| `ambiguous-corruption` | markers present but unparseable (nested/dup/mismatch/orphan) | **STOP.** Report the corruption verbatim. Never guess a repair.

Then overlay the **git-dirty** state: if `git status --porcelain -- AGENTS.md`
is non-empty, say so up front. The core never auto-resolves a dirty file — it
splices from the bytes on disk, so a dirty working tree means the diff is
against an uncommitted baseline. Surface that; let the operator decide.

---

## Call the tool

Use the **`agents_md_run` tool**:

```
agents_md_run(verb: "create" | "update" | "check",
              deep?: boolean,      // check only; rejected with a structured
                                   // error on create/update
              dryRun?: boolean)    // plan is computed, no write is performed
```

The tool resolves the repo root itself; you pass no paths. The result is
structured — do not parse prose:

- `create`/`update` results: `exitCode` plus
  `plan: { state, newBytes, oldBytes, wouldWrite, managedIds, omitted, drift }`
- `check` results: `exitCode` plus
  `check: { code, findings: [{kind, message}[]], corrupt }` — on the
  `no-file` case `check` is absent and `error` is present; render `error`
- a `dryRun: true` create/update returns the full plan (including `newBytes`)
  without writing anything

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
1. [DEFAULT] <lowest-consequence option — e.g. "omit the section and record it in the ledger">
2. <alternative A>
3. <alternative B>
```

Rules:
- The default MUST be the option that changes the fewest bytes and the least
  state (usually "omit + ledger row", never "write a guessed value").
- Record the operator's answer **in the same transaction as the write** — the
  answer becomes an `[asked:operator,<date>]` ledger row that the write splices
  in, so the decision and its effect land together or not at all.
- If the operator is absent (headless), see the headless clause.

---

## The headless clause (no UI)

If there is no interactive UI (headless / `pi -p` / a driver dispatch):
- **Do not call the tool** for any ask-case (a `create`/`update` with
  `plan.wouldWrite: true`). `check` is read-only and may run headless.
- **Assume the default** for each question the interactive run would have
  asked, and record each assumed answer as an `[asked:operator,<date>]`
  ledger row tagged as an assumption in its value (e.g. `value: "omit
  (headless-assumed)"`) — in the file, once the write happens in an
  interactive session.
- **Show the diff.** Run the verb with `dryRun: true` and surface the
  rendered diff from the tool result.
- **Write nothing.** A headless run must not auto-adopt a human file. Stop
  after showing the diff and report that the run is gated on a human — the
  tool's exit-code contract is 0/1/2 and carries no "gated" code, so the
  gating decision is yours, made by this clause.

Never auto-adopt a brownfield file headless.

---

## Brownfield adoption = WRAPPING ONLY

For a file that exists but has no markers, the ONLY permitted change is to
**wrap**: the tool parses the existing `## ` sections, classifies each as
`machine` (facts the core can re-derive: commands, environment) /
`doctrine` (human rules, taste, machine-read sentences like merge authority) /
`add` (a managed section that is absent), and produces a per-section plan. The
default plan is **doctrine-untouched**: every existing section is left exactly
where it is, with its heading and bytes intact; the core inserts its marker
pairs and appends only the managed sections it can derive.

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
  and recorded as an `[auto] section omitted: <reason>` ledger row — never
  invented.
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
