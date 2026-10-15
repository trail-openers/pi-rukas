# Headless runner

`pi-rukas-headless` runs `/work` cycles without an interactive Pi session. It is invoked as:

```
pi-rukas-headless work <issue> [more issues] [--restart] [--timeout <minutes>] [--json]
pi-rukas-headless --capabilities
```

- **`work`** — runs one or more work cycles, writes NDJSON v1 progress to stderr, and exits with a code derived from the state file.
- **`--capabilities`** — prints one versioned JSON object describing what *this* build supports and exits 0. It starts no cycle, reads no repository, and makes no network call.

A caller (e.g. orchard) calls `--capabilities` once per image build and once before each cycle. An unknown name in the object means "not supported"; the caller fails closed on it.

## The four contracts

The headless runner's contract with its caller is four independent surfaces, each versioned:

| Contract | Version constant | Module | Description |
|---|---|---|---|
| Exit codes | `EXIT` object (`exit-code.ts`) | `extension/src/headless/exit-code.ts` | The process exit code. 7 named values: `merged` (0), `handoff` (10), `clarification` (11), `aborted` (20), `interrupted` (21), `crash` (30), `refused` (40). |
| `--json` result schema | `RESULT_SCHEMA_VERSION` | `extension/src/headless/result.ts` | The JSON document on stdout when `--json` is used. One `HeadlessRunResult` object with `exitCode`, `issues[]` (each with `issue`, `status`, `stateFile`, `durationMs`, `steps`, `exitCode`), and an optional `error`. |
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
  "schemaVersion": 2,          // the version of the capabilities object itself
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
  "inputs": [                  // every PI_ENSEMBLE_* input this build reads
    { "name": "PI_ENSEMBLE_MAX_WORKSTREAMS", "type": "integer", "default": 6, "scope": "cycle" },
    { "name": "PI_ENSEMBLE_VERIFY_TIMEOUT_MS", "type": "duration-ms", "default": 600000, "scope": "cycle" },
    { "name": "PI_ENSEMBLE_MODEL_<ROLE>", "type": "string", "default": null, "scope": "cycle" },
    { "name": "PI_ENSEMBLE_ISSUE_IMAGES", "type": "boolean", "default": true, "scope": "cycle", "manifestVersion": 1 },
    …
  ],
  "files": [                   // the .pi/* project files a cycle reads
    { "path": ".pi/verify-cmd", "kind": "command", "whenAbsent": "verify command derived from the repo" },
    …
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
| `schemaVersion` | `CAPABILITIES_VERSION` constant | Version of the capabilities object shape. Bump when the shape changes. Version 2 (#1326) gave each `inputs[]` entry a `type`, `default` and `scope`, dropped `readBy`, and added `files`. |
| `version` | `extension/package.json` `version` | The pi-rukas version of the build. |
| `commit` | `.pi/pi-rukas-commit` (baked by `install.sh` / the image) | The git commit the build was made from. `null` when the checkout has no baked marker (e.g. a bare worktree or dev tree). |
| `contracts.exitCodes.version` | Named constant in `exit-code.ts` | Version of the exit-code contract. The 7 named values are stable within a version. |
| `contracts.exitCodes.values` | The `EXIT` object | The complete mapping of exit-code names to values. A caller can check for the presence of a named code. |
| `contracts.resultSchema.version` | Named constant in `result.ts` | Version of the `--json` result schema. |
| `contracts.ndjson.version` | `NDJSON_VERSION` | Version of the NDJSON progress schema. |
| `verbs.work.flags` | `WORK_FLAGS` array | The flags the `work` verb accepts, in the order the parser accepts them. An unknown flag in a caller's argv means "not supported" and is refused with exit 40. |
| `inputs[].name` | `HEADLESS_INPUTS` (`inputs.ts`) | An environment variable the build reads. A name with `<ROLE>` or `<SEAM>` is a family: `<ROLE>` is a role name and `<SEAM>` a decision-seam id, upper-cased with `-` → `_` (e.g. `PI_ENSEMBLE_MODEL_DEVELOPER`). |
| `inputs[].type` | Hardcoded | `boolean` (`1` on, `0` off), `integer`, `number` (see `unit`), `duration-ms`, `string`, `path`, `list` (joined by `separator`) or `enum` (one of `values`). |
| `inputs[].default` | Hardcoded; about 50 of them are checked against their live reader functions | The behaviour when the variable is unset. `null` means unset by default, with the fallback described in [configuration.md](configuration.md#environment-variables). |
| `inputs[].scope` | Hardcoded | Who sets it: `cycle` (changes what a cycle does), `sandbox` (the sandbox wrapper), `interactive` (the Pi UI only), `install` (path overrides), `internal` (pi-rukas sets it on its own children; a host must not), `test` (smoke tests only). |
| `inputs[].manifestVersion` | Hardcoded | Present on the two issue-image inputs: the manifest format version the build understands. |
| `files[]` | `HEADLESS_FILES` (`inputs.ts`) | The `.pi/*` files a cycle reads from the project (`path`, `kind`: `command` / `hook` / `config`, and what happens `whenAbsent`). Files the driver writes, such as `.pi/work-state/`, are state, not input, and are not listed. |
| `features.resultFromMemory` | Constant `true` | `true` when the result is taken from the driver's in-memory state rather than re-reading the state file (#1189). |
| `features.cycleDeadline` | Constant `true` | `true` when a cycle that hits its deadline parks with a handoff rather than being killed (#1238). |

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
```

An unknown name (no matching key in `features`, `inputs`, `files`, or `verbs.work.flags`) means the build does not support it. The caller fails closed — it does not guess or fall back.

### Baking the commit

`install.sh` and the Docker image build bake the current commit SHA into `.pi/pi-rukas-commit` (one line, no trailing newline). The `commit` field is `null` when the file is absent or empty — a developer's bare worktree or a fresh `git clone` without a build step reports `null`. This is correct: there is no build to report.

## Relationship to `docs/configuration.md`

`inputs` is the machine-readable list of every `PI_ENSEMBLE_*` variable read under `extension/src/`; [configuration.md](configuration.md#environment-variables) is the human-readable description. `test-headless-inputs.ts` scans `src/` for env reads (property, index, destructuring and name-literal forms) and fails when a read is missing from `inputs` or an entry is no longer read. A key built at runtime (`` `PI_ENSEMBLE_MODEL_${role}` ``) must be on the test's explicit allowlist, which maps it to its family entry. The test also checks about 50 listed defaults (numeric, list and boolean) against their live reader functions; the others are checked only in review. A new input therefore has to be listed in `inputs.ts` and described in configuration.md in the same change.

Variables read only by the shell wrappers in `bin/` (e.g. `PI_ENSEMBLE_HOST_ALIASES`, `PI_ENSEMBLE_IMAGE_DIRS`) configure the sandbox launch, not the runner, and are not listed.
