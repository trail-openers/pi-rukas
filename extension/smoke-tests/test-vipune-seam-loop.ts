#!/usr/bin/env bun
/**
 * The memory loop end to end: what the driver writes, and what a developer
 * brief can see of it (#1103).
 *
 * The doctrine is one sentence — a driver candidate influences nothing until
 * an operator promotes it — and two defects broke it. The brief read
 * candidates (`--include-candidates`), so every automatic write reached a
 * developer prompt the moment it landed; and driver rows were typed `guard`,
 * which `vipune prune` never demotes, so an unpromoted row could never age out.
 *
 * The stubbed half asserts on argv through every driver path at once.
 * Reachability from the driver is `test-seams-wired.ts`'s job.
 *
 * The binary half writes through the real vipune into a mkdtemp'd database
 * (`--db-path`, never ~/.vipune) and proves the exclusion against the store
 * itself: the candidate exists, is typed `observation`, and the brief is
 * silent about it. It is skipped when vipune is absent unless
 * `PI_ENSEMBLE_VIPUNE_REQUIRED=1`, when it fails.
 *
 * Doctrine once cited this as `test-vipune-seam-live.ts`. It spawns no Pi
 * child, so the `-live` suffix would exclude it from the offline gate (#944).
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { defaultVipuneWrite } from "../src/guard-memory-write.ts";
import { buildMemoryBrief } from "../src/memory-brief.ts";
import { writeFindings } from "../src/memory-write.ts";
import type { VipuneOpts } from "../src/vipune.ts";

const execFileAsync = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const META = { src: "pi-rukas", issue: 1103, kind: "lens-finding" } as const;

// ------------------------------------------------- offline: argv, always

{
  const calls: string[][] = [];
  const execFn = async (_f: string, args: string[]) => {
    calls.push(args);
    const stdout =
      args[0] === "add"
        ? JSON.stringify({ status: "added", id: `id-${calls.length}` })
        : JSON.stringify({ results: [] });
    return { stdout, stderr: "" };
  };
  await writeFindings(
    [{ path: "src/spawn-probe.ts", title: "stdin closes early", severity: "MEDIUM" }],
    META,
    { cwd: "/r", execFn },
  );
  await defaultVipuneWrite("[invariant-removal] spawn-probe.ts: constraint x", {
    cwd: "/r",
    issue: 1103,
    execFn,
  });
  await buildMemoryBrief(["src/spawn-probe.ts"], { cwd: "/r", execFn });

  const adds = calls.filter((c) => c[0] === "add").map((c) => c.join(" "));
  const searches = calls.filter((c) => c[0] === "search");
  assert(adds.length === 2, `both driver write paths reach the seam (${adds.length})`);
  assert(
    adds.every((c) => c.includes("--memory-type observation") && c.includes("--status candidate")),
    "every driver write is an observation-typed candidate",
  );
  assert(!adds.some((c) => c.includes("guard")), "...never a guard, which prune cannot age out");
  assert(searches.length > 0, `the brief searches (${searches.length} queries)`);
  assert(
    searches.every((c) => !c.includes("--include-candidates")),
    "the brief reads ACTIVE rows only",
  );
  assert(
    searches.every((c) => c.at(-2) === "--"),
    "...with `--` immediately before the query",
  );
  assert(!calls.some((c) => c.includes("--force")), "nothing passes --force");
}

// ------------------------------- the real binary, hermetic, when present

const haveVipune = await execFileAsync("sh", ["-c", "command -v vipune"])
  .then(() => true)
  .catch(() => false);

if (!haveVipune) {
  const required = process.env.PI_ENSEMBLE_VIPUNE_REQUIRED === "1";
  console.log(
    required ? "✗ vipune absent and REQUIRED" : "… vipune absent — skipping the binary half",
  );
  if (required) exit = 1;
} else {
  const dir = mkdtempSync(path.join(tmpdir(), "vipune-seam-loop-"));
  const base = ["--db-path", path.join(dir, "m.db"), "--project", "hermetic-seam"];
  const opts: VipuneOpts = {
    cwd: dir,
    timeoutMs: 20_000,
    execFn: (file, args, o) =>
      execFileAsync(file, [...base, ...args], o).then((x) => ({
        stdout: String(x.stdout),
        stderr: String(x.stderr),
      })),
  };
  try {
    const written = await writeFindings(
      [{ path: "src/spawn-probe.ts", title: "stdin closes early", severity: "MEDIUM" }],
      META,
      opts,
    );
    assert(written[0]?.outcome === "written", `the driver write lands (${written[0]?.outcome})`);

    const { stdout } = await execFileAsync("vipune", [
      ...base,
      "search",
      "--hybrid",
      "--recency",
      "0.0",
      "--no-touch",
      "--json",
      "--include-candidates",
      "--",
      "spawn-probe.ts",
    ]);
    const row = (
      JSON.parse(stdout) as {
        results: Array<{ id: string; memory_type?: string; status?: string }>;
      }
    ).results.find((r) => r.id === written[0]?.id);
    assert(row !== undefined, "the candidate IS in the store (the exclusion below is not vacuous)");
    assert(
      row?.memory_type === "observation" && row?.status === "candidate",
      `...stored as an observation candidate (${row?.memory_type}/${row?.status})`,
    );

    const brief = await buildMemoryBrief(["src/spawn-probe.ts"], opts);
    assert(
      brief.emptyBrief && !brief.hits.some((h) => h.id === written[0]?.id),
      "the brief is silent about an unpromoted candidate",
    );

    // Positive control: the exclusion above is only meaningful if the same row
    // IS returned once an operator promotes it. Status-only update — never -t.
    const id = written[0]?.id;
    if (id === undefined) throw new Error("driver write returned no id");
    await execFileAsync("vipune", [...base, "update", id, "--status", "active"]);
    const promoted = await buildMemoryBrief(["src/spawn-probe.ts"], opts);
    assert(
      promoted.hits.some((h) => h.id === id),
      "positive control: once promoted to active, the brief returns the same row",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
