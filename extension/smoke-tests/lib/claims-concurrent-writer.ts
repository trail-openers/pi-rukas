/**
 * #1454 r2 — the child entry point for the concurrent-claim-writers test.
 *
 * Lives in `lib/` beside the other test helpers so `test-seams-wired.ts` sees
 * it. It is deliberately a SEPARATE PROCESS (the parent spawns `bun run` on
 * this file): the thing under test is a cross-process `O_EXCL` lock, and an
 * in-process race cannot distinguish that lock from a promise chain.
 *
 * `PI_ENSEMBLE_TEST_CLAIMS_LOCK_BLOCKED=1` makes the lock unreachable, which
 * is how the test proves its own assertion can fail: without the lock the
 * lost update must become observable again.
 *
 * The third argument is a barrier file: the child spins until it appears, so
 * all writers enter `registerClaim` at once instead of being serialised by
 * process startup — a "concurrent" test whose children never actually overlap
 * proves nothing.
 */
import { existsSync } from "node:fs";
import { registerClaim } from "../../src/work-driver-path-claims.ts";

const [repoRoot, issueRaw, gateFile] = process.argv.slice(2);
if (!repoRoot || !issueRaw) {
  process.stderr.write("usage: claims-concurrent-writer.ts <repoRoot> <issue> [gateFile]\n");
  process.exit(2);
}
const issue = Number(issueRaw);
if (!Number.isInteger(issue)) {
  process.stderr.write(`issue must be an integer, got ${issueRaw}\n`);
  process.exit(2);
}

if (gateFile) {
  const deadline = Date.now() + 30_000;
  while (!existsSync(gateFile)) {
    if (Date.now() > deadline) {
      process.stderr.write("gate file never appeared\n");
      process.exit(3);
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

await registerClaim(repoRoot, issue, [`src/claimed-${issue}.ts`]);
