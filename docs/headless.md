# Headless runner

`pi-rukas-headless` runs `/work` cycles without an interactive Pi session. It is invoked as:

```
pi-rukas-headless work <issue> [more issues] [--restart] [--continue-pr] [--timeout <minutes>] [--json]
pi-rukas-headless plan <descriptor> (--dry-run | --file) [--type <t>] [--context <text>] [--reviewed-digest <d>] [--json]
pi-rukas-headless plan <descriptor> --start [--type <t>] [--context <text>] [--json]
pi-rukas-headless plan --resume <session> (--answer <file> | --retry | --confirm) [--json]
pi-rukas-headless research <topic> [--tier quick|standard|deep|adoption] [--context <text>] [--json]
pi-rukas-headless agents-md <create|update|check> [root] [file] [--deep] [--json]
pi-rukas-headless lens-review [--base <ref> --head <ref>] [--since <ref>] [--full] [--context <text>] [--pr <n>] [--json]
pi-rukas-headless --capabilities
```

- **`work`** — runs one or more work cycles, writes NDJSON v1 progress to stderr, and exits with a code derived from the state file.
- **`plan`, `research`, `agents-md`, `lens-review`** — run the compiled /plan and /research pipelines, the agents-md verbs and the six-pass review once, on the same headless host. See [Subcommands](#subcommands).
- **`--capabilities`** — prints one versioned JSON object describing what *this* build supports and exits 0. It starts no cycle, reads no project repository, and makes no network call.

A caller (e.g. orchard) calls `--capabilities` once per image build and once before each cycle. An unknown name in the object means "not supported"; the caller fails closed on it.

## Subcommands

`plan`, `research`, `agents-md` and `lens-review` (#1021) run one pipeline each and exit. They share `work`'s output rules: stderr carries only NDJSON v1 lines (the pipeline's messages as `log` lines, without `issue`), and stdout carries exactly one JSON document, always — `--json` is accepted and changes nothing. Every document carries `subcommand`, `exitCode`, `buildCommit` and `buildVersion`; bad arguments, including an unknown flag, exit 40 with `error.code: "bad-arguments"`. They use the exit-code values below with these meanings:

| Subcommand | 0 | 10 | 11 | 20 | 30 | 40 |
|---|---|---|---|---|---|---|
| `plan` | dry run (`spec`), or filed (`url`) | `duplicate-risk`, or a `--file` run that filed nothing (the reviewed spec changed) | `needs-clarification`, with `questions` | | | any other filing failure, with `failure.reason` / `failure.detail` |
| `research` | artifact written (`artifactPath`), including `"abstained": true` | | | | halted without an artifact (`halt`) | unknown tier (`error.code: "unknown-tier"`) |
| `agents-md` | clean | findings or drift; gated on a human (`"gated": true`) | | | | refused or corrupt (`error`) |
| `lens-review` | `APPROVED`, or no review (`"noReview": true` — an empty delta, not an approval) | `ISSUES_FOUND` | | `CRITICAL_ISSUES_FOUND` | `REVIEW_INCOMPLETE` | the round budget refused the run (`ROUND_CAP_REACHED`) |

- **`plan`** files only with `--file`; a dry run reports a `reviewedDigest`, and `--file --reviewed-digest <d>` with the same inputs files that reviewed spec verbatim. The document carries the pipeline's whole result (`spec`, `gaps`, `status`, `mode`). With `--start` or `--resume` it is a planning session instead: see [Planning sessions](#planning-sessions).
- **`research`**: a deep run whose entailment pass could not run carries `"entailment": "unavailable"`.
- **`agents-md`** documents carry `verb` (`create` / `update` / `check`), `status` (`clean`, `findings`, `gated`, `refused`), `findings[]` and, for `create` / `update`, `wouldWrite`. `root` defaults to the repository root.
- **`lens-review`** is admitted through the same round budget as `dispatch_lens_review` and writes the review ledger like it. Without `--base` / `--head` it reviews the working tree.

### Planning sessions

A caller that plans without a person at a terminal (#1471) holds the plan as a session over several runs, one turn per run, and asks the operator between them, on an issue for example. The session lives in `PI_ENSEMBLE_PLAN_SESSION_DIR` (absolute), or `<git common dir>/pi-plan-sessions` when it is unset; a caller that makes a fresh clone per turn sets it to a directory it keeps.

| Run | What it does |
|---|---|
| `plan <descriptor> --start [--type <t>] [--context <text>]` | Starts a session and runs its first turn. |
| `plan --resume <session> --answer <file>` | Runs the next turn with the operator's answer, read from `<file>` (at most 20,000 characters). |
| `plan --resume <session> --retry` | Runs the turn again with no new answer, after a failed one. |
| `plan --resume <session> --confirm` | Files the plan the last turn showed. Runs no pipeline stage. |

A turn is a dry run of the /plan pipeline, with the session's descriptor and context and every answer so far, in order, appended to the context. It never files. It ends with one of:

| Exit | `status` | Meaning |
|---|---|---|
| 11 | `question` | The pipeline needs answers before it can draft. `questions` holds them. |
| 12 | `shown` | A plan is drafted: `title`, `spec`, `reviewedDigest`. `questions` holds the open points the gap gate left for the operator (CRITICAL gaps and either/or decisions, with the proposed `resolution`); it can be empty. Answer to change the plan, or confirm. |
| 10 | `duplicate-risk` | The plan looks like a duplicate of open work. Answer to explain, or stop. |
| 40 | `failed` | The turn failed (`failure.reason`, as for a one-shot run). `--retry` runs it again. |

`--confirm` exits 0 with `status: "filed"`, `url` and `issueNumber`. It files the shown `spec` byte for byte, and only the plan the last turn showed: after an answer, the plan shown before it can no longer be confirmed. A confirm when no plan is shown exits 40 with `error.code: "nothing-to-confirm"`, and an answer after the session filed exits 40 with `"already-filed"`.

A session files once. A second confirm exits 0 with `"alreadyFiled": true` and makes no forge call. The session records that a filing started before it calls the forge, and keeps that record when the call fails, since a failed call may still have created the issue. The next confirm then searches the forge, closed issues included, for issues whose body carries the session's marker (the filed body's last line, `plan-session=<id>`):

- the issue of this plan: it is recorded, and the confirm exits 0 with `"recovered": true`;
- an issue of an earlier plan of the session: exit 40, `error.code: "earlier-plan-filed"` and its `url`; nothing is filed;
- none: the plan is filed;
- the forge cannot be searched or resolved: exit 40, `failure.reason: "filing-unverified"`; nothing is filed and the record stays, so a later confirm checks again.

Every document carries `mode: "turn"`, `status`, `session` (`id`, `turn`) and, after a turn, `text`: one sentence for the operator. Each question is `{ id, question, options, resolution? }`, numbered `q1`, `q2`, …; `options` is empty when the answer is free text. A session that does not exist, or whose record cannot be read, exits 41 with `status: "lost"` and `"lost": true`; it is never replaced by a new one. A run on a session another live run holds exits 40 with `"session-busy"`; a lock left by a run that is gone is taken over (on another host, after two hours). A turn that was killed leaves the session with no result and the earlier plan no longer confirmable; `--retry` runs it again. A session id is a UUID; anything else is a bad argument.

Each turn reads the same inputs as a one-shot run, `PI_ENSEMBLE_EXTRA_IMAGE_DIRS` and `PI_ENSEMBLE_PLAN_ISSUE` included, so a caller passes them on every turn. `--capabilities` lists the flags under `verbs.plan.flags` and the feature as `features.planTurns`.

## The four contracts

The headless runner's contract with its caller is four independent surfaces, each versioned:

| Contract | Version constant | Module | Description |
|---|---|---|---|
| Exit codes | `EXIT` object (`exit-code.ts`) | `extension/src/headless/exit-code.ts` | The process exit code. 9 named values: `merged` (0), `handoff` (10), `clarification` (11), `shown` (12), `aborted` (20), `interrupted` (21), `crash` (30), `refused` (40), `lost` (41). `shown` and `lost` come only from `plan` turns. |
| `--json` result schema | `RESULT_SCHEMA_VERSION` (4) | `extension/src/headless/result.ts` | The JSON document on stdout when `--json` is used. See below. Its `cap` values come from a published vocabulary (`extension/src/headless/caps.ts`). |
| NDJSON progress | `NDJSON_VERSION` (1); stable subset `NDJSON_STABLE_VERSION` (1) | `extension/src/headless/ndjson.ts` | One JSON object per line on stderr. Every line carries `v` (1), `kind`, `at` (ISO-8601). Driver event lines additionally carry `issue` and `key` (idempotency key `<issue>:<index>:<at>`). Only a declared subset of kinds is stable; every other line is marked `unstable: true`. |
| Capabilities | `CAPABILITIES_VERSION` (2) | `extension/src/headless/capabilities.ts` | The JSON object `--capabilities` prints. See below. |

### Exit codes

| Code | Name | Meaning |
|---|---|---|
| 0 | `merged` | Merged, or completed with nothing to merge |
| 10 | `handoff` | Handoff for any cap other than the clarification caps, or awaiting-human-merge |
| 11 | `clarification` | Handoff whose cap is `intent-park` or `explore-needs-clarification` |
| 12 | `shown` | `plan` turns only: a drafted plan waits for the operator's confirm ([Planning sessions](#planning-sessions)) |
| 20 | `aborted` | Aborted |
| 21 | `interrupted` | Interrupted by a signal (SIGINT/SIGTERM) |
| 30 | `crash` | The driver threw, or interrupted by the runner's own `--timeout`, or a cycle left running after the driver returned, or the runner process died without writing its result |
| 40 | `refused` | Refused to start (claimed by a live cycle, `needs-human-attention` without `--restart`, bad arguments, unknown flag) |
| 41 | `lost` | `plan` turns only: the session to resume does not exist |

A grouped run exits 21 if any issue was interrupted, otherwise the highest per-issue code. The `--json` result carries every issue regardless.

A `provider-unavailable` park (#1243 — the model endpoint, not the code) reports `issues[].status` as `interrupted` with `reason: "provider"` and exits as `handoff` (10), not 21: nothing was cut off and the handoff was delivered, so the host's contract is unchanged; only re-entry differs, in that running `work <issue>` again resumes the halted step instead of needing `--restart`.

A signal outranks the failure of the step it lands in. The step that was running when the signal fired is not routed: no cap, no handoff, exit 21, `resumable: true`, and its `interrupted` event names it (`step`). A cap that step recorded on its way out (an aborted child, an issue-body fetch cut short) is the abort's doing, so the result does not report it as `cap`; running `work <issue>` again re-runs the step. The one exception is the `handoff` step itself: a signal that lands there arrives after the cycle has already stopped on its cap, so the handoff finishes and the run exits with the handoff's code.

### `--json` result schema (v4)

With `--json`, stdout carries exactly one JSON document:

```json
{
  "schemaVersion": 4,
  "buildCommit": "d39f8731f34d…",
  "buildVersion": "0.12.79",
  "exitCode": 10,
  "issues": [
    {
      "issue": 42,
      "status": "handoff",
      "cap": "verify-failed:develop",
      "failedStep": "develop",
      "failure": {
        "kind": "verify",
        "step": "develop",
        "message": "verify command exited 1: 2 tests failed",
        "evidence": "verify command exited 1: 2 tests failed\n…"
      },
      "branch": "feature/issue-42-foo",
      "prNumber": 99,
      "prUrl": "https://github.com/owner/repo/pull/99",
      "usage": {
        "input": 812000, "output": 41000, "cacheRead": 2900000, "cacheWrite": 0, "cost": 3.12, "turns": 214, "dispatches": 9,
        "byRole": {
          "developer": { "input": 640000, "output": 33000, "cacheRead": 2400000, "cacheWrite": 0, "cost": 2.5, "turns": 170, "dispatches": 4 },
          "…": { }
        }
      },
      "resumable": false,
      "stateFile": "/path/to/.pi/work-state/42.json",
      "durationMs": 42000,
      "steps": [
        { "step": "explore", "startedAt": "…", "endedAt": "…" },
        { "step": "plan",    "startedAt": "…", "endedAt": "…" }
      ],
      "handoff": {
        "channel": "forge",
        "marker": "<!-- pi-rukas:handoff issue=42 cap=verify-failed:develop -->",
        "body": "<!-- pi-rukas:handoff issue=42 cap=verify-failed:develop -->\n## …",
        "bodyFile": "/path/to/handoff-comment.md",
        "commentUrl": "https://github.com/owner/repo/issues/42#issuecomment-1",
        "labelApplied": true
      },
      "exitCode": 10
    }
  ],
  "resources": { "host": { … }, "budget": { … }, "limits": { … } }
}
```

| Field | Present | Meaning |
|---|---|---|
| `schemaVersion` | always | `RESULT_SCHEMA_VERSION`. Version 2 (#1326) added `schemaVersion`, `buildCommit`, `buildVersion`, `failedStep`, `prUrl`, `usage` and `resumable`. Version 3 (#1327) added `parkReason` and `handoff`. Version 4 (#1384) renamed the cap `wall-clock` to `lens-review-timeout` (see [the `cap` vocabulary](#the-cap-vocabulary)). |
| `buildCommit` | always | The full 40-hex commit the running build was made from (the image's baked `.pi/pi-rukas-commit`, else the HEAD of the pi-rukas checkout), or `null` when nothing records it. Never anything else, so a host can safely run `git merge-base --is-ancestor <fix> <buildCommit>` when it is non-null. |
| `buildVersion` | always | The release version of the running build (`extension/package.json`). |
| `issues[].status` | always | `merged`, `handoff`, `aborted`, `interrupted`, `running` (the driver returned without a terminal state) or `not-started`. |
| `issues[].cap` | when a cap was hit | The last cap the cycle hit, from the published vocabulary (below). It can be set on a `merged` result too (a cap the cycle recovered from), so a host reads `status` and `exitCode` for the outcome and `cap` for the reason. A cap recorded by a step that a signal then cut off is not reported (see [Exit codes](#exit-codes)). |
| `issues[].parkReason` | when `cap` is `intent-park` | Why the cycle parked: `underspecified`, `contradicted-by-code`, `already-implemented`, `too-large`, `premise-unsound`, `unresolved-critical-open-point` or `blank-issue-body`. |
| `issues[].handoff` | once the cycle emitted a handoff | `channel` (`forge` or `host`, see [Handoff channel](#handoff-channel)); `marker`, the machine marker that is the first line of the body; `body`, the full handoff markdown, taken from the driver's record of this cycle (never re-read from the file); `bodyError` (`not-recorded`) in place of `body` when the cycle recorded none; `bodyFile`, a path for a person; `commentUrl`, the comment pi-rukas posted (forge channel); `labelApplied`, whether `needs-human-attention` was verified on the issue (and PR). |
| `issues[].failure` | when `cap` is set and the cycle did not merge | Why the cycle stopped on `cap`, as stable fields (#1367, added in this release). See [The `failure` object](#the-failure-object). |
| `issues[].failedStep` | when the cycle did not merge and started a step | The step it stopped in: the step a `<template>:<step>` cap names (`verify-failed:`, `verify-timeout:`, `verify-env:`, `verify-baseline-red:`, `pr-not-open:`, `step-failed:`, `driver-crash:`), else the last step started before the cap, else the last step started. It names where the cycle stopped, not necessarily a failure: for `awaiting-human-merge` it is the last step the cycle ran (e.g. `ci`). |
| `issues[].branch`, `prNumber`, `prUrl` | when known | `prUrl` is present only when unambiguous: the PR URL the driver recorded (its handoff comment on the PR), else one built from the project's git remote when there is exactly one remote, the forge is GitHub or GitLab, and the web address is certain (an `http(s)` remote, or ssh to github.com / gitlab.com; GitLab subgroups and explicit https ports are kept). Otherwise only `prNumber` is set. |
| `issues[].usage` | when a state existed | Tokens, cost and turns summed over every dispatch the cycle recorded (`dispatch-completed`, `dispatch-failed` and `dispatch-failed-provider` events), and the dispatch count. It covers the current cycle only: `--restart` discards the state, so earlier cycles' cost is not included. `usage.byRole` (#1368, added in this release) holds the same seven numbers per dispatch `role` (the `role` on the `dispatch-*` events, e.g. `developer`, `adversarial`), summed over the same dispatches, failed ones included, so its rows add up to the total. |
| `issues[].resumable` | always | `true` when running `work <issue>` again **without** `--restart` continues this cycle (it was interrupted, or stopped while running). Always `false` on a refusal (exit 40: another live process owns the cycle, so a re-run is refused again until it ends) and when `PI_ENSEMBLE_RESUME=0`. A terminal cycle needs `--restart` for a fresh one. |
| `issues[].continuedPr` | when a `--continue-pr` cycle reached the branch step | The PR it continued (#1468): `number`, `headRefName`, `startHeadSha` (the PR head when the run started) and `mainlineSha` (the mainline commit merged into it). See [`--continue-pr` for hosts](#--continue-pr-for-hosts). |
| `issues[].stateFile` | always | A path for a person to inspect. Not a host contract: see below. |
| `issues[].questions` | exit 11 only | The clarification questions, numbered `q1`, `q2`, … |
| `issues[].diverged` | on divergence | The in-memory and on-disk states disagreed; the exit code is 30. |
| `resources` | always | The host budget and the parallelism limits the run chose (#1325, added in this release). See [Resource report](#resource-report). |

An optional top-level `error` (`{ code, message }`) is present when the runner detected a divergence (e.g. `state-diverged`) or another runner-level failure.

**A runner that dies still answers (#1591).** `work` runs as a child of a small supervisor process that holds its stdout. If the child exits without writing a result — Bun aborts natively when it cannot create a thread, for example at a container's `pids.max`, and no handler runs on such an abort — the supervisor writes the document itself: `error.code: "crash"`, a message naming the signal or exit code, exit 30, and each issue projected from its state file (`not-started` when there is none; a non-terminal issue has exit 30). A cycle that had opened its PR still reports `branch` and `prUrl`. stderr is passed through untouched. `PI_ENSEMBLE_HEADLESS_SUPERVISED=1` runs `work` in-process without the supervisor.

`resources` (#1325, added in this release; an additive field, so no schema bump) is the host budget and the parallelism limits the run chose — see [Resource report](#resource-report). `failure` (#1367), `usage.byRole` (#1368) and `continuedPr` (#1468) are additive fields too, so they need no schema bump; a host detects them with `features.failureReason`, `features.usageByRole` and `features.continuePr` in `--capabilities`.

### The `failure` object

`issues[].failure` is the reason behind the result's `cap`, so a host never reads the unstable `dispatch-failed` / `dispatch-failed-provider` lines or the cap's prose to tell a provider outage from a real failure. It is present when the cycle hit a cap and did not merge.

| Field | Present | Meaning |
|---|---|---|
| `kind` | always | A coarse class, from `contracts.resultSchema.failureKinds` in `--capabilities` (below). |
| `step` | when known | The step it belongs to, the same as `failedStep`. |
| `role` | when a dispatch failed, or a guard cap names one | The failed dispatch's role (or the role a `loop-detected` / `token-budget` cap killed). |
| `cause` | when a dispatch failed | The driver's root-cause reading of the failed dispatch, the one its retry router acts on: `provider-severed`, `rate-limited:429`, `rate-limited:burst`, `rate-limited:quota-window`, `rate-limited:quota-terminal`, `provider-model-unavailable`, `self-killed:<timeout\|inactivity\|tool-inactivity\|abort\|loop\|token-budget\|plan-timeout>`, `crashed` or `crashed-unknown`. Additive: show an unknown one to a person. |
| `message` | always | One plain-text sentence, at most 500 characters: the failed dispatch's cause in words, else the first line of the cap's evidence, else the cap. |
| `providerMessage` | provider failures | The provider's own error message, at most 1000 characters. |
| `errorTail` | process failures | The end of the failed child's output, at most 2000 characters. |
| `killCause` | when pi-rukas ended the child | `timeout`, `inactivity`, `tool-inactivity`, `abort`, `loop`, `token-budget` or `plan-timeout`. |
| `exitCode` | when the failed child exited | Its exit code (`null` when killed by a signal). |
| `evidence` | when the cap recorded some | The cap's evidence, at most 2000 characters. Plain text for a person; do not parse it. |

Every text field has secrets redacted before it is cut to its bound.

On an `intent-park` (#1561), `message` names the park reason and the evidence the park rests on, e.g. `intent-park (already-implemented): PR #12 (MERGED) — …` or `… commit 58c2bf4 — …`; `evidence` adds the resolver's decisive rows and rationale. A cited PR's state is read from the forge (`state not read` when it could not be). When an `already-implemented` park rests on an OPEN PR, the message says the work is awaiting review in that PR rather than that the issue is done.

A failed dispatch is read only for the caps a failed dispatch causes (`step-failed:<step>`, `adversarial-infra-failure`, `provider-unavailable`, `developer-timeout`, `review-incomplete`, `loop-detected`, `token-budget`, `plan-timeout`): the last `dispatch-failed*` event between the start of the stopped step's last run and the cap. Usually its kind wins over the cap's — except for `provider-unavailable` and `develop-child-crash`, whose kind comes from the cap even when a failed dispatch exists to explain them. For `provider-unavailable` that matters on a multi-attempt outage: the cap is only chosen when the dispatch that ENDED the step was itself severed by the provider or hit a short-burst 429, and a rung of the ladder that died of something else must not relabel the park.

| `kind` | Meaning |
|---|---|
| `provider` | A dispatch stopped on a provider error: an outage, a 429, a spend cap, an unknown model (`cause` says which). The case a host may retry later on its own. |
| `timeout` | A time bound ended it: a child killed for time or silence, `verify-timeout:<step>`, `developer-timeout`, `plan-timeout`, `lens-review-timeout`, `deadline`. |
| `guard` | pi-rukas ended the child on a guard: a loop, the token budget, an abort. |
| `process` | The child process failed with no structured cause (a dispatch cap with no failed dispatch recorded is `process` too). |
| `verify` | The verify gate ran and judged the code red: `verify-failed:<step>`, `verify-baseline-red:<step>`, `integration-verify-failed`, `consolidated-verify-consolidation-created`. |
| `environment` | `verify-env:<step>`: the system refused to start a process, so the gate never ran. |
| `driver` | `driver-crash:<step>`: a driver step handler threw. |
| `cap` | Nothing failed: the cap's own rule stopped the cycle (a round cap, an intent park, awaiting merge, a fence violation, …). `evidence` says why. |

A new kind is additive and does not bump the schema: a host treats an unknown kind like `cap`.

### Resource report

The same object appears in the `--json` result and in `--capabilities` (`extension/src/resource-budget.ts`):

```
{
  "host": {
    "cpus": 4, "cpuSource": "cgroup-v2",          // os | cgroup-v2 | cgroup-v1
    "memoryBytes": 8589934592, "memorySource": "cgroup-v2",
    "cgroup": "v2",                                // v2 | v1 | none
    "pidsMax": 3072                                // absent when unlimited
  },
  "budget": { "workstreamSlots": 8, "verifyConcurrency": 2, "lensSlots": 3 },
  "limits": {
    "parallelGroups":    { "value": 1, "source": "budget" },  // env | budget | default
    "maxWorkstreams":    { "value": 6, "source": "default" },
    "verifyConcurrency": { "value": 2, "source": "budget" },  // 0 = unbounded
    "lensConcurrency":   { "value": 3, "source": "budget" }   // env | budget; 0 = unbounded
  }
}
```

`host` is what the machine allows: `os.availableParallelism()` and `os.totalmem()`, each lowered by a cgroup CPU quota or memory limit when one is set. `budget` is derived from it: `workstreamSlots` is two per CPU or one per GiB, whichever is lower; `verifyConcurrency` is one per two CPUs or per 2 GiB, at least 1; `lensSlots` (#1591) is `workstreamSlots` lowered to one per 1024 of the cgroup's `pids.max` (which counts threads too), at least 1. `limits` are what a cycle runs with. `source: "env"` means an explicit setting decided the value, `"budget"` that the host budget lowered the default, `"default"` that the static default applied. The budget never raises a default. The group and workstream defaults hold from about 9 CPUs and 18 GiB up.

### The `cap` vocabulary

`--capabilities` publishes every value `cap` can take under `contracts.resultSchema.caps`:

- `fixed` — literal caps such as `round-cap`, `intent-park`, `awaiting-human-merge`, `deadline` (the cycle deadline was reached; parked at a step boundary), `fence-violation:develop`, `fix-pass-park` (the adversarial fix pass parked on its own check), `provider-unavailable` (a dispatch the model ENDPOINT caused — a severed stream or a short-burst 429 — ended the step after its retries were spent; `failure.kind` is `provider`, so a host may re-queue it once the endpoint answers. The terminal dispatch is what is classified: a step that met an outage earlier and then died of a crash is a crash, not a provider park).
- `templates` — a prefix plus one parameter: `verify-failed:<step>` (the gate ran and judged the code), `verify-timeout:<step>` (the verify command hit its time bound), `verify-env:<step>` (the system refused to start a process, so the gate never ran), `verify-baseline-red:<step>` (the verify command already fails at the cycle's base commit, on the same assertion as the change or by timing out on both), `pr-not-open:<step>` (the cycle's PR was merged or closed when the step started), `step-failed:<step>`, `driver-crash:<step>` (with the step list in `values`), and `branch-ahead:<count>`.

**`verify-failed:<step>` was narrowed in result schema v2.** It now means only that the gate ran and judged the change. A gate that hit its bound, could not start a process, or was red at the base commit, and the PR-not-open and fix-pass parks, used to share it and now have the caps above (see [troubleshooting](troubleshooting.md#what-verify-failedstep-means-and-the-caps-that-split-from-it-1349)). This changes what an existing cap means, and the narrowing is deliberate. It is covered by the tolerate-the-unknown rule below: a host that meets one of the new caps treats it as a generic handoff. It ships in the same release as schema v2, so no released v2 build used the old meaning and the version is not bumped again. A host that read `verify-failed:` as "the gate parked" should also match the new caps, or treat them as unknown caps (below).

**`wall-clock` was renamed `lens-review-timeout` in result schema v4 (#1384).** pi-rukas used `wall-clock` for one clock only: the lens-review fix loop's own budget (`PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS`, 90 min by default). A host that ends cycles on its own time limit reads `wall-clock` as that limit, so an operator was sent to raise the wrong number. pi-rukas no longer emits `wall-clock`; each time bound it raises has its own id (`lens-review-timeout`, `plan-timeout`, `developer-timeout`, `verify-timeout:<step>`, `deadline`), and a host is free to use `wall-clock` for its own kill. Removing a value changes the vocabulary, so the result schema version moved from 3 to 4. The cap-hit carries the reason as `evidence`, so `failure.message` names the elapsed time and the budget rather than repeating the cap.

A host switches on these values instead of strings found in pi-rukas source. The list is checked against the driver's cap type at compile time, so the build cannot record a cap the vocabulary omits. Exit code 11 is reserved for `intent-park` and `explore-needs-clarification`.

### Versioning rule

Additions do not bump a version: a new cap, a new input or file, a new stable NDJSON kind or field, or a new optional result field. Removing or renaming one, or changing its meaning, does bump the version of the contract it belongs to. A host must therefore tolerate the unknown:

- An unknown `cap` is a generic handoff: act on `status` and `exitCode`, and show the cap to a person.
- Unknown fields are ignored.
- An unknown input `scope` is not `cycle`: the name is read, but not by a cycle's runner.
- An unknown NDJSON kind is treated as unstable.

### The state file is not a host contract

`.pi/work-state/<issue>.json` is the driver's private persistence. Its shape changes without a version bump, and the result's `stateFile` path is there for a person to inspect. A host reads the `--json` result, the NDJSON stream and the exit code, and nothing else. If a host needs a fact that only the state file has, that is a gap in this contract: file an issue rather than parse the file. The same applies to the `.worktrees/` layout and to pi-rukas source.

### NDJSON progress (v1)

One JSON object per line on stderr. Fields:

| Field | Type | Present | Description |
|---|---|---|---|
| `v` | `number` | always | Always `1` |
| `kind` | `string` | always | One of the `WorkEvent` kinds, or `log`, or `pi-resolved` |
| `unstable` | `true` | on kinds outside the stable subset | The line passes an internal event through; its kind and fields may change in any release |
| `at` | `string` | always | ISO-8601 timestamp |
| `issue` | `number` | when the line belongs to one issue | The issue number |
| `key` | `string` | on driver event lines | Idempotency key `<issue>:<index>:<at>` — a resumed cycle re-emits its prior event log, so a consumer dedupes on `key` |
| `event` | `object` | on driver event lines | The WorkEvent itself (its own `kind` would collide with the envelope's) |
| `message` | `string` | on `log` lines | The log message |
| `level` | `"warn"` | on `log` lines that carry a warning | Set on a diagnostic the runner rerouted from a warning (see below); absent on every other line |

The full set of valid `kind` values is exported as `NDJSON_KINDS` (= `KNOWN_EVENT_KINDS` + `log` + `pi-resolved`).

#### Every line pi-rukas writes is JSON

pi-rukas's own plain-text diagnostics, such as the `PI_ENSEMBLE_DEBUG` trace, `[pi-rukas] WARN …` lines and the `pi-binary-resolve` PATH warning, would otherwise reach stderr as plain text. The runner reroutes them: each line becomes a `log` line with no `issue`, and with `level: "warn"` when it is a warning. Its `message` is the original text, e.g.:

```json
{"v":1,"kind":"log","at":"2026-10-15T09:00:00.000Z","message":"[pi-rukas] pi-binary-resolve: WARNING — pi resolved from PATH, no integrity check performed","level":"warn"}
```

`console.log` output is rerouted the same way, so stdout carries only the summary line or the `--json` document.

Lines written by something other than pi-rukas can still reach stderr. Examples are an init or wrapper that shares the file descriptor, the runtime (bun) itself, or a launcher script. **A consumer must skip a stderr line that does not parse as JSON**, and must not treat it as a broken stream. The published image's `tini` runs with `-s`, so `docker run --init` no longer adds its "not running as PID 1" warning. A usage error printed before `work` starts (an unknown verb) is plain text and exits 40.

#### The stable subset

Only these kinds are a host contract, versioned by `NDJSON_STABLE_VERSION` (1) and published under `contracts.ndjson.stable` in `--capabilities`. Within a version, the listed `event` fields keep their names and meanings; optional ones may be absent.

| Kind | Stable `event` fields |
|---|---|
| `step-started` | `step`, `at`, `round` |
| `dispatch-started` | `step`, `role`, `jobId`, `at` |
| `dispatch-completed` | `step`, `role`, `jobId`, `ok`, `ms`, `at`, `usage` |
| `verify-started` | `step`, `command`, `at` — the develop gate's verify is about to run (#1415, added in this release); written before the command starts, so it arrives while the gate is still running |
| `verify-completed` | `step`, `command`, `ok`, `ms`, `at` — how that gate ended and how long it took |
| `cap-hit` | `cap`, `at`, `nextStep` |
| `handoff-emitted` | `at`, `commentUrl`, `labelApplied` |
| `ci-status` | `at`, `status`, `runUrl` |
| `merged` | `at`, `prNumber`, `mergeCommit` |
| `interrupted` | `at`, `reason`, `step` (only when the signal fired mid-step) |
| `log` | `message`, and `level` when set (on the line, not under `event`) |

Every other line carries `unstable: true`. A host may display it, but must not branch on it. The field lists are typed against the driver's event union, so renaming a stable field fails the build.

## What the runner refuses to accept

The headless runner is the surface a host — not a person — drives, so the two
things that would let it escalate are refused at argument parsing, before any
cycle starts (exit 40, `error.code: "bad-arguments"`):

| Refused | Why |
|---|---|
| `--merge` (and `--auto-merge`, `--allow-unreviewed`) | `--merge` is the one `AuthoritySource` that bypasses the policy judge. A flag an agent can pass is a flag an agent can pass, so a host that could set it could grant its own cycle permission to merge. Merge authority comes from the project's `AGENTS.md` read at the cycle's **base commit** (#406) and is citation-verified by the judge (#407) — nothing on the command line replaces either. |
| `--sandboxed` | Would claim a trust mode the sandbox image never granted. Trust is an **environment** fact, not a request: `.devcontainer/Dockerfile` bakes `PI_ENSEMBLE_SANDBOX_MODE=1` into the image, and a caller outside that image gets children that fail closed (hard deny on any `ask`-class tool — see [children fail closed](#children-fail-closed-outside-the-sandbox)). A flag that sets the same variable would let any caller declare itself sandboxed. |

`--capabilities` publishes no `--sandboxed` or `--merge` input for the same
reason: an unknown name means "not supported", and a host failing closed on it
is the intended outcome. `PI_ENSEMBLE_SANDBOX_MODE` **is** listed — as scope
`sandbox`, which the sandbox wrapper and the image set and a host must not.

The practical consequence at the merge step: a cycle parked there in a repository
whose doctrine grants nothing exits **10** (`awaiting-human-merge`) having run no
forge merge, even with every `gh` answer green. Authority is decided first, and
evidence is gathered only when authority granted — a denied cycle does not get
to ask `gh` whether it may merge. That short-circuit is what "a green PR is not
permission" (#380) means on this surface.

### Children fail closed outside the sandbox

A specialist child spawned by the runner inherits the runner's environment. If
neither `PI_ENSEMBLE_SANDBOX_MODE` nor `PI_ENSEMBLE_TRUST_MODE` is set, the
child's permission guard has no broker socket to escalate to and denies every
`ask`-class tool outright (`Tool '<name>' denied (subagent ask → no broker
socket — headless deny)`) rather than waiting for a verdict nobody can give.
Inside the image, the baked variable passes through untouched and the guard
short-circuits as it does for any sandboxed session. Mode-independent guards —
the merge guard, the issue-creation guard — run **before** that short-circuit
either way, so the container default does not disarm them.

## Handoff channel

When a cycle stops short of a merge, it hands off: it renders a handoff body (why it stopped, where the work is, what to do next). `PI_ENSEMBLE_HANDOFF_CHANNEL` decides who delivers it.

| Value | pi-rukas does | The host does |
|---|---|---|
| `forge` (default) | Posts the body as a comment (on the PR when one exists, else the issue) and applies `needs-human-attention` to the issue and the PR. | Nothing; it may read `issues[].handoff.commentUrl` and extend that comment. |
| `host` | Posts no handoff comment and applies no `needs-human-attention` label (and runs no ops handoff dispatch). The cycle still ends in `handoff` with the same exit code. | Delivers `issues[].handoff.body`, using `cap` and `parkReason` to choose how. |

The `host` channel covers only the handoff. Other forge writes a cycle makes still happen:

- the six-pass review's residual-findings comment on the PR (with its `<!-- pi-rukas:lens-residuals … -->` marker), which the merge guard depends on;
- the same residual findings posted to the issue when the PR was merged or closed under the cycle, or posting to it failed;
- marking a draft PR ready for review when the review concluded (`PI_ENSEMBLE_DRAFT_PR`).

The body is recorded on the cycle's `handoff-emitted` event, and the result reads it from there, not from `bodyFile`. A failed write of that file therefore loses nothing, and a later cycle's file never shows up as this cycle's body. If the handoff step itself throws on the `host` channel, the cycle ends `aborted`, but a handoff is still recorded: its body is rendered from the state as it stood, with the crash named at the top. A handoff recorded by a build without the body has `bodyError: "not-recorded"` instead of `body`.

Either way, the body's first line is a machine marker, invisible when rendered:

```
<!-- pi-rukas:handoff issue=42 cap=verify-failed:develop -->
```

`cap` is the result's typed `cap` (`none` when the cycle recorded none). A host that finds this marker in a comment on the issue or PR knows pi-rukas already posted the handoff, and edits or replies to that comment instead of posting a second one. A host on the `host` channel should keep the marker in what it posts, so a later `forge` run, or another reader, can find it the same way.

On the `host` channel the attention gate still reads `needs-human-attention`, but pi-rukas never applies it. A host that wants a handed-off issue to refuse plain re-runs applies the label itself; [`--restart`](#--restart-for-hosts) is then how it runs the issue again.

## `--restart` for hosts

`work <issue> --restart` is the supported way to run an issue again after a handoff that a person has dealt with. A host passes it; it never removes labels itself.

What `--restart` does:

- **Starts a fresh cycle.** The driver ignores the issue's state file and overwrites it. The previous cycle's event log is lost, so copy the state file first if you need it. Without `--restart`, a terminal cycle (`merged`, `handoff`, `aborted`) is refused with exit 40, and a `running` or `interrupted` one resumes (`issues[].resumable`).
- **Overrides the attention gate (#408).** Without `--restart`, an issue labelled `needs-human-attention` is refused with exit 40 before any dispatch. With it, the gate does not refuse.
- **Clears `needs-human-attention`** from every issue in the cycle that carries it, whoever applied it, including a host on the `host` channel. The restart is the answer the label asked for, and the next `forge` handoff applies it again. If the restarted cycle is interrupted, a plain re-run resumes it without hitting the gate. Clearing is best-effort and never stops the restart. A PR's copy of the label stays in place: the gate does not read it.

What `--restart` does not reset or check:

- **The forge.** An open PR for the issue is not duplicated. Without `--continue-pr` the run stops at the branch step with the cap `existing-pr-detected` (`PI_ENSEMBLE_PR_PREFLIGHT=0` turns that check off). With [`--continue-pr`](#--continue-pr-for-hosts) the run continues that PR.
- **Worktrees and branches.** A leftover worktree with no uncommitted or unpushed work is recreated, and one that holds work is refused (see [troubleshooting.md](troubleshooting.md)).
- **The intent-park record.** A restart that parks again for the same reason, on the same issue text and commit, links the earlier park comment instead of posting a new one.
- **Nothing about a live cycle.** `--restart` skips the check for another live process that owns the issue (that check is part of resuming). A host must never restart an issue it is still running; wait for the first run to exit.

Use `--restart` only when a person, or the host acting on a person's answer, has dealt with the handoff. Passing it on every run turns the gate off entirely, and the same handoff repeats.

## `--continue-pr` for hosts

`work <issue> --continue-pr` (#1468) continues the issue's open pull request instead of stopping on `existing-pr-detected`. A host uses it to refresh a PR that has fallen behind or conflicts with the mainline. The flag is additive: without it, nothing changes.

What it does:

- **Finds the PR.** Before explore, it lists the open PRs (`gh pr list --state open --limit 500`) and keeps those that close the issue in their body or name it in their branch. Exactly one must match, its head must be in the same repository, and its base must be the mainline. Otherwise the run stops before the branch step with one of the caps below, and nothing is written.
- **Merges the mainline into the PR head.** The branch step checks out the PR head as it is on the remote and merges `origin/<mainline>` into it with a merge commit. It never rebases. A conflicted merge is left in progress in the worktree, and the developer is told to resolve the markers and finish the merge, and to do no other work. The base of the cycle is the mainline tip, so the gates and the reviews judge the PR's whole diff against the mainline.
- **Pushes a fast-forward.** At commit-pr the PR branch is fast-forwarded to the result and pushed with a plain push. It never force-pushes, never opens a second PR and never runs the ops fallback. The PR's title and body are not changed.
- **Stops if someone else pushes.** At the start of each later step, and before a lens-fix round moves its worktree, it checks that the remote head is still one of its own commits. A push someone else made in between is rejected, never overwritten. If someone else pushed to it, deleted it or rewound it, the run stops on `continue-pr-head-moved`.

Limits:

- **One issue.** `--continue-pr` with more than one issue is refused with exit 40 (`bad-arguments`).
- **A terminal state still needs `--restart`.** A `merged`, `handoff` or `aborted` state file is refused with exit 40 as before. Pass `--restart --continue-pr` to run the issue again.
- **`PI_ENSEMBLE_PR_PREFLIGHT` is ignored.** The lookup always runs in this mode.
- **A red mainline parks the refresh.** When the verify command already fails at the mainline tip, commit-pr stops on `integration-verify-failed` and nothing is pushed. Fix the mainline first.
- **At most 500 open PRs.** A full page cannot prove that only one PR matches, so the lookup fails closed with `continue-pr-not-found`.
- **GitHub only.** Another forge gives `continue-pr-not-found`.

The caps (each has a row in [troubleshooting.md](troubleshooting.md)):

| Cap | When | Before the branch step |
|---|---|---|
| `continue-pr-ambiguous` | Two or more open PRs match the issue. `evidence` lists them. | yes |
| `continue-pr-fork` | The one match comes from a fork. | yes |
| `continue-pr-not-found` | No PR matches, or the lookup could not prove exactly one (a `gh` error, unreadable output, a full page, a forge that is not GitHub). | yes |
| `continue-pr-unsafe-head` | The head branch name is unsafe or is the mainline, the PR's base is not the mainline, the local branch is ahead of or diverged from the PR head, or another worktree holds the branch at another commit. | yes |
| `continue-pr-head-moved` | The PR head changed after the lookup, or someone else pushed to it, deleted it or rewound it during the run. | no |
| `continue-pr-unresolved` | At commit-pr the merge is still unfinished: a conflict, a leftover conflict marker, or a history that no longer has the PR head as its first parent. Nothing is pushed and the worktree is kept. | no |

Any other failure in this mode stops on `step-failed:branch` or `step-failed:commit-pr`. A successful run ends like any other cycle that opened a PR, usually `awaiting-human-merge` with exit 10, and the result carries `issues[].continuedPr`. A host detects the flag with `verbs.work.flags` and `features.continuePr` in `--capabilities`.

## `--capabilities` answer

`pi-rukas-headless --capabilities` prints one JSON object to stdout and exits 0. The object describes what **this specific build** of pi-rukas-headless supports.

### Schema

```
{
  "schemaVersion": 2,          // the version of the capabilities object itself
  "version": "0.12.79",        // the pi-rukas build version (extension/package.json)
  "commit": "abc1234…" | null, // the commit the build was made from; null when nothing records it
  "contracts": {
    "exitCodes": {
      "version": 1,             // the exit-code contract version
      "values": { "merged": 0, "handoff": 10, … }  // the full EXIT object
    },
    "resultSchema": {
      "version": 3,
      "caps": { "fixed": ["adversarial-infra-failure", …], "templates": [{ "prefix": "verify-failed:", "parameter": "step", "values": ["explore", …] }, …] },
      "failureKinds": ["provider", "timeout", "guard", "process", "verify", "environment", "driver", "cap"]
    },
    "ndjson": {
      "version": 1,
      "stable": { "version": 1, "kinds": { "step-started": ["step", "at", "round"], … } }
    }
  },
  "verbs": {
    "work": { "flags": ["--restart", "--continue-pr", "--json", "--timeout"] },
    "plan": { "flags": ["--dry-run", "--file", "--type", "--context", "--reviewed-digest", "--json"] },
    "research": { "flags": ["--tier", "--context", "--json"] },
    "agents-md": { "flags": ["--deep", "--json"] },
    "lens-review": { "flags": ["--base", "--head", "--since", "--full", "--context", "--pr", "--json"] }
  },
  "inputs": [                  // every PI_ENSEMBLE_* input this build or its wrapper reads
    { "name": "PI_ENSEMBLE_MAX_WORKSTREAMS", "type": "integer", "default": 6, "scope": "cycle" },
    { "name": "PI_ENSEMBLE_VERIFY_TIMEOUT_MS", "type": "duration-ms", "default": 600000, "scope": "cycle" },
    // #1509 — the develop-tier bound is now per tier; each reads its own knob,
    // then PI_ENSEMBLE_VERIFY_TIMEOUT_MS, then its `.pi/*-timeout-ms` file.
    { "name": "PI_ENSEMBLE_VERIFY_SUITE_TIMEOUT_MS", "type": "duration-ms", "default": 1800000, "scope": "cycle" },
    { "name": "PI_ENSEMBLE_VERIFY_FAST_TIMEOUT_MS", "type": "duration-ms", "default": 600000, "scope": "cycle" },
    { "name": "PI_ENSEMBLE_VERIFY_SMOKE_TIMEOUT_MS", "type": "duration-ms", "default": 600000, "scope": "cycle" },
    { "name": "PI_ENSEMBLE_MODEL_<ROLE>", "type": "string", "default": null, "scope": "cycle",
      "members": ["DEVELOPER", "OPS", "EXPLORE", "ADVERSARIAL_DEVELOPER", "CODE_REVIEW_SPECIALIST"] },
    { "name": "PI_ENSEMBLE_NO_SSH", "type": "boolean", "default": false, "scope": "wrapper" },
    { "name": "PI_ENSEMBLE_ISSUE_IMAGES", "type": "boolean", "default": true, "scope": "cycle", "manifestVersion": 1 },
    …
  ],
  "files": [                   // the .pi/* project files a cycle reads
    { "path": ".pi/verify-cmd", "kind": "command", "whenAbsent": "verify command derived from the repo" },
    …
  ],
  "features": {
    "resultFromMemory": true,   // #1189 — result from in-memory state, not the state file
    "cycleDeadline": true,      // #1238 — a cycle deadline that parks with a handoff
    "cycleDeadlineHandoffAllowance": true, // #1593 — the deadline bounds the step in flight
    "handoffChannel": true,     // #1327 — PI_ENSEMBLE_HANDOFF_CHANNEL=host
    "restartClearsAttention": true, // #1327 — --restart clears needs-human-attention
    "failureReason": true,      // #1367 — issues[].failure in the result
    "usageByRole": true,        // #1368 — issues[].usage.byRole in the result
    "continuePr": true          // #1468 — work --continue-pr and issues[].continuedPr
  },
  "resources": { … }            // #1325 — the host budget and limits; see Resource report
}
```

### Field descriptions

| Field | Source | Meaning |
|---|---|---|
| `schemaVersion` | `CAPABILITIES_VERSION` constant | Version of the capabilities object shape. Bump when the shape changes. Version 2 (#1326) gave each `inputs[]` entry a `type`, `default` and `scope`, dropped `readBy`, and added `files`. |
| `version` | `extension/package.json` `version` | The pi-rukas version of the build. |
| `commit` | `.pi/pi-rukas-commit` (baked by the image), else the pi-rukas checkout's HEAD | The git commit the build was made from. `null` when neither exists (e.g. an install copied without `.git`). |
| `contracts.exitCodes.version` | Named constant in `exit-code.ts` | Version of the exit-code contract. The 7 named values are stable within a version. |
| `contracts.exitCodes.values` | The `EXIT` object | The complete mapping of exit-code names to values. A caller can check for the presence of a named code. |
| `contracts.resultSchema.version` | Named constant in `result.ts` | Version of the `--json` result schema. |
| `contracts.resultSchema.caps` | `caps.ts` | Every value the result's `cap` can take (see "The `cap` vocabulary"). |
| `contracts.resultSchema.failureKinds` | `FAILURE_KINDS` (`failure.ts`) | Every value the result's `failure.kind` can take (see "The `failure` object"). |
| `contracts.ndjson.version` | `NDJSON_VERSION` | Version of the NDJSON progress schema. |
| `contracts.ndjson.stable` | `NDJSON_STABLE_VERSION`, `NDJSON_STABLE_FIELDS` | The stable kinds and their guaranteed `event` fields (see "The stable subset"). |
| `verbs.work.flags` | `WORK_FLAGS` array | The flags the `work` verb accepts, in the order the parser accepts them. An unknown flag in a caller's argv means "not supported" and is refused with exit 40. |
| `verbs.<subcommand>.flags` | `PLAN_FLAGS`, `RESEARCH_FLAGS`, `AGENTS_MD_FLAGS`, `LENS_REVIEW_FLAGS` | The flags each subcommand accepts (#1021). A subcommand absent from `verbs` is not in this build. |
| `inputs[].name` | `HEADLESS_INPUTS` (`inputs.ts`) | An environment variable the build reads. A name with `<ROLE>`, `<SEAM>` or `<LENS>` is a family: `<ROLE>` is a role name, `<SEAM>` a decision-seam id and `<LENS>` a code-review lens name, upper-cased with `-` → `_` (e.g. `PI_ENSEMBLE_MODEL_DEVELOPER`). |
| `inputs[].members` | The role list (`roles.ts`), the seam registry (`decision-seam-registry.ts`) and the bundled lens roster (`lens-roster.ts`) | Present on every family: the ids its placeholder takes in this build. A name with any other id, such as the typo `PI_ENSEMBLE_MODEL_REVIEWER`, is read by nothing and leaves the default in place. `<ROLE>` lists the spawned roles (the parent session has no per-role variable). `<SEAM>` lists the seams that read env config; the grandfathered policy judge does not. `<LENS>` lists the lenses shipped with the build; a lens added to the installed skills dir is not listed. Independent of `values`: `PI_ENSEMBLE_DECISION_MODE_<SEAM>` has both. |
| `inputs[].type` | Hardcoded | `boolean` (`1` on, `0` off), `integer`, `number` (see `unit`), `duration-ms`, `string`, `path`, `list` (joined by `separator`) or `enum` (one of `values`). |
| `inputs[].default` | Hardcoded; about 50 of them are checked against their live reader functions | The behaviour when the variable is unset. `null` means unset by default, with the fallback described in [configuration.md](configuration.md#environment-variables). |
| `inputs[].scope` | Hardcoded | Who sets it: `cycle` (changes what a cycle does), `sandbox` (the sandbox wrapper), `interactive` (the Pi UI only), `install` (path overrides), `wrapper` (read only by the `bin/pi-rukas` sandbox wrapper on the host, before the container starts; it has no effect on a cycle started without the wrapper, including `pi-rukas-headless` run directly), `internal` (pi-rukas sets it on its own children, or the wrapper on its container; a host must not), `test` (smoke tests only). |
| `inputs[].manifestVersion` | Hardcoded | Present on the two issue-image inputs: the manifest format version the build understands. |
| `files[]` | `HEADLESS_FILES` (`inputs.ts`) | The `.pi/*` files a cycle reads from the project (`path`, `kind`: `command` / `hook` / `config`, and what happens `whenAbsent`). Files the driver writes, such as `.pi/work-state/`, are state, not input, and are not listed. |
| `features.resultFromMemory` | Constant `true` | `true` when the result is taken from the driver's in-memory state rather than re-reading the state file (#1189). |
| `features.cycleDeadline` | Constant `true` | `true` when a cycle that hits its deadline parks with a handoff rather than being killed (#1238). |
| `features.cycleDeadlineHandoffAllowance` | Constant `true` | `true` when the deadline is where step work ends: children running at `PI_ENSEMBLE_CYCLE_DEADLINE` are stopped there, the handoff runs within `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS` after it, and a step that ended past the deadline records `deadline` as the cycle's cap (#1593). A host sets the deadline to its kill minus that allowance. |
| `features.handoffChannel` | Constant `true` | `true` when the build honours `PI_ENSEMBLE_HANDOFF_CHANNEL` and carries the handoff in the result (#1327). |
| `features.restartClearsAttention` | Constant `true` | `true` when `--restart` overrides the attention gate and clears `needs-human-attention` (#1327). See [`--restart` for hosts](#--restart-for-hosts). |
| `features.failureReason` | Constant `true` | `true` when the result carries `issues[].failure`, the reason behind its `cap` (#1367). |
| `features.usageByRole` | Constant `true` | `true` when the result's `usage` carries `byRole`, failed dispatches included (#1368). |
| `features.continuePr` | Constant `true` | `true` when `work` accepts `--continue-pr` and the result carries `issues[].continuedPr` (#1468). See [`--continue-pr` for hosts](#--continue-pr-for-hosts). |
| `resources` | `resourceReport()` (`resource-budget.ts`) | The host budget and the limits a cycle started now would run with, read when the answer is built. See [Resource report](#resource-report). |

### How a caller uses this

```bash
# Check before starting a cycle:
caps=$(pi-rukas-headless --capabilities)
for name in PI_ENSEMBLE_MAX_WORKSTREAMS PI_ENSEMBLE_VERIFY_TIMEOUT_MS; do
  echo "$caps" | jq -e --arg n "$name" 'any(.inputs[]; .name == $n)' >/dev/null \
    || { echo "This build does not read $name"; exit 1; }
done
echo "$caps" | jq -e '.features.cycleDeadline == true' \
  || { echo "This build has no cycle deadline"; exit 1; }
# A family member: refuse a role the build does not have.
echo "$caps" | jq -e --arg m "REVIEWER" \
  'any(.inputs[]; .name == "PI_ENSEMBLE_MODEL_<ROLE>" and (.members | index($m)))' >/dev/null \
  || { echo "PI_ENSEMBLE_MODEL_REVIEWER is not a role"; exit 1; }
```

An unknown name (no matching key in `features`, `inputs`, `files`, `verbs`, or a verb's `flags`) means the build does not support it. The caller fails closed — it does not guess or fall back.

### Baking the commit

The image publish workflow passes `GITHUB_SHA` as a build arg, and the Dockerfile bakes it into `.pi/pi-rukas-commit` under the install root, but only when it is a full 40-hex SHA. Without the marker, a pi-rukas git checkout reports its own HEAD (a root that only sits inside another repository does not). With neither, `commit` and the result's `buildCommit` are `null`; the version is always in `version` / `buildVersion`.

## Relationship to `docs/configuration.md`

`inputs` is the machine-readable list of every `PI_ENSEMBLE_*` variable read under `extension/src/` or by the sandbox wrapper; [configuration.md](configuration.md#environment-variables) is the human-readable description. `test-headless-inputs.ts` scans `src/` for env reads (property, index, destructuring and name-literal forms) and fails when a read is missing from `inputs` or an entry is no longer read. A key built at runtime (`` `PI_ENSEMBLE_MODEL_${role}` ``) must be on the test's explicit allowlist, which maps it to its family entry. The test also checks about 50 listed defaults (numeric, list and boolean) against their live reader functions; the others are checked only in review. A new input therefore has to be listed in `inputs.ts` and described in configuration.md in the same change.

Variables read only by the sandbox wrapper (`bin/pi-rukas` and the image entrypoint, e.g. `PI_ENSEMBLE_NO_DOCKER_SOCKET`, `PI_ENSEMBLE_NO_SSH`, `PI_ENSEMBLE_IMAGE_DIRS`) configure the sandbox launch, not the runner. They are listed with scope `wrapper`, so a host that fails closed can tell "the wrapper reads this" from "nothing reads this". `test-headless-inputs-wrapper.ts` scans those scripts for expansions (`$PI_ENSEMBLE_X`, `${PI_ENSEMBLE_X…}`) and fails when one is unlisted, when a `wrapper` entry is not read there or is also read in `src/`, or when a family's `members` drift from the list they are derived from.
