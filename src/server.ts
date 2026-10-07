import express, { type Express } from "express";
import type { Server } from "node:http";
import type { Logger } from "pino";

import { healthRouter } from "@/api/health/healthRouter";
import { createCareRouter } from "@/api/care/careRouter";
import { createCareService } from "@/api/care/careService";
import { createDevicesRouter } from "@/api/devices/devicesRouter";
import { createDevicesService } from "@/api/devices/devicesService";
import { createPairsRouter } from "@/api/pairs/pairsRouter";
import { createPairsService } from "@/api/pairs/pairsService";
import { createWorkspaceRouter } from "@/api/workspace/workspaceRouter";
import { createWorkspaceService } from "@/api/workspace/workspaceService";
import { createSupabaseAuthVerifier } from "@/auth/supabaseAuthVerifier";
import { corsAllowedOrigins, parseEnvironment, type Environment } from "@/config/env";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { createCareNotifier, type CareNotifier } from "@/notifications/careNotifier";
import { createWebPushClient } from "@/notifications/webPushClient";
import { errorHandler } from "@/middleware/errorHandler";
import { notFound } from "@/middleware/notFound";
import { requestLogger } from "@/middleware/requestLogger";
import { allowlistedCors } from "@/middleware/cors";
import type { AuthVerifier } from "@/middleware/auth";
import { createPairingQueries, type PairingQueries } from "@/queries/pairing";
import { createCareQueries, type CareQueries } from "@/queries/care";
import {
  createNotificationQueries,
  type NotificationQueries,
} from "@/queries/notifications";
import { createLogger } from "@/utils/logger";

export interface ApplicationDependencies {
  authVerifier: AuthVerifier;
  pairingQueries: PairingQueries;
  careQueries?: CareQueries;
  notificationQueries?: NotificationQueries;
  careNotifier?: CareNotifier;
  corsAllowedOrigins?: ReadonlySet<string>;
}

export function createApp(
  logger: Logger,
  dependencies?: ApplicationDependencies,
): Express {
  const app = express();

  app.disable("x-powered-by");
  if (dependencies?.corsAllowedOrigins !== undefined) {
    app.use(allowlistedCors(dependencies.corsAllowedOrigins));
  }
  app.use(requestLogger(logger));
  app.use(express.json({ limit: "1mb" }));

  app.use("/health", healthRouter);

  if (dependencies !== undefined) {
    app.use(
      "/api/me",
      createWorkspaceRouter(
        dependencies.authVerifier,
        createWorkspaceService(dependencies.pairingQueries),
      ),
    );
    if (dependencies.careQueries !== undefined) {
      app.use(
        "/api/pets",
        createCareRouter(
          dependencies.authVerifier,
          createCareService(dependencies.careQueries, dependencies.careNotifier),
        ),
      );
    }
    if (dependencies.notificationQueries !== undefined) {
      app.use(
        "/api/devices",
        createDevicesRouter(
          dependencies.authVerifier,
          createDevicesService(dependencies.notificationQueries),
        ),
      );
    }
    app.use(
      "/api/pairs",
      createPairsRouter(
        dependencies.authVerifier,
        createPairsService(dependencies.pairingQueries),
      ),
    );
  }

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export function startServer(
  environment: Environment = parseEnvironment(process.env),
): Server {
  const logger = createLogger(environment);
  const supabase = createSupabaseAdminClient(environment);
  const notificationQueries = createNotificationQueries(supabase);
  const webPush = createWebPushClient(
    environment.VAPID_SUBJECT, environment.VAPID_PUBLIC_KEY, environment.VAPID_PRIVATE_KEY,
  );
  const app = createApp(logger, {
    authVerifier: createSupabaseAuthVerifier(supabase),
    pairingQueries: createPairingQueries(supabase),
    careQueries: createCareQueries(supabase),
    notificationQueries,
    careNotifier: createCareNotifier(notificationQueries, webPush, logger),
    corsAllowedOrigins: corsAllowedOrigins(environment),
  });
  const server = app.listen(environment.PORT, () => {
    logger.info({ port: environment.PORT }, "Love Mochi API listening");
  });

  return server;
}

if (require.main === module) {
  try {
    startServer();
  } catch (error) {
    // Environment parsing happens before a logger exists. Keep this message
    // readable without serializing the environment or any credential values.
    const message = error instanceof Error ? error.message : "Unknown startup error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
