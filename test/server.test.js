import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequestHandler } from "../server/app.mjs";

const token = "0123456789abcdef01234567";

async function withServer(run) {
  const config = {
    bridgeToken: token,
    logLevel: "silent",
    typesafe: { model: "jev-test" },
    llm: { model: "chat-test" }
  };
  const jev = {
    configured: true,
    classifySite: async (body) => ({ intentFit: { choice: "supports" }, echoed: body.page.hostname }),
    classifyFeed: async (body) => ({ results: body.items })
  };
  const chat = { configured: true, chat: async () => ({ reply: "What is your stopping point?" }) };
  const logger = { info() {}, error() {} };
  const server = createServer(createRequestHandler({ config, jev, chat, logger }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("bridge rejects requests without its independent token", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 401);
  });
});

test("health reports configured services without exposing keys", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/health`, {
      headers: { "x-noyoudonot-token": token }
    });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.jev.configured, true);
    assert.equal(JSON.stringify(value).includes(token), false);
  });
});

test("site endpoint accepts extension-origin JSON calls", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/classify/site`, {
      method: "POST",
      headers: {
        origin: "moz-extension://test-id",
        "content-type": "application/json",
        "x-noyoudonot-token": token
      },
      body: JSON.stringify({ page: { hostname: "example.com" } })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "moz-extension://test-id");
    assert.equal((await response.json()).echoed, "example.com");
  });
});

test("ordinary website origins cannot call the local bridge", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/health`, {
      headers: {
        origin: "https://malicious.example",
        "x-noyoudonot-token": token
      }
    });
    assert.equal(response.status, 403);
  });
});
