export const STORAGE_VERSION = 1;

export const DEFAULT_SETTINGS = {
  enabled: true,
  alwaysIntent:
    "Use the web deliberately. Protect focused work, prefer tools and learning, and notice reflexive scrolling before it takes over.",
  dailyIntent: { text: "", date: "" },
  weeklyIntent: { text: "", week: "" },
  projects: [],
  sitePolicy: {
    enforcement: "balanced",
    confidenceThreshold: 0.62,
    interventionEnabled: true,
    minimumChatTurns: 3,
    grantMinutes: 15,
    protectedDomains: [
      "notion.so",
      "docs.google.com",
      "calendar.google.com",
      "github.com"
    ]
  },
  algorithms: {
    youtube: {
      enabled: true,
      intent:
        "Prefer specific, substantive videos that teach a useful idea or directly support an active project. Limit clickbait, repetitive commentary, outrage, and Shorts chosen only for stimulation.",
      display: "blur",
      strictness: "balanced",
      confidenceThreshold: 0.6
    },
    twitter: {
      enabled: true,
      intent:
        "Prefer primary sources, thoughtful technical material, useful updates, and posts from people I intentionally follow. Limit rage bait, recycled discourse, engagement farming, and context-free hot takes.",
      display: "blur",
      strictness: "balanced",
      confidenceThreshold: 0.6
    }
  },
  bridge: {
    url: "http://127.0.0.1:4317",
    token: ""
  }
};

export const EMPTY_STATS = {
  version: STORAGE_VERSION,
  days: {}
};

export const EMPTY_RUNTIME = {
  version: STORAGE_VERSION,
  active: null,
  idleState: "active",
  windowFocused: true,
  tabHosts: {},
  grants: {},
  pendingGates: {}
};

export const EMPTY_FEEDBACK = {
  youtube: [],
  twitter: []
};

export const EMPTY_CACHE = {
  sites: {},
  feed: {}
};

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function mergeSettings(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  return {
    ...clone(DEFAULT_SETTINGS),
    ...input,
    dailyIntent: { ...DEFAULT_SETTINGS.dailyIntent, ...(input.dailyIntent || {}) },
    weeklyIntent: { ...DEFAULT_SETTINGS.weeklyIntent, ...(input.weeklyIntent || {}) },
    projects: Array.isArray(input.projects) ? input.projects : [],
    sitePolicy: { ...DEFAULT_SETTINGS.sitePolicy, ...(input.sitePolicy || {}) },
    algorithms: {
      youtube: {
        ...DEFAULT_SETTINGS.algorithms.youtube,
        ...(input.algorithms?.youtube || {})
      },
      twitter: {
        ...DEFAULT_SETTINGS.algorithms.twitter,
        ...(input.algorithms?.twitter || {})
      }
    },
    bridge: { ...DEFAULT_SETTINGS.bridge, ...(input.bridge || {}) }
  };
}
