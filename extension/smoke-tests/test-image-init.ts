#!/usr/bin/env bun
/**
 * #1256 — the sandbox image must not run `pi` as PID 1.
 *
 * Node never reaps a process it did not spawn. With pi as PID 1 every
 * orphaned process (a gate's children after the gate is killed at its
 * timeout) stays a zombie and keeps its pid; a pid-limited container then
 * cannot fork for the rest of the cycle. The image's ENTRYPOINT therefore
 * starts with an init (tini) that reaps them.
 *
 * #1370 — and it runs with -s, so it still reaps (and stays quiet) when a
 * host's `docker run --init` makes another init PID 1.
 *
 * Static gate over .devcontainer/Dockerfile, proven in both directions with
 * inline fixtures (a gate never observed to fail is worthless).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const DOCKERFILE = path.resolve(import.meta.dirname, "..", "..", ".devcontainer", "Dockerfile");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The last exec-form ENTRYPOINT's argv, or undefined (comments skipped). */
export function entrypointArgv(dockerfile: string): string[] | undefined {
  let argv: string[] | undefined;
  for (const line of dockerfile.split("\n")) {
    const m = /^ENTRYPOINT\s+(\[.*\])\s*$/.exec(line.trim());
    if (!m) continue;
    try {
      argv = JSON.parse(m[1]) as string[];
    } catch {
      argv = undefined;
    }
  }
  return argv;
}

/** True when the image's PID 1 is tini and tini is installed by the image. */
export function imageHasInit(dockerfile: string): boolean {
  const argv = entrypointArgv(dockerfile);
  const installed = dockerfile
    .split("\n")
    .some((l) => !l.trim().startsWith("#") && /(^|\s)tini(\s|\\|$)/.test(l));
  return argv !== undefined && path.basename(argv[0] ?? "") === "tini" && installed;
}

assert(
  !imageHasInit('RUN apt-get install -y git\nENTRYPOINT ["/usr/local/bin/pi-rukas-entrypoint"]\n'),
  "canary: an entrypoint that runs the command as PID 1 is caught",
);
assert(
  !imageHasInit('RUN apt-get install -y git\nENTRYPOINT ["/usr/bin/tini", "--", "/ep"]\n'),
  "canary: a tini entrypoint without tini installed is caught",
);
assert(
  imageHasInit(
    'RUN apt-get install -y \\\n      tini \\\n   && true\nENTRYPOINT ["/usr/bin/tini", "--", "/ep"]\n',
  ),
  "canary: tini installed and first in the entrypoint passes",
);

const real = readFileSync(DOCKERFILE, "utf8");
const argv = entrypointArgv(real);
assert(
  imageHasInit(real),
  `the image's PID 1 is an init that reaps orphans (ENTRYPOINT ${JSON.stringify(argv)})`,
);
assert(
  argv?.[argv.length - 2] === "--" &&
    argv?.[argv.length - 1] === "/usr/local/bin/pi-rukas-entrypoint",
  "the init hands over to the pi-rukas entrypoint",
);
// #1370 — under `docker run --init` tini is not PID 1. Without -s it then
// cannot reap and prints a plain-text warning onto the headless NDJSON stderr.
assert(
  argv?.slice(1, -2).includes("-s") === true,
  "tini runs as a subreaper (-s), so a host's --init neither breaks reaping nor prints a warning",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
