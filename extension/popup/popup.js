import { formatDuration } from "../shared/time.js";

const elements = {
  enabled: document.querySelector("#enabled"),
  hostname: document.querySelector("#hostname"),
  title: document.querySelector("#title"),
  siteIcon: document.querySelector("#site-icon"),
  status: document.querySelector("#status"),
  time: document.querySelector("#time"),
  opens: document.querySelector("#opens"),
  fit: document.querySelector("#fit"),
  note: document.querySelector("#decision-note"),
  pause: document.querySelector("#pause-site"),
  dashboard: document.querySelector("#dashboard"),
  settings: document.querySelector("#settings"),
  connection: document.querySelector("#connection"),
  connectionText: document.querySelector("#connection-text")
};

let current;
void load();

elements.enabled.addEventListener("change", async () => {
  elements.enabled.disabled = true;
  await send({ type: "TOGGLE_ENABLED", enabled: elements.enabled.checked });
  elements.enabled.disabled = false;
});

elements.pause.addEventListener("click", async () => {
  if (!current?.hostname) return;
  elements.pause.disabled = true;
  const response = await send({
    type: "PAUSE_SITE",
    hostname: current.hostname,
    minutes: 15
  });
  elements.pause.textContent = response?.ok ? "Allowed for 15m ✓" : "Could not allow";
});

elements.dashboard.addEventListener("click", openOptions);
elements.settings.addEventListener("click", openOptions);

async function load() {
  const response = await send({ type: "GET_POPUP_DATA" });
  if (!response?.ok) {
    elements.note.textContent = response?.error || "Could not load extension state.";
    return;
  }
  current = response.data;
  render(current);
  checkBridge(current.bridgeConfigured);
}

function render(data) {
  elements.enabled.checked = data.enabled;
  elements.hostname.textContent = data.hostname || "No website selected";
  elements.title.textContent = data.title || "Open a web page to see its activity.";
  elements.siteIcon.textContent = data.hostname ? data.hostname.charAt(0) : "•";
  elements.time.textContent = formatDuration(data.site.seconds || 0);
  elements.opens.textContent = String(data.site.opens || 0);
  elements.pause.disabled = !data.hostname;
  if (data.hasGrant) elements.pause.textContent = "Allowed temporarily ✓";

  const decision = data.lastDecision;
  const fit = decision?.decision?.intentFit;
  if (!fit) {
    elements.fit.textContent = "—";
    if (!data.enabled) {
      elements.status.textContent = "paused";
      elements.status.className = "status-pill";
      elements.note.textContent = "Intent checks and feed filtering are paused.";
    } else if (data.isProtected) {
      elements.status.textContent = "protected";
      elements.status.className = "status-pill good";
      elements.note.textContent =
        "This domain is in your “Never interrupt” list, so it is not sent to Jev.";
    } else {
      elements.status.textContent = "waiting";
      elements.status.className = "status-pill";
      elements.note.textContent =
        "No Jev judgment yet. Reload this tab or navigate to another page to evaluate it.";
    }
    return;
  }

  const labels = {
    supports: "supports",
    purposeful: "purposeful",
    intentional_leisure: "leisure",
    likely_drift: "drift",
    conflicts: "conflict"
  };
  const label = labels[fit.choice] || fit.choice;
  const confidence = Math.round((fit.confidence || 0) * 100);
  const threshold = Math.round((data.siteConfidenceThreshold || 0.62) * 100);
  elements.fit.textContent = `${confidence}%`;
  elements.status.textContent = label;
  elements.status.className = `status-pill ${statusClass(fit.choice)}`;
  const siteKind = String(decision.decision.siteKind?.choice || "site").replaceAll("_", " ");
  if (decision.outcome.reason === "explicit_restriction") {
    const restriction = Math.round(Number(decision.decision.explicitlyDisallowed || 0) * 100);
    elements.note.textContent = `An active intention explicitly disallows this visit now (${restriction}% match). Action: ${decision.outcome.action}.`;
  } else if (decision.outcome.reason === "low_confidence") {
    elements.note.textContent = `Jev marked this visit “${label},” but ${confidence}% classification confidence is below your ${threshold}% threshold, so no interruption was applied.`;
  } else if (["supports", "purposeful", "intentional_leisure"].includes(decision.outcome.reason)) {
    elements.note.textContent = `Jev marked this visit “${label}” (${confidence}% confidence). That classification allows the visit; the threshold only gates potential interruptions.`;
  } else {
    elements.note.textContent = `Jev marked this visit “${label}” and the destination “${siteKind}.” ${decision.outcome.action === "allow" ? "Allowed by your current policy." : `Action: ${decision.outcome.action}.`}`;
  }
}

async function checkBridge(configured) {
  if (!configured) {
    elements.connection.className = "connection offline";
    elements.connectionText.textContent = "Local bridge needs setup";
    return;
  }
  const response = await send({ type: "TEST_BRIDGE" });
  if (response?.ok && response.health?.jev?.configured) {
    elements.connection.className = "connection online";
    elements.connectionText.textContent = `Jev connected · ${response.health.jev.model}`;
  } else {
    elements.connection.className = "connection offline";
    elements.connectionText.textContent = response?.error || "Jev is not configured";
  }
}

function statusClass(choice) {
  if (choice === "supports" || choice === "purposeful") return "good";
  if (choice === "intentional_leisure" || choice === "likely_drift") return "warn";
  if (choice === "conflicts") return "stop";
  return "";
}

async function openOptions() {
  await send({ type: "OPEN_OPTIONS" });
  window.close();
}

async function send(message) {
  try {
    return await browser.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
