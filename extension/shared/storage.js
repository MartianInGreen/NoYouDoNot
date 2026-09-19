import {
  DEFAULT_SETTINGS,
  EMPTY_CACHE,
  EMPTY_FEEDBACK,
  EMPTY_RUNTIME,
  EMPTY_STATS,
  clone,
  mergeSettings
} from "./defaults.js";

export async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return mergeSettings(settings);
}

export async function initializeStorage() {
  const current = await browser.storage.local.get([
    "settings",
    "stats",
    "runtimeState",
    "decisions",
    "feedback",
    "classificationCache"
  ]);
  const updates = {};
  updates.settings = mergeSettings(current.settings || DEFAULT_SETTINGS);
  if (!current.stats) updates.stats = clone(EMPTY_STATS);
  if (!current.runtimeState) updates.runtimeState = clone(EMPTY_RUNTIME);
  if (!Array.isArray(current.decisions)) updates.decisions = [];
  if (!current.feedback) updates.feedback = clone(EMPTY_FEEDBACK);
  if (!current.classificationCache) updates.classificationCache = clone(EMPTY_CACHE);
  await browser.storage.local.set(updates);
  return updates.settings;
}

export function sanitizeSettings(candidate) {
  const value = mergeSettings(candidate);
  const allowedEnforcement = new Set(["observe", "balanced", "strict"]);
  const allowedDisplay = new Set(["badge", "blur", "hide"]);
  const allowedStrictness = new Set(["lenient", "balanced", "strict"]);

  value.enabled = Boolean(value.enabled);
  value.alwaysIntent = String(value.alwaysIntent || "").slice(0, 5000);
  value.dailyIntent = {
    text: String(value.dailyIntent?.text || "").slice(0, 3000),
    date: String(value.dailyIntent?.date || "").slice(0, 10)
  };
  value.weeklyIntent = {
    text: String(value.weeklyIntent?.text || "").slice(0, 4000),
    week: String(value.weeklyIntent?.week || "").slice(0, 10)
  };
  value.projects = (Array.isArray(value.projects) ? value.projects : [])
    .slice(0, 20)
    .map((project) => ({
      id: String(project.id || crypto.randomUUID()).slice(0, 100),
      name: String(project.name || "").slice(0, 120),
      intent: String(project.intent || "").slice(0, 3000),
      active: Boolean(project.active)
    }));

  value.sitePolicy.enforcement = allowedEnforcement.has(value.sitePolicy.enforcement)
    ? value.sitePolicy.enforcement
    : "balanced";
  value.sitePolicy.confidenceThreshold = clamp(value.sitePolicy.confidenceThreshold, 0.5, 0.95, 0.62);
  value.sitePolicy.interventionEnabled = Boolean(value.sitePolicy.interventionEnabled);
  value.sitePolicy.minimumChatTurns = Math.round(
    clamp(value.sitePolicy.minimumChatTurns, 2, 6, 3)
  );
  value.sitePolicy.grantMinutes = Math.round(clamp(value.sitePolicy.grantMinutes, 5, 120, 15));
  value.sitePolicy.protectedDomains = [
    ...new Set(
      (Array.isArray(value.sitePolicy.protectedDomains)
        ? value.sitePolicy.protectedDomains
        : []
      )
        .map((domain) => String(domain).trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 100)
    )
  ];

  for (const platform of ["youtube", "twitter"]) {
    const algorithm = value.algorithms[platform];
    algorithm.enabled = Boolean(algorithm.enabled);
    algorithm.intent = String(algorithm.intent || "").slice(0, 5000);
    algorithm.display = allowedDisplay.has(algorithm.display) ? algorithm.display : "blur";
    algorithm.strictness = allowedStrictness.has(algorithm.strictness)
      ? algorithm.strictness
      : "balanced";
    algorithm.confidenceThreshold = clamp(algorithm.confidenceThreshold, 0.5, 0.95, 0.6);
  }

  value.bridge.url = String(value.bridge.url || "http://127.0.0.1:4317")
    .trim()
    .replace(/\/+$/, "")
    .slice(0, 500);
  value.bridge.token = String(value.bridge.token || "").trim().slice(0, 500);
  return value;
}

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}
