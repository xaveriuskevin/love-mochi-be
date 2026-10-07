import { Router } from "express";

import { getHealth } from "@/api/health/healthController";

export const healthRouter = Router();

healthRouter.get("/", getHealth);
