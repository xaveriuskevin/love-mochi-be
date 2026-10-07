import type { ErrorRequestHandler } from "express";

import { ApiError } from "@/utils/errors";

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
  };
}

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  request,
  response,
  _next,
) => {
  if (error instanceof ApiError) {
    const errorBody: ErrorResponse["error"] = {
      code: error.code,
      message: error.message,
    };

    if (error.fields !== undefined) {
      errorBody.fields = error.fields;
    }

    response.status(error.statusCode).json({
      error: errorBody,
    } satisfies ErrorResponse);
    return;
  }

  request.log.error({ err: error }, "Unhandled request error");
  response.status(500).json({
    error: { code: "INTERNAL_SERVER_ERROR", message: "Internal server error" },
  } satisfies ErrorResponse);
};
