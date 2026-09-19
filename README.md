# No You Do Not

A local-first Firefox extension for controlling browsing with **natural-language intentions**, rather than a growing list of brittle URL rules.

<table>
  <tr>
    <td>
      <img width="100%" alt="annotate-2026-09-19_12-20-54"
           src="https://github.com/user-attachments/assets/e213cc1c-698e-4802-9bc5-58e3fa9bee1e" />
    </td>
    <td>
      <img width="100%" alt="image"
           src="https://github.com/user-attachments/assets/3fee9446-f0c6-43d2-ad56-0630857b334c" />
    </td>
  </tr>
  <tr>
    <td>
      <img width="100%" alt="image"
           src="https://github.com/user-attachments/assets/93517c0e-76df-4f11-8560-ba76fa912e2e" />
    </td>
    <td>
      <img width="100%" alt="image"
           src="https://github.com/user-attachments/assets/a299ee17-0dc2-4989-bede-d361d9338522" />
    </td>
  </tr>
</table>


[TypeSafe Jev](https://typesafe.ai) makes fast, typed semantic judgments about a visit or feed item. Ordinary code keeps time, applies confidence thresholds, and decides whether to allow, nudge, ask for reflection, or block. An optional generative LLM handles the conversational intervention that Jev is not designed to provide.

## What is implemented

- **Active browsing statistics** — time per hostname, site opens, and a 90-day local history. Time accrues only while Firefox is focused, the user is not idle, and the tab is active.
- **Layered intentions** — durable “always,” current day, current ISO week, and active project descriptions.
- **Semantic site decisions** — Jev classifies each visit as supporting, purposeful, intentional leisure, likely drift, or conflicting. It also classifies the destination as a useful tool, mixed-use site, or attention sink.
- **Confidence-gated consequences** — uncertain model results fail open. Observe, balanced, and strict policy modes turn typed judgments into deterministic behavior.
- **YouTube and X/Twitter algorithms** — visible videos/posts are batch-classified for disposition, informative value, and topic fit. Items can be badged, blurred, or hidden. “Show once,” “Good filter,” and “Less like this” feedback becomes examples for later calls.
- **Conversational intervention** — optionally require 2–6 meaningful messages with an OpenAI-compatible LLM before continuing. Provider outages have an explicit five-minute fail-open; the extension never silently traps a tab.
- **Editable safe destinations** — domains such as Notion and Google Docs are never interrupted by default.
- **Local dashboard** — attention totals, recent Jev judgments, intent editors, algorithm controls, connection health, export, and deletion.

## Why there is a companion bridge

Provider keys should not be embedded in browser JavaScript. The included Node bridge:

1. binds only to `127.0.0.1`;
2. requires a separate random bridge token;
3. accepts browser calls only from extension origins;
4. keeps TypeSafe and LLM keys in environment variables;
5. uses the official `@typesafe-ai/sdk` package.

The extension itself is restricted to a localhost bridge. See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Setup

### 1. Configure the bridge

Node.js 20 or newer is required.

```bash
npm install
cp .env.example .env
openssl rand -hex 24
```

Put the generated value in `NOYOUDONOT_BRIDGE_TOKEN`, then add a TypeSafe key from [console.typesafe.ai](https://console.typesafe.ai):

```dotenv
TYPESAFE_API_KEY=sk_...
TYPESAFE_MODEL=jev-latest
NOYOUDONOT_BRIDGE_TOKEN=the_random_value
PORT=4317
```

For conversational interventions, also configure any OpenAI-compatible chat endpoint:

```dotenv
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=...
LLM_MODEL=gpt-4o-mini
```

A local endpoint can omit `LLM_API_KEY`. `LLM_BASE_URL` may end in `/v1` or `/chat/completions`.

Start the bridge and leave it running:

```bash
npm start
```

### 2. Load the Firefox extension

Firefox 142 or newer is required so Firefox can show its built-in data-transmission consent during installation.

For development:

```bash
npm run dev:firefox
```

Or load it manually:

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select [`extension/manifest.json`](extension/manifest.json).

Firefox opens the dashboard after installation.

### 3. Connect it

In **AI connection**:

- leave the URL as `http://127.0.0.1:4317` unless `PORT` changed;
- paste the same `NOYOUDONOT_BRIDGE_TOKEN` value;
- select **Test connection**;
- save changes.

Provider keys are never entered into Firefox.

## How decisions work

### Site visits

The extension computes exact time/open totals in code and sends Jev a small state containing:

- hostname, query-free path, and title;
- active intentions;
- named time-of-day bucket;
- computed usage totals.

One Jev call asks independent Choice, Noul, and Score questions, including a direct check for whether an active intention explicitly disallows the visit at the exact local time. The extension then applies this policy:

- a sufficiently certain explicit restriction → chat when the barrier is enabled; otherwise nudge or block by mode;
- supporting, evidenced-purposeful, or explicitly appropriate leisure → allow;
- likely drift → nudge, or chat in strict mode;
- conflict → chat when the barrier is enabled; otherwise nudge or block by mode;
- uncertain AI judgments → always allow.

Protected domains and temporary user grants are deterministic safety controls, not semantic browsing rules.

### Feeds

The content script observes nearby YouTube/X cards and sends small batches to Jev. For every item, one request asks:

- Choice: promote, allow, or limit;
- Score: informative/lasting value from 0–3;
- Noul: probability of matching a requested topic or value.

Code combines those typed answers with confidence and strictness settings. Page content is marked as untrusted state, but model classifiers can still be wrong; feedback and conservative thresholds matter.

### Intervention chat

Jev does not generate prose, so it is not used as a chatbot. The optional LLM asks for a concrete purpose, why it matters now, and a stopping point. The minimum turn count is enforced by the background script, not left to the model.

## Commands

```bash
npm start          # run the localhost bridge
npm run dev:firefox # launch a temporary Firefox profile with web-ext
npm test           # unit and bridge integration tests (no provider calls)
npm run lint       # Firefox manifest lint + static validation
npm run check      # lint and test
npm run build      # create an unsigned .zip in artifacts/
```

## Project layout

```text
extension/
  background/      tracking, classification, policy application, gates
  content/         YouTube and X/Twitter feed adapter
  gate/            nudge/block/reflection page
  options/         dashboard and intent editor
  popup/           current-site summary
  shared/          defaults, time helpers, pure policy functions
server/             localhost TypeSafe + LLM bridge
scripts/            static extension validation
test/               policy, time, Jev shape, LLM, and HTTP tests
```

## Permissions

- `tabs`, `webNavigation`: determine the active hostname/title and count top-level visits.
- `idle`, `alarms`: count focused, non-idle time without relying on a permanently running page.
- `storage`: keep local settings and aggregate history.
- Host access is limited to localhost plus YouTube, X, and Twitter. The latter three are needed for feed content scripts.
- Firefox's built-in consent declares `browsingActivity`, `websiteContent`, and `personalCommunications`, because the user-directed workflow transmits visit metadata/feed cards to Jev and reflection text to the configured LLM. There is no project-operated telemetry.

## Current limitations

- YouTube and X frequently change their DOM; card selectors may need maintenance.
- A newly classified navigation can render briefly before the extension replaces it with an intervention page.
- Temporary add-ons disappear when Firefox closes. Sign the built package for permanent installation.
- Jev and the selected LLM are external services with their own availability, cost, and data policies.
- This is a behavior-support tool, not a parental-control or tamper-resistant security boundary. Users can always disable the add-on.

## License

MIT
