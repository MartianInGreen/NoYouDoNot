import { percent } from "../shared/ui.js";

const id = new URLSearchParams(location.search).get("id") || "";
let gate;
let sending = false;

const elements = {
  card: document.querySelector("#gate-card"),
  loading: document.querySelector("#loading"),
  error: document.querySelector("#error"),
  errorText: document.querySelector("#error-text"),
  heading: document.querySelector("#heading"),
  eyebrow: document.querySelector("#eyebrow"),
  hostname: document.querySelector("#hostname"),
  title: document.querySelector("#title"),
  fit: document.querySelector("#fit"),
  kind: document.querySelector("#kind"),
  confidence: document.querySelector("#confidence"),
  explanation: document.querySelector("#explanation"),
  intentText: document.querySelector("#intent-text"),
  reminder: document.querySelector("#intent-reminder"),
  chat: document.querySelector("#chat"),
  messages: document.querySelector("#messages"),
  progress: document.querySelector("#progress"),
  form: document.querySelector("#chat-form"),
  input: document.querySelector("#chat-input"),
  send: document.querySelector("#send"),
  hint: document.querySelector("#chat-hint"),
  leave: document.querySelector("#leave"),
  continue: document.querySelector("#continue"),
  fallback: document.querySelector("#fallback")
};

void load();

elements.form.addEventListener("submit", sendChat);
elements.leave.addEventListener("click", closeTab);
document.querySelector("#error-close").addEventListener("click", closeTab);
document.querySelector("#settings").addEventListener("click", () => send({ type: "OPEN_OPTIONS" }));
elements.continue.addEventListener("click", () => continueVisit(false));
elements.fallback.addEventListener("click", () => continueVisit(true));
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.form.requestSubmit();
  }
});

async function load() {
  const response = await send({ type: "GET_GATE", id });
  if (!response?.ok || !response.gate) {
    return showError(response?.error || "The intervention is no longer active.");
  }
  gate = response.gate;
  render();
}

function render() {
  elements.loading.hidden = true;
  elements.card.hidden = false;
  const action = gate.outcome?.action;
  const fit = gate.decision?.intentFit;
  const kind = gate.decision?.siteKind;
  elements.hostname.textContent = gate.hostname;
  elements.title.textContent = gate.title || "Untitled page";
  elements.fit.textContent = label(fit?.choice || "unknown");
  elements.kind.textContent = label(kind?.choice || "unknown");
  elements.confidence.textContent = percent(fit?.confidence);
  elements.explanation.textContent = explanationText(fit?.choice, kind?.choice, action);

  const intent = gate.intents?.daily || gate.intents?.weekly || gate.intents?.always;
  if (intent) elements.intentText.textContent = `“${intent}”`;
  else elements.reminder.hidden = true;

  if (action === "nudge") {
    elements.eyebrow.textContent = "A MOMENT OF CHOICE";
    elements.heading.textContent = "Is this what you meant to do?";
    elements.continue.disabled = false;
  } else if (action === "chat") {
    elements.eyebrow.textContent = "EXPLAIN BEFORE ENTERING";
    elements.heading.textContent = "Turn the impulse into a decision.";
    elements.chat.hidden = false;
    addMessage(
      "assistant",
      "What did you come here to do, specifically—and why does it matter right now?"
    );
    for (const message of gate.messages || []) addMessage(message.role, message.content);
    renderProgress(gate.chatTurns);
    elements.continue.disabled = gate.chatTurns < gate.minimumChatTurns;
    if (gate.chatFailures > 0) elements.fallback.hidden = false;
    setTimeout(() => elements.input.focus(), 50);
  } else {
    elements.eyebrow.textContent = "STRICT BOUNDARY";
    elements.heading.textContent = "This visit conflicts with your stated intent.";
    elements.continue.hidden = true;
  }
}

async function sendChat(event) {
  event.preventDefault();
  if (sending) return;
  const text = elements.input.value.trim();
  if (text.length < 12) {
    elements.hint.textContent = "Please use at least a short, concrete sentence.";
    elements.input.focus();
    return;
  }
  sending = true;
  elements.send.disabled = true;
  elements.input.disabled = true;
  elements.hint.textContent = "Consulting your reflection model…";
  addMessage("user", text);
  elements.input.value = "";

  const response = await send({ type: "GATE_CHAT", id, text });
  sending = false;
  elements.send.disabled = false;
  elements.input.disabled = false;
  if (!response?.ok) {
    addMessage("error", response?.error || "The reflection model is unavailable.");
    elements.hint.textContent = "The provider could not respond. You can retry or use the visible fail-open.";
    elements.fallback.hidden = false;
    elements.input.focus();
    return;
  }

  addMessage("assistant", response.reply);
  gate.chatTurns = response.chatTurns;
  renderProgress(gate.chatTurns);
  elements.continue.disabled = !response.canContinue;
  elements.hint.textContent = response.canContinue
    ? "You have made the choice explicit. You may continue or close the tab."
    : `${response.remaining} more ${response.remaining === 1 ? "answer" : "answers"} before continuing.`;
  elements.input.focus();
}

function renderProgress(completed) {
  elements.progress.replaceChildren();
  for (let index = 0; index < gate.minimumChatTurns; index += 1) {
    const pip = document.createElement("i");
    if (index < completed) pip.className = "done";
    elements.progress.append(pip);
  }
  elements.progress.setAttribute(
    "aria-label",
    `${Math.min(completed, gate.minimumChatTurns)} of ${gate.minimumChatTurns} reflection messages complete`
  );
}

function addMessage(role, content) {
  const item = document.createElement("div");
  item.className = `message ${role === "user" ? "user" : role === "error" ? "error" : "assistant"}`;
  item.textContent = content;
  elements.messages.append(item);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

async function continueVisit(fallback) {
  elements.continue.disabled = true;
  elements.fallback.disabled = true;
  const response = await send({ type: "GATE_CONTINUE", id, fallback });
  if (!response?.ok) {
    addMessage("error", response?.error || "Could not continue.");
    elements.continue.disabled = false;
    elements.fallback.disabled = false;
  }
}

async function closeTab() {
  elements.leave.disabled = true;
  const response = await send({ type: "GATE_CLOSE", id });
  if (!response?.ok) showError(response?.error || "Could not close the tab.");
}

function showError(message) {
  elements.loading.hidden = true;
  elements.card.hidden = true;
  elements.error.hidden = false;
  elements.errorText.textContent = message;
}

function label(value) {
  return String(value || "").replaceAll("_", " ");
}

function explanationText(fit, kind, action) {
  const fitText = {
    likely_drift: "Jev sees signs of habitual or open-ended browsing rather than a clear current purpose.",
    conflicts: "Jev sees a direct conflict with the intention you wrote.",
    intentional_leisure: "Jev sees this as leisure that may fit the context you described.",
    purposeful: "Jev sees a plausible deliberate purpose.",
    supports: "Jev sees this visit as supportive of an active goal."
  }[fit] || "Jev compared this visit with your active intentions.";
  const kindText = kind === "attention_sink"
    ? " The destination is usually optimized for continued consumption."
    : kind === "mixed_use"
      ? " The destination can be useful or distracting depending on why you opened it."
      : " The destination is usually a functional tool.";
  const actionText = action === "chat"
    ? " A short reflection is required before access."
    : action === "block"
      ? " Strict mode is holding this boundary."
      : " You can make an explicit choice now.";
  return `${fitText}${kindText}${actionText}`;
}

async function send(message) {
  try {
    return await browser.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
