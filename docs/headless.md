# Headless runner

`pi-rukas-headless` runs `/work` cycles without an interactive Pi session. It is invoked as:

```
pi-rukas-headless work <issue> [more issues] [--restart] [--timeout <minutes>] [--json]
pi-rukas-headless --capabilities
```

- **`work`** — runs one or more work cycles, writes NDJSON v1 progress to stderr, and exits with a code derived from the state file.
- **`--capabilities`** — prints one versioned JSON object describing what *this* build supports and exits 0. It starts no cycle, reads no repository, and makes no network call.

A caller (e.g. tehas) calls `--capabilities` once per image build and once before each cycle. An unknown name in the object means "not supported"; the caller fails closed on it.

## The four contracts

The headless runner's contract with its caller is four independent surfaces, each versioned:

| Contract | Version constant | Module | Description |
|---|---|---|---|
| Exit codes | `EXIT` object (`exit-code.ts`) | `extension/src/headless/exit-code.ts` | The process exit code. 7 named values: `merged` (0), `handoff` (10), `clarification` (11), `aborted` (20), `interrupted` (21), `crash` (30), `refused` (40). |
| `--json` result schema | `HEADLESS_RESULT_VERSION` | `extension/src/headless/result.ts` | The JSON document on stdout when `--json` is used. One `HeadlessRunResult` object with `exitCode`, `issues[]` (each with `issue`, `status`, `stateFile`, `durationMs`, `steps`, `exitCode`), and an optional `error`. |
| NDJSON progress | `NDJSON_VERSION` (1) | `extension/src/headless/ndjson.ts` | One JSON object per line on stderr. Every line carries `v` (1), `kind`, `at` (ISO-8601). Driver event lines additionally carry `issue` and `key` (idempotency key `<issue>:<index>:<at>`). Kinds: all `WorkEvent` kinds plus `log` and `pi-resolved`. |
| Capabilities | `CAPABILITIES_VERSION` (1) | `extension/src/headless/capabilities.ts` | The JSON object `--capabilities` prints. See below. |

### Exit codes

| Code | Name | Meaning |
|---|---|---|
| 0 | `merged` | Merged, or completed with nothing to merge |
| 10 | `handoff` | Handoff for any cap other than the clarification caps, or awaiting-human-merge |
| 11 | `clarification` | Handoff whose cap is `intent-park` or `explore-needs-clarification` |
| 20 | `aborted` | Aborted |
| 21 | `interrupted` | Interrupted by a signal (SIGINT/SIGTERM) |
| 30 | `crash` | The driver threw, or interrupted by the runner's own `--timeout`, or a cycle left running after the driver returned |
| 40 | `refused` | Refused to start (claimed by a live cycle, `needs-human-attention` without `--restart`, bad arguments, unknown flag) |

A grouped run exits 21 if any issue was interrupted, otherwise the highest per-issue code. The `--json` result carries every issue regardless.

### `--json` result schema

With `--json`, stdout carries exactly one JSON document:

```json
{
  "exitCode": 10,
  "issues": [
    {
      "issue": 42,
      "status": "handoff",
      "cap": "round-cap",
      "branch": "feature/issue-42-foo",
      "prNumber": 99,
      "stateFile": "/path/to/.pi/work-state/42.json",
      "durationMs": 42000,
      "steps": [
        { "step": "explore", "startedAt": "…", "endedAt": "…" },
        { "step": "plan",    "startedAt": "…", "endedAt": "…" }
      ],
      "exitCode": 10
    }
  ]
}
```

An optional top-level `error` (`{ code, message }`) is present when the runner detected a divergence (e.g. `state-diverged`) or another runner-level failure.

### NDJSON progress (v1)

One JSON object per line on stderr. Fields:

| Field | Type | Present | Description |
|---|---|---|---|
| `v` | `number` | always | Always `1` |
| `kind` | `string` | always | One of the `WorkEvent` kinds, or `log`, or `pi-resolved` |
| `at` | `string` | always | ISO-8601 timestamp |
| `issue` | `number` | when the line belongs to one issue | The issue number |
| `key` | `string` | on driver event lines | Idempotency key `<issue>:<index>:<at>` — a resumed cycle re-emits its prior event log, so a consumer dedupes on `key` |
| `event` | `object` | on driver event lines | The WorkEvent itself (its own `kind` would collide with the envelope's) |
| `message` | `string` | on `log` lines | The log message |

The full set of valid `kind` values is exported as `NDJSON_KINDS` (= `KNOWN_EVENT_KINDS` + `log` + `pi-resolved`).

## `--capabilities` answer

`pi-rukas-headless --capabilities` prints one JSON object to stdout and exits 0. The object describes what **this specific build** of pi-rukas-headless supports.

### Schema

```
{
  "schemaVersion": 1,          // the version of the capabilities object itself
  "version": "0.12.79",        // the pi-rukas build version (extension/package.json)
  "commit": "abc1234…" | null, // the baked commit; null when not baked (bare worktree)
  "contracts": {
    "exitCodes": {
      "version": 1,             // the exit-code contract version
      "values": { "merged": 0, "handoff": 10, … }  // the full EXIT object
    },
    "resultSchema": { "version": 1 },
    "ndjson": { "version": 1 }
  },
  "verbs": {
    "work": { "flags": ["--restart", "--json", "--timeout"] }
  },
  "inputs": [
    {
      "name": "PI_ENSEMBLE_EXTRA_IMAGE_DIRS",
      "readBy": "explore,plan",
      "manifestVersion": 1
    },
    {
      "name": "PI_ENSEMBLE_ISSUE_IMAGES",
      "readBy": "explore,plan",
      "manifestVersion": 1
    }
  ],
  "features": {
    "resultFromMemory": true,   // #1189 — result from in-memory state, not the state file
    "cycleDeadline": true       // #1238 — a cycle deadline that parks with a handoff
  }
}
```

### Field descriptions

| Field | Source | Meaning |
|---|---|---|
| `schemaVersion` | `CAPABILITIES_VERSION` constant | Version of the capabilities object shape. Bump when the top-level shape changes. A caller that knows `schemaVersion: 1` can parse this object; a future `schemaVersion: 2` with a new field is a caller-visible change. |
| `version` | `extension/package.json` `version` | The pi-rukas version of the build. |
| `commit` | `.pi/pi-rukas-commit` (baked by `install.sh` / the image) | The git commit the build was made from. `null` when the checkout has no baked marker (e.g. a bare worktree or dev tree). |
| `contracts.exitCodes.version` | Named constant in `exit-code.ts` | Version of the exit-code contract. The 7 named values are stable within a version. |
| `contracts.exitCodes.values` | The `EXIT` object | The complete mapping of exit-code names to values. A caller can check for the presence of a named code. |
| `contracts.resultSchema.version` | Named constant in `result.ts` | Version of the `--json` result schema. |
| `contracts.ndjson.version` | `NDJSON_VERSION` | Version of the NDJSON progress schema. |
| `verbs.work.flags` | `WORK_FLAGS` array | The flags the `work` verb accepts, in the order the parser accepts them. An unknown flag in a caller's argv means "not supported" and is refused with exit 40. |
| `inputs[].name` | Hardcoded in `capabilities.ts` | The environment variable name the runner reads. A caller that passes an env var not listed here means "not read by this build" and should fail closed. |
| `inputs[].readBy` | Hardcoded | The comma-separated list of steps that receive the input (e.g. `explore,plan`). |
| `inputs[].manifestVersion` | Hardcoded | The manifest format version the runner understands. |
| `features.resultFromMemory` | Constant `true` | `true` when the result is taken from the driver's in-memory state rather than re-reading the state file (#1189). |
| `features.cycleDeadline` | Constant `true` | `true` when a cycle that hits its deadline parks with a handoff rather than being killed (#1238). |

### How a caller uses this

```bash
# Check before starting a cycle:
caps=$(pi-rukas-headless --capabilities)
echo "$caps" | jq -e '.inputs[].name == "PI_ENSEMBLE_EXTRA_IMAGE_DIRS"' \
  || { echo "This build does not read PI_ENSEMBLE_EXTRA_IMAGE_DIRS"; exit 1; }
echo "$caps" | jq -e '.features.cycleDeadline == true' \
  || { echo "This build has no cycle deadline"; exit 1; }
```

An unknown name (no matching key in `features`, `inputs`, or `verbs.work.flags`) means the build does not support it. The caller fails closed — it does not guess or fall back.

### Baking the commit

`install.sh` and the Docker image build bake the current commit SHA into `.pi/pi-rukas-commit` (one line, no trailing newline). The `commit` field is `null` when the file is absent or empty — a developer's bare worktree or a fresh `git clone` without a build step reports `null`. This is correct: there is no build to report.

## Relationship to `docs/configuration.md`

The inputs listed in the capabilities answer (`PI_ENSEMBLE_EXTRA_IMAGE_DIRS`, `PI_ENSEMBLE_ISSUE_IMAGES`) are documented in [configuration.md](configuration.md#environment-variables). The capabilities answer is the machine-readable form; the documentation table is the human-readable form. Both must agree — the drift test (`test-headless-capabilities.ts`) re-derives the capabilities answer from the live constants and fails when they diverge.
