# AI assistant setup

Natural-language entity creation (`/schemas/<domain>/<product>/new` > "Describe it") and AI field suggestions call a **local or self-hosted LLM
server**. Nothing is sent to a hosted provider: domain and entity names go to the server you configure, and only to it.

## Providers

| `provider` | Server | Endpoint the app calls |
| --- | --- | --- |
| `ollama` | [Ollama](https://ollama.com) | `POST {base}/api/generate` |
| `vllm` | any OpenAI-compatible server (vLLM, LiteLLM proxy, llama.cpp server ...) | `POST {base}/v1/completions` |

## Where to configure it

1. **Admin > AI** (platform administrators): provider, base URL, model, a **Test connection** button, and the source the running configuration comes from.
2. **Environment variables** (the server):

| Variable | Meaning |
| --- | --- |
| `AI_PROVIDER` | `ollama` or `vllm` (case-insensitive) |
| `AI_BASE_URL` | the server **root**, e.g. `http://localhost:11434`. A trailing `/` or `/v1` is removed: the clients add their own path |
| `AI_MODEL` | model name, default `llama3` |
| `AI_API_KEY` | optional; sent as `Authorization: Bearer <key>`. **Environment only**: never stored in the database, shown in the UI, logged or audited |
| `OLLAMA_HOST` | fallback for the base URL when `AI_PROVIDER=ollama` and `AI_BASE_URL` is unset. Ollama's own variable (`host[:port]`; `http://` is assumed, `0.0.0.0` becomes `127.0.0.1`) |
| `OPENAI_BASE_URL` | fallback for the base URL when `AI_PROVIDER=vllm` and `AI_BASE_URL` is unset (the OpenAI convention, usually ending in `/v1`) |

### Why these names

`AI_PROVIDER`, `AI_BASE_URL` and `AI_MODEL` are this application's own names; no SDK reads them. The conventional names of the supported backends are
`OLLAMA_HOST` and `OPENAI_BASE_URL`, so they are honoured as fallbacks and an existing setup keeps working. `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are **not**
read, on purpose: a key for a hosted service must never be sent to a self-hosted address by accident. Use `AI_API_KEY`.

### Precedence

1. A saved Admin > AI configuration that has a **provider and a base URL** wins entirely (its model, when empty, comes from `AI_MODEL`, then `llama3`).
2. Otherwise `AI_PROVIDER` with `AI_BASE_URL`.
3. Otherwise `AI_PROVIDER` with `OLLAMA_HOST` / `OPENAI_BASE_URL`.
4. Otherwise AI is off. If the database cannot be read, the environment alone decides.

"Clear saved settings" on the page removes the override and the environment decides again. The page shows which of these is in use.

## Security notes

- The base URL is fetched **by the server**, so whoever can edit it (`ai.manage`: platform administrators) can make the server call any http(s) address it can
  reach. Treat that right like network access. The connection test does not follow redirects and times out after 3 seconds.
- Changes are written to the audit log (provider, base URL, model; never a key).
- Only `http://` and `https://` addresses are accepted.

## Examples

```bash
# Ollama on the same machine
AI_PROVIDER=ollama
AI_BASE_URL=http://localhost:11434
AI_MODEL=llama3

# vLLM behind a gateway that needs a token
AI_PROVIDER=vllm
AI_BASE_URL=http://vllm.internal:8000
AI_MODEL=meta-llama/Llama-3.1-8B-Instruct
AI_API_KEY=...
```
