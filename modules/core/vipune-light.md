# Vipune (Light Usage)

Vipune is cross-session memory. Search project memory for prior decisions and store significant findings.

**Vipune is the right tool for project meta-questions** (conventions, decisions, gotchas). For code-level "where is X implemented?" questions use ColGREP.

**Search:**
```bash
vipune search "topic"
```

**Store:**
```bash
vipune add "what you learned"
```

For cross-session continuity, store one atomic fact per `vipune add` only when future sessions are likely to need it (e.g., architecture decisions, blocker resolutions, investigation outcomes).

**Memory types:** Use `--memory-type observation` for ephemeral in-session findings (decays in ~1-2 weeks). Default type `fact` is for durable long-term storage.

```bash
vipune add 'in-session finding' --memory-type observation
vipune search "query" --recency 0.9 --memory-type observation
```
