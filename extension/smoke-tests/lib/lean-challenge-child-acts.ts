/**
 * lean-challenge-child-acts — the adversary child's declarations, shared by the challenge
 * fixtures and the #2660 site tests. The child's `submit_tests` call and the red/green edge
 * test bodies it writes are the same bytes in every case that arms the step with a child;
 * they live here so the fixture module stays the step driver and not the child's script.
 */

/** A test the adversary wrote that FAILS against the current head. */
export function redEdge(rel: string): string {
  return [
    "#!/bin/sh",
    `echo "not ok - ${rel}" 1>&2`,
    'echo "assertion failed: retry gave up on the second transient failure" 1>&2',
    "exit 1",
    "",
  ].join("\n");
}

/** A test the adversary wrote that PASSES against the current head. */
export function greenEdge(rel: string): string {
  return ["#!/bin/sh", `echo "ok - ${rel}"`, "exit 0", ""].join("\n");
}

/** The child declared these files for this criterion. */
export function submit(criterionId: string, testFiles: string[]): unknown {
  return { name: "submit_tests", arguments: { criterionId, testFiles } };
}
