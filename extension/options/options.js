import { mergeSettings } from "../shared/defaults.js";
import { formatDuration, isoWeekKey, localDateKey, recentDateKeys } from "../shared/time.js";

let dashboard;
let settings;
let period = 1;
let projects = [];
let toastTimer;

const byId = (id) => document.getElementById(id);
const controls = {
  enabled: byId("enabled"),
  always: byId("always-intent"),
  daily: byId("daily-intent"),
  weekly: byId("weekly-intent"),
  projectList: byId("project-list"),
  enforcement: byId("enforcement"),
  interventionEnabled: byId("intervention-enabled"),
  minimumTurns: byId("minimum-turns"),
  siteThreshold: byId("site-threshold"),
  grantMinutes: byId("grant-minutes"),
  protectedDomains: byId("protected-domains"),
  bridgeUrl: byId("bridge-url"),
  bridgeToken: byId("bridge-token")
};

void load();

byId("save").addEventListener("click", save);
byId("add-project").addEventListener("click", addProject);
byId("test-bridge").addEventListener("click", testBridge);
byId("export-data").addEventListener("click", exportData);
byId("clear-data").addEventListener("click", clearData);
controls.projectList.addEventListener("click", onProjectClick);

document.querySelectorAll("[data-period]").forEach((button) => {
  button.addEventListener("click", () => {
    period = Number(button.dataset.period);
    document.querySelectorAll("[data-period]").forEach((item) =>
      item.classList.toggle("selected", item === button)
    );
    renderOverview();
  });
});

document.querySelectorAll('input[type="range"]').forEach((input) => {
  input.addEventListener("input", updateRangeOutputs);
});

document.querySelectorAll("nav a").forEach((link) => {
  link.addEventListener("click", () => {
    document.querySelectorAll("nav a").forEach((item) => item.classList.remove("active"));
    link.classList.add("active");
  });
});

async function load() {
  const response = await send({ type: "GET_DASHBOARD" });
  if (!response?.ok) {
    toast(response?.error || "Could not load dashboard.", true);
    return;
  }
  dashboard = response.data;
  settings = mergeSettings(dashboard.settings);
  projects = settings.projects.map((project) => ({ ...project }));
  populateForm();
  renderOverview();
  renderDecisions();
  renderProjects();
  renderFeedback();
  await refreshConnection();
}

function populateForm() {
  controls.enabled.checked = settings.enabled;
  controls.always.value = settings.alwaysIntent;
  controls.daily.value = settings.dailyIntent?.date === localDateKey() ? settings.dailyIntent.text : "";
  controls.weekly.value = settings.weeklyIntent?.week === isoWeekKey() ? settings.weeklyIntent.text : "";
  byId("daily-label").textContent = `Active for ${localDateKey()}.`;
  byId("weekly-label").textContent = `Active for ${isoWeekKey()}.`;

  controls.enforcement.value = settings.sitePolicy.enforcement;
  controls.interventionEnabled.checked = settings.sitePolicy.interventionEnabled;
  controls.minimumTurns.value = String(settings.sitePolicy.minimumChatTurns);
  controls.siteThreshold.value = String(Math.round(settings.sitePolicy.confidenceThreshold * 100));
  controls.grantMinutes.value = String(settings.sitePolicy.grantMinutes);
  controls.protectedDomains.value = settings.sitePolicy.protectedDomains.join("\n");
  controls.bridgeUrl.value = settings.bridge.url;
  controls.bridgeToken.value = settings.bridge.token;

  for (const platform of ["youtube", "twitter"]) {
    const algorithm = settings.algorithms[platform];
    byId(`${platform}-enabled`).checked = algorithm.enabled;
    byId(`${platform}-intent`).value = algorithm.intent;
    byId(`${platform}-display`).value = algorithm.display;
    byId(`${platform}-strictness`).value = algorithm.strictness;
    byId(`${platform}-threshold`).value = String(Math.round(algorithm.confidenceThreshold * 100));
  }
  updateRangeOutputs();
}

function collectSettings() {
  collectProjectsFromDom();
  const next = mergeSettings(settings);
  next.enabled = controls.enabled.checked;
  next.alwaysIntent = controls.always.value.trim();
  next.dailyIntent = {
    text: controls.daily.value.trim(),
    date: controls.daily.value.trim() ? localDateKey() : ""
  };
  next.weeklyIntent = {
    text: controls.weekly.value.trim(),
    week: controls.weekly.value.trim() ? isoWeekKey() : ""
  };
  next.projects = projects;
  next.sitePolicy = {
    ...next.sitePolicy,
    enforcement: controls.enforcement.value,
    interventionEnabled: controls.interventionEnabled.checked,
    minimumChatTurns: Number(controls.minimumTurns.value),
    confidenceThreshold: Number(controls.siteThreshold.value) / 100,
    grantMinutes: Number(controls.grantMinutes.value),
    protectedDomains: controls.protectedDomains.value
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean)
  };
  for (const platform of ["youtube", "twitter"]) {
    next.algorithms[platform] = {
      ...next.algorithms[platform],
      enabled: byId(`${platform}-enabled`).checked,
      intent: byId(`${platform}-intent`).value.trim(),
      display: byId(`${platform}-display`).value,
      strictness: byId(`${platform}-strictness`).value,
      confidenceThreshold: Number(byId(`${platform}-threshold`).value) / 100
    };
  }
  next.bridge = {
    url: controls.bridgeUrl.value.trim(),
    token: controls.bridgeToken.value.trim()
  };
  return next;
}

async function save() {
  const button = byId("save");
  button.disabled = true;
  button.textContent = "Saving…";
  const response = await send({ type: "SAVE_SETTINGS", settings: collectSettings() });
  button.disabled = false;
  button.textContent = "Save changes";
  if (!response?.ok) return toast(response?.error || "Could not save settings.", true);
  settings = mergeSettings(response.settings);
  projects = settings.projects.map((project) => ({ ...project }));
  toast("Changes saved. New judgments will use your updated intent.");
  await refreshConnection();
}

function renderOverview() {
  if (!dashboard) return;
  const keys = recentDateKeys(period);
  const sites = new Map();
  let opens = 0;
  let interventions = 0;
  let filtered = 0;
  for (const key of keys) {
    const day = dashboard.stats.days?.[key];
    if (!day) continue;
    interventions += Number(day.interventions || 0);
    filtered += Number(day.feed?.youtube?.limited || 0) + Number(day.feed?.twitter?.limited || 0);
    for (const [hostname, value] of Object.entries(day.sites || {})) {
      const current = sites.get(hostname) || { seconds: 0, opens: 0 };
      current.seconds += Number(value.seconds || 0);
      current.opens += Number(value.opens || 0);
      sites.set(hostname, current);
      opens += Number(value.opens || 0);
    }
  }
  const totalSeconds = [...sites.values()].reduce((sum, value) => sum + value.seconds, 0);
  byId("summary-time").textContent = formatDuration(totalSeconds);
  byId("summary-opens").textContent = String(opens);
  byId("summary-interventions").textContent = String(interventions);
  byId("summary-filtered").textContent = String(filtered);
  byId("site-count").textContent = `${sites.size} site${sites.size === 1 ? "" : "s"}`;

  const chart = byId("site-chart");
  const sorted = [...sites.entries()].sort((a, b) => b[1].seconds - a[1].seconds).slice(0, 8);
  if (!sorted.length) {
    chart.className = "site-chart empty-state";
    chart.textContent = "No browsing activity recorded yet.";
    return;
  }
  const maximum = sorted[0][1].seconds || 1;
  chart.className = "site-chart";
  chart.replaceChildren(
    ...sorted.map(([hostname, value]) => {
      const row = makeElement("div", "site-row");
      const name = makeElement("span", "site-name", hostname);
      name.title = hostname;
      const bar = makeElement("span", "site-bar");
      const fill = document.createElement("i");
      fill.style.width = `${Math.max(2, (value.seconds / maximum) * 100)}%`;
      bar.append(fill);
      row.append(name, bar, makeElement("span", "site-value", formatDuration(value.seconds)));
      return row;
    })
  );
}

function renderDecisions() {
  const list = byId("recent-decisions");
  const decisions = (dashboard.decisions || []).filter((value) => value.type === "site").slice(0, 7);
  if (!decisions.length) {
    list.className = "decision-list empty-state";
    list.textContent = "No decisions yet. Navigate to a site after connecting Jev.";
    return;
  }
  list.className = "decision-list";
  list.replaceChildren(
    ...decisions.map((decision) => {
      const fit = String(decision.decision?.intentFit?.choice || "unknown").replaceAll("_", " ");
      const action = decision.outcome?.action || "allow";
      const row = makeElement("div", "decision-item");
      const bullet = makeElement("span", "decision-bullet");
      bullet.classList.add(action);
      const copy = document.createElement("span");
      copy.append(
        makeElement("strong", "", decision.hostname),
        makeElement("small", "", `${fit} → ${action}`)
      );
      const time = makeElement("time", "", relativeTime(decision.timestamp));
      row.append(bullet, copy, time);
      return row;
    })
  );
}

function renderProjects() {
  if (!projects.length) {
    controls.projectList.replaceChildren(
      makeElement(
        "div",
        "project-empty",
        "No active projects yet. Add one to give Jev more specific context."
      )
    );
    return;
  }
  controls.projectList.replaceChildren(
    ...projects.map((project, index) => {
      const card = makeElement("div", "project-card");
      card.dataset.index = String(index);

      const active = document.createElement("input");
      active.className = "project-active";
      active.type = "checkbox";
      active.checked = project.active;
      active.setAttribute("aria-label", "Project is active");

      const name = document.createElement("input");
      name.className = "project-name";
      name.type = "text";
      name.value = project.name;
      name.placeholder = "Project name";
      name.setAttribute("aria-label", "Project name");

      const intent = document.createElement("textarea");
      intent.className = "project-intent";
      intent.rows = 2;
      intent.value = project.intent;
      intent.placeholder = "What does useful browsing look like for this project?";
      intent.setAttribute("aria-label", "Project intention");

      const remove = makeElement("button", "remove-project", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", "Remove project");
      card.append(active, name, intent, remove);
      return card;
    })
  );
}

function collectProjectsFromDom() {
  const cards = [...controls.projectList.querySelectorAll(".project-card")];
  if (!cards.length) return;
  projects = cards.map((card, index) => ({
    id: projects[index]?.id || crypto.randomUUID(),
    active: card.querySelector(".project-active").checked,
    name: card.querySelector(".project-name").value.trim(),
    intent: card.querySelector(".project-intent").value.trim()
  }));
}

function addProject() {
  collectProjectsFromDom();
  projects.push({ id: crypto.randomUUID(), name: "", intent: "", active: true });
  renderProjects();
  controls.projectList.querySelector(".project-card:last-child .project-name")?.focus();
}

function onProjectClick(event) {
  const button = event.target.closest(".remove-project");
  if (!button) return;
  collectProjectsFromDom();
  const index = Number(button.closest(".project-card").dataset.index);
  projects.splice(index, 1);
  renderProjects();
}

function renderFeedback() {
  for (const platform of ["youtube", "twitter"]) {
    const count = dashboard.feedback?.[platform]?.length || 0;
    byId(`${platform}-feedback`).textContent = `${count} feedback example${count === 1 ? "" : "s"} shaping future classifications`;
  }
}

function updateRangeOutputs() {
  byId("site-threshold-output").textContent = `${controls.siteThreshold.value}%`;
  for (const platform of ["youtube", "twitter"]) {
    byId(`${platform}-threshold-output`).textContent = `${byId(`${platform}-threshold`).value}%`;
  }
}

async function testBridge() {
  const button = byId("test-bridge");
  button.disabled = true;
  button.textContent = "Testing…";
  const response = await send({ type: "TEST_BRIDGE", settings: collectSettings() });
  button.disabled = false;
  button.textContent = "Test connection";
  renderConnection(response);
  if (response?.ok) toast("Local bridge reached successfully.");
  else toast(response?.error || "Could not reach bridge.", true);
}

async function refreshConnection() {
  const response = await send({ type: "TEST_BRIDGE", settings: collectSettings() });
  renderConnection(response);
}

function renderConnection(response) {
  const dot = byId("sidebar-dot");
  const icon = byId("connection-icon");
  dot.className = "status-dot";
  icon.className = "large-status";
  if (response?.ok && response.health?.jev?.configured) {
    dot.classList.add("online");
    icon.classList.add("online");
    icon.textContent = "✓";
    byId("sidebar-status").textContent = "Jev connected";
    byId("sidebar-model").textContent = response.health.jev.model;
    byId("connection-title").textContent = "Bridge connected";
    byId("connection-description").textContent = `Jev ${response.health.jev.model}; reflection LLM ${response.health.llm.configured ? response.health.llm.model : "not configured"}.`;
  } else {
    dot.classList.add("offline");
    icon.classList.add("offline");
    icon.textContent = "!";
    byId("sidebar-status").textContent = "Bridge offline";
    byId("sidebar-model").textContent = "Fail-open mode";
    byId("connection-title").textContent = "Bridge needs attention";
    byId("connection-description").textContent = response?.error || "Jev is not configured on the bridge.";
  }
}

async function exportData() {
  const response = await send({ type: "EXPORT_DATA" });
  if (!response?.ok) return toast(response?.error || "Export failed.", true);
  const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `no-you-do-not-${localDateKey()}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Export downloaded. Bridge token was redacted.");
}

async function clearData() {
  if (!window.confirm("Clear all local activity, judgments, cache, and feed feedback?")) return;
  const response = await send({ type: "CLEAR_DATA" });
  if (!response?.ok) return toast(response?.error || "Could not clear data.", true);
  const fresh = await send({ type: "GET_DASHBOARD" });
  if (fresh?.ok) {
    dashboard = fresh.data;
    renderOverview();
    renderDecisions();
    renderFeedback();
  }
  toast("Local activity data cleared.");
}

function relativeTime(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - Number(timestamp || 0)) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function toast(message, error = false) {
  const element = byId("toast");
  element.textContent = message;
  element.className = error ? "visible error" : "visible";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (element.className = ""), 3600);
}

function makeElement(tagName, className = "", text = "") {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== "") element.textContent = String(text);
  return element;
}

async function send(message) {
  try {
    return await browser.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
