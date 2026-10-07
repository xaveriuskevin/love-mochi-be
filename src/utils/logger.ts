import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from "pino";

import type { Environment } from "@/config/env";

export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.idempotency-key",
  "req.body.inviteCode",
  "req.body.label",
  "req.body.note",
  "req.body.subscription.endpoint",
  "req.body.subscription.keys.p256dh",
  "req.body.subscription.keys.auth",
  "res.headers['set-cookie']",
  "inviteCode",
  "inviteHash",
  "invite.code",
  "label",
  "note",
  "SUPABASE_SERVICE_ROLE_KEY",
  "supabaseServiceRoleKey",
  "serviceRoleKey",
  "VAPID_PRIVATE_KEY",
  "vapidPrivateKey",
  "*.SUPABASE_SERVICE_ROLE_KEY",
  "*.supabaseServiceRoleKey",
  "*.serviceRoleKey",
  "*.VAPID_PRIVATE_KEY",
  "*.vapidPrivateKey",
  "*.inviteCode",
  "*.inviteHash",
  "*.invite.code",
  "*.label",
  "*.note",
  "token",
  "*.token",
  "endpoint",
  "p256dh",
  "auth",
  "subscription",
  "*.endpoint",
  "*.p256dh",
  "*.auth",
  "*.subscription",
];

export function createLogger(
  environment: Pick<Environment, "LOG_LEVEL" | "NODE_ENV">,
  destination?: DestinationStream,
): Logger {
  const options: LoggerOptions = {
    level: environment.LOG_LEVEL,
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
    },
  };

  if (environment.NODE_ENV === "development") {
    options.transport = {
      target: "pino-pretty",
      options: { colorize: true, singleLine: true },
    };
  }

  return destination === undefined ? pino(options) : pino(options, destination);
}
