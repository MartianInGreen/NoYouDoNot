import "dotenv/config";
import { createServer } from "node:http";
import { createRequestHandler } from "./app.mjs";
import { loadConfig, validateConfig } from "./config.mjs";
import { createJevService } from "./jev.mjs";
import { createChatService } from "./llm.mjs";

const config = loadConfig();
const errors = validateConfig(config);
if (errors.length) {
  console.error("Cannot start No You Do Not bridge:\n- " + errors.join("\n- "));
  process.exit(1);
}

const jev = createJevService(config.typesafe);
const chat = createChatService(config.llm);
const handler = createRequestHandler({ config, jev, chat });
const server = createServer(handler);

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(config.port, config.host, () => {
  console.info(`No You Do Not bridge listening on http://${config.host}:${config.port}`);
  console.info(`Jev: ${jev.configured ? config.typesafe.model : "not configured"}`);
  console.info(`Intervention LLM: ${chat.configured ? config.llm.model : "not configured"}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
