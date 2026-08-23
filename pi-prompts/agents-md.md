---
description: Idempotently create / update / check the marker-managed sections of this repo's AGENTS.md. The core is a pure TypeScript renderer; the file surgery is deterministic and byte-preserving for anything outside the managed markers.
argument-hint: "<create|update|check> [--deep]"
---

# /agents-md: idempotent AGENTS.md management

**Verb**: first argument of `$ARGUMENTS` (default `update`). Optional `--deep`
turns on real execution of the gate commands during `check`.

This command drives a **compiled TypeScript core** (
`extension/src/agents-md/`). The core is a pure-function renderer whose
idempotency is *proven by a test* (double-render `Buffer.equals`), and whose
splice touches **only** the bytes between its own marker pairs. Your job as the
PM here is to run the core, interpret its structured result, show the operator
the diff, and ask — not to edit the file yourself.

You MUST NOT hand-edit `AGENTS.md` for this command. Every byte change goes
through the core. This is the difference between a tool whose correctness is a
theorem and a tool whose correctness is a hope.

---

## The state machine

Before doing anything, classify the target file (`<repoRoot>/AGENTS.md`):

| State | Meaning | Action |
|-------|---------|--------|
| `no-file` | no `AGENTS.md` | `create` is automatic (reads + a create-when-absent write); show the diff, write |
| `no-markers` | file exists but has no pi-ensemble markers | **brownfield wrap** (see below) — WRAPPING ONLY |
| `has-markers` | managed sections present | `update` (no-op when current) |
| `markers-stale` | managed sections present but drift detected | `update` to re-derive; show diff, ask |
| `ambiguous-corruption` | markers present but unparseable (nested/dup/mismatch/orphan) | **STOP.** Report the corruption verbatim. Never guess a repair. |

Then overlay the **git-dirty** state: if `git status --porcelain -- AGENTS.md`
is non-empty, say so up front. The core never auto-resolves a dirty file — it
splices from the bytes on disk, so a dirty working tree means the diff is
against an uncommitted baseline. Surface that; let the operator decide.

---

## Run the core

```bash
bun extension/src/agents-md/agents-md.ts <verb> <repoRoot> <repoRoot>/AGENTS.md [--deep]
```

The process **exit code is the contract**:

- `0` clean — markers valid, nothing referenced is missing
- `1` findings / drift — the file parses, but a referenced path is gone, a
  gate command's tool is off PATH, or a ledger row drifted from its derivation
- `2` refuse / corrupt / invalid — unparseable markers, empty managed section,
  or a `create` on an existing file
- `3` gated on a human — a check needs interactive confirmation this process
  cannot grant

The stdout of `create`/`update` reports `would write` vs `no-op (already
current)`, the managed section ids, any omitted sections (with reasons), and
any drift. Read it; that IS the plan.

**Exit 2 or 3 → stop.** Do not continue the verb. Report the reason and, for
corruption, the exact `MarkerError` message.

---

## The auto-vs-ask rule

These are **automatic** (no question, no confirmation gate):
- every read, every `check`
- a no-op `update` (the write codepath is provably not entered)
- `create` when the file is absent

Everything else is **ask**:
- any `create`/`update` that would replace or insert bytes the operator
  authored — show a unified diff first, then ask for explicit go-ahead before
  the write.
- a brownfield wrap (it inserts marker lines into a human file).

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
- **Assume the default** for each question.
- Record each assumed answer as an `[asked:operator,<date>]` ledger row tagged
  as an assumption in its value (e.g. `value: "omit (headless-assumed)"`).
- **Show the diff.**
- **Write nothing.** A headless run must not auto-adopt a human file. Report
  the would-be bytes and stop at exit `3`-semantics (gated on a human) even if
  the process could proceed.

Never auto-adopt a brownfield file headless.

---

## Brownfield adoption = WRAPPING ONLY

For a file that exists but has no markers, the ONLY permitted change is to
**wrap**: parse the existing `## ` sections, classify each as
`machine` (facts the core can re-derive: commands, environment) /
`doctrine` (human rules, taste, machine-read sentences like merge authority) /
`add` (a managed section that is absent), and produce a per-section plan. The
default plan is **doctrine-untouched**: every existing section is left exactly
where it is, with its heading and bytes intact; the core inserts its marker
pairs and appends only the managed sections it can derive.

Assert, before writing: the resulting diff is **insertions-only** (new marker
lines + appended managed sections). No line of the original file is deleted or
reworded. If the plan would delete or rename anything, it is not a wrap — stop
and ask.

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
  existence-level only: paths exist, `command -v`, `bash -n`). `--deep` runs
  the commands, but only on explicit opt-in.
- ❌ No LLM fallback for content. A section the core cannot derive is **omitted**
  and recorded as an `[auto] section omitted: <reason>` ledger row — never
  invented.
- ❌ Never operate on unparseable markers. Corruption is a stop, not a guess.
- ❌ Never auto-adopt a brownfield file headless.

---

## Report back

Your final message must state: the verb, the exit code, the managed section
ids, any omitted sections and why, any drift, and — when a write happened — the
exact diff you showed and the operator's answer. If you stopped (exit 2/3 or
corruption), state the exact reason and the verbatim error.
