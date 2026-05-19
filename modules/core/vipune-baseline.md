# Vipune (Baseline)

Vipune is cross-session memory. Search before starting work on any task. Store decisions and findings so future sessions have context.

**Vipune is the right tool for project meta-questions** ("what's our convention here?", "did we decide on a stack?", "what's the gotcha with X?"). For code-level questions ("where is X implemented?", "find code that does Y") use ColGREP.

**Search:**
```bash
vipune search "topic"
```

**Store:**
```bash
vipune add "what you learned, with context"
```

## Memory Types

Use both memory patterns depending on the nature of the finding:

**Long-term memory** (persists forever — architecture decisions, conventions, blocker fixes):
```bash
vipune add 'durable finding'   # default type: fact
```

**Session working memory** (ephemeral — what was decided or found this session):
```bash
vipune add 'in-session finding' --memory-type observation
```
Observations decay within ~1-2 weeks. All session agents share the same DB — your observations are readable by PM and other agents.

**Retrieve in-session context** (what happened earlier in this session):
```bash
vipune search "query" --recency 0.9 --memory-type observation
```

**One atomic fact per `vipune add` call.** Run `vipune --help` for advanced options.
