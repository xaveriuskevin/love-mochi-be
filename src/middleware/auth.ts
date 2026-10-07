import type { RequestHandler } from "express";

import { ApiError } from "@/utils/errors";

export interface AuthVerifier {
  verifyAccessToken(accessToken: string): Promise<{ id: string } | null>;
}

export function requireAuth(authVerifier: AuthVerifier): RequestHandler {
  return async (request, _response, next) => {
    const authorization = request.header("authorization");
    const match = authorization?.match(/^Bearer\s+(\S+)$/i);

    if (match?.[1] === undefined) {
      next(new ApiError(401, "AUTH_REQUIRED", "Authentication required"));
      return;
    }

    try {
      const user = await authVerifier.verifyAccessToken(match[1]);

      if (user === null) {
        next(new ApiError(401, "AUTH_REQUIRED", "Authentication required"));
        return;
      }

      request.auth = { userId: user.id };
      next();
    } catch {
      next(new ApiError(401, "AUTH_REQUIRED", "Authentication required"));
    }
  };
}
