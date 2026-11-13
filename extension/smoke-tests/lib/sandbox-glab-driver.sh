#!/usr/bin/env bash
# Offline driver for extension/smoke-tests/test-sandbox-glab-config-mount.ts.
# Not a test itself (no `test-` prefix, so the gate glob never runs it) and not
# shipped: it is a fixture the test prepends the marker-extracted glab body to
# and then executes in a fresh bash.
#
# The body comes from bin/lib-pi-rukas-shell.sh between its `# >>> glab-config`
# / `# <<< glab-config` markers, so what runs here is the wrapper's own code, not
# a paraphrase of it. Each verb seeds exactly the array the body writes to —
# `mounts` for build_glab_mount, `envs` for build_glab_env — and prints nothing
# but the rows, one per line.
#
# Rows are joined on a unit separator before becoming lines, and a `-v` / `-e`
# flag is rejoined with its operand first: docker receives them as two argv
# entries, so a naive per-line dump would report half a row per element.

# >>> driver-body
ROWS=()

__emit() {
  # One row per line. A `-v` row is TWO words in the array (`-v` and the
  # source:target:ro pair), which is how build_mounts builds it, so the flag and
  # its operand are rejoined here — otherwise every row would arrive as two
  # lines and each assertion would compare half a row.
  local i out=() line
  i=0
  while [ "$i" -lt "${#ROWS[@]}" ]; do
    case "${ROWS[$i]}" in
      -v | -e)
        line="${ROWS[$i]} ${ROWS[$((i + 1))]-}"
        i=$((i + 2))
        ;;
      *)
        line="${ROWS[$i]}"
        i=$((i + 1))
        ;;
    esac
    out+=("$line")
  done
  [ "${#out[@]}" -eq 0 ] && return 0
  printf '%s\037' "${out[@]}" | tr '\037' '\n' | sed '/^$/d'
}

__mount() {
  mounts=()
  build_glab_mount
  ROWS=("${mounts[@]}")
}

# build_env's host-env passthrough, driven the way the wrapper drives it: the
# same NUL read, the same variable-name validity guard, the same exact-match
# blocklist (injected by the test as __BL, copied out of bin/pi-rukas), the same
# empty-value skip. Then the gh token branch verbatim — it must keep working
# untouched — and the marker-extracted build_glab_env LAST, so its
# GLAB_CONFIG_DIR row is the one docker sees, exactly as build_env orders it.
__env() {
  envs=()
  while IFS= read -r -d '' _entry; do
    [[ -z "$_entry" ]] && continue
    _var="${_entry%%=*}"
    _value="${_entry#*=}"
    [[ ! "$_var" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && continue
    [[ "$__BL" == *" $_var "* ]] && continue
    case "$_var" in LC_*|PI_ENSEMBLE_*|BASH_FUNC_*|__*) continue ;; esac
    [[ -z "$_value" ]] && continue
    envs+=(-e "$_var=$_value")
  done < <(env -0)
  if [ -z "${GH_TOKEN-}" ] && [ -z "${GITHUB_TOKEN-}" ] && command -v gh >/dev/null 2>&1; then
    if gh_tok="$(gh auth token 2>/dev/null)" && [ -n "$gh_tok" ]; then
      envs+=(-e "GH_TOKEN=$gh_tok")
    fi
  fi
  build_glab_env
  ROWS=("${envs[@]}")
}

# The glab env body on its own, with no passthrough in front of it: proves the
# GLAB_CONFIG_DIR row is the body's own decision and tracks the mount condition.
__env_only() {
  envs=()
  build_glab_env
  ROWS=("${envs[@]}")
}
# <<< driver-body

case "${1:-mount}" in
  mount) __mount ;;
  env) __env ;;
  env-only) __env_only ;;
  *)
    echo "sandbox-glab-driver: unknown verb '$1'" >&2
    exit 2
    ;;
esac
__emit
