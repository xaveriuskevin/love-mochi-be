import { Router } from "express";

import { createCareController } from "@/api/care/careController";
import type { CareService } from "@/api/care/careService";
import { requireAuth, type AuthVerifier } from "@/middleware/auth";

export function createCareRouter(authVerifier: AuthVerifier, service: CareService): Router {
  const router = Router(); const controller = createCareController(service);
  router.use(requireAuth(authVerifier));
  router.get("/:petId/activity-state", controller.getState);
  router.get("/:petId/activities", controller.listActivities);
  router.post("/:petId/activities", controller.createActivity);
  router.put("/:petId/feeding-schedule", controller.putFeeding);
  router.get("/:petId/treatment-schedules", controller.listTreatments);
  router.post("/:petId/treatment-schedules", controller.createTreatment);
  router.patch("/:petId/treatment-schedules/:scheduleId", controller.updateTreatment);
  router.delete("/:petId/treatment-schedules/:scheduleId", controller.archiveTreatment);
  return router;
}
