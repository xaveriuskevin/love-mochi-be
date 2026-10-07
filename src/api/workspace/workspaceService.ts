import {
  PairingQueryError,
  type PairingQueries,
} from "@/queries/pairing";
import type { WorkspaceResponse } from "@/types/api";
import { ApiError } from "@/utils/errors";

export interface WorkspaceService {
  getWorkspace(userId: string): Promise<WorkspaceResponse>;
}

export function createWorkspaceService(queries: PairingQueries): WorkspaceService {
  return {
    async getWorkspace(userId) {
      try {
        return await queries.getWorkspace(userId);
      } catch (error) {
        if (error instanceof PairingQueryError && error.databaseCode === "AUTH_REQUIRED") {
          throw new ApiError(401, "AUTH_REQUIRED", "Authentication required");
        }

        throw error;
      }
    },
  };
}
