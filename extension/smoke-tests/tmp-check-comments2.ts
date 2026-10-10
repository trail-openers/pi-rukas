import { execp } from "../src/lens-exec.ts";

// Check if the PR_HEAD comment lines exist in the working tree
const r = await execp(`grep -n "shape-checks headSha" smoke-tests/test-merge-guard-round-cap.ts`, { cwd: ".", timeout: 10_000, maxBuffer: 1024 });
console.log("Working tree:", r.stdout.trim());

// Check if it exists at HEAD
const h = await execp(`git grep -e "shape-checks headSha" HEAD -- smoke-tests/test-merge-guard-round-cap.ts`, { cwd: "..", timeout: 10_000, maxBuffer: 1024 });
console.log("At HEAD:", h.stdout.trim() || "(not found)");

// Check if it exists at origin/main
const m = await execp(`git grep -e "shape-checks headSha" origin/main -- smoke-tests/test-merge-guard-round-cap.ts`, { cwd: "..", timeout: 10_000, maxBuffer: 1024 });
console.log("At origin/main:", m.stdout.trim() || "(not found)");
process.exit(0);
