#!/usr/bin/env bun
/**
 * GitLab MR creation must be built from flags `glab` actually has, and the body
 * must reach the CLI as one argv element rather than as text inside a shell
 * string.
 *
 * `glab mr create` has no `--output` and no positional source branch on any
 * version; `--description-file` exists from 1.115.0 and is refused on older
 * builds. The builder emitted all three, so every GitLab PR-create step died on
 * `Unknown flag:` before a network call on every version (on 1.89.0 at the
 * invented flags, on 1.115.0+ at `--output`), and the plain URL that a real
 * create prints on success was never read — the mapper applied a JSON parse to
 * stdout that only ever carries a URL. The fixed command uses the inline `-d`,
 * which every version lists.
 *
 * Pinned here: the argv itself, the body's route to it, the URL-shaped reply,
 * the refusals that must happen BEFORE any exec, and the switch that puts the
 * old command back. The flags themselves are judged against real `glab --help`
 * output by `test-glab-flags.ts`.
 */

import { createForge, forgeCommands } from "../src/forge.ts";
import path from "node:path";
import { shq } from "../src/forge-commands.ts";
import type { ForgeExecFn } from "../src/forge-types.ts";
import { glDetection, GL_MR } from "./forge-fixtures.ts";
import { withEnv } from "./lib/env-scope.ts";

let exit = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

interface Call {
  cmd: string;
  argv?: string[];
}

/** Records every exec call — the command string AND the argv, if one was given. */
function recorder(stdout: string): { fn: ForgeExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const fn: ForgeExecFn = async (cmd, opts) => {
    calls.push({ cmd, argv: opts?.argv });
    return { stdout };
  };
  return { fn, calls };
}

const TITLE = "feat(glab): create the merge request";
const BRANCH = "feature/issue-2342-glab-mr-create";
const BODY = "## Summary\n\n- a body with 'quotes', \"doubles\" and $(not-a-subshell)\n";
const MR_URL = "https://gitlab.com/acme/widget/-/merge_requests/17\n";

const MR_FLAGS = new Set([
  "-s",
  "--source-branch",
  "-b",
  "--target-branch",
  "-t",
  "--title",
  "-d",
  "--description",
  "--draft",
  "-y",
  "--yes",
]);

/**
 * Undo `shq` on one emitted token: one it left bare IS the string; a quoted one
 * is the string with the `'\\''` escapes put back. Needed so the byte-comparison
 * can feed the adapter's temp path back into the builder it is judged against.
 */
function unshq(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  if (!token.startsWith("'")) return token;
  return token.slice(1, -1).replaceAll("'\\''", "'");
}

// ── 1. the builder: argv form, real flags only ────────────────────────────

{
  const built = forgeCommands.prCreateCmd("gitlab", TITLE, BRANCH, BODY, {
    baseBranch: "main",
    draft: true,
  });
  assert(built.cmd === "glab", `cmd is the executable, not a shell string (${built.cmd})`);
  assert(Array.isArray(built.argv), "argv is given");
  const argv = built.argv ?? [];
  assert(argv[0] === "mr" && argv[1] === "create", `subcommand comes first (${argv.join(" ")})`);
  for (const flag of ["-s", "-t", "-d", "-b", "--draft", "-y"]) {
    assert(argv.includes(flag), `carries ${flag}`);
  }
  const at = (flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
  assert(at("-s") === BRANCH, `-s names the source branch (got ${String(at("-s"))})`);
  assert(at("-b") === "main", `-b names the target branch (got ${String(at("-b"))})`);
  assert(at("-t") === TITLE, `-t carries the title verbatim (got ${String(at("-t"))})`);
  assert(at("-d") === BODY, `-d carries the body as ONE argv element (got ${String(at("-d"))})`);
  assert(
    argv.filter((a) => a === "-y").length === 1,
    "-y is pinned once — it is what stops the submission prompt",
  );
  const bodyElems = argv.filter((a) => a.includes("not-a-subshell"));
  assert(
    bodyElems.length === 1 && bodyElems[0] === BODY,
    "the body appears once, and only as the single -d value",
  );
  assert(
    !argv.some((a) => a.includes("--description-file") || a === "--output" || a === "json"),
    `no flag glab's mr create lacks (${argv.filter((a) => a.startsWith("-")).join(" ")})`,
  );
  assert(
    !argv.some((a) => a.startsWith("-") && !MR_FLAGS.has(a)),
    `every flag is one mr create supports (${argv.filter((a) => a.startsWith("-")).join(" ")})`,
  );
  assert(
    !argv.includes(BRANCH) || argv.indexOf(BRANCH) === argv.indexOf("-s") + 1,
    "the source branch is never positional — it is the -s value",
  );
  const noTarget = forgeCommands.prCreateCmd("gitlab", TITLE, BRANCH, BODY, { draft: true });
  assert(
    !(noTarget.argv ?? []).includes("-b"),
    "no base branch means no -b at all, not an empty value",
  );
  const notDraft = forgeCommands.prCreateCmd("gitlab", TITLE, BRANCH, BODY, {});
  assert(!(notDraft.argv ?? []).includes("--draft"), "a ready MR carries no --draft");
  const gh = forgeCommands.prCreateCmd("github", TITLE, BRANCH, "/tmp/b", { baseBranch: "main" });
  assert(
    gh.argv === undefined && gh.cmd.includes("--body-file /tmp/b"),
    `the GitHub builder keeps its unchanged shell string (${gh.cmd})`,
  );
}

// ── 2. the adapter: exec gets the argv, and the body is checked first ──────

{
  const seen: { cmd: string; argv?: string[]; opts?: Record<string, unknown> }[] = [];
  const fn: ForgeExecFn = async (cmd, opts) => {
    seen.push({ cmd, argv: opts?.argv, opts: opts as Record<string, unknown> | undefined });
    return { stdout: MR_URL };
  };
  const forge = createForge(glDetection("acme", "widget"), { execFn: fn });
  const mr = await forge.prCreate(TITLE, BRANCH, BODY, { baseBranch: "main", draft: true });
  const call = seen.find((c) => c.cmd === "glab");
  assert(call !== undefined, `the create ran as an argv exec of \`glab\` (${JSON.stringify(seen.map((c) => c.cmd))})`);
  assert(call?.argv?.includes("-d") === true, "the exec carried the -d argv element");
  assert(
    (call?.argv ?? []).filter((a) => a === BODY).length === 1,
    "the exec's -d value is exactly the bytes it was handed",
  );
  assert(
    mr.number === 17,
    `the number comes from the URL line glab prints (got ${mr.number})`,
  );
  assert(mr.url === MR_URL.trim(), `the url is that line (got ${mr.url})`);
  assert(
    seen.every((c) => !c.cmd.includes("not-a-subshell") && !c.cmd.includes(BRANCH)),
    "no logged command string carries the body or the branch",
  );
  assert(
    call?.opts?.env !== undefined,
    "the create is given an explicit env, which strips the forge login and says non-interactive (its stdin is ended by execp's argv form — see test-exec-argv-stdin.ts)",
  );
  assert(
    (call?.opts?.env as Record<string, string> | undefined)?.CI === "1",
    "and that env says non-interactive, so a prompt fails rather than hangs",
  );
}

// ── 3. stdout shapes: plain URL in, refusal out ────────────────────────────

{
  const noisy = `Creating merge request for ${BRANCH} in acme/widget\n${MR_URL}`;
  const { fn } = recorder(noisy);
  const forge = createForge(glDetection("acme", "widget"), { execFn: fn });
  const mr = await forge.prCreate(TITLE, BRANCH, BODY, { baseBranch: "main" });
  assert(mr.number === 17, `the last MR URL line wins over the progress line (${mr.number})`);
  assert(mr.url === MR_URL.trim(), `url ${mr.url}`);
}

{
  // What a real `glab mr create` answers: the new MR's URL on its own line. The
  // read is anchored to that line, and the two rows below are the mutants that
  // prove it: a whole JSON row (the shape the OFF arm's `--output json` printed
  // pre-fix) and a prose line quoting a URL are both refusals, because an
  // unanchored read finds `iid: 17` / the quoted number in either and reports an
  // MR this create never printed.
  const { fn } = recorder(MR_URL);
  const forge = createForge(glDetection("acme", "widget"), { execFn: fn });
  const mr = await forge.prCreate(TITLE, BRANCH, BODY, {});
  assert(mr.number === 17, `the URL line is what is read (${mr.number})`);
  assert(mr.url === MR_URL.trim(), `url ${mr.url}`);

  // A JSON row is not an answer on this path, and must reject rather than be
  // mapped through the `mr view` row mapper as it used to be.
  const row = { ...GL_MR, web_url: MR_URL.trim() };
  const { fn: rowFn } = recorder(JSON.stringify(row));
  const forgeRow = createForge(glDetection("acme", "widget"), { execFn: rowFn });
  let rejectedRow: Error | undefined;
  await forgeRow.prCreate(TITLE, BRANCH, BODY, {}).catch((e) => {
    rejectedRow = e as Error;
  });
  assert(
    rejectedRow !== undefined && /no merge request URL/.test(rejectedRow?.message ?? ""),
    `a JSON row with no URL line refuses by name (${String(rejectedRow?.message).slice(0, 60)})`,
  );

  // A JSON row with no URL is not an answer either (the shape without the field
  // the anchored read was matching against).
  const { web_url: _dropped, ...rowWithoutUrl } = GL_MR;
  const { fn: noUrl } = recorder(JSON.stringify(rowWithoutUrl));
  const forgeNoUrl = createForge(glDetection("acme", "widget"), { execFn: noUrl });
  let rejected: Error | undefined;
  await forgeNoUrl.prCreate(TITLE, BRANCH, BODY, {}).catch((e) => {
    rejected = e as Error;
  });
  assert(
    rejected !== undefined && /no merge request URL/.test(rejected?.message ?? ""),
    `a reply with no URL line refuses by name (${String(rejected?.message)})`,
  );
}

{
  const { fn } = recorder("some other output\n");
  const forge = createForge(glDetection("acme", "widget"), { execFn: fn });
  let rejected: Error | undefined;
  await forge.prCreate(TITLE, BRANCH, BODY, {}).catch((e) => {
    rejected = e as Error;
  });
  assert(
    rejected !== undefined && /no merge request URL/.test(rejected?.message ?? ""),
    `no URL line is a named refusal, never number 0 (${String(rejected?.message)})`,
  );
}

{
  // The read must be the URL ITSELF, not any line mentioning one. A `glab`
  // warning that quotes an MR URL (an existing MR, a lint notice) is prose, and
  // `parsePrNumberFromResponse` finds a number anywhere in its input — so a
  // substring filter read that line as the create's answer. Refused by name.
  const prose = `Warning: this duplicates https://gitlab.com/acme/widget/-/merge_requests/99 already\n`;
  const { fn } = recorder(prose);
  const forge = createForge(glDetection("acme", "widget"), { execFn: fn });
  let rejected: Error | undefined;
  await forge.prCreate(TITLE, BRANCH, BODY, {}).catch((e) => {
    rejected = e as Error;
  });
  assert(
    rejected !== undefined && /no merge request URL/.test(rejected?.message ?? ""),
    `a prose line MENTIONING a merge_requests URL is not accepted (${String(rejected?.message)})`,
  );

  // …and when a real URL line also appears, the number is THAT one, not the
  // number the prose mentioned.
  const both = `Warning: see https://gitlab.com/acme/widget/-/merge_requests/99\n${MR_URL}`;
  const { fn: fnBoth } = recorder(both);
  const forgeBoth = createForge(glDetection("acme", "widget"), { execFn: fnBoth });
  const mrBoth = await forgeBoth.prCreate(TITLE, BRANCH, BODY, {});
  assert(
    mrBoth.number === 17 && mrBoth.url === MR_URL.trim(),
    `only the line that IS the URL is read (got ${mrBoth.number} ${mrBoth.url})`,
  );
}

// ── 4. an empty body refuses BEFORE the command is built ───────────────────

{
  for (const body of ["", "   \n\t ", "-"]) {
    const { fn, calls } = recorder(MR_URL);
    const forge = createForge(glDetection("acme", "widget"), { execFn: fn });
    let rejected: Error | undefined;
    await forge.prCreate(TITLE, BRANCH, body, {}).catch((e) => {
      rejected = e as Error;
    });
    assert(
      rejected !== undefined && /empty|dash/i.test(rejected?.message ?? ""),
      `body ${JSON.stringify(body)} is refused by name (${String(rejected?.message)})`,
    );
    assert(calls.length === 0, `and nothing was exec'd for body ${JSON.stringify(body)}`);
  }
}

// ── 5. the switch off puts the old command back, byte for byte ─────────────

{
  const OLD =
    "glab mr create feature/branch -t Title --description-file /tmp/b --target-branch main --draft --output json";
  await withEnv({ PI_ENSEMBLE_GLAB_MR_CREATE: "0" }, async () => {
    const legacy = forgeCommands.prCreateCmd("gitlab", "Title", "feature/branch", "/tmp/b", {
      baseBranch: "main",
      draft: true,
    });
    assert(legacy.cmd === OLD, `off value emits the pre-fix shell string (${legacy.cmd})`);
    assert(legacy.argv === undefined, "off value emits no argv — the pre-fix path had none");

    // The switch's contract is that `"0"` IS the old behaviour, so the adapter
    // must not merely emit an old-shaped command — it must emit the SAME bytes
    // the pre-fix builder produced for the same inputs. The pre-fix `prCreate`
    // wrote the body to a temp file and passed that PATH; handing the off arm
    // the body STRING turned the quoted `--description-file` value into the body
    // itself, so the "known-broken baseline" was broken differently (glab read a
    // nonexistent file named after the whole body) and a cycle compared against
    // it was not comparing against the baseline.
    //
    // Pinned against a transcription of that builder — the one on `origin/main`
    // at this PR's base, kept here verbatim — rather than a hand-written string,
    // so a drift in either half fails this row.
    const originMainOffArmBuilder = (
      title: string,
      headBranch: string,
      bodyFile: string,
      baseBranch?: string,
      draft?: boolean,
    ): string => {
      const draftFlag = draft ? " --draft" : "";
      const target = baseBranch ? ` --target-branch ${shq(baseBranch)}` : "";
      return `glab mr create ${shq(headBranch)} -t ${shq(title)} --description-file ${shq(bodyFile)}${target}${draftFlag} --output json`;
    };

    const seen: Call[] = [];
    // The temp path the adapter hands the builder is the half under test, so it
    // is read back OUT of the emitted command and fed to the transcription of the
    // origin/main builder. Comparing the WHOLE string (not a `/tmp/…` regex) is
    // what makes "byte-identical" mean what the switch's contract says.
    const emittedCommands: string[] = [];
    const fn: ForgeExecFn = async (cmd, opts) => {
      seen.push({ cmd, argv: opts?.argv });
      emittedCommands.push(cmd);
      return { stdout: MR_URL };
    };
    const forge = createForge(glDetection("acme", "widget"), { execFn: fn });
    await forge.prCreate(TITLE, BRANCH, BODY, { baseBranch: "main", draft: true });
    const offArm = emittedCommands.find((c) => c.startsWith("glab mr create "));
    assert(
      offArm !== undefined,
      `the off arm ran a shell string (${JSON.stringify(emittedCommands.map((c) => c.slice(0, 24)))})`,
    );
    assert(
      seen.every((c) => c.argv === undefined),
      `the off arm ran with no argv — the pre-fix path had none (got ${JSON.stringify(seen.map((c) => c.argv))})`,
    );
    // A body that cannot be confused with a path, so a body-string leak is loud.
    const emitted = offArm ?? "";
    assert(
      !emitted.includes("not-a-subshell") && !emitted.includes("## Summary"),
      `the body is NOT shell text on the off arm (${emitted.slice(0, 90)}…)`,
    );
    const bodyFile = unshq(emitted.match(/ --description-file (\S+)/)?.[1]);
    assert(
      bodyFile !== undefined && path.basename(bodyFile) === "body.md",
      `--description-file names the adapter's temp body file, not the body (got ${String(bodyFile).slice(0, 60)})`,
    );
    const expected = originMainOffArmBuilder(TITLE, BRANCH, bodyFile ?? "", "main", true);
    assert(
      emitted === expected,
      `byte-identical to the origin/main builder for the same inputs\n  got      ${emitted.slice(0, 150)}\n  expected ${expected.slice(0, 150)}`,
    );
  });
  await withEnv({ PI_ENSEMBLE_GLAB_MR_CREATE: undefined }, () => {
    const modern = forgeCommands.prCreateCmd("gitlab", "Title", "feature/branch", "/tmp/b", {});
    assert(modern.cmd === "glab", "unset is the fixed argv path");
  });
  await withEnv({ PI_ENSEMBLE_GLAB_MR_CREATE: "1" }, () => {
    const modern = forgeCommands.prCreateCmd("gitlab", "Title", "feature/branch", "/tmp/b", {});
    assert(modern.cmd === "glab", '"1" is the fixed argv path too');
  });
}

console.log(`\n${exit === 0 ? "glab mr create green" : "glab mr create RED"} — exit ${exit}`);
process.exit(exit);
