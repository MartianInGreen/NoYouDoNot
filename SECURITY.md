# Security notes

- The companion service binds to `127.0.0.1` only.
- Every route requires `NOYOUDONOT_BRIDGE_TOKEN`; use a random value of at least 16 characters.
- Browser requests are accepted only from extension origins. The bridge has body-size and rate limits.
- TypeSafe and LLM API keys remain in the server environment, not extension storage.
- The packaged extension permits bridge traffic only to `localhost`/`127.0.0.1`.
- Site URLs are stripped to hostname and path before leaving the browser. Query strings and fragments are not sent.
- Feed and page content is explicitly marked as untrusted in model state. Model judgments are still fallible; disruptive actions are confidence-gated and provider failures fail open.

Do not expose the bridge port to a LAN or public interface. Do not reuse the bridge token as an API key or account password.

Report vulnerabilities through a private security advisory when this repository is hosted on GitHub.
