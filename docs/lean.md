# The lean engine

A second, deterministic `/work`. Where the compiled `/work` driver narrates a
pipeline to specialists, lean runs a pure transition table whose only
specification is a set of tests proved to fail before anybody wrote the
feature. Phase 1 of epic #1883. Source: `extension/src/lean/`; headless entry:
`extension/src/headless/work-lean.ts`.

## What lean is

One issue, one run, one state file. Each step decides its own verdict, the table
in `machine.ts` decides where the run goes, and the step log is the record — not
a model's recollection of what happened.

    ready → specify → build → challenge → build → verify → publish → review → ci → land

`review`, `ci` and `land` are in the table but have no handlers yet — see
[Limits today](#limits-today). A run that reaches any of them ends at `handback`.

| Step | Who | What it does |
|---|---|---|
| `ready` | driver | Fetches the issue, parses its `pi-spec v1` block, judges readiness, resolves the mainline sha, loads `.pi/work.json` **at that sha**. Any failure is a `fail` outcome. |
| `specify` | adversary (a `developer` child) | Writes the acceptance tests and submits them. Each submitted file is run against the base commit; a file that passes there is dropped. Freeze a contract with no red test and the step returns `no-red-test` and the run is refused. |
| `build` | builder (a `developer` child) | Makes the frozen tests pass. The frozen paths are named individually and marked untouchable. At most `MAX_BUILD_ATTEMPTS` (`machine.ts`) rounds. |
| `challenge` | adversary | Tries to break the builder's claim with new tests. Runs at most once. New tests earn one more build round; none — or a round stopped by its own budget — go to verify. |
| `verify` | driver | The run's own gate, no model in it: clean tree, frozen-test integrity (blobs still hash to their records), a compiler canary, every frozen test, then `verify.fast` / `verify.full`, then the spec's `command` criteria. `green` or `red`. |
| `publish` | driver | Pushes the branch under a lease bound to a sha it just read from origin, and opens (or reuses) the PR. Refuses to publish a green it did not observe at the head it is pushing. |
| `review`, `ci`, `land` | — | In the table, not in the build. Their handlers throw `work-lean stage <state> is not built yet`. |
| `handback` | driver | Posts one issue comment saying what the run still needs, then ends the run. |

Two refusals sit beside the main line: `decline` posts the rules an unreadable
or unready spec failed and ends the run `not-ready`, and any handler that
throws ends the run `handed-back` with `handler error at <state>: …`.

The load-bearing rule: only `ci` + `green` enters `land`, and even then the
engine re-reads its own log — the newest decided `verify` **and** `ci` must both
be green and no `draft` marker may be standing. Green is the only verdict that
clears a draft.

## What an issue needs

The issue body carries **one** fenced block whose info string is exactly
`pi-spec v1`. Its content is JSON, and it is the whole contract: the driver
does not infer scope, criteria or size from prose.

| Field | Type | Notes |
|---|---|---|
| `problem` | string, non-empty | What the run is for. |
| `criteria` | array, ≥1 | Each: `id` matching `AC1`, `AC2`, … ; `text` non-empty; `verify` one of `test`, `command`, `manual`; optional `command`. |
| `scope` | optional object | `paths` (may touch) and `out` (must not), both `string[]`. |
| `size` | `"S"`, `"M"` or `"L"` | `L` is refused: *"size L is too large for one run — split it"*. |

Verify kinds: **`test`** — an acceptance test proves it, and only `test`
criteria may have frozen files submitted against them. **`command`** — must
carry a non-empty `command`, which the gate executes and records separately; a
`command` criterion the gate could not run holds the PR as a draft.
**`manual`** — nobody can check it, so the PR is always a draft.

A minimal example:

````markdown
```pi-spec v1
{
  "problem": "work-lean ignores a project's configured test directory",
  "criteria": [
    { "id": "AC1", "text": "a submitted test outside the configured dir is refused", "verify": "test" },
    { "id": "AC2", "text": "the config loader refuses a half-set pair", "verify": "test" }
  ],
  "scope": { "paths": ["extension/src/lean/config.ts"] },
  "size": "S"
}
```
````

Failures name themselves — "no pi-spec v1 block", "2 pi-spec v1 blocks",
"pi-spec v1 block is empty", "…is not valid JSON", "spec.size must be one of
S, M, L" are distinct reasons, and they are the rules `decline` posts.

**`/plan` writes it on the filing path.** The driver assembles the body once
(`assembleFinalBody` in `plan-driver-final-body.ts`, which calls
`plan-pi-spec.ts`), and that assembled body is the one the driver files — the
block is not injected any other way. `plan-pi-spec.ts` maps the
drafted spec onto the contract, bounds every field it emits (title clipped, at
most 12 criteria, all `verify: "test"`, no `scope`), places the section at the
**top** of the body (so an unclosed fence in prose below cannot swallow it), and
reads the block back through the real parser before filing. Any `pi-spec v1`
fence already in the drafted prose is renamed to `pi-spec-example v1`, so a
quoted example can never become the contract.

## Configuration

Full field-by-field reference — including every `verify.*` rule, the
`.pi/verify-cmd` fallback, and what each refusal says:
[configuration.md](configuration.md) → the `.pi/work.json` row. Headless flags
and exit codes: [headless.md](headless.md). What follows is the shape of it.

`.pi/work.json` is read with `git show <baseSha>:.pi/work.json` — never from
the working tree — so a run is not judged by bytes it wrote itself. **Absent
means defaults.** An invalid file is *not* defaulted: it raises
`LeanConfigError`, because a typo'd budget must not silently become "no budget".

```json
{
  "version": 1,
  "autoMerge": false,
  "verify": {
    "fast": "cd extension && bun run check",
    "full": "cd extension && bun test",
    "test": "bun run {file}",
    "testDir": "extension/smoke-tests",
    "testGlob": "test-*.ts"
  },
  "budgets": { "build": { "turns": 100, "tokens": 5000000, "minutes": 10 } }
}
```

- **`version`** — must be exactly `1`; anything else, including absent, is
  invalid.
- **`verify.fast` / `verify.full`** — shell strings run with `cwd` at the
  worktree root, fast before full, first failure wins, each under its own
  30-minute bound. A committed `.pi/verify-cmd` is the fallback for the full
  tier **only when `work.json` is absent**.
- **`verify.test`** — the per-file runner template `specify` uses to prove a
  test red on the base: argv form, never a shell, exactly one whole-word
  `{file}`.
- **`verify.testDir` / `verify.testGlob`** — a pair or neither: where the
  adversary's acceptance tests live and what they are called, so the frozen
  tests land where your own CI runs them.
- **`autoMerge`** — boolean, default `false`. **Read, not acted on.** Nothing
  consumes it yet; the land step will. Today it records intent only.
- **`budgets`** — per state, each `{turns, tokens, minutes}`, non-negative
  integers (`0` is unbounded for turns and tokens, never for minutes), merged
  **over** the shipped defaults, so naming `build` alone keeps the defaults for
  the others. A state name with no default row is **refused** — a typo'd key is
  a ceiling nobody reads.

**Shipped defaults** (`DEFAULT_BUDGETS` in `extension/src/lean/config.ts` — the
jsdoc there carries the measurements they were sized from; `test-lean-config.ts`
pins the table against literals, so changing a number is a deliberate edit):

| State | turns | tokens | minutes |
|---|---|---|---|
| `specify` | 250 | 30M | 20 |
| `build` | 400 | 60M | 45 |
| `challenge` | 200 | 25M | 15 |
| `review` (no handler yet) | 150 | 20M | 15 |
| `ci` (no handler yet) | 0 | 0 | 30 |

**When a budget fires.** `turns` and `tokens` abort at once at a turn boundary.
`minutes` arms the child bound (`spawn-child-bound.ts`): a **wrap-up steer at the
bound**, then a kill at **bound + grace (`PI_ENSEMBLE_CHILD_BOUND_GRACE_MS`,
10 min)**. A breach is a **verdict**, not infrastructure: the step returns
`{kind: "budget"}` with `limit`, `value` and `used`; the table routes it, and
**the step decides the route**. A `specify` or `build` breach ends the run
(`handback`, **10**); a **`challenge`** breach **continues to `verify`** like a
round that added no tests — optional strengthening, and a non-converged round says
nothing about what `verify` still checks. `PI_ENSEMBLE_DISPATCH_CAPS=0` makes the
wall clock inert, and the step says so.

**Bounds on a frozen test.** A kept acceptance test must be new at the base
commit, at most **120 lines** (`MAX_TEST_LINES`), at most **16 KiB**
(`MAX_TEST_BYTES`), and at most **2 per criterion** across the whole run
(`MAX_TEST_FILES_PER_CRITERION`, seeded from what earlier rounds froze so a
second round cannot double it). Two call-cost bounds sit beside them: one
`submit_tests` row names at most 8 files, one call gets at most 32 distinct
paths probed against the base, and a test the run already froze may never be
resubmitted — the adversary cannot replace the contract the builder is measured
against.

## Running it

**Interactive.** `/work-lean <issue>` — one positional issue number, nothing
else. It seeds the run with the mainline sha, drives it to a terminal state and
notifies one summary line: `work-lean #<issue>: handed-back (exit 10) — <reason>`.

**Headless.** `pi-rukas-headless work-lean <issue> [--json]` — exactly one
positional issue number; `--json` is accepted and changes nothing, as with every
other subcommand. Stderr carries only NDJSON v1 log lines; stdout carries
exactly one JSON document with `subcommand`, `issue`, `exitCode`, `state`,
`summary`, `steps` (the step-log length) and, when the run reached `publish`,
`prUrl`. The verb adds no policy of its own — the run's own code is the exit
code.

**Exit codes** (`EXIT_CODES` in `machine.ts`, plus the two the verb adds):

| Code | Meaning |
|---|---|
| 0 | `landed` |
| 10 | `handed-back` |
| 11 | `not-ready` — the issue's spec was refused |
| 30 | the run threw, with `error.code: "crash"` |
| 40 | bad arguments, or a live run already holds this issue's lock (`error.code: "refused"`) |

30 and 40 come from the headless runner's `EXIT` table, not from the machine;
`0`/`10`/`11` are the machine's and are re-validated against it, so a run that
reported `{code: 99, state: "landed"}` is a crash rather than a document.

**Resume.** The state file *is* the resume. `runLean` loads it, folds the
append-only step log through the table, and refuses a file whose snapshot the
fold cannot reproduce. A step recorded **without** an outcome is a crash mid-step
and is the only thing re-run — so a crash never double-bills a build or re-posts
a comment. A run carrying a terminal `result` returns verbatim provided the stamp
agrees with the log (terminal state, matching code, and a `landed` whose land
gate actually holds); a stamp the log did not earn is a `LeanStateError`.

**Lock.** `<repoRoot>/.pi/lean-state/<issue>.lock`, taken atomically with its
owner identity (`<host> <pidns> <pid> <starttime>`) written inside it. Only a
holder this process can **prove dead** is reclaimed; a live, foreign,
unjudgeable or unreadable owner all refuse rather than risk driving one issue
twice. A refusal is `LeanLockError`, which is what the
headless verb maps to exit 40.

## What you get back

**A PR** — and today a PR plus a handback comment is the normal outcome, since
nothing past `publish` is built. The body (`publish-body.ts`) is the run's own
claim about itself, generated from the step log: one row per acceptance
criterion with the frozen test that answers for it and the verdict the gate
recorded for it — `green`, `red`, `not run`, `passed (command; …)`, or
`manual — needs a human`. It also carries the gate's reason verbatim (fenced),
the base sha, the version stamp, and the `role = model` pairs the run dispatched
with, plus one line when the challenge round hit its own budget (`challenge
stopped at its minutes budget (15); no extra tests were added`). A run whose head
is not green, or whose spec has a `manual` criterion or an unrunnable `command`
criterion, opens the PR as a **draft**.

**A state file** at `.pi/lean-state/<issue>.json`, written atomically
(tmp + rename). It is WAL-shaped: `steps` is the append-only log (one entry per
visit, keyed `<issue>:<state>:<n>`, outcome stamped in when the step settles)
and `state`/`counters` are a cache that `resume.ts` re-derives rather than
trusts. Read it when you want to know what a run actually decided.

**A handback comment** on the issue, in this order of usefulness: the newest
budget breach **that no step other than a report (`handback`, `decline`) is newer than** — a `challenge` breach the
table carried past to `verify` is not why the run ended, so a later red owns the
line — else the newest red `verify` reason, else the newest red `ci`, else the
newest green verdict, else the last error; then the frozen tests (max 20),
`Branch:` and `PR:` (or "no PR yet"). A comment that could not be posted is
recorded; it never changes the verdict.

## Limits today

- **No `review`, `ci` or `land` steps.** The states and their edges exist in the
  table; their handlers throw `work-lean stage <state> is not built yet`, which
  the engine turns into `handler error at <state>: …`, a handback, exit 10.
  Nothing merges, so **`autoMerge` is read and never acted on** — and when
  `land` is built it will need the same merge-authority resolution `/work` has
  (#380 / #407): a grant read from the project's `AGENTS.md` at the cycle's
  base sha, plus executed forge evidence, before anything merges.
- In practice every run that reaches `publish` ends in a handback, because the
  very next state is unbuilt. Treat the PR, not the exit code, as the artefact.
- **The old `/work` driver is a separate program.** `extension/src/work-driver.ts`
  with state at `.pi/work-state/<issue>.json`; lean is
  `extension/src/lean/` with state at `.pi/lean-state/<issue>.json`. Neither
  reads the other, and lean has no grouping, no explore, no plan step and no
  merge-authority gate.
