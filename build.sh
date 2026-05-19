#!/bin/bash
# Assemble per-role system prompts from modules + manifests + agents-base.
# Outputs one Markdown file per role into PROMPTS_DIR.

set -euo pipefail
[ "${PI_ENSEMBLE_BUILD_TRACE:-0}" = "1" ] && set -x

# Default BASE to the directory containing this script. Override with
# PI_ENSEMBLE_BASE if running from elsewhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${PI_ENSEMBLE_BASE:-$SCRIPT_DIR}"
MANIFESTS_DIR="$BASE/manifests"
PROMPTS_DIR="${PROMPTS_DIR:-$BASE/dist/prompts}"

get_config_filename() {
  case "$1" in
    standard) echo "agents.json" ;;
    *) return 1 ;;
  esac
}

# Verify modules/ directory exists
if [[ ! -d "$BASE/modules" ]]; then
  echo "ERROR: modules/ directory not found in $BASE"
  exit 1
fi

# Parse environment parameter. Currently only "standard" is supported; the
# multi-environment scaffolding is kept so future variants (e.g. enterprise
# overlays) can be added by dropping in <agent>.<env>.manifest files.
ENV="${1:-standard}"

if [[ "$ENV" != "standard" ]]; then
  echo "ERROR: Invalid environment '$ENV'. Only 'standard' is supported."
  exit 1
fi

ENVIRONMENTS=("$ENV")

# Get list of base agent names from manifests/
get_base_agents() {
  for manifest in "$MANIFESTS_DIR"/*.manifest; do
    basename "$manifest" .manifest
  done | sort -u
}

# Generate agent capabilities table from JSON config
# $1 = ENV, $2 = agent_name (if set, generate self-only block; if empty, generate full PM matrix)
generate_agent_capabilities() {
  local ENV="${1:-standard}"
  local AGENT_NAME="${2:-}"
  local config_filename
  config_filename=$(get_config_filename "$ENV") || {
    echo "ERROR: Unsupported environment '$ENV'"
    return 1
  }
  local config_file="$BASE/$config_filename"
  local target_file
  local config_comment="<!-- Auto-generated from $config_filename -->"

  # Determine target file
  if [[ -z "$AGENT_NAME" ]]; then
    # PM gets full matrix
    target_file="$BASE/agents-base/project-manager.md"
  else
    # Specialists get self-only block
    target_file="$BASE/agents-base/${AGENT_NAME}.md"
  fi

  if [[ ! -f "$config_file" ]]; then
    echo "WARNING: $config_file not found, skipping capabilities generation"
    return 0
  fi

  # Verify jq is available
  if ! command -v jq &> /dev/null; then
    echo "ERROR: jq is required but not installed"
    return 1
  fi

  # Verify target file exists
  if [[ ! -f "$target_file" ]]; then
    echo "ERROR: $target_file not found"
    return 1
  fi

  # Create temporary file for generated content
  local temp_capabilities=$(mktemp)
  local target_tmp="${target_file}.tmp"

  # Ensure cleanup on exit
  trap "rm -f '$temp_capabilities' '$target_tmp'" EXIT

  # Generate header for new format
  if [[ -z "$AGENT_NAME" ]]; then
    cat > "$temp_capabilities" << 'EOF'
## Agent Capabilities

EOF
  else
    cat > "$temp_capabilities" << 'EOF'
### Tools & Permissions
EOF
  fi

  # Extract capabilities for target agent(s) using jq
  if [[ -z "$AGENT_NAME" ]]; then
    # Full PM matrix - all agents
    jq -r '
      .agent | to_entries[] |
      .key as $agent |
      .value.permission as $perm |

      # Agent display name
      (if $agent == "project-manager" then "PM (orchestrator)"
       else "@\($agent)" end) as $display |

      # Non-bash tool permissions that are "allow"
      [
        (if ($perm.read // "deny") == "allow" then "read" else empty end),
        (if ($perm.write // "deny") == "allow" then "write" else empty end),
        (if ($perm.edit // "deny") == "allow" then "edit" else empty end),
        (if ($perm.rg // "deny") == "allow" then "rg" else empty end),
        (if ($perm.skill // "deny") == "allow" then "skill" else empty end),
        (if ($perm.webfetch // "deny") == "allow" then "webfetch" else empty end),
        (if ($perm.list // "deny") == "allow" then "list" else empty end),
        (if ($perm.todowrite // "deny") == "allow" then "todowrite" else empty end),
        (if ($perm.task // "deny") == "allow" then "task" else empty end),
        (if ($perm.taskctl // "deny") == "allow" then "taskctl" else empty end),
        (if ($perm.cancel_task // "deny") == "allow" then "cancel_task" else empty end),
        (if ($perm.list_tasks // "deny") == "allow" then "list_tasks" else empty end),
        (if ($perm.check_task // "deny") == "allow" then "check_task" else empty end)
      ] | map(select(. != "")) | join(", ") as $tools |

      # MCP tool permissions (anything not in the standard/infrastructure keys)
      [
        ($perm | to_entries[] | 
          select(
            .key != "read" and
            .key != "write" and
            .key != "edit" and
            .key != "rg" and
            .key != "skill" and
            .key != "webfetch" and
            .key != "list" and
            .key != "todowrite" and
            .key != "task" and
            .key != "taskctl" and
            .key != "cancel_task" and
            .key != "list_tasks" and
            .key != "check_task" and
            .key != "multiedit" and
            .key != "websearch" and
            .key != "bash" and
            .key != "*" and
            .key != "external_directory" and
            .value == "allow"
          ) | 
          .key | gsub("\\*$"; "")
        )
      ] | sort | unique | join(", ") as $mcp_tools |
      
       # Format MCP line - show (none) if empty
       (if $mcp_tools == "" then "(none)" else $mcp_tools end) as $mcp_display |

       # Bash allows (excluding the * default) - sorted for deterministic output
       [
         (($perm.bash // {}) | to_entries[] | select(.key != "*" and .value == "allow") | .key)
       ] | sort | unique | join(", ") as $bash_allows |

       # Bash default
       (if ($perm.bash["*"] // "deny") == "deny" then "deny-all + allowlist" else "allow-all" end) as $bash_default |

       "### \($display)\n**Tools:** \($tools)\n**MCP:** \($mcp_display)\n**Bash (\($bash_default)):** \($bash_allows)\n"
     ' "$config_file" >> "$temp_capabilities" || {
      echo "ERROR: Failed to parse config file with jq"
      rm -f "$temp_capabilities"
      return 1
    }
  else
    # Self-only capabilities for specialists
    # Validate agent exists in config before proceeding
    if ! jq -e ".agent[\"$AGENT_NAME\"]" "$config_file" > /dev/null 2>&1; then
      echo "ERROR: Agent '$AGENT_NAME' not found in config file $config_file"
      return 1
    fi
    
    jq -r \
      --arg agent "$AGENT_NAME" '
      .agent[$agent] |
      .permission as $perm |

      # Non-bash tool permissions that are "allow"
      [
        (if ($perm.read // "deny") == "allow" then "read" else empty end),
        (if ($perm.write // "deny") == "allow" then "write" else empty end),
        (if ($perm.edit // "deny") == "allow" then "edit" else empty end),
        (if ($perm.rg // "deny") == "allow" then "rg" else empty end),
        (if ($perm.skill // "deny") == "allow" then "skill" else empty end),
        (if ($perm.webfetch // "deny") == "allow" then "webfetch" else empty end),
        (if ($perm.list // "deny") == "allow" then "list" else empty end),
        (if ($perm.todowrite // "deny") == "allow" then "todowrite" else empty end),
        (if ($perm.task // "deny") == "allow" then "task" else empty end),
        (if ($perm.taskctl // "deny") == "allow" then "taskctl" else empty end),
        (if ($perm.cancel_task // "deny") == "allow" then "cancel_task" else empty end),
        (if ($perm.list_tasks // "deny") == "allow" then "list_tasks" else empty end),
        (if ($perm.check_task // "deny") == "allow" then "check_task" else empty end)
      ] | map(select(. != "")) | join(", ") as $tools |

      # MCP tool permissions (anything not in the standard/infrastructure keys)
      [
        ($perm | to_entries[] | 
          select(
            .key != "read" and
            .key != "write" and
            .key != "edit" and
            .key != "rg" and
            .key != "skill" and
            .key != "webfetch" and
            .key != "list" and
            .key != "todowrite" and
            .key != "task" and
            .key != "taskctl" and
            .key != "cancel_task" and
            .key != "list_tasks" and
            .key != "check_task" and
            .key != "multiedit" and
            .key != "websearch" and
            .key != "bash" and
            .key != "*" and
            .key != "external_directory" and
            .value == "allow"
          ) | 
          .key | gsub("\\*$"; "")
        )
      ] | sort | unique | join(", ") as $mcp_tools |
      
       # Format MCP line - show (none) if empty
       (if $mcp_tools == "" then "(none)" else $mcp_tools end) as $mcp_display |

       # Bash allows (excluding the * default) - sorted for deterministic output
       [
         (($perm.bash // {}) | to_entries[] | select(.key != "*" and .value == "allow") | .key)
       ] | sort | unique | join(", ") as $bash_allows |

       # Bash default
       (if ($perm.bash["*"] // "deny") == "deny" then "deny-all + allowlist" else "allow-all" end) as $bash_default |

       "**Tools:** \($tools)\n**MCP:** \($mcp_display)\n**Bash (\($bash_default)):** \($bash_allows)\n"
     ' "$config_file" >> "$temp_capabilities" || {
       echo "ERROR: Failed to parse config file with jq for agent $AGENT_NAME"
      rm -f "$temp_capabilities"
      return 1
    }
  fi

  # Validate jq output has more than just the header
  if (( $(wc -l < "$temp_capabilities") <= 2 )); then
    echo "ERROR: No agent capabilities found in config file"
    return 1
  fi

# Read the generated content and output to stdout for capture during prompt assembly
  local capabilities_content
  capabilities_content=$(cat "$temp_capabilities")
  rm -f "$temp_capabilities"

  # Verify jq output has more than just the header
  local line_count
  line_count=$(echo "$capabilities_content" | wc -l | tr -d ' ')
  if (( line_count <= 2 )); then
    echo "ERROR: No agent capabilities found in config file" >&2
    return 1
  fi

  # Output the capabilities content for capture by caller
  # Format: CONFIG_COMMENT\nCAPABILITIES_CONTENT
  echo "$config_comment"
  echo "$capabilities_content"

  if [[ -z "$AGENT_NAME" ]]; then
    echo "✓ Generated full agent capabilities matrix for $config_file" >&2
  else
    echo "✓ Generated specialist capabilities for $AGENT_NAME" >&2
  fi
}

AGENTS=()
while IFS= read -r agent; do
  AGENTS+=("$agent")
done < <(get_base_agents)

echo "Building prompts for: ${ENVIRONMENTS[*]}"
echo "Agents: ${AGENTS[*]}"
echo ""

# Build prompts for each environment
for env in "${ENVIRONMENTS[@]}"; do
  OUTPUT_DIR="$PROMPTS_DIR/$env"
  mkdir -p "$OUTPUT_DIR"

# Preflight validation: ensure all specialist base files exist
  for agent in "${AGENTS[@]}"; do
    if [[ "$agent" != "project-manager" ]]; then
      specialist_file="$BASE/agents-base/${agent}.md"
      if [[ ! -f "$specialist_file" ]]; then
        echo "ERROR: Missing specialist base file: $specialist_file"
        exit 1
      fi
    fi
  done

  # Clean stale files before build
  rm -f "$OUTPUT_DIR"/*.txt "$OUTPUT_DIR"/*.md 2>/dev/null || true

  echo "=== Building $env environment ==="

  for agent in "${AGENTS[@]}"; do
    # Manifest resolution: check {agent}.{env}.manifest first, fall back to {agent}.manifest
    env_manifest="$MANIFESTS_DIR/${agent}.${env}.manifest"
    base_manifest="$MANIFESTS_DIR/${agent}.manifest"

    if [[ -f "$env_manifest" ]]; then
      manifest="$env_manifest"
      manifest_name="${agent}.${env}.manifest"
    elif [[ -f "$base_manifest" ]]; then
      manifest="$base_manifest"
      manifest_name="${agent}.manifest"
    else
      echo "ERROR: No manifest found for agent '$agent' (checked $env_manifest and $base_manifest)"
      exit 1
    fi

    output="$OUTPUT_DIR/${agent}.md"

    echo "Building $agent ($env)..."
    echo "  Manifest: $manifest_name"

    # Generate capabilities for this agent (capture output to variable)
    if [[ "$agent" == "project-manager" ]]; then
      # PM gets full multi-agent matrix
      agent_capabilities=$(generate_agent_capabilities "$env" "")
      if [[ $? -ne 0 ]]; then
        echo "ERROR: Failed to generate PM capabilities"
        exit 1
      fi
    else
      # Specialists get self-only capabilities
      agent_capabilities=$(generate_agent_capabilities "$env" "$agent")
      if [[ $? -ne 0 ]]; then
        echo "ERROR: Failed to generate capabilities for $agent"
        exit 1
      fi
    fi

    # Extract capabilities content (skip first line which is the auto-generated HTML comment -
    # we deliberately drop it since markers are stripped during assembly)
    capabilities_content=$(echo "$agent_capabilities" | tail -n +2)

    # Create empty output file
    > "$output"

    # Process each line in manifest
    module_count=0
    capabilities_injected=false
    while IFS= read -r line || [[ -n "$line" ]]; do
      # Skip comments and blank lines
      [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue

      # Trim whitespace
      line=$(echo "$line" | xargs)

      # Construct full path
      module_path="$BASE/$line"

      # Verify file exists
      if [[ ! -f "$module_path" ]]; then
        echo "ERROR: Missing module: $module_path"
        echo "  Referenced in: $manifest"
        exit 1
      fi

      # Append module content, handling capabilities injection
      if [[ -f "$module_path" ]] && grep -q "^<!-- AGENT-CAPABILITIES-START -->$" "$module_path" && ! $capabilities_injected; then
        # This file has capabilities markers - inject pre-generated content
        # Write capabilities content to temp file for awk to read
        tmp_caps=$(mktemp)
        printf '%s' "$capabilities_content" > "$tmp_caps"

        awk -v start="<!-- AGENT-CAPABILITIES-START -->" -v end="<!-- AGENT-CAPABILITIES-END -->" -v tmpfile="$tmp_caps" '
          $0 == start {
            while ((getline line < tmpfile) > 0) print line
            close(tmpfile)
            skip = 1
            next
          }
          $0 == end {
            skip = 0
            next
          }
          !skip { print }
        ' "$module_path" >> "$output"

        rm -f "$tmp_caps"
        capabilities_injected=true
      else
        # No capabilities markers or already injected - strip comment lines and append
        {
          awk '
            !/^<!-- AGENT-CAPABILITIES-START -->$/ &&
            !/^<!-- AGENT-CAPABILITIES-END -->$/ &&
            !/^<!-- Auto-generated from agents\.json -->$/
          ' "$module_path"
          echo ""
        } >> "$output"
      fi

      ((module_count++))
    done < "$manifest"

    # Validate that capabilities were injected if the manifest contains a file with markers
    if [[ "$agent" != "project-manager" && ! $capabilities_injected ]]; then
      echo "WARNING: No capabilities injected for $agent (no AGENT-CAPABILITIES markers found in manifest modules)"
    fi

    # Validate manifest has at least one module
    if [[ "$module_count" -eq 0 ]]; then
      echo "ERROR: Manifest has no module references (only comments/blank lines)"
      echo "  Manifest: $manifest"
      exit 1
    fi

    echo "  -> $output"
  done

  echo ""
done

echo "Build complete!"
echo ""
echo "Generated prompts:"
for env in "${ENVIRONMENTS[@]}"; do
  echo ""
  echo "=== $env environment ==="
  ls -lh "$PROMPTS_DIR/$env"/*.md | awk '{print $9, "(" $5 ")"}'
done
