import type { RequestHandler } from "express";

const ALLOWED_HEADERS = "Authorization, Content-Type, Idempotency-Key";

export function allowlistedCors(allowedOrigins: ReadonlySet<string>): RequestHandler {
  return (request, response, next) => {
    const origin = request.get("origin");
    if (origin === undefined) { next(); return; }
    if (!allowedOrigins.has(origin)) {
      response.status(403).json({
        error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin is not allowed" },
      });
      return;
    }
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    if (request.method === "OPTIONS") { response.status(204).send(); return; }
    next();
  };
}
