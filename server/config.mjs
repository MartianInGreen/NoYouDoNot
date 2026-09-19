export function loadConfig(environment = process.env) {
  const port = Number(environment.PORT || 4317);
  return {
    host: "127.0.0.1",
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 4317,
    bridgeToken: String(environment.NOYOUDONOT_BRIDGE_TOKEN || "").trim(),
    typesafe: {
      apiKey: String(environment.TYPESAFE_API_KEY || "").trim(),
      model: String(environment.TYPESAFE_MODEL || "jev-latest").trim(),
      baseURL: String(environment.TYPESAFE_BASE_URL || "").trim() || undefined
    },
    llm: {
      baseURL: String(environment.LLM_BASE_URL || "").trim(),
      apiKey: String(environment.LLM_API_KEY || "").trim(),
      model: String(environment.LLM_MODEL || "").trim()
    },
    logLevel: String(environment.LOG_LEVEL || "info").toLowerCase()
  };
}

export function validateConfig(config) {
  const errors = [];
  if (config.bridgeToken.length < 16) {
    errors.push("NOYOUDONOT_BRIDGE_TOKEN must be at least 16 characters long.");
  }
  return errors;
}
