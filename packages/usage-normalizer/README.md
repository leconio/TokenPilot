# Usage normalizer

This pure package converts the canonical, privacy-safe `UsageEvent` into one `NormalizedUsage`
record with mutually exclusive usage lines. It has no database or queue dependency.

The LiteLLM adapter accepts only canonical events and preserves missing versus explicit zero fields
and content-free source paths. Connectors split inclusive Provider totals before event creation and
keep gateway response cache separate from Provider prompt cache. Prompt, response, messages,
headers, and credentials are never valid usage content.
