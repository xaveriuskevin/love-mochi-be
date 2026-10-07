import type { RequestHandler } from "express";

import type { WorkspaceService } from "@/api/workspace/workspaceService";

export function createWorkspaceController(service: WorkspaceService): {
  getWorkspace: RequestHandler;
} {
  return {
    async getWorkspace(request, response, next) {
      try {
        const result = await service.getWorkspace(request.auth.userId);
        response.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  };
}
