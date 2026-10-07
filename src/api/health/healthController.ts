import type { RequestHandler } from "express";

import { getHealthStatus } from "@/api/health/healthService";

export const getHealth: RequestHandler = (_request, response) => {
  response.status(200).json(getHealthStatus());
};
