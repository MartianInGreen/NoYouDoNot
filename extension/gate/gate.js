import { percent } from "../shared/ui.js";

const id = new URLSearchParams(location.search).get("id") || "";
let gate;
let sending = false;
let countdownTimer;

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
  intentLabel: document.querySelector("#intent-label"),
  reminder: document.querySelector("#intent-reminder"),
  chat: document.querySelector("#chat"),
  messages: document.querySelector("#messages"),
  reflectionStatus: document.querySelector("#reflection-status"),
  assessment: document.querySelector("#assessment"),
  reasonWeight: document.querySelector("#reason-weight"),
  reasonBar: document.querySelector("#reason-bar"),
  conflictWeight: document.querySelector("#conflict-weight"),
  conflictBar: document.querySelector("#conflict-bar"),
  form: document.querySelector("#chat-form"),
  input: document.querySelector("#chat-input"),
  send: document.querySelector("#send"),
  hint: document.querySelector("#chat-hint"),
  leave: document.querySelector("#leave"),
  continue: document.querySelector("#continue"),
  fallback: document.querySelector("#fallback"),
  warning: document.querySelector("#conflict-warning"),
  warningCopy: document.querySelector("#warning-copy"),
  warningReasonWeight: document.querySelector("#warning-reason-weight"),
  warningConflictWeight: document.querySelector("#warning-conflict-weight"),
  warningCountdown: document.querySelector("#warning-countdown"),
  warningLeave: document.querySelector("#warning-leave"),
  warningContinue: document.querySelector("#warning-continue")
};

void load();

elements.form.addEventListener("submit", sendChat);
elements.leave.addEventListener("click", closeTab);
elements.warningLeave.addEventListener("click", closeTab);
document.querySelector("#error-close").addEventListener("click", closeTab);
document.querySelector("#settings").addEventListener("click", () => send({ type: "OPEN_OPTIONS" }));
elements.continue.addEventListener("click", () => continueVisit(false));
elements.warningContinue.addEventListener("click", () => continueVisit(false));
elements.fallback.addEventListener("click", () => continueVisit(true));
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.form.requestSubmit();
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && gate?.warningRequired) updateWarningCountdown();
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
  const restrictionReason = ["explicit_restriction", "specific_restriction"].includes(
    gate.outcome?.reason
  );
  const displayedFit =
    gate.decision?.effectivePolicy?.choice === "general_guidance" &&
    fit?.choice === "conflicts" &&
    gate.outcome?.reason === "likely_drift"
      ? "likely_drift"
      : fit?.choice;
  elements.hostname.textContent = gate.hostname;
  elements.title.textContent = gate.title || "Untitled page";
  elements.fit.textContent = restrictionReason
    ? "specific restriction"
    : label(displayedFit || "unknown");
  elements.kind.textContent = label(kind?.choice || "unknown");
  elements.confidence.textContent = percent(
    gate.outcome?.reason === "specific_restriction"
      ? gate.decision?.effectivePolicy?.confidence
      : gate.outcome?.reason === "explicit_restriction"
        ? gate.decision?.explicitlyDisallowed
        : fit?.confidence
  );
  elements.explanation.textContent = explanationText(
    displayedFit,
    kind?.choice,
    action,
    gate.outcome?.reason,
    gate.decision
  );

  const intent = governingIntentText(gate);
  if (intent) {
    elements.intentLabel.textContent = governingIntentLabel(gate.decision);
    elements.intentText.textContent = `“${intent}”`;
  } else {
    elements.reminder.hidden = true;
  }

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
    renderChatState();
    if (!gate.reasonAccepted) setTimeout(() => elements.input.focus(), 50);
  } else {
    elements.eyebrow.textContent = "STRICT BOUNDARY";
    elements.heading.textContent = "This visit conflicts with your stated intent.";
    elements.continue.hidden = true;
  }
}

async function sendChat(event) {
  event.preventDefault();
  if (sending || gate?.reasonAccepted) return;
  const text = elements.input.value.trim();
  if (!text) {
    elements.hint.textContent = "Please enter a reason for this visit.";
    elements.input.focus();
    return;
  }
  sending = true;
  elements.send.disabled = true;
  elements.input.disabled = true;
  elements.hint.textContent = "Getting a response, then asking Jev to weigh your reason…";
  elements.reflectionStatus.className = "reflection-status";
  elements.reflectionStatus.textContent = "Checking this exchange…";
  addMessage("user", text);
  elements.input.value = "";

  const response = await send({ type: "GATE_CHAT", id, text });
  sending = false;
  if (!response?.ok) {
    addMessage("error", response?.error || "The reflection services are unavailable.");
    elements.hint.textContent =
      "A provider could not respond. You can retry or use the visible fail-open.";
    elements.reflectionStatus.className = "reflection-status more";
    elements.reflectionStatus.textContent = "Check unavailable";
    setComposerEnabled(true);
    elements.fallback.hidden = false;
    elements.input.focus();
    return;
  }

  addMessage("assistant", response.reply);
  if (response.gate) gate = response.gate;
  renderChatState();
  if (response.assessmentUnavailable) {
    elements.hint.textContent =
      "Jev could not weigh this exchange. You can try again or use the visible fail-open.";
  }
  if (!gate.reasonAccepted) elements.input.focus();
}

function renderChatState() {
  const assessment = gate.assessment;
  elements.fallback.hidden = !(Number(gate.chatFailures || 0) > 0);
  elements.continue.disabled = !gate.canContinue || Boolean(gate.warningRequired);

  if (!assessment) {
    elements.assessment.hidden = true;
    elements.reflectionStatus.className = "reflection-status";
    elements.reflectionStatus.textContent = gate.chatFailures
      ? "Check unavailable"
      : "Jev checks each exchange";
    elements.form.hidden = false;
    setComposerEnabled(true);
    return;
  }

  elements.assessment.hidden = false;
  elements.reasonWeight.textContent = percent(assessment.reasonExplained);
  elements.conflictWeight.textContent = percent(assessment.reasonConflicts);
  elements.reasonBar.style.width = weightWidth(assessment.reasonExplained);
  elements.conflictBar.style.width = weightWidth(assessment.reasonConflicts);

  if (!gate.reasonAccepted) {
    elements.reflectionStatus.className = "reflection-status more";
    elements.reflectionStatus.textContent = "More clarity needed";
    elements.hint.textContent = `${percent(assessment.reasonExplained)} explained. Add the concrete purpose, why now, or a stopping point.`;
    elements.form.hidden = false;
    setComposerEnabled(true);
    return;
  }

  elements.form.hidden = true;
  setComposerEnabled(false);
  elements.reflectionStatus.className = "reflection-status ready";
  elements.reflectionStatus.textContent = gate.warningRequired
    ? "Explained · conflict remains"
    : "Reason explained";

  if (gate.warningRequired) {
    elements.hint.textContent = "Your reason is clear, but Jev still finds a strong conflict.";
    openConflictWarning();
  } else {
    elements.hint.textContent =
      "Jev finds your reason sufficiently explained. You may continue or close the tab.";
    elements.continue.disabled = false;
  }
}

function setComposerEnabled(enabled) {
  elements.input.disabled = !enabled;
  elements.send.disabled = !enabled;
}

function openConflictWarning() {
  elements.warning.hidden = false;
  document.body.classList.add("warning-open");
  elements.warningReasonWeight.textContent = percent(gate.assessment?.reasonExplained);
  elements.warningConflictWeight.textContent = percent(gate.assessment?.reasonConflicts);
  elements.warningCopy.textContent = `Jev found a clear explanation, but its ${percent(
    gate.assessment?.reasonConflicts
  )} conflict weight still points away from your active intentions. The pause scales with that weight and is capped by your settings.`;
  clearInterval(countdownTimer);
  updateWarningCountdown();
  if (gate.waitRemainingSeconds > 0) {
    elements.warningLeave.focus();
    countdownTimer = setInterval(updateWarningCountdown, 1000);
  } else {
    elements.warningContinue.focus();
  }
}

function updateWarningCountdown() {
  if (!gate?.warningRequired) return;
  const remaining = Math.max(0, Math.ceil((Number(gate.waitUntil || 0) - Date.now()) / 1000));
  gate.waitRemainingSeconds = remaining;
  if (remaining > 0) {
    elements.warningCountdown.textContent = `${remaining} second${remaining === 1 ? "" : "s"}`;
    elements.warningContinue.textContent = `Continue in ${remaining}s`;
    elements.warningContinue.disabled = true;
    return;
  }

  clearInterval(countdownTimer);
  countdownTimer = undefined;
  gate.canContinue = true;
  elements.warningCountdown.textContent = "one final moment";
  elements.warningContinue.textContent = "Continue despite the conflict";
  elements.warningContinue.disabled = false;
}

function weightWidth(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0%";
  return `${Math.round(Math.min(1, Math.max(0, number)) * 100)}%`;
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
  elements.warningContinue.disabled = true;
  elements.fallback.disabled = true;
  const response = await send({ type: "GATE_CONTINUE", id, fallback });
  if (!response?.ok) {
    const message = response?.error || "Could not continue.";
    addMessage("error", message);
    if (gate?.warningRequired) elements.warningCopy.textContent = message;
    elements.continue.disabled = !gate?.canContinue;
    elements.fallback.disabled = false;
    updateWarningCountdown();
  }
}

async function closeTab() {
  elements.leave.disabled = true;
  elements.warningLeave.disabled = true;
  const response = await send({ type: "GATE_CLOSE", id });
  if (!response?.ok) showError(response?.error || "Could not close the tab.");
}

function showError(message) {
  clearInterval(countdownTimer);
  document.body.classList.remove("warning-open");
  elements.warning.hidden = true;
  elements.loading.hidden = true;
  elements.card.hidden = true;
  elements.error.hidden = false;
  elements.errorText.textContent = message;
}

function label(value) {
  return String(value || "").replaceAll("_", " ");
}

function governingIntentText(value) {
  if (value.decision?.effectivePolicy?.choice === "general_guidance" && value.intents?.always) {
    return value.intents.always;
  }
  const source = value.decision?.governingIntent?.choice;
  if (!source) {
    return value.intents?.daily || value.intents?.weekly || value.intents?.always || "";
  }
  if (source === "always") return value.intents?.always || "";
  if (source === "daily") return value.intents?.daily || "";
  if (source === "weekly") return value.intents?.weekly || "";
  if (source.startsWith("project_")) {
    const index = Number(source.slice("project_".length));
    return value.intents?.projects?.[index]?.intent || "";
  }
  return "";
}

function governingIntentLabel(decision) {
  const localTime = decision?.evaluatedLocalTime;
  const suffix = localTime ? ` AT ${localTime}` : "";
  if (decision?.effectivePolicy?.choice === "specific_restriction") {
    return `APPLICABLE RESTRICTION${suffix}`;
  }
  if (decision?.effectivePolicy?.choice === "specific_allowance") {
    return `APPLICABLE CARVE-OUT${suffix}`;
  }
  if (decision?.effectivePolicy?.choice === "general_guidance") {
    return `BROADER GUIDANCE${suffix}`;
  }
  return `MOST RELEVANT GUIDANCE${suffix}`;
}

function explanationText(fit, kind, action, reason, decision) {
  const localTime = decision?.evaluatedLocalTime;
  const policy = decision?.effectivePolicy?.choice;
  const policyText = policy === "general_guidance" && localTime
    ? `At ${localTime}, no specific prohibition or carve-out controls this visit; only broader guidance applies. `
    : policy === "specific_restriction" && localTime
      ? `After applying specific carve-outs, a restriction still applies at ${localTime}. `
      : "";
  const fitText = reason === "explicit_restriction"
    ? "An active intention explicitly disallows this kind of visit at the current local time."
    : reason === "specific_restriction"
      ? ""
      : {
          likely_drift: "Jev sees signs of habitual or open-ended browsing rather than a clear current purpose.",
          conflicts: "Jev sees this visit as opposed to the applicable intention guidance.",
          intentional_leisure: "Jev sees this as leisure that may fit the context you described.",
          purposeful: "Jev sees evidence of a deliberate purpose.",
          supports: "Jev sees this visit as supportive of an active goal."
        }[fit] || "Jev compared this visit with your active intentions.";
  const kindText = kind === "attention_sink"
    ? " The destination is usually optimized for continued consumption."
    : kind === "mixed_use"
      ? " The destination can be useful or distracting depending on why you opened it."
      : " The destination is usually a functional tool.";
  const actionText = action === "chat"
    ? " Explain the visit clearly before access."
    : action === "block"
      ? " Strict mode is holding this boundary."
      : " You can make an explicit choice now.";
  return `${policyText}${fitText}${kindText}${actionText}`;
}

async function send(message) {
  try {
    return await browser.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
