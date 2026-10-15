#!/usr/bin/env bun
/**
 * #1326 — the headless host contract: a host can act on a result without the
 * state file or pi-rukas source.
 *
 *   - the published `cap` vocabulary covers every cap the state validator knows
 *   - the result projects `failedStep`, summed `usage`, `resumable` and a typed `cap`
 *   - the --json document carries `schemaVersion` 2 and `buildCommit`
 *   - `buildCommit` resolves from the baked marker, the install checkout, or the release
 *   - `prUrl` is built for GitHub and GitLab remotes only
 *   - NDJSON marks every kind outside the stable subset `unstable: true`
 *
 * Offline: temp directories only, and one `--capabilities` run of the CLI.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readBuildCommit, readBuildVersion } from "../src/headless/build.ts";
import { buildCapabilities } from "../src/headless/capabilities.ts";
import { FIXED_CAPS, capStep, capVocabulary } from "../src/headless/caps.ts";
import { createHeadlessHost } from "../src/headless/host.ts";
import {
  NDJSON_KINDS,
  NDJSON_STABLE_KINDS,
  NDJSON_STABLE_VERSION,
  validateNdjsonLine,
} from "../src/headless/ndjson.ts";
import { formatPrUrl, prUrlFromComment } from "../src/headless/pr-url.ts";
import { RESULT_SCHEMA_VERSION, projectIssue, resultDocument } from "../src/headless/result.ts";
import type { WorkEvent } from "../src/workflow-state-events.ts";
import { WORK_STEPS } from "../src/workflow-state-schema.ts";
import { CAP_HIT_FIXED_LITERALS } from "../src/workflow-state-validate-caps.ts";
import { type WorkState, appendEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── The cap vocabulary.
{
  const fixed = FIXED_CAPS as readonly string[];
  const unknown = CAP_HIT_FIXED_LITERALS.filter((c) => !fixed.includes(c as string));
  assert(unknown.length === 0, `every validator cap literal is published (${unknown.join(", ")})`);
  assert(new Set(fixed).size === fixed.length, "published caps are unique");
  assert(JSON.stringify([...fixed].sort()) === JSON.stringify(fixed), "published caps are sorted");
  const vocab = capVocabulary();
  const verify = vocab.templates.find((t) => t.prefix === "verify-failed:");
  assert(
    JSON.stringify(verify?.values) === JSON.stringify(WORK_STEPS),
    "verify-failed: is a template over every step",
  );
  assert(
    vocab.templates.some((t) => t.prefix === "branch-ahead:" && t.parameter === "count"),
    "branch-ahead: is a template over a count",
  );
  const caps = buildCapabilities();
  assert(
    JSON.stringify(caps.contracts.resultSchema.caps) === JSON.stringify(vocab),
    "--capabilities publishes the cap vocabulary",
  );
  assert(caps.contracts.resultSchema.version === RESULT_SCHEMA_VERSION, "result schema version");
  assert(RESULT_SCHEMA_VERSION === 3, "the result schema version is bumped to 3");
  assert(capStep("verify-failed:develop") === "develop", "capStep reads a step template");
  assert(capStep("verify-timeout:develop") === "develop", "verify-timeout: is a step template");
  assert(fixed.includes("deadline"), "the cycle-deadline cap is published");
  assert(capStep("branch-ahead:3") === undefined, "capStep ignores a count template");
  assert(capStep("fence-violation:develop") === undefined, "capStep ignores a fixed literal");
}

// ── Result projection.
function build(events: WorkEvent[], status: WorkState["pipelineState"]["status"]): WorkState {
  let s = initialState(7);
  for (const e of events) s = appendEvent(s, e);
  return { ...s, pipelineState: { ...s.pipelineState, status, branchName: "feat/x" } };
}
const usage = (n: number) => ({
  input: n,
  output: 1,
  cacheRead: 2,
  cacheWrite: 0,
  cost: 0.5,
  turns: 3,
});
const dispatch = (at: number, n: number): WorkEvent => ({
  kind: "dispatch-completed",
  step: "develop",
  role: "developer",
  jobId: `j${at}`,
  label: "developer",
  ok: true,
  ms: 10,
  at,
  usage: usage(n),
});
const capHit = (cap: string, at: number): WorkEvent =>
  ({ kind: "cap-hit", cap, at, reviewRound: 1, nextStep: "handoff" }) as WorkEvent;
{
  const s = build(
    [
      { kind: "step-started", step: "plan", at: 1 },
      { kind: "step-started", step: "develop", at: 2 },
      dispatch(3, 100),
      dispatch(4, 50),
      capHit("verify-failed:develop", 5),
      { kind: "step-started", step: "handoff", at: 6 },
    ],
    "handoff",
  );
  const r = projectIssue(s, "/tmp/7.json");
  assert(r.cap === "verify-failed:develop", "cap is the last cap hit");
  assert(r.failedStep === "develop", "failedStep comes from a step-template cap");
  assert(r.branch === "feat/x", "branch is projected");
  assert(
    r.usage?.input === 150 && r.usage.turns === 6 && r.usage.cost === 1 && r.usage.dispatches === 2,
    "usage is summed over every dispatch",
  );
  assert(r.resumable === false, "a handoff is not resumable");
}
{
  const s = build(
    [
      { kind: "step-started", step: "lens-review", at: 1 },
      capHit("round-cap", 2),
      { kind: "step-started", step: "handoff", at: 3 },
    ],
    "handoff",
  );
  assert(
    projectIssue(s, "f").failedStep === "lens-review",
    "failedStep is the step started before a fixed cap, not handoff",
  );
}
{
  const s = build(
    [
      { kind: "step-started", step: "ci", at: 1 },
      { kind: "interrupted", at: 2, reason: "signal" },
    ],
    "interrupted",
  );
  const r = projectIssue(s, "f");
  assert(r.resumable === true && r.failedStep === "ci", "an interrupted cycle is resumable at ci");
  const saved = process.env.PI_ENSEMBLE_RESUME;
  process.env.PI_ENSEMBLE_RESUME = "0";
  try {
    assert(projectIssue(s, "f").resumable === false, "PI_ENSEMBLE_RESUME=0: nothing is resumable");
  } finally {
    if (saved === undefined) delete process.env.PI_ENSEMBLE_RESUME;
    else process.env.PI_ENSEMBLE_RESUME = saved;
  }
  assert(r.usage?.dispatches === 0, "a cycle with no dispatch sums to zero");
}
{
  const s = build(
    [
      { kind: "step-started", step: "ci", at: 1 },
      { kind: "merged", at: 2, prNumber: 9 },
    ],
    "merged",
  );
  const r = projectIssue(s, "f");
  assert(r.failedStep === undefined && r.resumable === false, "a merge has no failedStep");
  assert(r.prNumber === 9, "prNumber comes from the merged event");
}

// ── The --json document.
{
  const doc = resultDocument({ exitCode: 0, results: [] }, { commit: null, version: "1.0.0" });
  assert(
    doc.schemaVersion === 3 &&
      doc.buildCommit === null &&
      doc.buildVersion === "1.0.0" &&
      !("error" in doc),
    "the document carries schemaVersion, buildCommit (SHA or null) and buildVersion",
  );
  const withErr = resultDocument(
    { exitCode: 30, results: [], error: { code: "state-diverged", message: "m" } },
    { commit: null, version: "x" },
  );
  assert(withErr.error?.code === "state-diverged", "a runner error is kept");
}

// ── buildCommit.
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pi-build-"));
  try {
    const root = path.join(tmp, "install");
    mkdirSync(path.join(root, "extension"), { recursive: true });
    writeFileSync(path.join(root, "extension", "package.json"), '{"version":"9.9.9"}');
    // Inside a git repository that is not the install root itself.
    execFileSync("git", ["init", "-q", tmp]);
    execFileSync("git", [
      "-C",
      tmp,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    ]);
    assert(readBuildCommit(root) === null, "a parent repository's HEAD is not reported");
    assert(readBuildVersion(path.join(root, "extension", "package.json")) === "9.9.9", "version");
    mkdirSync(path.join(root, ".pi"));
    writeFileSync(path.join(root, ".pi", "pi-rukas-commit"), "deadbeef\n");
    assert(readBuildCommit(root) === null, "a marker that is not a 40-hex SHA is ignored");
    const sha = "0123456789abcdef0123456789abcdef01234567";
    writeFileSync(path.join(root, ".pi", "pi-rukas-commit"), `${sha}\n`);
    assert(readBuildCommit(root) === sha, "the baked marker wins");
    const head = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert(readBuildCommit(tmp) === head, "an install root that is a checkout reports its HEAD");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const out = execFileSync(
    "bun",
    [path.resolve(import.meta.dirname, "../src/headless/cli.ts"), "--capabilities"],
    {
      encoding: "utf8",
    },
  );
  const caps = JSON.parse(out) as { commit: string | null; schemaVersion: number };
  assert(
    caps.commit === readBuildCommit(),
    `--capabilities reports this checkout's commit (${caps.commit})`,
  );
}

// ── The image path: the Dockerfile's own bake step, fed the build arg the
// publish workflow passes, writes a marker readBuildCommit accepts.
{
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const docker = readFileSync(path.join(repoRoot, ".devcontainer", "Dockerfile"), "utf8");
  const workflow = readFileSync(
    path.join(repoRoot, ".github", "workflows", "publish-image.yml"),
    "utf8",
  );
  assert(
    /build-args: \|\s*\n\s*GITHUB_SHA=\$\{\{ github\.sha \}\}/.test(workflow),
    "publish-image.yml passes GITHUB_SHA as a build arg",
  );
  const lines = docker.split("\n");
  const argAt = lines.findIndex((l) => /^ARG GITHUB_SHA\b/.test(l));
  const runAt = lines.findIndex((l) => l.startsWith("RUN") && l.includes("GITHUB_SHA"));
  assert(
    argAt >= 0 && runAt > argAt,
    "the Dockerfile declares ARG GITHUB_SHA before the bake step",
  );
  let body = "";
  for (let i = runAt; i < lines.length; i++) {
    const l = lines[i] as string;
    // Docker joins a `\`-continued line to the next with no newline.
    body += l.replace(/\\$/, "");
    if (!l.endsWith("\\")) break;
  }
  body = body.replace(/^RUN /, "");
  const bake = (sha: string): string | null => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pi-bake-"));
    try {
      execFileSync("bash", ["-c", body], {
        env: { ...process.env, GITHUB_SHA: sha, PI_ENSEMBLE_DIR: dir },
      });
      return readBuildCommit(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const sha = "89abcdef0123456789abcdef0123456789abcdef";
  assert(bake(sha) === sha, "the image bake step writes a commit the build reports");
  assert(bake("") === null, "no build arg bakes nothing");
  assert(bake("v1.2.3") === null, "a non-SHA build arg bakes nothing");
}

// ── prUrl: only when unambiguous.
{
  const cases: [string, string, string | undefined][] = [
    ["github", "git@github.com:o/r.git", "https://github.com/o/r/pull/5"],
    ["github", "ssh://git@github.com:22/o/r.git", "https://github.com/o/r/pull/5"],
    ["github", "https://ghe.example.com:8443/o/r", "https://ghe.example.com:8443/o/r/pull/5"],
    ["github", "https://github.com/o/r/extra", undefined],
    [
      "gitlab",
      "https://gitlab.example.com/g/sub/p.git",
      "https://gitlab.example.com/g/sub/p/-/merge_requests/5",
    ],
    ["gitlab", "git@gitlab.com:g/sub/p.git", "https://gitlab.com/g/sub/p/-/merge_requests/5"],
    // An ssh alias host (or a self-hosted ssh host) has no certain web address.
    ["github", "git@github-work:o/r.git", undefined],
    ["gitlab", "ssh://git@gitlab.example.com:2222/g/p.git", undefined],
    ["gitlab", "https://gitlab.example.com/g/../p", undefined],
    ["unknown", "https://x.example/o/r", undefined],
  ];
  for (const [forge, remote, want] of cases) {
    const got = formatPrUrl(forge, remote, 5);
    assert(got === want, `${forge} ${remote} → ${want ?? "no URL"} (${got ?? "none"})`);
  }
  assert(
    prUrlFromComment("https://github.com/o/r/pull/5#issuecomment-1", 5) ===
      "https://github.com/o/r/pull/5",
    "a recorded PR comment URL yields the PR URL",
  );
  assert(
    prUrlFromComment("https://github.com/o/r/pull/6#issuecomment-1", 5) === undefined,
    "a comment on another PR is not used",
  );
  const s = build(
    [
      { kind: "merged", at: 1, prNumber: 5 },
      {
        kind: "handoff-emitted",
        at: 2,
        labelApplied: true,
        targetType: "pr",
        targetNumber: 5,
        commentUrl: "https://gitlab.example.com/a/b/c/-/merge_requests/5#note_9",
      } as WorkEvent,
    ],
    "merged",
  );
  assert(
    projectIssue(s, "f").prUrl === "https://gitlab.example.com/a/b/c/-/merge_requests/5",
    "the result prefers the PR URL the driver recorded",
  );
}

// ── NDJSON stable subset.
{
  assert(NDJSON_STABLE_VERSION === 1, "the stable subset has its own version");
  assert(
    NDJSON_STABLE_KINDS.every((k) => NDJSON_KINDS.includes(k)),
    "every stable kind is an NDJSON kind",
  );
  const lines: string[] = [];
  const host = createHeadlessHost(7, (l) => lines.push(l));
  host.emit({ kind: "step-started", step: "plan", at: 1 }, 0);
  host.emit({ kind: "lens-approved", at: 2 }, 1);
  host.sendUserMessage("hi");
  const [stable, internal, log] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  assert(stable?.unstable === undefined, "a stable kind is not marked");
  assert(internal?.unstable === true, "a kind outside the subset is marked unstable");
  assert(log?.unstable === undefined, "a log line is stable");
  assert(
    [stable, internal, log].every((l) => validateNdjsonLine(l).length === 0),
    "every marked line validates",
  );
  const now = new Date().toISOString();
  assert(
    validateNdjsonLine({ v: 1, kind: "log", at: now, unstable: true }).length > 0,
    "a stable kind marked unstable is rejected",
  );
}

process.exit(exit);
