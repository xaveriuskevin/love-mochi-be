import { Router } from "express";

import { createDevicesController } from "@/api/devices/devicesController";
import type { DevicesService } from "@/api/devices/devicesService";
import { requireAuth, type AuthVerifier } from "@/middleware/auth";

export function createDevicesRouter(authVerifier: AuthVerifier, service: DevicesService): Router {
  const router = Router(); const controller = createDevicesController(service);
  router.use(requireAuth(authVerifier));
  router.post("/web-push-subscriptions", controller.registerWebPush);
  router.delete("/web-push-subscriptions/:deviceId", controller.removeWebPush);
  return router;
}
