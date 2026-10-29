/**
 * lean/verify — the PR-body half of the `command` criteria tier.
 *
 * Split out of `test-lean-verify-command-criteria.ts`, whose subject is the GATE.
 * These cases are about what the record a gate writes becomes in the PR body: a
 * criterion the gate ran is the only thing that may print `passed (command)`, and
 * a criterion it declined prints its OWN reason on its OWN row — because an
 * operator reading a blank cell has to know whether to fix the issue or repair the
 * tree. A gate that recorded one shared reason for three declined criteria would
 * answer that question for one of them and mislead the reader about the other two.
 */

import type { PublishBodyInput } from "../src/lean/publish-body.ts";
import { commandBody, resultCellOf } from "./lib/lean-verify-command-body.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

// --------------------------- (e) only the gate's own record licenses "passed"
{
  const body = commandBody({ commandCriteria: ["AC2"] });
  assert(
    body.includes("| passed (command) |"),
    "(e) a command the gate ran reads passed (command)",
  );
  assert(
    body.includes("| not executed (command) |"),
    "(e) a command with no reason recorded says it was not executed, and nothing more",
  );
  // Each declined command prints its OWN reason on its OWN row: a single shared
  // reason would tell the operator to fix one thing while two are broken.
  const explained = commandBody({
    commandCriteria: ["AC2"],
    commandNotRunnable: {
      AC3: "tests/link.test.sh is a symlink",
      AC4: "rm -rf / is not a plain repo-relative file path",
    },
    draft: true,
  });
  assert(
    resultCellOf(explained, "AC3") === "not executed (command): tests/link.test.sh is a symlink",
    `(e) the symlinked criterion explains itself on its own row (${resultCellOf(explained, "AC3")})`,
  );
  assert(
    resultCellOf(explained, "AC4") ===
      "not executed (command): rm -rf / is not a plain repo-relative file path",
    `(e) the shell-shaped criterion explains itself on its own row, separately (${resultCellOf(explained, "AC4")})`,
  );
  assert(
    resultCellOf(explained, "AC2") === "passed (command)",
    "(e) declined commands do not silence the record of the one that ran",
  );
  assert(
    resultCellOf(explained, "AC1") === "green",
    "(e) a test criterion is still coloured by the gate's verdict",
  );
  assert(
    resultCellOf(body, "AC3") === "not executed (command)",
    "(e) with no reason recorded the cell says not executed, and nothing more",
  );
  assert(
    !body.includes("| command | `tests/AC2-preserve.test.sh` | green |"),
    "(e) a command row never borrows the gate's overall verdict",
  );
  assert(
    !commandBody({ draft: true }).includes("passed (command)"),
    "(e) with no verify record at all, no command row claims it passed",
  );
  // The map is addressed by criterion id all the way through: a renderer that
  // printed the first reason on every blank row would pass a substring assertion
  // and fail this one.
  const swapped = commandBody({
    commandNotRunnable: {
      AC3: "tests/link.test.sh is a symlink",
      AC4: "tests/gone.test.sh changed since base",
    },
  });
  assert(
    resultCellOf(swapped, "AC3") === "not executed (command): tests/link.test.sh is a symlink" &&
      resultCellOf(swapped, "AC4") === "not executed (command): tests/gone.test.sh changed since base",
    "(e) reasons cannot trade rows — each id prints the reason recorded for it",
  );
}

// ---------------- (e3) the record publish hands the renderer is per criterion too
//
// `publish` reads the gate's map off the step log and passes it straight through.
// A field widened or narrowed on the way (a string where the record holds a map,
// or ids flattened into one reason) is a type error here, and a silent drop is a
// failed assertion below.
{
  const fromGate: PublishBodyInput["commandNotRunnable"] = {
    AC3: "tests/link.test.sh is a symlink",
  };
  const body = commandBody({ commandCriteria: ["AC2"], commandNotRunnable: fromGate });
  assert(
    resultCellOf(body, "AC3") === "not executed (command): tests/link.test.sh is a symlink",
    "(e3) the record publish forwards reaches the row verbatim",
  );
  assert(
    resultCellOf(body, "AC4") === "not executed (command)",
    "(e3) a criterion the gate gave no reason for is not given someone else's",
  );
}

process.exit(failures());
