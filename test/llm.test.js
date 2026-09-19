import test from "node:test";
import assert from "node:assert/strict";
import { createChatService } from "../server/llm.mjs";

test("reflection service uses an OpenAI-compatible endpoint and a bounded prompt", async () => {
  let request;
  const service = createChatService(
    { baseURL: "http://localhost:11434/v1", apiKey: "", model: "local-model" },
    {
      fetch: async (url, options) => {
        request = { url, options, body: JSON.parse(options.body) };
        return new Response(
          JSON.stringify({ model: "local-model", choices: [{ message: { content: "What will tell you it is time to stop?" } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    }
  );
  const result = await service.chat({
    visit: { hostname: "youtube.com", title: "Home" },
    intents: { always: "Avoid automatic scrolling", projects: [] },
    messages: [{ role: "user", content: "I want one tutorial for my project." }]
  });

  assert.equal(request.url, "http://localhost:11434/v1/chat/completions");
  assert.equal(request.body.messages[0].role, "system");
  assert.match(request.body.messages[0].content, /Do not shame/);
  assert.match(request.body.messages[0].content, /after every exchange, Jev independently judges/i);
  assert.doesNotMatch(request.body.messages[0].content, /after \d+ user turns/i);
  assert.equal(result.reply, "What will tell you it is time to stop?");
});
