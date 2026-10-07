import { Router } from "express";

import { createWorkspaceController } from "@/api/workspace/workspaceController";
import type { WorkspaceService } from "@/api/workspace/workspaceService";
import { requireAuth, type AuthVerifier } from "@/middleware/auth";

export function createWorkspaceRouter(
  authVerifier: AuthVerifier,
  service: WorkspaceService,
): Router {
  const router = Router();
  const controller = createWorkspaceController(service);

  router.get("/workspace", requireAuth(authVerifier), controller.getWorkspace);

  return router;
}
