# Vipune (Heavy Usage Pattern)

Vipune is cross-session memory. Search aggressively, store continuously.

**Vipune is the right tool for project meta-questions** (conventions, decisions, gotchas, architectural rationale, who-is-working-on-what). For code-level "where is X implemented?" questions use ColGREP — they're orthogonal tools.

**Search:**
```bash
vipune search "topic"
```

**Store:**
```bash
vipune add "what you learned, with context"
```

## Memory Types

Vipune supports two memory patterns — use both:

**Long-term memory** (default, persists forever):
```bash
vipune add 'architectural decision or finding'   # type: fact (default)
```

**Session working memory** (ephemeral, shared across all agents):
```bash
vipune add 'what we just decided or observed' --memory-type observation
```
Observations decay within ~1-2 weeks and self-retire. All agents in a session share the same project-scoped DB — observations stored by @explore or @developer are immediately retrievable by PM and vice versa.

**Searching session context** (retrieve what happened earlier this session):
```bash
vipune search "what did we decide on X" --recency 0.9 --memory-type observation
```

**Instruct subagents to use both patterns:**
- "Store your key findings as `--memory-type observation` for session context"
- "Search vipune with `--recency 0.9 --memory-type observation` for earlier session decisions"

**Usage Pattern:**
- Search vipune at **session start** for ALL project context
- Search vipune **before delegating work** to check prior decisions
- Search vipune **before major decisions** to verify alignment
- Store findings **after each task completes** for cross-session continuity

**Use single quotes for safe vipune add:**
```bash
# SAFE: Single quotes prevent shell expansion
vipune add 'key finding with context and implications'

# AVOID: Double quotes may execute commands like `$(cmd)` or `$VAR`
vipune add "key finding $(whoami)"  # ❌ DANGEROUS
```

**Vipune is your memory bank. Use it liberally:**
- Session memory: Project context, decisions, patterns
- Cross-session continuity: What agents discover about this project
- Decision tracking: Why we chose X over Y, architectural rationale
- Blocker resolution: How we fixed past issues, lessons learned

**Instruct subagents:**
- "Search vipune at start for prior decisions on authentication"
- "Store any architectural findings in vipune after your investigation"

One atomic fact per `vipune add` call. Run `vipune --help` for advanced options.
