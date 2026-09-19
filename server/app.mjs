import { timingSafeEqual } from "node:crypto";

const MAX_BODY_BYTES = 256 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 240;

export function createRequestHandler({ config, jev, chat, logger = console }) {
  const clients = new Map();

  return async function requestHandler(request, response) {
    setSecurityHeaders(response);
    const origin = request.headers.origin;
    if (origin && isExtensionOrigin(origin)) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "origin");
    }

    if (request.method === "OPTIONS") {
      if (origin && !isExtensionOrigin(origin)) {
        return sendJson(response, 403, { error: "Browser origin not allowed." });
      }
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      response.setHeader(
        "access-control-allow-headers",
        "content-type, x-noyoudonot-token"
      );
      return sendEmpty(response, 204);
    }

    if (origin && !isExtensionOrigin(origin)) {
      return sendJson(response, 403, { error: "Only extension origins are accepted." });
    }
    if (!authorized(request.headers["x-noyoudonot-token"], config.bridgeToken)) {
      return sendJson(response, 401, { error: "Bridge token rejected." });
    }
    if (!withinRateLimit(clients, request.socket.remoteAddress || "local")) {
      response.setHeader("retry-after", "60");
      return sendJson(response, 429, { error: "Local bridge rate limit exceeded." });
    }

    const url = new URL(request.url || "/", "http://127.0.0.1");
    const started = Date.now();
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, {
          ok: true,
          service: "no-you-do-not-bridge",
          jev: { configured: jev.configured, model: config.typesafe.model },
          llm: { configured: chat.configured, model: config.llm.model || null }
        });
      }

      if (request.method !== "POST") {
        return sendJson(response, 404, { error: "Route not found." });
      }
      const body = await readJsonBody(request);
      let result;
      if (url.pathname === "/v1/classify/site") {
        result = await jev.classifySite(body);
      } else if (url.pathname === "/v1/classify/intervention") {
        result = await jev.evaluateIntervention(body);
      } else if (url.pathname === "/v1/classify/feed") {
        result = await jev.classifyFeed(body);
      } else if (url.pathname === "/v1/intervention/chat") {
        result = await chat.chat(body);
      } else {
        return sendJson(response, 404, { error: "Route not found." });
      }

      if (config.logLevel === "debug") {
        logger.info(`${request.method} ${url.pathname} ${Date.now() - started}ms`);
      }
      return sendJson(response, 200, result);
    } catch (error) {
      const status = Number(error?.status) || 500;
      if (status >= 500) logger.error(`[bridge] ${url.pathname}: ${error?.message || error}`);
      return sendJson(response, status, {
        error: publicError(error, status)
      });
    }
  };
}

function setSecurityHeaders(response) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'none'");
}

function isExtensionOrigin(origin) {
  return origin.startsWith("moz-extension://") || origin.startsWith("chrome-extension://");
}

function authorized(value, expected) {
  if (typeof value !== "string" || !expected) return false;
  const actualBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function withinRateLimit(clients, key) {
  const now = Date.now();
  const existing = clients.get(key);
  if (!existing || now - existing.startedAt >= RATE_WINDOW_MS) {
    clients.set(key, { startedAt: now, count: 1 });
    return true;
  }
  existing.count += 1;
  return existing.count <= RATE_LIMIT;
}

async function readJsonBody(request) {
  const contentType = String(request.headers["content-type"] || "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw httpError("Content-Type must be application/json.", 415);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError("Request body is too large.", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw httpError("Request body is not valid JSON.", 400);
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function sendEmpty(response, status) {
  response.writeHead(status);
  response.end();
}

function publicError(error, status) {
  if (status >= 500 && !error?.status) return "The local bridge encountered an error.";
  return String(error?.message || "Request failed.").slice(0, 500);
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
