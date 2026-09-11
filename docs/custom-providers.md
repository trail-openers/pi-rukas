# Adding a custom OpenAI-compatible provider

For self-hosted vLLM, an internal LLM endpoint, or any third-party OpenAI Chat-Completions–compatible API, register it once in Pi's own config and `pi-rukas` will route subagents through it like any other provider.

**Step 1 — register the provider in `~/.pi/agent/models.json`** (create the file if it doesn't exist; merge with existing `providers` block if it does):

```jsonc
{
  "providers": {
    "my-vllm": {
      "api": "openai-completions",
      "baseUrl": "https://llm.example.com/v1",
      "apiKey": "$MY_LLM_KEY",
      "models": [
        {
          "id": "vendor/model-name",
          "name": "Friendly Display Name",
          "reasoning": true,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 262144,
          "maxTokens": 32768,
          "compat": {
            "thinkingFormat": "qwen-chat-template",
            "supportsReasoningEffort": false,
            "maxTokensField": "max_tokens"
          }
        }
      ]
    }
  }
}
```

Compat flags worth knowing:
- `thinkingFormat: "qwen-chat-template"` — for vLLM servers running `--reasoning-parser qwen3`; Pi sends `chat_template_kwargs.enable_thinking` instead of the OpenAI-style `reasoning_effort` field. Omit if your endpoint is non-reasoning.
- `supportsReasoningEffort: false` — most open-weight reasoning models are binary on/off, not tiered.
- `maxTokensField: "max_tokens"` — classic OpenAI naming; vLLM expects this rather than the newer `max_completion_tokens`.
- `cost: { zeros }` — internal/free endpoints; Pi's usage reporter still tracks tokens but won't multiply by a per-token rate.

**Step 2 — store the API key.** Pick whichever option fits your security posture:

- **1Password CLI** — store the credential in 1Password, then in `models.json`: `"apiKey": "!op read 'op://Private/<vault-item>/credential'"` (Pi re-executes the reference on each request)
- **Env var** — `export MY_LLM_KEY="..."` in your shell rc, then `"apiKey": "$MY_LLM_KEY"`
- **Plaintext** — paste the key directly into the `apiKey` field. Pi creates `models.json` with `0600` perms; fine for personal machines, not for shared hosts

**Step 3 — use it.** Three ways depending on how broadly you want it applied:

- *Main agent only*: `pi --provider my-vllm --model "vendor/model-name"` — or set it as the default in `~/.pi/agent/settings.json`:
  ```json
  { "defaultProvider": "my-vllm", "defaultModel": "vendor/model-name" }
  ```
- *Main agent for one specific project*: drop the same `defaultProvider`/`defaultModel` snippet into `./.pi/settings.json` at the project root. Pi reads project-local config and overrides the user-global default when invoked from there.
- *Subagents*: run `/ensemble-model` inside Pi — the custom provider appears under its own section in the picker. Pick a role + model and the choice persists as `{provider, model}` in `~/.pi/agent/ensemble-models.json`. Alternatively set `PI_ENSEMBLE_PROVIDER_<ROLE>=my-vllm` + `PI_ENSEMBLE_MODEL_<ROLE>=vendor/model-name` per role, or the `PI_ENSEMBLE_SUBAGENT_*` pair for all subagents.

`pi-rukas` passes `--provider <name>` ahead of `--model <id>` to each spawned subagent when a provider is configured, so Pi disambiguates the model ID against your registered providers rather than only its built-in catalog.

