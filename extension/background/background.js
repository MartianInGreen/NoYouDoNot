import {
  EMPTY_CACHE,
  EMPTY_FEEDBACK,
  EMPTY_RUNTIME,
  EMPTY_STATS,
  clone
} from "../shared/defaults.js";
import {
  deriveConflictWaitSeconds,
  deriveFeedAction,
  deriveInterventionAccess,
  deriveSiteAction,
  isProtectedDomain,
  isWebUrl,
  normalizeHostname,
  stableHash
} from "../shared/policy.js";
import {
  getSettings,
  initializeStorage,
  sanitizeSettings
} from "../shared/storage.js";
import {
  activeIntentSnapshot,
  localDateKey,
  timeBucket
} from "../shared/time.js";

const TRACKING_ALARM = "nydn-tracking-heartbeat";
const CLEANUP_ALARM = "nydn-storage-cleanup";
const MAX_TICK_SECONDS = 90;
const SITE_CACHE_TTL_MS = 10 * 60 * 1000;
const SITE_CLASSIFIER_VERSION = 3;
const FEED_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DECISION_LIMIT = 250;
const FEEDBACK_LIMIT = 80;
const PENDING_GATE_TTL_MS = 2 * 60 * 60 * 1000;
const WINDOW_NONE = browser.windows?.WINDOW_ID_NONE ?? -1;

let mutationQueue = Promise.resolve();
let bootPromise;
const navigationTokens = new Map();

function serialize(task) {
  const result = mutationQueue.then(task, task);
  mutationQueue = result.catch((error) => {
    console.error("[NYDN] storage mutation failed", error);
  });
  return result;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function ensureDay(stats, dateKey) {
  stats.days ||= {};
  stats.days[dateKey] ||= {
    sites: {},
    interventions: 0,
    feed: {
      youtube: { classified: 0, limited: 0, promoted: 0 },
      twitter: { classified: 0, limited: 0, promoted: 0 }
    }
  };
  const day = stats.days[dateKey];
  day.sites ||= {};
  day.interventions ||= 0;
  day.feed ||= {
    youtube: { classified: 0, limited: 0, promoted: 0 },
    twitter: { classified: 0, limited: 0, promoted: 0 }
  };
  return day;
}

function ensureSite(day, hostname) {
  day.sites[hostname] ||= { seconds: 0, opens: 0, lastTitle: "", lastPath: "/" };
  return day.sites[hostname];
}

function accrueActive(runtime, stats, now = Date.now()) {
  if (!runtime.active) return;
  const lastTick = Number(runtime.active.lastTick || now);
  const elapsed = Math.max(0, Math.min(MAX_TICK_SECONDS, (now - lastTick) / 1000));
  runtime.active.lastTick = now;

  if (
    !runtime.windowFocused ||
    runtime.idleState !== "active" ||
    !runtime.active.hostname ||
    elapsed <= 0
  ) {
    return;
  }

  runtime.active.sessionSeconds = Number(runtime.active.sessionSeconds || 0) + elapsed;
  const day = ensureDay(stats, localDateKey(new Date(now)));
  const site = ensureSite(day, runtime.active.hostname);
  site.seconds += elapsed;
  if (runtime.active.title) site.lastTitle = runtime.active.title.slice(0, 300);
  if (runtime.active.path) site.lastPath = runtime.active.path.slice(0, 500);
}

async function mutateTracking(mutator) {
  return serialize(async () => {
    const stored = await browser.storage.local.get(["runtimeState", "stats"]);
    const runtime = stored.runtimeState || clone(EMPTY_RUNTIME);
    const stats = stored.stats || clone(EMPTY_STATS);
    accrueActive(runtime, stats);
    await mutator(runtime, stats);
    await browser.storage.local.set({ runtimeState: runtime, stats });
    return { runtime, stats };
  });
}

async function setActiveTab(tab, options = {}) {
  const now = Date.now();
  await mutateTracking(async (runtime) => {
    if (!tab || !isWebUrl(tab.url || "")) {
      runtime.active = null;
      return;
    }
    const parsed = new URL(tab.url);
    const hostname = normalizeHostname(parsed.hostname);
    const sameSession =
      runtime.active?.tabId === tab.id && runtime.active?.hostname === hostname;
    runtime.active = {
      tabId: tab.id,
      windowId: tab.windowId,
      hostname,
      path: parsed.pathname.slice(0, 500),
      url: tab.url,
      title: String(tab.title || "").slice(0, 300),
      lastTick: now,
      sessionStartedAt: sameSession
        ? runtime.active.sessionStartedAt || now
        : options.sessionStartedAt || now,
      sessionSeconds: sameSession ? Number(runtime.active.sessionSeconds || 0) : 0
    };
  });
}

async function syncActiveTab() {
  const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  await setActiveTab(tabs[0] || null);
}

async function recordNavigation(details, countOpen) {
  const parsed = new URL(details.url);
  const hostname = normalizeHostname(parsed.hostname);
  const now = Date.now();
  return mutateTracking(async (runtime, stats) => {
    const previousHost = runtime.tabHosts[String(details.tabId)];
    if (countOpen && previousHost !== hostname) {
      const day = ensureDay(stats, localDateKey(new Date(now)));
      ensureSite(day, hostname).opens += 1;
    }
    runtime.tabHosts[String(details.tabId)] = hostname;

    if (runtime.active?.tabId === details.tabId) {
      const sameHost = runtime.active.hostname === hostname;
      runtime.active = {
        ...runtime.active,
        hostname,
        path: parsed.pathname.slice(0, 500),
        url: details.url,
        lastTick: now,
        sessionStartedAt: sameHost ? runtime.active.sessionStartedAt || now : now,
        sessionSeconds: sameHost ? Number(runtime.active.sessionSeconds || 0) : 0
      };
    }
  });
}

async function initializeTracking() {
  try {
    const idleState = await browser.idle.queryState(60);
    await serialize(async () => {
      const { runtimeState } = await browser.storage.local.get("runtimeState");
      const runtime = runtimeState || clone(EMPTY_RUNTIME);
      runtime.idleState = idleState;
      runtime.windowFocused = true;
      await browser.storage.local.set({ runtimeState: runtime });
    });
    await syncActiveTab();
  } catch (error) {
    console.warn("[NYDN] could not initialize active tab tracking", error);
  }
}

async function boot() {
  await initializeStorage();
  browser.idle.setDetectionInterval(60);
  await browser.alarms.create(TRACKING_ALARM, { periodInMinutes: 1 });
  await browser.alarms.create(CLEANUP_ALARM, { periodInMinutes: 60 });
  await initializeTracking();
}

bootPromise = boot();

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  await bootPromise;
  if (reason === "install") {
    await browser.runtime.openOptionsPage();
  }
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  await bootPromise;
  if (alarm.name === TRACKING_ALARM) {
    await mutateTracking(async () => {});
  } else if (alarm.name === CLEANUP_ALARM) {
    await cleanupStorage();
  }
});

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  await bootPromise;
  try {
    await setActiveTab(await browser.tabs.get(tabId));
  } catch {
    await setActiveTab(null);
  }
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.title) return;
  await bootPromise;
  await mutateTracking(async (runtime) => {
    if (runtime.active?.tabId === tabId) {
      runtime.active.title = String(tab.title || changeInfo.title).slice(0, 300);
    }
  });
});

browser.tabs.onRemoved.addListener(async (tabId) => {
  navigationTokens.delete(tabId);
  await bootPromise;
  await mutateTracking(async (runtime) => {
    delete runtime.tabHosts[String(tabId)];
    for (const [id, gate] of Object.entries(runtime.pendingGates || {})) {
      if (gate.tabId === tabId) delete runtime.pendingGates[id];
    }
    if (runtime.active?.tabId === tabId) runtime.active = null;
  });
});

browser.windows.onFocusChanged.addListener(async (windowId) => {
  await bootPromise;
  await mutateTracking(async (runtime) => {
    runtime.windowFocused = windowId !== WINDOW_NONE;
  });
  if (windowId !== WINDOW_NONE) await syncActiveTab();
});

browser.idle.onStateChanged.addListener(async (state) => {
  await bootPromise;
  await mutateTracking(async (runtime) => {
    runtime.idleState = state;
    if (runtime.active) runtime.active.lastTick = Date.now();
  });
});

browser.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await bootPromise;
  if (!isWebUrl(details.url)) {
    await syncActiveTab();
    return;
  }
  await recordNavigation(details, details.transitionType !== "reload");
  await syncActiveTab();
  await classifyNavigation(details);
});

browser.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0 || !isWebUrl(details.url)) return;
  await bootPromise;
  await recordNavigation(details, false);
  await syncActiveTab();
  await classifyNavigation(details);
});

async function classifyNavigation(details) {
  const token = `${details.url}|${Date.now()}|${Math.random()}`;
  navigationTokens.set(details.tabId, token);
  await sleep(350);
  if (navigationTokens.get(details.tabId) !== token) return;

  let tab;
  try {
    tab = await browser.tabs.get(details.tabId);
  } catch {
    return;
  }
  if (!isWebUrl(tab.url || "") || stripHash(tab.url) !== stripHash(details.url)) return;

  const settings = await getSettings();
  if (!settings.enabled) return;

  const parsed = new URL(tab.url);
  const hostname = normalizeHostname(parsed.hostname);
  const { runtimeState, stats } = await browser.storage.local.get(["runtimeState", "stats"]);
  const runtime = runtimeState || clone(EMPTY_RUNTIME);
  const pendingEntry = Object.entries(runtime.pendingGates || {}).find(
    ([, gate]) => gate.tabId === tab.id
  );
  if (pendingEntry) {
    const [pendingId, pendingGate] = pendingEntry;
    if (
      pendingGate.hostname === hostname &&
      pendingGate.classifierVersion === SITE_CLASSIFIER_VERSION
    ) {
      await browser.tabs.update(tab.id, {
        url: browser.runtime.getURL(`gate/gate.html?id=${encodeURIComponent(pendingId)}`)
      });
      return;
    }
    await removeGate(pendingId);
  }
  if (isProtectedDomain(hostname, settings.sitePolicy.protectedDomains)) return;
  if (hasGrant(runtime, hostname)) return;

  const now = new Date();
  const intents = activeIntentSnapshot(settings, now);
  if (!hasAnyIntent(intents)) return;
  const behavior = behaviorSnapshot(stats || clone(EMPTY_STATS), runtime, hostname, now);
  const localTime = `${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes()
  ).padStart(2, "0")}`;
  const page = {
    hostname,
    path: parsed.pathname.slice(0, 500),
    title: String(tab.title || "").slice(0, 300)
  };
  const cacheKey = stableHash({
    type: "site",
    classifierVersion: SITE_CLASSIFIER_VERSION,
    page,
    intents,
    localDate: localDateKey(now),
    localTime,
    weekday: now.getDay(),
    usageBand: Math.floor(behavior.minutesOnSiteToday / 10)
  });

  let decision = await readCache("sites", cacheKey, SITE_CACHE_TTL_MS);
  let cached = Boolean(decision);
  try {
    if (!decision) {
      decision = await bridgeRequest(settings, "/v1/classify/site", {
        page,
        intents,
        context: {
          localTime,
          weekday: now.toLocaleDateString([], { weekday: "long" }),
          timeOfDay: timeBucket(now),
          behavior
        }
      });
      await writeCache("sites", cacheKey, decision);
    }
  } catch (error) {
    await recordBridgeError(error);
    return;
  }

  if (navigationTokens.get(details.tabId) !== token) return;
  try {
    const current = await browser.tabs.get(details.tabId);
    if (stripHash(current.url || "") !== stripHash(details.url)) return;
  } catch {
    return;
  }

  const latestSettings = await getSettings();
  const { runtimeState: latestRuntimeValue } = await browser.storage.local.get("runtimeState");
  const latestRuntime = latestRuntimeValue || clone(EMPTY_RUNTIME);
  if (
    !latestSettings.enabled ||
    isProtectedDomain(hostname, latestSettings.sitePolicy.protectedDomains) ||
    hasGrant(latestRuntime, hostname)
  ) {
    return;
  }
  const outcome = deriveSiteAction(decision, latestSettings.sitePolicy);
  const record = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    type: "site",
    hostname,
    path: page.path,
    title: page.title,
    decision,
    outcome,
    cached
  };
  await saveDecision(record);

  if (["nudge", "chat", "block"].includes(outcome.action)) {
    await createGate(tab, record, latestSettings);
  }
}

function behaviorSnapshot(stats, runtime, hostname, now) {
  const day = stats.days?.[localDateKey(now)] || { sites: {}, interventions: 0 };
  const site = day.sites?.[hostname] || { seconds: 0, opens: 0 };
  const totalSeconds = Object.values(day.sites || {}).reduce(
    (sum, value) => sum + Number(value.seconds || 0),
    0
  );
  const active = runtime.active?.hostname === hostname ? runtime.active : null;
  return {
    minutesOnSiteToday: Math.round(Number(site.seconds || 0) / 60),
    opensToday: Number(site.opens || 0),
    totalTrackedMinutesToday: Math.round(totalSeconds / 60),
    currentSessionMinutes: active
      ? Math.max(0, Math.round(Number(active.sessionSeconds || 0) / 60))
      : 0,
    interventionsToday: Number(day.interventions || 0)
  };
}

function hasAnyIntent(intents) {
  return Boolean(
    intents.always || intents.daily || intents.weekly || (intents.projects || []).length
  );
}

function hasGrant(runtime, hostname) {
  const now = Date.now();
  return Object.entries(runtime.grants || {}).some(
    ([domain, expiresAt]) =>
      Number(expiresAt) > now && (hostname === domain || hostname.endsWith(`.${domain}`))
  );
}

async function createGate(tab, record, settings) {
  const gateId = crypto.randomUUID();
  const createdAt = new Date();
  const gate = {
    id: gateId,
    tabId: tab.id,
    classifierVersion: SITE_CLASSIFIER_VERSION,
    createdAt: createdAt.getTime(),
    targetUrl: tab.url,
    hostname: record.hostname,
    path: record.path,
    title: record.title,
    outcome: record.outcome,
    decision: record.decision,
    grantMinutes: settings.sitePolicy.grantMinutes,
    assessment: null,
    warning: null,
    chatFailures: 0,
    chatRevision: 0,
    messages: [],
    intents: activeIntentSnapshot(settings, createdAt),
    context: {
      localTime: `${String(createdAt.getHours()).padStart(2, "0")}:${String(
        createdAt.getMinutes()
      ).padStart(2, "0")}`,
      weekday: createdAt.toLocaleDateString([], { weekday: "long" }),
      timeOfDay: timeBucket(createdAt)
    }
  };

  await serialize(async () => {
    const stored = await browser.storage.local.get(["runtimeState", "stats"]);
    const runtime = stored.runtimeState || clone(EMPTY_RUNTIME);
    const stats = stored.stats || clone(EMPTY_STATS);
    runtime.pendingGates ||= {};
    runtime.pendingGates[gateId] = gate;
    const day = ensureDay(stats, localDateKey());
    day.interventions += 1;
    await browser.storage.local.set({ runtimeState: runtime, stats });
  });

  try {
    const current = await browser.tabs.get(tab.id);
    if (stripHash(current.url || "") !== stripHash(tab.url || "")) {
      await removeGate(gateId);
      return;
    }
    await browser.tabs.update(tab.id, {
      url: browser.runtime.getURL(`gate/gate.html?id=${encodeURIComponent(gateId)}`)
    });
  } catch {
    await removeGate(gateId);
  }
}

async function saveDecision(record) {
  await serialize(async () => {
    const { decisions } = await browser.storage.local.get("decisions");
    const values = Array.isArray(decisions) ? decisions : [];
    values.unshift(record);
    await browser.storage.local.set({ decisions: values.slice(0, DECISION_LIMIT) });
  });
}

async function recordBridgeError(error) {
  const record = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    type: "system",
    outcome: { action: "allow", reason: "bridge_unavailable" },
    error: humanError(error)
  };
  await saveDecision(record);
}

async function bridgeRequest(settings, path, body, options = {}) {
  const endpoint = validateBridgeUrl(settings.bridge.url);
  if (!settings.bridge.token) {
    throw new Error("The local bridge token has not been configured.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);
  try {
    const response = await fetch(`${endpoint}${path}`, {
      method: options.method || "POST",
      headers: {
        "content-type": "application/json",
        "x-noyoudonot-token": settings.bridge.token
      },
      body: options.method === "GET" ? undefined : JSON.stringify(body || {}),
      signal: controller.signal
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new Error(payload?.error || `Bridge returned HTTP ${response.status}.`);
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("The local bridge timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function validateBridgeUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("The bridge URL is invalid.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!loopback || url.protocol !== "http:") {
    throw new Error("For privacy, this build only connects to a localhost HTTP bridge.");
  }
  return url.origin;
}

async function readCache(bucket, key, ttl) {
  const { classificationCache } = await browser.storage.local.get("classificationCache");
  const entry = classificationCache?.[bucket]?.[key];
  if (!entry || Date.now() - Number(entry.timestamp || 0) > ttl) return null;
  return entry.value;
}

async function writeCache(bucket, key, value) {
  await serialize(async () => {
    const { classificationCache } = await browser.storage.local.get("classificationCache");
    const cache = classificationCache || clone(EMPTY_CACHE);
    cache[bucket] ||= {};
    cache[bucket][key] = { timestamp: Date.now(), value };
    const entries = Object.entries(cache[bucket]);
    const maximum = bucket === "feed" ? 600 : 200;
    if (entries.length > maximum) {
      entries
        .sort((left, right) => Number(right[1].timestamp) - Number(left[1].timestamp))
        .slice(maximum)
        .forEach(([entryKey]) => delete cache[bucket][entryKey]);
    }
    await browser.storage.local.set({ classificationCache: cache });
  });
}

async function classifyFeedItems(message, sender) {
  const platform = message.platform === "youtube" ? "youtube" : "twitter";
  if (!sender.tab?.url || !senderMatchesPlatform(sender.tab.url, platform)) {
    throw new Error("Feed classification request did not come from the expected site.");
  }
  const settings = await getSettings();
  const algorithm = settings.algorithms[platform];
  if (!settings.enabled || !algorithm.enabled || !algorithm.intent.trim()) {
    return { results: [], disabled: true };
  }

  const items = (Array.isArray(message.items) ? message.items : [])
    .slice(0, 10)
    .map(sanitizeFeedItem)
    .filter((item) => item.id && (item.text || item.title));
  if (!items.length) return { results: [] };

  const { feedback } = await browser.storage.local.get("feedback");
  const examples = (feedback?.[platform] || []).slice(0, 12).map((entry) => ({
    title: String(entry.item?.title || "").slice(0, 180),
    text: String(entry.item?.text || "").slice(0, 350),
    author: String(entry.item?.author || "").slice(0, 100),
    userLabel: entry.userLabel
  }));
  const intents = activeIntentSnapshot(settings);
  const algorithmFingerprint = stableHash({ algorithm, examples, intents });
  const results = [];
  const misses = [];
  const keys = new Map();

  for (const item of items) {
    const key = stableHash({
      platform,
      algorithmFingerprint,
      title: item.title,
      text: item.text,
      author: item.author,
      url: item.url
    });
    keys.set(item.id, key);
    const cached = await readCache("feed", key, FEED_CACHE_TTL_MS);
    if (cached) results.push({ ...cached, id: item.id, cached: true });
    else misses.push(item);
  }

  if (misses.length) {
    let response;
    try {
      response = await bridgeRequest(settings, "/v1/classify/feed", {
        platform,
        algorithm: algorithm.intent,
        intents,
        feedbackExamples: examples,
        items: misses
      });
    } catch (error) {
      await recordBridgeError(error);
      return {
        results: items.map((item) => ({ id: item.id, action: "allow", unavailable: true })),
        error: humanError(error)
      };
    }

    for (const result of response.results || []) {
      const item = misses.find((candidate) => candidate.id === result.id);
      if (!item) continue;
      const outcome = deriveFeedAction(result, algorithm);
      const normalized = { ...result, ...outcome, display: algorithm.display };
      results.push(normalized);
      await writeCache("feed", keys.get(item.id), normalized);
    }
    await recordFeedCounts(platform, results.filter((result) => !result.cached));
  }

  return { results };
}

function sanitizeFeedItem(item) {
  return {
    id: String(item?.id || "").slice(0, 120),
    title: String(item?.title || "").replace(/\s+/g, " ").trim().slice(0, 500),
    text: String(item?.text || "").replace(/\s+/g, " ").trim().slice(0, 1400),
    author: String(item?.author || "").replace(/\s+/g, " ").trim().slice(0, 180),
    metadata: String(item?.metadata || "").replace(/\s+/g, " ").trim().slice(0, 300),
    url: safeContentUrl(item?.url)
  };
}

function safeContentUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return `${normalizeHostname(parsed.hostname)}${parsed.pathname}`.slice(0, 500);
  } catch {
    return "";
  }
}

function senderMatchesPlatform(url, platform) {
  const host = normalizeHostname(url);
  return platform === "youtube"
    ? host === "youtube.com" || host.endsWith(".youtube.com")
    : host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com");
}

async function recordFeedCounts(platform, results) {
  if (!results.length) return;
  await serialize(async () => {
    const { stats } = await browser.storage.local.get("stats");
    const values = stats || clone(EMPTY_STATS);
    const day = ensureDay(values, localDateKey());
    day.feed[platform] ||= { classified: 0, limited: 0, promoted: 0 };
    day.feed[platform].classified += results.length;
    day.feed[platform].limited += results.filter((value) => value.action === "limit").length;
    day.feed[platform].promoted += results.filter((value) => value.action === "promote").length;
    await browser.storage.local.set({ stats: values });
  });
}

async function saveFeedFeedback(message, sender) {
  const platform = message.platform === "youtube" ? "youtube" : "twitter";
  if (!sender.tab?.url || !senderMatchesPlatform(sender.tab.url, platform)) {
    throw new Error("Feedback did not come from the expected site.");
  }
  const userLabel = message.userLabel === "limit" ? "limit" : "show";
  const item = sanitizeFeedItem(message.item || {});
  await serialize(async () => {
    const stored = await browser.storage.local.get(["feedback", "classificationCache"]);
    const feedback = stored.feedback || clone(EMPTY_FEEDBACK);
    feedback[platform] ||= [];
    feedback[platform].unshift({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      userLabel,
      item,
      classifierChoice: String(message.classifierChoice || "").slice(0, 40)
    });
    feedback[platform] = feedback[platform].slice(0, FEEDBACK_LIMIT);
    const cache = stored.classificationCache || clone(EMPTY_CACHE);
    cache.feed = {};
    await browser.storage.local.set({ feedback, classificationCache: cache });
  });
  return { saved: true };
}

async function getGate(id, sender) {
  const { runtimeState } = await browser.storage.local.get("runtimeState");
  const gate = runtimeState?.pendingGates?.[id];
  if (!gate || (sender.tab?.id != null && sender.tab.id !== gate.tabId)) return null;
  return publicGate(gate);
}

function gateAssessmentState(gate, now = Date.now()) {
  const state = deriveInterventionAccess(gate.assessment, gate.warning, now);
  return {
    assessment: gate.assessment || null,
    ...state,
    canContinue:
      gate.outcome?.action === "nudge" ||
      (gate.outcome?.action === "chat" && state.canContinue)
  };
}

function publicGate(gate) {
  return {
    id: gate.id,
    hostname: gate.hostname,
    title: gate.title,
    outcome: gate.outcome,
    decision: gate.decision,
    grantMinutes: gate.grantMinutes,
    chatFailures: Number(gate.chatFailures || 0),
    intents: gate.intents,
    messages: gate.messages || [],
    ...gateAssessmentState(gate)
  };
}

async function chatAtGate(id, text, sender) {
  const cleanText = String(text || "").trim().slice(0, 1800);
  if (!cleanText) {
    throw new Error("Please enter a reason for this visit.");
  }

  const { runtimeState } = await browser.storage.local.get("runtimeState");
  const gate = runtimeState?.pendingGates?.[id];
  if (!gate || (sender.tab?.id != null && sender.tab.id !== gate.tabId)) {
    throw new Error("This intervention has expired.");
  }
  if (gate.outcome?.action !== "chat") {
    throw new Error("This intervention does not require a conversation.");
  }
  if (gateAssessmentState(gate).reasonAccepted) {
    throw new Error("This reflection is already complete.");
  }

  const settings = await getSettings();
  const existingMessages = gate.messages || [];
  const chatRevision = Number(gate.chatRevision || 0);
  const history = [...existingMessages, { role: "user", content: cleanText }].slice(-20);
  let response;
  try {
    response = await bridgeRequest(
      settings,
      "/v1/intervention/chat",
      {
        visit: { hostname: gate.hostname, path: gate.path, title: gate.title },
        reason: gate.outcome.reason,
        intents: gate.intents,
        context: gate.context,
        messages: history
      },
      { timeout: 30000 }
    );
  } catch (error) {
    await incrementGateFailure(id);
    throw error;
  }

  const reply = String(response.reply || "").trim().slice(0, 2500);
  if (!reply) {
    await incrementGateFailure(id);
    throw new Error("The conversation model returned an empty reply.");
  }

  const messages = [...history, { role: "assistant", content: reply }].slice(-20);
  let evaluation;
  try {
    evaluation = await bridgeRequest(
      settings,
      "/v1/classify/intervention",
      {
        visit: { hostname: gate.hostname, path: gate.path, title: gate.title },
        reason: gate.outcome.reason,
        intents: gate.intents,
        context: gate.context,
        messages
      },
      { timeout: 20000 }
    );
    evaluation = {
      reasonExplained: interventionWeight(evaluation.reasonExplained),
      reasonConflicts: interventionWeight(evaluation.reasonConflicts),
      model: String(evaluation.model || "").slice(0, 120)
    };
  } catch (error) {
    await recordBridgeError(error);
    const savedGate = await saveGateExchange(id, chatRevision, messages, {
      assessment: null,
      warning: null,
      chatFailures: Number(gate.chatFailures || 0) + 1
    });
    return {
      reply,
      gate: publicGate(savedGate),
      assessmentUnavailable: true
    };
  }

  const threshold = Number(settings.sitePolicy.confidenceThreshold);
  const evaluatedAt = Date.now();
  const reasonAccepted = evaluation.reasonExplained >= threshold;
  const warningRequired = reasonAccepted && evaluation.reasonConflicts >= threshold;
  const waitSeconds = warningRequired
    ? deriveConflictWaitSeconds(
        evaluation.reasonConflicts,
        threshold,
        settings.sitePolicy.conflictWaitBaseSeconds,
        settings.sitePolicy.conflictWaitMaxSeconds
      )
    : 0;
  const assessment = {
    ...evaluation,
    threshold,
    evaluatedAt
  };
  const warning = warningRequired
    ? { waitSeconds, waitUntil: evaluatedAt + waitSeconds * 1000 }
    : null;
  const savedGate = await saveGateExchange(id, chatRevision, messages, {
    assessment,
    warning,
    chatFailures: 0
  });
  return { reply, gate: publicGate(savedGate), assessmentUnavailable: false };
}

function interventionWeight(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Jev returned an invalid intervention weight.");
  }
  return Math.min(1, Math.max(0, value));
}

async function saveGateExchange(id, expectedRevision, messages, changes) {
  return serialize(async () => {
    const { runtimeState: latestValue } = await browser.storage.local.get("runtimeState");
    const latest = latestValue || clone(EMPTY_RUNTIME);
    const latestGate = latest.pendingGates?.[id];
    if (!latestGate) throw new Error("This intervention has expired.");
    if (Number(latestGate.chatRevision || 0) !== expectedRevision) {
      throw new Error("Another reflection response was already saved. Refresh and try again.");
    }
    latestGate.messages = messages;
    latestGate.chatRevision = expectedRevision + 1;
    Object.assign(latestGate, changes);
    await browser.storage.local.set({ runtimeState: latest });
    return latestGate;
  });
}

async function incrementGateFailure(id) {
  await serialize(async () => {
    const { runtimeState: latestValue } = await browser.storage.local.get("runtimeState");
    const latest = latestValue || clone(EMPTY_RUNTIME);
    if (latest.pendingGates?.[id]) {
      latest.pendingGates[id].chatFailures = Number(latest.pendingGates[id].chatFailures || 0) + 1;
      await browser.storage.local.set({ runtimeState: latest });
    }
  });
}

async function continueGate(id, sender, fallback = false) {
  let target;
  let tabId;
  await serialize(async () => {
    const { runtimeState } = await browser.storage.local.get("runtimeState");
    const runtime = runtimeState || clone(EMPTY_RUNTIME);
    const gate = runtime.pendingGates?.[id];
    if (!gate || (sender.tab?.id != null && sender.tab.id !== gate.tabId)) {
      throw new Error("This intervention has expired.");
    }
    if (gate.outcome.action === "block") {
      throw new Error("This visit is blocked by strict mode. Change the intent or mode in settings.");
    }

    const usingFailOpen = fallback && Number(gate.chatFailures || 0) > 0;
    if (gate.outcome.action === "chat" && !usingFailOpen) {
      const state = gateAssessmentState(gate);
      if (!state.reasonAccepted) {
        throw new Error("Keep reflecting until Jev finds the reason sufficiently explained.");
      }
      if (state.warningRequired && state.waitRemainingSeconds > 0) {
        throw new Error(
          `This reason still conflicts with your intentions. Wait ${state.waitRemainingSeconds} more seconds.`
        );
      }
    }

    const minutes = usingFailOpen ? 5 : gate.grantMinutes;
    runtime.grants ||= {};
    runtime.grants[gate.hostname] = Date.now() + minutes * 60 * 1000;
    target = gate.targetUrl;
    tabId = gate.tabId;
    delete runtime.pendingGates[id];
    await browser.storage.local.set({ runtimeState: runtime });
  });
  await browser.tabs.update(tabId, { url: target });
  return { continued: true };
}

async function closeGate(id, sender) {
  let tabId;
  await serialize(async () => {
    const { runtimeState } = await browser.storage.local.get("runtimeState");
    const runtime = runtimeState || clone(EMPTY_RUNTIME);
    const gate = runtime.pendingGates?.[id];
    if (!gate || (sender.tab?.id != null && sender.tab.id !== gate.tabId)) return;
    tabId = gate.tabId;
    delete runtime.pendingGates[id];
    await browser.storage.local.set({ runtimeState: runtime });
  });
  if (tabId == null) return { closed: true };
  const tabs = await browser.tabs.query({ currentWindow: true });
  if (tabs.length > 1) await browser.tabs.remove(tabId);
  else await browser.tabs.update(tabId, { url: "about:blank" });
  return { closed: true };
}

async function removeGate(id) {
  await serialize(async () => {
    const { runtimeState } = await browser.storage.local.get("runtimeState");
    const runtime = runtimeState || clone(EMPTY_RUNTIME);
    if (runtime.pendingGates) delete runtime.pendingGates[id];
    await browser.storage.local.set({ runtimeState: runtime });
  });
}

async function grantSite(hostname, minutes) {
  const host = normalizeHostname(hostname);
  if (!host) throw new Error("No web site is active.");
  await serialize(async () => {
    const { runtimeState } = await browser.storage.local.get("runtimeState");
    const runtime = runtimeState || clone(EMPTY_RUNTIME);
    runtime.grants ||= {};
    runtime.grants[host] = Date.now() + Math.max(1, Math.min(120, Number(minutes) || 15)) * 60000;
    await browser.storage.local.set({ runtimeState: runtime });
  });
}

async function dashboardData() {
  await mutateTracking(async () => {});
  const stored = await browser.storage.local.get([
    "settings",
    "stats",
    "runtimeState",
    "decisions",
    "feedback"
  ]);
  return {
    settings: sanitizeSettings(stored.settings),
    stats: stored.stats || clone(EMPTY_STATS),
    runtime: stored.runtimeState || clone(EMPTY_RUNTIME),
    decisions: stored.decisions || [],
    feedback: stored.feedback || clone(EMPTY_FEEDBACK)
  };
}

async function popupData() {
  await mutateTracking(async () => {});
  const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  const data = await dashboardData();
  let hostname = "";
  if (tab?.url && isWebUrl(tab.url)) hostname = normalizeHostname(tab.url);
  const today = data.stats.days?.[localDateKey()] || { sites: {} };
  const site = today.sites?.[hostname] || { seconds: 0, opens: 0 };
  const lastDecision = data.decisions.find(
    (decision) => decision.type === "site" && decision.hostname === hostname
  );
  return {
    enabled: data.settings.enabled,
    hostname,
    title: tab?.title || "",
    site,
    lastDecision,
    isProtected: isProtectedDomain(hostname, data.settings.sitePolicy.protectedDomains),
    hasGrant: hasGrant(data.runtime, hostname),
    siteConfidenceThreshold: data.settings.sitePolicy.confidenceThreshold,
    bridgeConfigured: Boolean(data.settings.bridge.token)
  };
}

async function saveSettings(candidate) {
  const settings = sanitizeSettings(candidate);
  await serialize(() =>
    browser.storage.local.set({
      settings,
      classificationCache: clone(EMPTY_CACHE)
    })
  );
  const tabs = await browser.tabs.query({});
  await Promise.allSettled(
    tabs.map((tab) => browser.tabs.sendMessage(tab.id, { type: "SETTINGS_CHANGED" }))
  );
  return settings;
}

async function testBridge(candidateSettings) {
  const settings = candidateSettings ? sanitizeSettings(candidateSettings) : await getSettings();
  return bridgeRequest(settings, "/health", null, { method: "GET", timeout: 8000 });
}

async function clearActivityData() {
  await serialize(async () => {
    const { runtimeState } = await browser.storage.local.get("runtimeState");
    const runtime = runtimeState || clone(EMPTY_RUNTIME);
    if (runtime.active) {
      runtime.active.lastTick = Date.now();
      runtime.active.sessionStartedAt = Date.now();
      runtime.active.sessionSeconds = 0;
    }
    await browser.storage.local.set({
      stats: clone(EMPTY_STATS),
      decisions: [],
      feedback: clone(EMPTY_FEEDBACK),
      classificationCache: clone(EMPTY_CACHE),
      runtimeState: runtime
    });
  });
  return { cleared: true };
}

async function exportData() {
  const data = await dashboardData();
  data.settings.bridge.token = "[redacted]";
  delete data.runtime.pendingGates;
  return {
    exportedAt: new Date().toISOString(),
    version: browser.runtime.getManifest().version,
    ...data
  };
}

async function cleanupStorage() {
  await serialize(async () => {
    const stored = await browser.storage.local.get([
      "stats",
      "runtimeState",
      "classificationCache"
    ]);
    const stats = stored.stats || clone(EMPTY_STATS);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffKey = localDateKey(cutoff);
    for (const key of Object.keys(stats.days || {})) {
      if (key < cutoffKey) delete stats.days[key];
    }

    const runtime = stored.runtimeState || clone(EMPTY_RUNTIME);
    const now = Date.now();
    for (const [domain, expiry] of Object.entries(runtime.grants || {})) {
      if (Number(expiry) <= now) delete runtime.grants[domain];
    }
    for (const [id, gate] of Object.entries(runtime.pendingGates || {})) {
      if (now - Number(gate.createdAt || 0) > PENDING_GATE_TTL_MS) {
        delete runtime.pendingGates[id];
      }
    }

    const cache = stored.classificationCache || clone(EMPTY_CACHE);
    for (const [key, entry] of Object.entries(cache.sites || {})) {
      if (now - Number(entry.timestamp || 0) > SITE_CACHE_TTL_MS) delete cache.sites[key];
    }
    for (const [key, entry] of Object.entries(cache.feed || {})) {
      if (now - Number(entry.timestamp || 0) > FEED_CACHE_TTL_MS) delete cache.feed[key];
    }
    await browser.storage.local.set({ stats, runtimeState: runtime, classificationCache: cache });
  });
}

browser.runtime.onMessage.addListener((message, sender) =>
  handleMessage(message, sender).catch((error) => ({ ok: false, error: humanError(error) }))
);

async function handleMessage(message, sender) {
  await bootPromise;
  switch (message?.type) {
    case "GET_DASHBOARD":
      return { ok: true, data: await dashboardData() };
    case "GET_POPUP_DATA":
      return { ok: true, data: await popupData() };
    case "SAVE_SETTINGS":
      return { ok: true, settings: await saveSettings(message.settings) };
    case "TEST_BRIDGE":
      return { ok: true, health: await testBridge(message.settings) };
    case "TOGGLE_ENABLED": {
      const settings = await getSettings();
      settings.enabled = Boolean(message.enabled);
      return { ok: true, settings: await saveSettings(settings) };
    }
    case "PAUSE_SITE":
      await grantSite(message.hostname, message.minutes);
      return { ok: true };
    case "CLASSIFY_FEED_ITEMS":
      return { ok: true, ...(await classifyFeedItems(message, sender)) };
    case "FEED_FEEDBACK":
      return { ok: true, ...(await saveFeedFeedback(message, sender)) };
    case "GET_GATE":
      return { ok: true, gate: await getGate(String(message.id || ""), sender) };
    case "GATE_CHAT":
      return {
        ok: true,
        ...(await chatAtGate(String(message.id || ""), message.text, sender))
      };
    case "GATE_CONTINUE":
      return {
        ok: true,
        ...(await continueGate(String(message.id || ""), sender, Boolean(message.fallback)))
      };
    case "GATE_CLOSE":
      return { ok: true, ...(await closeGate(String(message.id || ""), sender)) };
    case "OPEN_OPTIONS":
      await browser.runtime.openOptionsPage();
      return { ok: true };
    case "EXPORT_DATA":
      return { ok: true, data: await exportData() };
    case "CLEAR_DATA":
      return { ok: true, ...(await clearActivityData()) };
    default:
      throw new Error("Unknown extension message.");
  }
}

function stripHash(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value;
  }
}

function humanError(error) {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error || "Unknown error").slice(0, 500);
}
