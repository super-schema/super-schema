# AI assistant setup

Natural-language entity creation and field suggestions call the AI endpoint configured by a platform administrator in **Admin > AI**. Domain and entity context is sent to that endpoint.

## Providers

| Provider | Configuration | Request |
| --- | --- | --- |
| Ollama | Server root and optional model (default llama3) | POST /api/generate |
| vLLM / OpenAI-compatible | Server root and optional model | POST /v1/completions |
| Custom | Full Chat Completions endpoint and required model | POST to the exact endpoint |

Ollama and vLLM base URLs have trailing slashes and /v1 removed. Custom endpoints retain their path and non-secret query parameters, including API-version parameters.

## Custom integration

1. Select **Custom provider** and enter the full endpoint, for example https://gateway.example.com/v1/chat/completions.
2. Enter the model identifier accepted by the integration.
3. Optionally enter a bearer API key. For other authentication schemes, project IDs, or organization IDs, supply **Additional headers** as a JSON object with string values.
4. **Test connection** submits a small chat request using the current form values. It checks endpoint, model, and authentication together and may consume a small number of tokens.
5. **Save** makes the configuration available to entity creation, field suggestions, and AI import enhancement.

Custom generation omits `temperature` by default, matching the connection test, because some models reject sampling parameters. Internal callers can explicitly supply a temperature for endpoints that support it.

Custom integrations must implement the [OpenAI Chat Completions request and response format](https://developers.openai.com/api/reference/resources/chat). Other protocols or automatic OAuth token exchange require an adapter. Custom requests and their connection tests time out after 30 seconds. Ollama/vLLM model-list tests time out after 3 seconds. Custom requests and connection tests do not follow redirects.

## Credentials

Custom keys and integration headers are encrypted at rest using the existing secret-box mechanism: SECRETS_ENCRYPTION_KEY, falling back to AUTH_SECRET / NEXTAUTH_SECRET. Reads return presence flags; saved secrets are never shown in the form or included in audit entries.

- Leave credential fields blank to keep the saved values for the same endpoint.
- Enter {} in Additional headers to clear the headers.
- Choose **Remove saved credentials on save** to clear the saved key and headers.
- Changing endpoint or provider discards its saved credentials. Enter credentials again for the new endpoint.
- A saved custom endpoint never receives AI_API_KEY implicitly.
- Place secrets in credential fields or headers; URL credentials, secret query parameters, and fragments are rejected.

Deploy the additive credentials migration before using the updated application:

    npm run db:deploy

## Environment configuration

| Variable | Meaning |
| --- | --- |
| AI_PROVIDER | ollama, vllm, or custom (case-insensitive) |
| AI_BASE_URL | Server root for Ollama/vLLM; full endpoint for custom |
| AI_MODEL | Model identifier, default llama3 for Ollama/vLLM; required for custom |
| AI_API_KEY | Optional bearer token for environment configuration and legacy provider overrides |
| OLLAMA_HOST | Ollama fallback when AI_BASE_URL is unset; accepts host:port or a URL |
| OPENAI_BASE_URL | vLLM fallback when AI_BASE_URL is unset |

OPENAI_API_KEY and ANTHROPIC_API_KEY are not read automatically.

A complete saved configuration wins over the environment. Otherwise AI_PROVIDER plus AI_BASE_URL applies, followed by the Ollama/vLLM fallback. If the database cannot be read, the environment decides. If saved credentials cannot be decrypted, AI is unavailable until the credentials are repaired. **Clear saved settings** removes the override and its credentials.

Changes are audited with provider, URL, and model only. Editing the endpoint requires ai.manage (a platform administrator); the server fetches the configured HTTP(S) address.
