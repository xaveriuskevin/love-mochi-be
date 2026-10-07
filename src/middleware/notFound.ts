import type { RequestHandler } from "express";

import { ApiError } from "@/utils/errors";

export const notFound: RequestHandler = (_request, _response, next) => {
  next(new ApiError(404, "NOT_FOUND", "Route not found"));
};
