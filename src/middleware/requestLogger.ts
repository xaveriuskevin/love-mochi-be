import type { RequestHandler } from "express";
import pinoHttp from "pino-http";
import type { Logger } from "pino";

export function requestLogger(logger: Logger): RequestHandler {
  return pinoHttp({
    logger,
    customLogLevel: (_request, response, error) => {
      if (error !== undefined || response.statusCode >= 500) return "error";
      if (response.statusCode >= 400) return "warn";
      return "info";
    },
  });
}
