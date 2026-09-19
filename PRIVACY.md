# Privacy and data flow

No You Do Not is local-first.

## Kept in Firefox

The extension stores:

- aggregate active-tab time and open counts by hostname and day;
- natural-language intentions and policy settings;
- recent typed Jev decisions and confidence values;
- YouTube/X feedback examples;
- short-lived access grants, classification cache entries, and pending intervention state.

Activity is retained for up to 90 days. **Data & privacy → Clear local activity** removes activity, decisions, feedback, and caches while retaining settings.

## Sent for classification

The extension connects only to the configured loopback bridge (`127.0.0.1` or `localhost`) using a separate bridge token. Provider API keys stay in the bridge process and are never stored in Firefox.

For a site judgment, the bridge receives and sends to TypeSafe Jev:

- hostname;
- URL path, with query string and fragment removed;
- page title;
- active intentions;
- local time bucket and code-computed aggregate usage totals.

For YouTube and X/Twitter classification, the bridge receives visible item title/text, author/channel, metadata, a query-free content path, the platform algorithm description, and a small set of user feedback examples. That material is sent to Jev.

When the optional reflection barrier is used, the visit hostname/title, active intentions, and intervention conversation are sent to the OpenAI-compatible LLM endpoint configured on the bridge.

## Never collected by this project

The extension does not collect page bodies outside supported YouTube/X feed cards, cookies, form fields, passwords, browsing queries, or keystrokes on ordinary pages. It has no project-operated analytics or telemetry endpoint.

Provider retention and training policies are controlled by TypeSafe and the LLM provider chosen by the user. Review those policies before connecting accounts or entering sensitive text.
