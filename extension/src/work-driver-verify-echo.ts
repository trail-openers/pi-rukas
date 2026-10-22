/**
 * work-driver-verify-echo — #1765: what the executor's own echo is, and what is
 * the project's gate speaking.
 *
 * `probeBaselineVerify` decides a base commit's colour from the stream an
 * executor hands back. When the child printed nothing, `combinedExecFailureStream`
 * falls back to the Error's own message, which node always leads with
 * `Command failed: <cmd>` — so a stream that reduces to that line is the harness
 * talking, not the gate, and reading it as gate output would park a cycle on a
 * base that may be perfectly green.
 *
 * Deciding that needs two things: removing every spelling the echo can carry the
 * command in (bare, quoted, JSON-escaped, and each of those wrapped in a shell
 * `sh -c`/`bash -c` invocation, because `execp` with `shell: true` reaches
 * `/bin/sh -c`), and then deciding what a leftover is. The leftover rule is the
 * load-bearing one, and it is a WHITELIST: only the residual spellings stripping
 * actually produces for the wrappers in `ECHO_WRAPPERS` are harness punctuation.
 * The pre-round-3 rule was a punctuation class — any run of `- / ' " \ space` plus
 * an optional `c`/`sh`/`bash` — so a child whose only output line was `----` read
 * as "nothing but the harness" and the probe called the base GREEN.
 *
 * Split out of `work-driver-verify-baseline.ts` for the AGENTS.md §12 500-line
 * cap. It has no imports: this is a leaf, and the probe imports it, never the
 * other way round.
 */

/**
 * The ONE list of shell wrappers this seam recognises in an executor's echo:
 * the spellings `execp` can invoke the project's command with (`shell: true`
 * reaches `/bin/sh -c`, and a caller may name `bash`). Both `stripCmdEcho` and
 * `isWrapperRemnant` read it, so a residual can only ever be excused for a
 * wrapper this file also strips — an arbitrary run of punctuation is never
 * harness output.
 */
const ECHO_WRAPPERS = ["sh -c ", "bash -c ", "/bin/sh -c ", "/bin/bash -c "] as const;

/**
 * The wrapper's own text in every state `stripCmdEcho` can strand it in. The
 * command is stripped as a whole token, so a wrapped echo keeps the quote pair
 * the wrapper was written with and nothing else: `sh -c 'sh gate.sh'` reduces to
 * the bare wrapper, and the JSON-echoed form `"sh -c \"sh gate.sh\""` to the
 * wrapper between its outer double quotes and the shell's escaped inner ones.
 * The set is GENERATED from those quote pairs rather than written as literals, so
 * it is exactly the residuals stripping produces and nothing wider — the derived
 * form is what a residual is, and an arbitrary run of quotes and dashes is not
 * one.
 */
const ECHO_WRAPPER_REMNANTS: ReadonlySet<string> = new Set(
  (() => {
    const q = String.fromCharCode(34);
    const sq = String.fromCharCode(39);
    const bs = String.fromCharCode(92);
    // The quote pairs the executor's echo can carry a wrapped command in, each
    // written as it appears once the command token itself is gone: `inner` is
    // what sits between the wrapper and the surviving `outer` pair.
    const pairs: Array<{ outer: string; inner: string }> = [
      { outer: "", inner: "" },
      { outer: "", inner: sq },
      { outer: "", inner: q },
      { outer: q, inner: `${bs}${q}` },
    ];
    return ECHO_WRAPPERS.flatMap((wrap) => {
      const text = wrap.trimEnd();
      return pairs.map((p) => `${p.outer}${text}${p.inner}${p.outer}`);
    });
  })(),
);

/**
 * Leftovers of the executor's own shell wrapper: the residuals `stripCmdEcho`
 * produces for the wrappers in `ECHO_WRAPPERS`, and nothing else.
 *
 * #1765 lens round 3 — this is a whitelist, not a punctuation class. The old rule
 * accepted ANY run of `- / ' " \ space` plus an optional `c`, `sh` or `bash`, so a
 * stream whose first line reduced to `----`, `--`, `-c`, `c`, `sh` or `bash`
 * counted as "nothing but the harness" and the probe called the base GREEN on a
 * child that may have printed that line as its own output. Only a spelling this
 * file knows the executor produces may excuse a residual.
 *
 * Exported for the direct canary in `test-verify-baseline-attribution.ts`.
 */
export function isWrapperRemnant(rest: string): boolean {
  return ECHO_WRAPPER_REMNANTS.has(rest.trim());
}

/** Remove every spelling of the invoked command from the executor's echo. */
function stripCmdEcho(rest: string, cmd: string): string {
  let out = rest;
  for (const form of commandEchoForms(cmd)) {
    if (!form) continue;
    out = out.split(form).join("");
  }
  return out.trim();
}

/**
 * Every spelling the executor's echo can carry the invoked command in: the
 * command itself, its quoted forms, and each of those embedded in a shell
 * wrapper (`sh -c '…'`, `bash -c "…"`), because node echoes the WHOLE invocation
 * — a shell-wrapped gate arrives with its inner command quoted, and a residual
 * quote or a leftover `-c` is the harness's own punctuation, not gate output.
 */
function commandEchoForms(cmd: string): string[] {
  const spell = (s: string): string[] => [s, JSON.stringify(s), `'${s}'`, `"${s}"`];
  const forms = spell(cmd);
  for (const wrap of ECHO_WRAPPERS) {
    // `wrap + cmd` is what a caller wrote; `wrap + quoted(cmd)` is what node
    // echoes after the shell re-quoted it. Both are stripped. Longest-first so a
    // nested wrapper cannot be half-consumed by the shorter spelling inside it:
    // stripping bare `sh gate.sh` out of `sh -c "sh -c \"sh gate.sh\""` first
    // would leave an inner wrapper behind for the residual rule to judge.
    for (const inner of [`${wrap}${cmd}`, `${wrap}${JSON.stringify(cmd)}`]) {
      forms.push(...spell(inner));
    }
  }
  // Longest spelling first, and the bare command last: every wrapper spelling
  // contains it, so the narrow forms must go before the wide one.
  return forms.sort((a, b) => b.length - a.length);
}

/**
 * Is `raw` nothing but node's own `Command failed: <cmd>` echo? The executor
 * error's message starts with that line and `combinedExecFailureStream` hands it
 * back verbatim when the child produced no stdout and no stderr, so a stream that
 * reduces to it is the harness talking, not the project's gate.
 *
 * #1765 lens round 1 — the WHOLE stream decides, not its first line. The old rule
 * bailed out on any newline, so an echo followed by a real failure line
 * (`Command failed: sh gate.sh\nerror: test failed`) read as "the gate spoke" on
 * the strength of the echo alone — the wrong direction only because the failure
 * happened to be real: a harness that prints its own banner under the echo would
 * have handed the probe a red base it never observed. Now every line is stripped
 * of the echo's spellings and the answer is `true` only when nothing but
 * whitespace survives across ALL of them, so any real gate output means it is not
 * harness-only.
 */
export function baseStreamIsHarnessOnly(raw: string, cmd: string): boolean {
  const head = "Command failed:";
  const lines = raw.trimStart().split("\n");
  // The echo's own line is the first non-empty one; anything before it means the
  // child printed something of its own, and this is not the harness alone.
  const first = lines[0] ?? "";
  if (!first.trimStart().startsWith(head)) return false;
  const afterEcho = stripCmdEcho(first.trimStart().slice(head.length), cmd);
  // A residual shell wrapper is harness punctuation, not gate output: a caller
  // whose command is `sh gate.sh` and whose executor ran `sh -c "sh gate.sh"`
  // echoes the invocation with the wrapper and its quoting, and none of that was
  // printed by the project. Whatever survives the command's own spellings is
  // therefore content only if it is not a bare wrapper remnant.
  if (afterEcho.length > 0 && !isWrapperRemnant(afterEcho)) return false;
  return lines.slice(1).every((line) => stripCmdEcho(line, cmd).length === 0);
}
