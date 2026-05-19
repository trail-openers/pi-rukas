# Shell Script Patterns

## Script Template

```bash
#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"

usage() {
    cat << EOF
Usage: ${SCRIPT_NAME} [options] <argument>

Options:
    -h, --help      Show this help
    -v, --verbose   Verbose output
    -d, --dry-run   Show what would be done
EOF
}

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"; }
debug() { [[ "${VERBOSE:-0}" -eq 1 ]] && log "DEBUG: $*"; }
error() { echo "ERROR: $*" >&2; exit 1; }
warn() { echo "WARNING: $*" >&2; }

main() {
    local verbose=false
    local dry_run=false

    while [[ $# -gt 0 ]]; do
        case "$1" in
            -h|--help) usage; exit 0 ;;
            -v|--verbose) verbose=true; shift ;;
            -d|--dry-run) dry_run=true; shift ;;
            --) shift; break ;;
            -*) error "Unknown option: $1" ;;
            *) break ;;
        esac
    done

    [[ $# -eq 0 ]] && { usage; exit 1; }

    # Main logic here
}

main "$@"
```

## Error Handling

```bash
# Cleanup trap
cleanup() {
    local exit_code=$?
    [[ -f "${TEMP_FILE:-}" ]] && rm -f "$TEMP_FILE"
    exit $exit_code
}
trap cleanup EXIT INT TERM

# Require commands
require() {
    command -v "$1" >/dev/null 2>&1 || error "Required: $1"
}

# Safe temp file
TEMP_FILE=$(mktemp) || error "Cannot create temp file"
```

## POSIX vs Bash

```bash
# POSIX (portable)
command -v git >/dev/null 2>&1   # NOT: which git
[ -f "$file" ]                    # NOT: [[ -f $file ]]
$(command)                        # NOT: `command`
printf '%s\n' "$var"              # NOT: echo "$var"

# Bash-specific (when needed)
[[ "$string" =~ pattern ]]        # Regex matching
declare -A assoc_array            # Associative arrays
${var,,}                          # Lowercase
${var^^}                          # Uppercase
```

## Configuration Pattern

```bash
# Environment-based config with defaults
CONFIG_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/myapp/config"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/myapp"
LOG_LEVEL="${LOG_LEVEL:-INFO}"

# Load config if exists
[[ -f "$CONFIG_FILE" ]] && source "$CONFIG_FILE"
```

## File Processing

```bash
# Safe line-by-line reading
while IFS= read -r line || [[ -n "$line" ]]; do
    process_line "$line"
done < "$file"

# Process with null delimiter (handles spaces/newlines)
while IFS= read -r -d '' file; do
    process_file "$file"
done < <(find . -type f -print0)
```

## Parallel Processing

```bash
parallel_process() {
    local max_jobs="${MAX_JOBS:-$(nproc)}"
    local job_count=0

    for item in "$@"; do
        if [[ $job_count -ge $max_jobs ]]; then
            wait -n  # Wait for any job (bash 4.3+)
            ((job_count--))
        fi

        process_item "$item" &
        ((job_count++))
    done

    wait  # Wait for remaining jobs
}
```

## Input Validation

```bash
# Validate integer
is_integer() {
    [[ "$1" =~ ^-?[0-9]+$ ]]
}

# Validate file
validate_file() {
    local file="$1"
    [[ -z "$file" ]] && error "File required"
    [[ ! -f "$file" ]] && error "Not a file: $file"
    [[ ! -r "$file" ]] && error "Cannot read: $file"
}

# Sanitize filename
sanitize_filename() {
    local filename="$1"
    filename="${filename//[^a-zA-Z0-9._-]/}"
    filename="${filename#../}"
    filename="${filename#/}"
    printf '%s' "$filename"
}
```

## BATS Testing

```bash
# tests/script.bats
setup() {
    load 'test_helper/bats-support/load'
    load 'test_helper/bats-assert/load'
}

@test "displays help with -h" {
    run ./script.sh -h
    assert_success
    assert_output --partial "Usage:"
}

@test "fails without required argument" {
    run ./script.sh
    assert_failure
    assert_output --partial "ERROR"
}

@test "processes file correctly" {
    echo "test" > "$BATS_TMPDIR/input.txt"
    run ./script.sh "$BATS_TMPDIR/input.txt"
    assert_success
}
```
