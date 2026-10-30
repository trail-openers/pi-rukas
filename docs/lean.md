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
| `build` | builder (a `developer` child) | Makes the frozen tests pass. The frozen paths are named individually and marked untouchable. At most `MAX_BUILD_ATTEMPTS` (2) rounds. |
| `challenge` | adversary | Tries to break the builder's claim with new tests. Runs at most once per run. New tests earn one more build round; none go straight to verify. |
| `verify` | driver | The run's own gate, no model in it: clean tree, frozen-test integrity (blobs still hash to their records), a compiler canary, every frozen test, then `verify.fast` / `verify.full`, then the spec's `command` criteria. `green` or `red`. |
| `publish` | driver | Pushes the branch under a lease bound to a sha it just read from origin, and opens (or reuses) the PR. Refuses to publish a green it did not observe at the head it is pushing. |
| `review`, `ci`, `land` | — | In the table, not in the build. Their handlers throw `work-lean stage <state> is not built yet`. |
| `handback` | driver | Posts one issue comment saying what the run still needs, then ends the run. |

Two refusals sit beside the main line: `decline` posts the rules an unreadable
or unready spec failed and ends the run `not-ready`, and any handler that
throws ends the run `handed-back` with `handler error at <state>: …`.

The load-bearing rule: only `ci` + `green` enters `land`, and even then the
engine re-reads its own log — the newest decided `verify` **and** `ci` must
both be green and no `draft` marker may be standing. Green is the only verdict
that clears a draft.

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

Verify kinds:

- **`test`** — an acceptance test proves it. Only `test` criteria may have
  frozen test files submitted against them.
- **`command`** — must carry a non-empty `command`, which the gate executes
  separately and records separately. A `command` criterion the gate could not
  run holds the PR as a draft.
- **`manual`** — nobody can check it, so the PR is always a draft.

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

**`/plan` writes it.** `plan-pi-spec.ts` maps the drafted spec onto the
contract, bounds every field it emits (title clipped, at most 12 criteria, all
`verify: "test"`, no `scope`), places the section at the **top** of the body (so
an unclosed fence in prose below cannot swallow it), and reads the block back
through the real parser before filing. Any `pi-spec v1` fence already in the
drafted prose is renamed to `pi-spec-example v1`, so a quoted example can never
become the contract.

## Configuration

Full field-by-field reference: [configuration.md](configuration.md) (the
`.pi/work.json` row). Headless flags and exit codes:
[headless.md](headless.md). What follows is the shape of it.

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
  "budgets": { "build": { "turns": 150, "tokens": 20000000, "minutes": 45 } }
}
```

- **`version`** — must be exactly `1`; anything else, including absent, is
  invalid.
- **`verify.testDir` / `verify.testGlob`** — a pair or neither. Where the
  adversary's acceptance tests live and what they are called. Both absent (the
  default) means the child may write its tests anywhere in the worktree. When
  set, both adversary prompts name the folder and the pattern, and the
  `submit_tests` boundary refuses a test that is not **directly** inside
  `testDir` or whose basename does not match `testGlob` — so the frozen tests
  land where your own CI runs them. `testDir` is repo-relative with no
  wildcard and exactly one canonical spelling; `testGlob` is a basename pattern
  with exactly one `*` and a real extension after it.
- **`verify.test`** — the per-file runner template `specify` uses to prove a
  test red on the base. Executed as an executable plus argv, **never through a
  shell**: it must carry exactly one whole-word `{file}` (`bun run test-{file}.ts`
  is refused), and no `;` `&` `|` `` ` `` `$` `<` `>` `"` `'` `\` or newline
  anywhere.
- **`verify.fast` / `verify.full`** — shell command strings, run with `cwd` at
  the worktree root, fast before full, first failure wins, each under its own
  30-minute bound (`TIER_TIMEOUT_MS`). A committed
  `.pi/verify-cmd` is the fallback for the full tier **only when `work.json` is
  absent**; a `work.json` with no `verify.full` runs no full tier at all.
- **`autoMerge`** — boolean, default `false`. **Read, not acted on.** Nothing
  consumes it yet; the land step will. Today it records intent only.
- **`budgets`** — per state, each `{turns, tokens, minutes}`, non-negative
  integers (`0` is unbounded for turns and tokens, never for minutes), merged
  **over** the shipped defaults, so naming `build` alone keeps the defaults for
  the others. Shipped defaults: `specify` 80/10 000 000/20, `build`
  150/20 000 000/45, `challenge` 60/8 000 000/15, `review` 40/6 000 000/15,
  `ci` 0/0/30. A state with no default has no budget until a phase adds its
  handler.

**When a budget fires.** `minutes` becomes the child's wall clock;
`turns`/`tokens` are watched on the child's progress stream and abort at a turn
boundary. A breach is a **verdict**, not an infrastructure failure — the step
returns `{kind: "budget"}` with `limit`, `value` and `used`, the table routes it
to `handback`, and the run exits **10**. The handback comment names the ceiling
that stopped the child (`build stopped: minutes budget 45 exceeded (used 47)`).
With `PI_ENSEMBLE_DISPATCH_CAPS=0` the wall clock is inert and the step says so
rather than describing a bound that never fired.

**Bounds on a frozen test.** A kept acceptance test must be:

- at most **120 lines** (`MAX_TEST_LINES`);
- at most **16 KiB** (`MAX_TEST_BYTES` = 16 384), checked on the file's stat
  before it is read;
- **new at the base commit** — an existing path is refused ("a new acceptance
  test must be a new file"), which is what makes a frozen test one the child
  wrote rather than a project test that was already green;
- **no more than 2 files per criterion across the whole run**
  (`MAX_TEST_FILES_PER_CRITERION`) — the quota is seeded from what earlier
  rounds already froze, so a second round cannot double it.

Two call-cost bounds sit beside them: a single `submit_tests` row names at most
8 files (`MAX_TEST_FILES_PER_ROW`) and one call gets at most 32 distinct paths
probed against the base (`MAX_TEST_FILES_PER_CALL`). A test the run already
froze may never be resubmitted — the adversary cannot replace the contract the
builder is measured against.

## Running it

**Interactive.** `/work-lean <issue>` — one positional issue number, nothing
else. It seeds the run with the mainline sha, drives it to a terminal state and
notifies one summary line: `work-lean #<issue>: handed-back (exit 10) — <reason>`.

**Headless.**

```
pi-rukas-headless work-lean <issue> [--json]
```

Exactly one positional issue number; `--json` is accepted and changes nothing,
as with every other subcommand. Stderr carries only NDJSON v1 log lines;
stdout carries exactly one JSON document with `subcommand`, `issue`,
`exitCode`, `state`, `summary`, `steps` (the step-log length) and, when the run
reached `publish`, `prUrl`. The verb adds no policy of its own — the run's own
code is the exit code.

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
fold cannot reproduce. A step recorded **without** an outcome is a crash
mid-step and is the only thing re-run — so a crash never double-bills a build
or re-posts a comment. A run that already carries a terminal `result` returns
verbatim, provided the stamp agrees with the log (terminal state, matching
code, and a `landed` whose land gate actually holds); a stamp the log did not
earn is a `LeanStateError`, not a success.

**Lock.** `<repoRoot>/.pi/lean-state/<issue>.lock`, taken atomically with its
owner identity (`<host> <pidns> <pid> <starttime>`) written inside it. Only a
holder this process can **prove dead** is reclaimed; a live, foreign, or
unjudgeable owner — and an unreadable body — all refuse rather than risk
driving one issue twice. A refusal is `LeanLockError`, which is what the
headless verb maps to exit 40.

## What you get back

**A PR** — and today a PR plus a handback comment is the normal outcome, since
nothing past `publish` is built. The body (`publish-body.ts`) is the run's own
claim about itself, generated from the step log: one row per acceptance
criterion with the frozen test that answers for it and the verdict the gate
recorded for it — `green`, `red`, `not run`, `passed (command; …)`, or
`manual — needs a human`. It also carries the gate's reason verbatim (fenced),
the base sha, the version stamp, and the `role = model` pairs the run
dispatched with. A run whose head is not green, or whose spec has a `manual`
criterion or an unrunnable `command` criterion, opens the PR as a **draft**.

**A state file** at `.pi/lean-state/<issue>.json`, written atomically
(tmp + rename). It is WAL-shaped: `steps` is the append-only log (one entry
per visit, keyed `<issue>:<state>:<n>`, outcome stamped in when the step
settles) and `state`/`counters` are a cache that `resume.ts` re-derives rather
than trusts. Read it when you want to know what a run actually decided.

**A handback comment** on the issue, in this order of usefulness: the newest
budget breach, else the newest red `verify` reason, else the newest red `ci`,
else the newest green verdict, else the last error the log holds; then the
frozen acceptance tests (capped at 20 paths); then `Branch:` and `PR:` (or
"no PR yet"). A comment that could not be posted is recorded as such and does
not change the verdict.

## Limits today

- **No `review`, `ci` or `land` steps.** The states and their edges exist in the
  table; their handlers throw `work-lean stage <state> is not built yet`, which
  the engine turns into `handler error at <state>: …`, a handback, exit 10.
  Nothing merges, so **`autoMerge` is read and never acted on.**
- In practice every run that reaches `publish` ends in a handback, because the
  very next state is unbuilt. Treat the PR, not the exit code, as the artefact.
- **The old `/work` driver is a separate program.** `extension/src/work-driver.ts`
  with state at `.pi/work-state/<issue>.json`; lean is
  `extension/src/lean/` with state at `.pi/lean-state/<issue>.json`. Neither
  reads the other, and lean has no grouping, no explore, no plan step and no
  merge-authority gate.
