const WEB_PROTOCOLS = new Set(["http:", "https:"]);

export function normalizeHostname(input) {
  try {
    const hostname = input.includes("://") ? new URL(input).hostname : input;
    return hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return "";
  }
}

export function isWebUrl(url) {
  try {
    return WEB_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function domainMatches(hostname, configuredDomain) {
  const host = normalizeHostname(hostname);
  const domain = normalizeHostname(String(configuredDomain || "").trim());
  return Boolean(domain && (host === domain || host.endsWith(`.${domain}`)));
}

export function isProtectedDomain(hostname, protectedDomains = []) {
  return protectedDomains.some((domain) => domainMatches(hostname, domain));
}

export function deriveSiteAction(decision, sitePolicy) {
  const enforcement = sitePolicy?.enforcement || "balanced";
  if (enforcement === "observe") {
    return { action: "allow", reason: "observe_mode" };
  }

  const fit = decision?.intentFit?.choice;
  const confidence = Number(decision?.intentFit?.confidence || 0);
  const threshold = Number(sitePolicy?.confidenceThreshold ?? 0.62);
  if (!fit || confidence < threshold) {
    return { action: "allow", reason: "low_confidence" };
  }

  if (fit === "supports" || fit === "purposeful" || fit === "intentional_leisure") {
    return { action: "allow", reason: fit };
  }

  const withChat = Boolean(sitePolicy?.interventionEnabled);
  if (fit === "likely_drift") {
    if (enforcement === "strict" && withChat) {
      return { action: "chat", reason: fit };
    }
    return { action: "nudge", reason: fit };
  }

  if (fit === "conflicts") {
    if (withChat) return { action: "chat", reason: fit };
    return enforcement === "strict"
      ? { action: "block", reason: fit }
      : { action: "nudge", reason: fit };
  }

  return { action: "allow", reason: "unknown_classification" };
}

export function deriveFeedAction(result, algorithm) {
  const confidence = Number(result?.disposition?.confidence || 0);
  const threshold = Number(algorithm?.confidenceThreshold ?? 0.6);
  if (!result?.disposition?.choice || confidence < threshold) {
    return { action: "allow", reason: "uncertain" };
  }

  const disposition = result.disposition.choice;
  if (disposition === "promote") return { action: "promote", reason: "algorithm_match" };
  if (disposition === "limit") return { action: "limit", reason: "algorithm_limit" };

  const informative = Number(result?.informative?.score ?? 1.5);
  const infoConfidence = Number(result?.informative?.confidence || 0);
  const topicFit = Number(result?.topicFit ?? 0.5);
  const strictness = algorithm?.strictness || "balanced";

  if (
    strictness === "strict" &&
    infoConfidence >= threshold &&
    informative < 1.15 &&
    topicFit < 0.35
  ) {
    return { action: "limit", reason: "low_value_and_topic_mismatch" };
  }

  if (
    strictness === "balanced" &&
    infoConfidence >= threshold &&
    informative < 0.55 &&
    topicFit < 0.2
  ) {
    return { action: "limit", reason: "very_low_value" };
  }

  return { action: "allow", reason: "algorithm_allow" };
}

export function stableHash(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
