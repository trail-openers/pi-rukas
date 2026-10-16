/**
 * test-forge-labels.ts — the label family of the forge adapter (#1377).
 *
 * `start_plan_driver` gained caller-supplied labels, and the rule the driver
 * enforces is check-then-refuse: a label must exist on the repo BEFORE the
 * issue is created (so an auto-filed ticket is distinguishable from the first
 * moment, with no follow-up `gh issue edit` window), and a missing label is
 * NEVER created as a filing side effect. The whole check rests on two adapter
 * primitives, and both have a failure mode that would silently invert the rule:
 *
 *   - `parseLabelNames` — a CLI that does not answer with a JSON array must
 *     THROW. Returning `[]` there would report "no labels exist", turn every
 *     caller's labels into "missing", and refuse legitimate filings. The one
 *     honest `[]` is the CLIs' real empty answer (`No labels found` / empty).
 *   - `labelFlags`/`issueCreateCmd` — labels are one argv element each. A name
 *     may legally contain a space and a colon, and this seam is a shell string,
 *     so an unquoted label would split into extra argv elements.
 *
 * Run: cd extension && bun run smoke-tests/test-forge-labels.ts
 */
import {
  issueCreateCmd,
  labelAddCmd,
  labelCreateCmd,
  labelFlags,
  labelListCmd,
} from "../src/forge-commands.ts";
import { labelOps } from "../src/forge-label-ops.ts";
import { parseLabelNames } from "../src/forge-labels.ts";

let exitCode = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok: ${name}`))
    .catch((e) => {
      console.error(`  FAIL: ${name} — ${e?.message ?? e}`);
      exitCode = 1;
    });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** A `run` seam that answers each command from a table and records what was asked. */
function runStub(table: Record<string, string>) {
  const seen: string[] = [];
  const run = <T>(cmd: string, map: (stdout: string) => T): Promise<T> => {
    seen.push(cmd);
    if (!(cmd in table)) return Promise.reject(new Error(`unexpected command: ${cmd}`));
    return Promise.resolve(map(table[cmd] ?? ""));
  };
  return { run, seen };
}

async function main() {
  console.log("parseLabelNames:");

  await check("github: a JSON array of {name} rows yields the names", () => {
    const out = parseLabelNames('[{"name":"bug"},{"name":"kind: bug"}]', "github");
    assert(
      JSON.stringify(out) === JSON.stringify(["bug", "kind: bug"]),
      `got ${JSON.stringify(out)}`,
    );
  });

  await check("gitlab: extra fields (id/color/description) are ignored", () => {
    const out = parseLabelNames('[{"id":1,"name":"auto-filed","color":"#fff"}]', "gitlab");
    assert(JSON.stringify(out) === '["auto-filed"]', `got ${JSON.stringify(out)}`);
  });

  await check("the CLIs' real empty answers are [] not an error", () => {
    assert(JSON.stringify(parseLabelNames("", "github")) === "[]", "empty stdout");
    assert(JSON.stringify(parseLabelNames("  \n", "github")) === "[]", "whitespace stdout");
    assert(
      JSON.stringify(parseLabelNames("No labels found", "github")) === "[]",
      "the plain-text 'No labels found' line",
    );
    assert(
      JSON.stringify(parseLabelNames("no labels found", "gitlab")) === "[]",
      "lower-case variant",
    );
  });

  await check("an EMPTY JSON array is [] (not a throw)", () => {
    assert(JSON.stringify(parseLabelNames("[]", "github")) === "[]", "got a throw");
  });

  await check("non-JSON stdout THROWS — it is never read as 'no labels exist'", () => {
    for (const bad of ["not json", "gh: HTTP 401 (bad credentials)", "<html>502</html>"]) {
      let threw = false;
      try {
        parseLabelNames(bad, "github");
      } catch (err) {
        threw = true;
        assert(
          /did not return JSON/.test(String((err as Error).message)),
          `the throw names the cause: ${(err as Error).message}`,
        );
      }
      assert(threw, `"${bad}" must throw, not report an empty label set`);
    }
  });

  await check("a JSON non-array THROWS (an object is not a label set)", () => {
    for (const bad of ['{"name":"bug"}', "null", "42", '"bug"']) {
      let threw = false;
      try {
        parseLabelNames(bad, "gitlab");
      } catch (err) {
        threw = true;
        assert(/not an array/.test(String((err as Error).message)), `message: ${err}`);
      }
      assert(threw, `${bad} must throw`);
    }
  });

  await check("rows without a usable name are skipped, never an empty-string label", () => {
    const out = parseLabelNames('[{"name":"bug"},{"name":""},{"name":null},{},{"x":1}]', "github");
    assert(JSON.stringify(out) === '["bug"]', `got ${JSON.stringify(out)}`);
  });

  await check("the throw names the forge so a mixed-forge repo is diagnosable", () => {
    try {
      parseLabelNames("oops", "gitlab");
      assert(false, "expected a throw");
    } catch (err) {
      assert(/gitlab/.test(String((err as Error).message)), String((err as Error).message));
    }
  });

  console.log("labelFlags / issueCreateCmd:");

  // `shq` quotes only what needs it (existing forge-commands behaviour, matched
  // by the title/body quoting these commands already use), so the assertions
  // are behavioural: a name containing a space must be ONE argv element, and
  // one flag per label / one comma-joined flag is the per-forge shape.
  await check("github: one --label flag per label, each a single argv element", () => {
    const flags = labelFlags("github", ["auto-filed", "kind: bug"]);
    // One flag per label; the values are everything after each `--label `.
    const parts = flags
      .trim()
      .split("--label ")
      .slice(1)
      .map((x) => x.trim());
    assert(parts.length === 2, `two flags, got ${parts.length}: ${flags}`);
    assert(parts[0] === "auto-filed", `simple name unquoted (shq): ${parts[0]}`);
    assert(parts[1] === "'kind: bug'", `the spaced name is quoted whole: ${parts[1]}`);
  });

  await check("gitlab: ONE comma-joined --label flag", () => {
    const flags = labelFlags("gitlab", ["auto-filed", "kind: bug"]);
    assert(
      flags.trim().startsWith("--label ") && flags.trim().split("--label").length === 2,
      `exactly one flag: ${flags}`,
    );
    assert(flags.includes("auto-filed,'kind: bug'"), `comma-joined: ${flags}`);
  });

  await check("no labels → the flag is absent entirely (argv unchanged)", () => {
    assert(labelFlags("github", []) === "", "github");
    assert(labelFlags("gitlab", []) === "", "gitlab");
  });

  await check("a label is quoted as ONE element: spaces and ':' survive", () => {
    const cmd = issueCreateCmd("github", "T", "/tmp/b.md", ["kind: bug", "p0"]);
    assert(cmd.includes("--label 'kind: bug'"), `the space stayed inside one element: ${cmd}`);
    assert(cmd.includes("--label p0"), `the second label rides the same call: ${cmd}`);
  });

  await check("a shell-metacharacter label cannot escape its quoting", () => {
    // The plan layer refuses such a name long before here (LABEL_RE admits no
    // quote or semicolon). This asserts the argv seam would still quote it
    // whole rather than emit a splittable argument.
    const cmd = issueCreateCmd("github", "T", "/tmp/b.md", ["a'; echo pwned"]);
    assert(cmd.includes("'a'\\''; echo pwned'"), `the quote is escaped, not closed: ${cmd}`);
    assert(cmd.startsWith("gh issue create --title T"), `prefix intact: ${cmd}`);
  });

  await check("the label flags come AFTER title and body-file, one call", () => {
    const cmd = issueCreateCmd("github", "T", "/tmp/b.md", ["a"]);
    assert(
      cmd.indexOf("--body-file") < cmd.indexOf("--label"),
      `--label appended after the body file: ${cmd}`,
    );
    assert(!/;\s*gh /.test(cmd), `the create is a single command, not a create-then-edit: ${cmd}`);
    assert(!/issue edit/.test(cmd), `no follow-up edit smuggled in: ${cmd}`);
  });

  await check("no labels → the create command is byte-identical to before #1377", () => {
    const withDefault = issueCreateCmd("github", "T", "/tmp/b.md");
    const withEmpty = issueCreateCmd("github", "T", "/tmp/b.md", []);
    assert(withDefault === withEmpty, "the optional arg changes nothing when empty");
    assert(!withDefault.includes("--label"), `no label flag leaked: ${withDefault}`);
  });

  console.log("labelListCmd + labelOps:");

  await check("the list read is one unchained command per forge", () => {
    const gh = labelListCmd("github");
    const gl = labelListCmd("gitlab");
    assert(gh === "gh label list --limit 500 --json name", `got ${gh}`);
    assert(gl === "glab label list --per-page 100 --output json", `got ${gl}`);
    for (const cmd of [gh, gl]) {
      assert(!/[;&|`$<>]/.test(cmd), `the #408 single-command rule (no chains): ${cmd}`);
    }
  });

  await check("Forge.labelList runs the list command and parses it", async () => {
    const { run, seen } = runStub({ [labelListCmd("github")]: '[{"name":"auto-filed"}]' });
    const ops = labelOps({ forge: "github", run });
    const names = await ops.labelList();
    assert(JSON.stringify(names) === '["auto-filed"]', `got ${JSON.stringify(names)}`);
    assert(seen.length === 1 && seen[0] === labelListCmd("github"), `one call: ${seen}`);
  });

  await check("a failing list read propagates — it is a halt, not an empty set", async () => {
    const { run } = runStub({});
    const ops = labelOps({ forge: "github", run });
    let threw = false;
    try {
      await ops.labelList();
    } catch {
      threw = true;
    }
    assert(threw, "the CLI failure must reach the caller (which reports 'could not read')");
  });

  await check("labelCreate: gh's 'true' on --force is not a label row", async () => {
    const cmd = labelCreateCmd("github", "x", "ffffff");
    const { run } = runStub({ [cmd]: "true" });
    const ops = labelOps({ forge: "github", run });
    assert((await ops.labelCreate("x", "ffffff")) === undefined, "got a row from 'true'");
  });

  await check("labelAdd maps the mr→pr subcommand (#775 shape)", async () => {
    const cmd = labelAddCmd("github", "mr", 7, "auto-filed");
    assert(cmd === "gh pr edit 7 --add-label auto-filed", `pr not mr: ${cmd}`);
    const { run, seen } = runStub({ [cmd]: "" });
    const ops = labelOps({ forge: "github", run });
    await ops.labelAdd("mr", 7, "auto-filed");
    assert(seen[0] === cmd, `got ${seen[0]}`);
    assert(
      labelAddCmd("github", "issue", 7, "a").startsWith("gh issue edit 7"),
      "issue stays issue",
    );
  });

  console.log(`\n${exitCode === 0 ? "PASS" : "FAIL"} test-forge-labels`);
  process.exit(exitCode);
}

await main();
