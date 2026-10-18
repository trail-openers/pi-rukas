/**
 * work-driver-prompts-plan — the Step 2 (plan) prompt builder.
 *
 * Split from work-driver-prompts-early.ts (AGENTS.md §12 500-line cap) when
 * #1322 added the plan-by-contract doctrine. Pure string template, no
 * `DriverContext`; work-driver-prompts-early.ts re-exports it so existing
 * importers keep their path.
 *
 * #1322 — the prompt asks for the change's CONTRACT, not just its files.
 * Every guard the driver has at plan time (path overlap, declared
 * `depends-on`, the basename grep in work-driver-plan-coupling.ts) looks at
 * the code as it is at the base commit, so a symbol the change itself
 * creates (a new field, a new export, a new event variant) is invisible to
 * all of them. Only the planner knows about those edges; the `introduces:` /
 * `consumes:` lines are how it tells the driver, which derives the
 * `depends-on` edge it would otherwise have had to guess
 * (work-driver-plan-contract.ts).
 */
import { scratchHygieneSection } from "./work-driver-prompts-late.ts";

/**
 * #1652 — how a workstream is reported, stated once and reused: the planner
 * prompt and the corrective steer (`correctivePlanSteer`,
 * work-driver-plan-steers.ts) both quote this text, so the two cannot disagree
 * about the channel. The channel is the tool call, not a markdown block (#819's
 * two-block ambiguity cannot arise through it).
 */
export const PLAN_WORKSTREAM_CALL_RULE =
  "Report EACH workstream with ONE `report_workstream` tool call — the tool calls are the plan, and prose is not read for workstreams. A call whose `id` repeats an earlier call in this reply is refused and adds nothing.";

/**
 * #819 round-2 — the coverage half of the same pair: the plan-to-spec gate
 * rejects a plan that leaves a deliverable no workstream claims, so the
 * planner is told the rule before it plans rather than after.
 */
export const PLAN_DELIVERABLE_PATH_RULE =
  "EVERY deliverable that declares `[paths: …]` in the spec must appear in at least one workstream's `paths:` line — a deliverable no workstream claims is a plan-to-spec rejection.";

/**
 * Step 2 (plan) prompt. PR3 (#1652: workstreams are `report_workstream` tool
 * calls, not a markdown block); single-workstream
 * issues return one `### default` entry (or zero, which the driver synthesises).
 */
export function inlinePlanPrompt(issues: number[], scratchDirAbs: string): string {
  const headline = issues.length === 1 ? `issue #${issues[0]}` : `issues #${issues.join(", #")}`;
  return [
    `/work ${headline} — Step 2 (Decomposition).`,
    "",
    `The driver has already cached ${issues.length === 1 ? "the issue body" : "each issue body"} and Step 1's explore report. Read ${issues.length === 1 ? "both" : "all of them"}, then work in this order:`,
    "",
    "  1. ENUMERATE the discrete findings first. Numbered items and checkboxes in the issue body are the default enumeration — one finding per item. Write the list out before you decide anything about workstreams.",
    "  2. ONE workstream is the default. Split only where you can show the work is genuinely independent, and for every extra workstream write one line saying why it is independent (`Split reason: <id> — <why it compiles and passes the gates without its siblings>`). No two workstreams may share a file, and NO workstream may have a compile or runtime dependency on another (a type change and every place that uses it is ONE workstream, not two — the consumer does not compile without the producer's commit). Shared files, shared symbols, or one half that cannot build without the other means ONE workstream. A single-file two-line fix is one workstream; that is fine.",
    "  3. PARTITION BY CONTRACT, NOT BY FILE. List the symbols the change CREATES (a new field on a shared type, a new export, a renamed function, a new event variant or union member) and where each is consumed. A change that threads one new value through a pipeline (classify → result → event → router → message) touches a different file at every hop, so a file-based split looks clean and is not: every hop needs the symbol the previous hop adds. That is ONE workstream.",
    '  4. If the issue names an existing commit or PR that already makes this change ("fixed in <repo>#N", "port <sha>", "cherry-pick PR #N"), plan ONE workstream whose scope is to apply that change (cherry-pick it) and resolve the conflicts. Do not re-derive it from prose in parallel — the original commit already has the coherence a split would lose.',
    "  5. Anything you deliberately are NOT doing goes under an explicit `Deferred:` line with a one-line reason. Silently dropping a finding is worse than deferring it.",
    "",
    "Why this matters: each workstream gets its own worktree and its own developer, and every workstream must pass the project's quality gates ALONE, applied to the base commit — a combined run that passes does not excuse a workstream that fails on its own. A workstream cannot see its siblings' commits, so a symbol introduced in one and used in another is a guess on both sides. Workstreams whose changes depend on each other are the dominant cause of a cycle failing to converge: one plan split a new type field and a new export from their consumers across four workstreams, the consumer failed the type check alone and the combined tree failed it again, while the same change as one commit applied cleanly. Decompose only where the halves can each stand alone.",
    "",
    "Return your enumeration and reasoning, then make the workstream calls (the channel rule is stated below). The tool's schema is the format: each call carries `id` (a short lowercase id), `scope` (one line), `paths` and `outOfScope`.",
    "",
    "Use short ids like `task-a`, `task-b` for N>1 workstreams. The `outOfScope` field is LOAD-BEARING — issue #553 polluted PR #556 with off-scope files because nothing told the developer what was OUT. Fence the scope explicitly even when you think it's obvious.",
    "",
    "The two list fields are different kinds of thing. `paths` is a list of plain repo-relative file paths (e.g. `src/foo.ts`) — nothing else: no globs, no `..`, no leading `/`, no annotations beyond a trailing `(new)`. `outOfScope` is FREE TEXT — short phrases or sentences naming what must not be touched (e.g. `the docs folder`, `the public API of foo`). The developer reads it. Only a file path written there is also enforced by the scope gate, so name a file by path when the fence must be mechanical.",
    "",
    "EVERY workstream MUST declare a non-empty `paths:`. The driver checks the committed diff against that list to prove each workstream's slice actually landed; an empty list silently disables that check for the slice. `paths` means files the developer is EXPECTED TO MODIFY: a file you list in `paths` but never edit (e.g. a shared or legacy test whose contract you keep green without touching it) counts as a missing slice at the consolidation gate and parks the cycle. Shared tests, legacy tests, or anything you deliberately keep green without editing go in `outOfScope` — that is what the outOfScope field is for.",
    "",
    PLAN_DELIVERABLE_PATH_RULE,
    PLAN_WORKSTREAM_CALL_RULE,
    "",
    "If single-workstream, ALWAYS use the id `default` so the driver routes through the same code path uniformly.",
    "",
    "Optional per-workstream fields (N>1 plans that declare workstream ORDERING, the change's contract, or integration coverage) — the same names as the tool's schema:",
    "",
    "  - `dependsOn` — the workstream id(s) this one builds on. The develop step defers this workstream's worktree until the referenced one commits, and sources it from that worktree's HEAD rather than the cycle's base. The graph must be a DAG: no workstream may depend on itself or on a chain that loops back to it. A reference to an undeclared id (or to a workstream folded away by the ceiling) is a plan-quality rejection.",
    '  - `introduces` — the symbols this workstream CREATES that do not exist at the base commit (new fields, exports, functions, types, variants), as a list, e.g. `["providerRepeats", "isFinalProviderFault"]`.',
    "  - `consumes` — the symbols this workstream USES that do not exist at the base commit. Symbols that already exist need not be listed. When a workstream consumes a symbol a sibling introduces, the driver records a `depends-on` edge for it and merges the two into one workstream — so declare the contract honestly rather than splitting around it. Over N>1 workstreams, declare both lines on every workstream whose change adds or uses a new symbol.",
    "",
    "Cross-declaration contract for N>1 workstreams: put every sibling workstream's `paths` files in your own `outOfScope` list (and keep the contract symmetric). The driver's plan-quality gate rejects two workstreams claiming the same file, and the develop scope fence honours the cross-declaration — a `dependsOn` workstream is exempted from its sibling's files for exactly that reason. Do not rely on the exemption for paths your workstream genuinely needs to edit; if two workstreams both need to edit a file, that is one workstream, not two.",
    "  - `integrationTest` — the consolidated-tree test path that exercises this workstream TOGETHER with the workstream(s) it depends on. REQUIRED (plan-quality rejection otherwise) when two workstreams are interdependent through DIFFERENT files — i.e. one declares `dependsOn: [<other>]` with a disjoint file set, or one's test file exercises the other's file. The line is a DECLARATION only: the develop step does not execute it; it exists so the plan records that integration coverage was required.",
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}
