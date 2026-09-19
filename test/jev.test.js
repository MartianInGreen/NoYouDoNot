import test from "node:test";
import assert from "node:assert/strict";
import { createJevService } from "../server/jev.mjs";

function choiceAnswer(choice, labels, confidence = 0.8) {
  return {
    type: "choice",
    choice,
    confidence,
    probabilities: Object.fromEntries(labels.map((label) => [label, label === choice ? 0.8 : 0.05]))
  };
}

function scoreAnswer(score = 2.2) {
  return {
    type: "score",
    score,
    confidence: 0.75,
    probabilities: { 0: 0.05, 1: 0.1, 2: 0.55, 3: 0.3 },
    legend: { 0: "none", 1: "some", 2: "good", 3: "great" }
  };
}

test("site classifier builds typed atomic Jev questions", async () => {
  let captured;
  const client = {
    async systemOne(request) {
      captured = request;
      return {
        model: "jev-test",
        usage: { input_tokens: 10, output_tokens: 4 },
        answers: {
          intent_fit: choiceAnswer("supports", ["supports", "purposeful", "intentional_leisure", "likely_drift", "conflicts"]),
          site_kind: choiceAnswer("useful_tool", ["useful_tool", "mixed_use", "attention_sink"]),
          purposeful: { type: "noul", noul: 0.9 },
          expected_value: scoreAnswer()
        }
      };
    }
  };
  const service = createJevService({ apiKey: "test", model: "jev-test" }, { client });
  const result = await service.classifySite({
    page: { hostname: "example.com", path: "/work", title: "Work" },
    intents: { always: "Do useful work", projects: [] },
    context: { behavior: { minutesOnSiteToday: 4 } }
  });

  assert.equal(captured.questions.intent_fit.type, "choice");
  assert.equal(captured.questions.purposeful.type, "noul");
  assert.equal(captured.questions.expected_value.type, "score");
  assert.equal(captured.state.visit.hostname, "example.com");
  assert.equal(result.intentFit.choice, "supports");
  assert.equal(result.expectedValue.score, 2.2);
});

test("feed classifier asks three questions per item in one call", async () => {
  let captured;
  const client = {
    async systemOne(request) {
      captured = request;
      const answers = {};
      for (let index = 0; index < 2; index += 1) {
        answers[`disposition_${index}`] = choiceAnswer("allow", ["promote", "allow", "limit"]);
        answers[`informative_${index}`] = scoreAnswer(1.5);
        answers[`topic_fit_${index}`] = { type: "noul", noul: 0.65 };
      }
      return { model: "jev-test", usage: { input_tokens: 20, output_tokens: 6 }, answers };
    }
  };
  const service = createJevService({ apiKey: "test", model: "jev-test" }, { client });
  const result = await service.classifyFeed({
    platform: "youtube",
    algorithm: "Prefer useful engineering lessons",
    items: [
      { id: "a", title: "One" },
      { id: "b", title: "Two" }
    ]
  });

  assert.equal(Object.keys(captured.questions).length, 6);
  assert.equal(captured.questions.disposition_0.type, "choice");
  assert.equal(captured.questions.informative_1.type, "score");
  assert.equal(result.results.length, 2);
  assert.equal(result.results[1].topicFit, 0.65);
});
