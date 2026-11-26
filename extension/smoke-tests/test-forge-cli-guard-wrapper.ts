/**
 * forge-read-cli-answer.ts — the one refusal text of the #2638 forge rule, and the
 * `gh`/`glab` stub that answers a non-ops child with it.
 *
 * Two halves, both mechanical:
 *
 *   A — ONE exported constant owns the sentence (`forge-read-refusal.ts`), the
 *       guard and the wrapper both print it, and its route clause is conditional
 *       on whether THAT child was given `forge_read` (decision 11).
 *   B — the wrapper is a real executable on a real PATH. Each row runs it the way
 *       a shell would and asserts the wrapper's OWN string on stderr with a
 *       non-zero exit — never anything a real CLI printed (decision 1: the field
 *       report's "Unauthenticated" is not a requirement, and no CLI in this repo
 *       prints that word).
 *
 * The ops arm is the load-bearing negative: the role that keeps its login must
 * gain NO stub directory at all, so `ops` reaches the real CLI. A builder that
 * handed ops a refusing stub would break the one role that lands work and still
 * pass every refusal row above it.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FORGE_CLI_GUARD_DIR,
  FORGE_CLI_GUARD_REASON_ENV,
  FORGE_CLI_GUARD_SWITCH,
  forgeCliGuardEnv,
  forgeCliGuardScript,
} from "../src/forge-cli-guard-wrapper.ts";
import {
  FORGE_READ_NO_BROKER,
  FORGE_READ_ROUTE,
  FORGE_READ_RULE,
  forgeReadRefusalText,
  roleKeepsForgeLogin,
} from "../src/forge-read-refusal.ts";
import { assert, exit } from "./lib/assert-rig.ts";
import { withEnv } from "./lib/env-scope.ts";

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-2638-cli-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ───────────────────────────── A — one constant, two voices, conditional route

{
  const withTool = forgeReadRefusalText(true);
  const withoutTool = forgeReadRefusalText(false);
  assert(
    withTool.includes(FORGE_READ_RULE),
    "A: the refusal names the rule (forge access is not available to this role)",
  );
  assert(
    withTool.includes(FORGE_READ_ROUTE) && withTool.includes("forge_read"),
    "A: with forge_read available, the refusal names the sanctioned route",
  );
  assert(
    !withoutTool.includes("Read through forge_read") && withoutTool.includes(FORGE_READ_NO_BROKER),
    "A: with no parent broker, the refusal names the broker's absence as its own reason (never offers a tool the child lacks)",
  );
  assert(withoutTool.includes("ops"), "A: the no-broker arm names the ops role as the route");
  assert(
    FORGE_READ_RULE === "forge access is not available to this role",
    "A: the rule sentence is the exported constant, spelled exactly once in src/",
  );
  const src = readFileSync("src/forge-read-refusal.ts", "utf8");
  assert(
    (src.match(/forge access is not available to this role/g) ?? []).length === 1,
    "A: the sentence appears once in its owning module (a second spelling in a second file is the drift this constant exists to prevent)",
  );
}

// ───────────────────────────────────── B — the wrapper answers on a real PATH

/** Run one stub the way the child's shell would: `sh -lc 'gh …'` with PATH pinned. */
function runStub(
  bin: string,
  cli: string,
  argv: string[],
  env: Record<string, string | undefined>,
): { status: number | null; stderr: string; stdout: string } {
  const res = spawnSync("/bin/sh", ["-c", `${cli} ${argv.join(" ")}`], {
    encoding: "utf8",
    env: { PATH: bin, ...env },
  });
  return { status: res.status, stderr: res.stderr, stdout: res.stdout };
}

for (const cli of ["gh", "glab"]) {
  const dir = scratch();
  const reason = forgeReadRefusalText(true);
  const built = forgeCliGuardEnv("developer", dir, reason);
  assert(
    Object.keys(built).length === 2 && built.PATH !== undefined,
    `B/${cli}: the builder returns exactly the reason env and the PATH prefix (got ${JSON.stringify(Object.keys(built))})`,
  );
  assert(
    (built.PATH ?? "").startsWith(path.join(dir, FORGE_CLI_GUARD_DIR)) &&
      (built.PATH ?? "").includes(path.delimiter),
    `B/${cli}: the stub dir is FIRST on the child's PATH, which still carries what the parent had (got ${JSON.stringify((built.PATH ?? "").slice(0, 60))})`,
  );
  const stubPath = path.join(dir, FORGE_CLI_GUARD_DIR, cli);
  assert(existsSync(stubPath), `B/${cli}: ${FORGE_CLI_GUARD_DIR}/${cli} exists`);
  assert(
    readFileSync(stubPath, "utf8") === forgeCliGuardScript(FORGE_CLI_GUARD_REASON_ENV, cli),
    `B/${cli}: the stub holds no prose of its own — it prints the reason the harness handed down`,
  );
  // Three shapes of the same call: a read subcommand, an auth subcommand, no args.
  for (const argv of [["auth", "status"], ["issue", "view", "1"], []]) {
    const r = runStub(built.PATH as string, cli, argv, { [FORGE_CLI_GUARD_REASON_ENV]: reason });
    assert(
      r.status !== null && r.status !== 0,
      `B/${cli}: \`${cli} ${argv.join(" ")}\` exits non-zero (got ${r.status})`,
    );
    assert(
      r.stderr.includes(FORGE_READ_RULE),
      `B/${cli}: \`${cli} ${argv.join(" ")}\` prints the WRAPPER's own refusal on stderr (${JSON.stringify(r.stderr.slice(0, 90))})`,
    );
    assert(
      r.stdout === "",
      `B/${cli}: the refusal goes to stderr, not stdout (got ${JSON.stringify(r.stdout.slice(0, 60))})`,
    );
  }
  // The fallback arm: an invocation whose env carries no reason still refuses.
  const noReason = runStub(built.PATH as string, cli, ["pr", "merge", "1"], {
    [FORGE_CLI_GUARD_REASON_ENV]: undefined,
  });
  assert(
    noReason.status !== null && noReason.status !== 0 && noReason.stderr.includes(FORGE_READ_RULE),
    `B/${cli}: without the reason env the stub still refuses with the same rule (no path to the real CLI)`,
  );
  // The stub never execs a CLI: a `gh` on the real PATH behind it must not run.
  const behind = path.join(dir, "real-bin");
  mkdirSync(behind, { recursive: true });
  const marker = path.join(dir, "real-cli-ran");
  const fake = `#!/bin/sh\ntouch ${marker}\nprintf 'real CLI output\\n' >&2\nexit 0\n`;
  const { writeFileSync, chmodSync } = await import("node:fs");
  writeFileSync(path.join(behind, cli), fake, { mode: 0o755 });
  chmodSync(path.join(behind, cli), 0o755);
  const shadowed = runStub(`${built.PATH}:${behind}`, cli, ["auth", "status"], {
    [FORGE_CLI_GUARD_REASON_ENV]: reason,
  });
  assert(
    !existsSync(marker) && shadowed.status !== 0,
    `B/${cli}: a real ${cli} later on PATH never runs — the stub answers first and execs nothing`,
  );
}

// ─────────────────────────── C — ops is exempt: the builder adds nothing at all

{
  const dir = scratch();
  const built = forgeCliGuardEnv("ops", dir, forgeReadRefusalText(true));
  assert(
    Object.keys(built).length === 0,
    `C: an ops child gets NO stub dir and no PATH change (got ${JSON.stringify(built)}) — it keeps the real CLI`,
  );
  assert(
    !existsSync(path.join(dir, FORGE_CLI_GUARD_DIR)),
    "C: the stub directory is not even created for ops",
  );
}

// ───────────────── D — the operator's escape hatch restores the real CLI byte for byte

await withEnv({ [FORGE_CLI_GUARD_SWITCH]: "0" }, async () => {
  const dir = scratch();
  const built = forgeCliGuardEnv("developer", dir, "x");
  assert(
    Object.keys(built).length === 0,
    `D: ${FORGE_CLI_GUARD_SWITCH}=0 → no prefix, no reason env (got ${JSON.stringify(built)})`,
  );
});

// ─────────────────────────────── E — the role predicate fails closed (decision 12)

assert(roleKeepsForgeLogin("ops") === true, "E: ops keeps its login and is exempt");
assert(
  roleKeepsForgeLogin("OPS") === true,
  "E: the exemption is case-insensitive like the strip's",
);
assert(roleKeepsForgeLogin(undefined) === false, "E: an ABSENT role is not exempt (fails closed)");
assert(roleKeepsForgeLogin("") === false, "E: an empty role is not exempt");
assert(roleKeepsForgeLogin("developer") === false, "E: developer is not exempt");
assert(roleKeepsForgeLogin("strange-role") === false, "E: an unrecognised role is not exempt");

console.log(`\nexit ${exit}`);
process.exit(exit);
