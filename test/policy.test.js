import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveFeedAction,
  deriveSiteAction,
  domainMatches,
  isProtectedDomain,
  normalizeHostname,
  stableHash
} from "../extension/shared/policy.js";

test("normalizes hostnames and matches only domain boundaries", () => {
  assert.equal(normalizeHostname("https://www.Notion.so/page"), "notion.so");
  assert.equal(domainMatches("team.notion.so", "notion.so"), true);
  assert.equal(domainMatches("evilnotion.so", "notion.so"), false);
  assert.equal(isProtectedDomain("docs.google.com", ["google.com"]), true);
});

test("site policy always fails open below the confidence threshold", () => {
  const result = deriveSiteAction(
    { intentFit: { choice: "conflicts", confidence: 0.61 } },
    { enforcement: "strict", confidenceThreshold: 0.62, interventionEnabled: false }
  );
  assert.deepEqual(result, { action: "allow", reason: "low_confidence" });
});

test("a direct active restriction takes precedence over an uncertain broad classification", () => {
  assert.deepEqual(
    deriveSiteAction(
      {
        explicitlyDisallowed: 0.94,
        intentFit: { choice: "conflicts", confidence: 0.35 }
      },
      { enforcement: "balanced", confidenceThreshold: 0.62, interventionEnabled: true }
    ),
    { action: "chat", reason: "explicit_restriction" }
  );
});

test("an uncertain direct restriction still fails open", () => {
  assert.deepEqual(
    deriveSiteAction(
      {
        explicitlyDisallowed: 0.61,
        intentFit: { choice: "conflicts", confidence: 0.61 }
      },
      { enforcement: "strict", confidenceThreshold: 0.62, interventionEnabled: false }
    ),
    { action: "allow", reason: "low_confidence" }
  );
});

test("balanced mode sends explicit conflicts to reflection when enabled", () => {
  assert.deepEqual(
    deriveSiteAction(
      { intentFit: { choice: "conflicts", confidence: 0.9 } },
      { enforcement: "balanced", confidenceThreshold: 0.6, interventionEnabled: true }
    ),
    { action: "chat", reason: "conflicts" }
  );
});

test("strict mode blocks conflicts without an override barrier", () => {
  assert.equal(
    deriveSiteAction(
      { intentFit: { choice: "conflicts", confidence: 0.9 } },
      { enforcement: "strict", confidenceThreshold: 0.6, interventionEnabled: false }
    ).action,
    "block"
  );
});

test("positive classifications are the allow reason regardless of confidence", () => {
  for (const choice of ["supports", "purposeful", "intentional_leisure"]) {
    assert.deepEqual(
      deriveSiteAction(
        { intentFit: { choice, confidence: 0.2 } },
        { enforcement: "strict", confidenceThreshold: 0.6, interventionEnabled: true }
      ),
      { action: "allow", reason: choice }
    );
  }
});

test("feed policy limits explicit high-confidence limit results", () => {
  const result = deriveFeedAction(
    {
      disposition: { choice: "limit", confidence: 0.8 },
      informative: { score: 2, confidence: 0.8 },
      topicFit: 0.8
    },
    { confidenceThreshold: 0.6, strictness: "balanced" }
  );
  assert.equal(result.action, "limit");
});

test("feed policy does not hide uncertain items", () => {
  const result = deriveFeedAction(
    { disposition: { choice: "limit", confidence: 0.59 } },
    { confidenceThreshold: 0.6, strictness: "strict" }
  );
  assert.deepEqual(result, { action: "allow", reason: "uncertain" });
});

test("strict feed policy can combine low information and topic mismatch", () => {
  const result = deriveFeedAction(
    {
      disposition: { choice: "allow", confidence: 0.85 },
      informative: { score: 0.8, confidence: 0.9 },
      topicFit: 0.2
    },
    { confidenceThreshold: 0.6, strictness: "strict" }
  );
  assert.equal(result.reason, "low_value_and_topic_mismatch");
});

test("stable hashes are deterministic", () => {
  assert.equal(stableHash({ a: 1 }), stableHash({ a: 1 }));
  assert.notEqual(stableHash({ a: 1 }), stableHash({ a: 2 }));
});
