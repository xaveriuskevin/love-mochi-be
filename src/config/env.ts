import { z } from "zod";

function isOriginAllowlist(value: string): boolean {
  const origins = value.split(",").map((origin) => origin.trim()).filter(Boolean);
  return origins.length > 0 && origins.every((origin) => {
    try {
      const parsed = new URL(origin);
      return (parsed.protocol === "http:" || parsed.protocol === "https:")
        && parsed.origin === origin && origin !== "*";
    } catch { return false; }
  });
}

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  SUPABASE_URL: z.url("SUPABASE_URL must be a valid URL"),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  CORS_ALLOWED_ORIGINS: z.string().refine(
    isOriginAllowlist,
    "CORS_ALLOWED_ORIGINS must be a comma-separated list of explicit HTTP(S) origins",
  ).default("http://localhost:5173,http://127.0.0.1:5173"),
  VAPID_PUBLIC_KEY: z.string().length(87, "VAPID_PUBLIC_KEY must be 87 characters").regex(
    /^[A-Za-z0-9_-]+$/, "VAPID_PUBLIC_KEY must be base64url",
  ),
  VAPID_PRIVATE_KEY: z.string().length(43, "VAPID_PRIVATE_KEY must be 43 characters").regex(
    /^[A-Za-z0-9_-]+$/, "VAPID_PRIVATE_KEY must be base64url",
  ),
  VAPID_SUBJECT: z.string().refine(
    (value) => /^mailto:[^@\s]+@[^@\s]+$/.test(value) || (() => {
      try { return new URL(value).protocol === "https:"; } catch { return false; }
    })(),
    "VAPID_SUBJECT must use mailto: or https://",
  ),
});

export type Environment = z.infer<typeof environmentSchema>;

export function corsAllowedOrigins(environment: Environment): ReadonlySet<string> {
  return new Set(environment.CORS_ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean));
}

function readableEnvironmentError(error: z.ZodError): Error {
  const details = error.issues
    .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
    .join("; ");
  return new Error(`Invalid environment configuration: ${details}`);
}

export function parseEnvironment(input: NodeJS.ProcessEnv): Environment {
  const result = environmentSchema.safeParse(input);

  if (!result.success) {
    throw readableEnvironmentError(result.error);
  }

  return result.data;
}
