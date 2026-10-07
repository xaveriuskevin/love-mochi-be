import { Router } from "express";

import { createPairsController } from "@/api/pairs/pairsController";
import type { PairsService } from "@/api/pairs/pairsService";
import { requireAuth, type AuthVerifier } from "@/middleware/auth";

export function createPairsRouter(
  authVerifier: AuthVerifier,
  service: PairsService,
): Router {
  const router = Router();
  const controller = createPairsController(service);

  router.use(requireAuth(authVerifier));
  router.post("/", controller.createPair);
  router.post("/join", controller.joinPair);
  router.post("/invite/rotate", controller.rotateInvite);

  return router;
}
