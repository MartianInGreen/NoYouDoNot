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

  const threshold = Number(sitePolicy?.confidenceThreshold ?? 0.62);
  const withChat = Boolean(sitePolicy?.interventionEnabled);
  const effectivePolicy = decision?.effectivePolicy;

  if (effectivePolicy?.choice) {
    const policyConfidence = Number(effectivePolicy.confidence || 0);
    if (policyConfidence < threshold) {
      return { action: "allow", reason: "uncertain_effective_policy" };
    }
    if (effectivePolicy.choice === "specific_allowance") {
      return { action: "allow", reason: "specific_allowance" };
    }
    if (effectivePolicy.choice === "not_covered") {
      return { action: "allow", reason: "not_covered_by_intentions" };
    }
    if (effectivePolicy.choice === "ambiguous") {
      return { action: "allow", reason: "ambiguous_intentions" };
    }
    if (effectivePolicy.choice === "specific_restriction") {
      if (withChat) return { action: "chat", reason: "specific_restriction" };
      return enforcement === "strict"
        ? { action: "block", reason: "specific_restriction" }
        : { action: "nudge", reason: "specific_restriction" };
    }
    if (effectivePolicy.choice !== "general_guidance") {
      return { action: "allow", reason: "unknown_effective_policy" };
    }
  } else {
    // Backward compatibility for cached judgments made before intentions were
    // explicitly reconciled into one effective policy.
    const explicitlyDisallowed = Number(decision?.explicitlyDisallowed);
    if (Number.isFinite(explicitlyDisallowed) && explicitlyDisallowed >= threshold) {
      if (withChat) return { action: "chat", reason: "explicit_restriction" };
      return enforcement === "strict"
        ? { action: "block", reason: "explicit_restriction" }
        : { action: "nudge", reason: "explicit_restriction" };
    }
  }

  let fit = decision?.intentFit?.choice;
  if (effectivePolicy?.choice === "general_guidance" && fit === "conflicts") {
    // Broad guidance can justify a nudge, but not the same consequence as a
    // concrete rule that survived carve-out reconciliation.
    fit = "likely_drift";
  }
  const confidence = Number(decision?.intentFit?.confidence || 0);
  if (!fit) return { action: "allow", reason: "unknown_classification" };

  if (fit === "supports" || fit === "purposeful" || fit === "intentional_leisure") {
    return { action: "allow", reason: fit };
  }

  // Confidence only gates adverse classifications. A low-confidence positive
  // classification would be allowed regardless, so the threshold is not its reason.
  if (confidence < threshold) {
    return { action: "allow", reason: "low_confidence" };
  }

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

export function deriveInterventionAccess(assessment, warning, now = Date.now()) {
  const threshold = Number(assessment?.threshold);
  const reasonExplained = Number(assessment?.reasonExplained);
  const reasonConflicts = Number(assessment?.reasonConflicts);
  const hasAssessment =
    Boolean(assessment) &&
    Number.isFinite(threshold) &&
    Number.isFinite(reasonExplained) &&
    Number.isFinite(reasonConflicts);
  const reasonAccepted = hasAssessment && reasonExplained >= threshold;
  const warningRequired = reasonAccepted && reasonConflicts >= threshold;
  const warningEnd = Number(warning?.waitUntil);
  const warningDuration = Number(warning?.waitSeconds);
  const waitUntil = warningRequired && Number.isFinite(warningEnd) ? warningEnd : 0;
  const waitSeconds = warningRequired && Number.isFinite(warningDuration) ? warningDuration : 0;
  const waitRemainingSeconds = warningRequired
    ? Math.max(0, Math.ceil((waitUntil - now) / 1000))
    : 0;

  return {
    reasonAccepted,
    warningRequired,
    waitSeconds,
    waitUntil,
    waitRemainingSeconds,
    canContinue: reasonAccepted && waitRemainingSeconds === 0
  };
}

export function deriveConflictWaitSeconds(
  conflictWeight,
  threshold = 0.62,
  baseSeconds = 15,
  maximumSeconds = 120
) {
  const weight = Number(conflictWeight);
  if (!Number.isFinite(weight)) return 0;

  const cutoff = Math.min(1, Math.max(0, Number(threshold) || 0));
  if (weight < cutoff) return 0;

  const base = Math.max(1, Math.round(Number(baseSeconds) || 15));
  const maximum = Math.max(base, Math.round(Number(maximumSeconds) || base));
  if (maximum === base || cutoff >= 1) return base;

  // A just-high-enough conflict gets one base interval. The wait then grows
  // linearly with the semantic distance up to the configured hard maximum.
  const distance = Math.min(1, Math.max(0, (weight - cutoff) / (1 - cutoff)));
  return Math.min(maximum, Math.ceil(base + (maximum - base) * distance));
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
