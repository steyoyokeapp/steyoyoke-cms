import http from "node:http";
import { randomUUID } from "node:crypto";

const originalEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function patchedEmit(event, ...args) {
  if (event === "request") {
    const [request, response] = args;
    const started = performance.now();
    const incoming = request.headers["x-request-id"];
    const requestId = typeof incoming === "string" ? incoming.slice(0, 128) : randomUUID();
    request.headers["x-request-id"] = requestId;
    response.setHeader("x-request-id", requestId);
    response.once("finish", () => {
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(), level: "info", event: "http_request", requestId,
        method: request.method, route: new URL(request.url || "/", "http://internal").pathname,
        status: response.statusCode, durationMs: Math.round((performance.now() - started) * 100) / 100,
      }));
    });
  }
  return originalEmit.call(this, event, ...args);
};

await import("./server.js");
