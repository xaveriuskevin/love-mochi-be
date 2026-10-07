import { describe, expect, it } from "bun:test";

import { parseEnvironment } from "@/config/env";

const VALID_VAPID_PUBLIC_KEY = `B${"A".repeat(86)}`;
const VALID_VAPID_PRIVATE_KEY = "A".repeat(43);
const VAPID = {
  VAPID_PUBLIC_KEY: VALID_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: VALID_VAPID_PRIVATE_KEY,
  VAPID_SUBJECT: "mailto:test@example.com",
};

describe("startup environment", () => {
  it("fails fast with readable field names when required values are absent", () => {
    expect(() => parseEnvironment({})).toThrow(
      /Invalid environment configuration:.*SUPABASE_URL.*SUPABASE_SERVICE_ROLE_KEY/,
    );
  });

  it("does not include a supplied credential in validation errors", () => {
    const credential = "never-log-this-service-role-key";

    expect(() =>
      parseEnvironment({
        SUPABASE_URL: "not-a-url",
        SUPABASE_SERVICE_ROLE_KEY: credential,
      }),
    ).toThrow(/SUPABASE_URL must be a valid URL/);

    try {
      parseEnvironment({
        SUPABASE_URL: "not-a-url",
        SUPABASE_SERVICE_ROLE_KEY: credential,
      });
    } catch (error) {
      expect(String(error)).not.toContain(credential);
    }
  });

  it("accepts only explicit configured CORS origins", () => {
    expect(() => parseEnvironment({
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "secret",
      CORS_ALLOWED_ORIGINS: "*",
    })).toThrow(/CORS_ALLOWED_ORIGINS/);
    expect(parseEnvironment({
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "secret", ...VAPID,
      CORS_ALLOWED_ORIGINS: "http://localhost:5173,https://app.example.com",
    }).CORS_ALLOWED_ORIGINS).toContain("https://app.example.com");
  });
});

describe("Web Push environment", () => {
  it("requires complete VAPID credentials without echoing the private key", () => {
    const privateKey = "NeverPrintThisPrivateVapidKey".padEnd(43, "A");
    try {
      parseEnvironment({
        SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "secret",
        VAPID_PUBLIC_KEY: VALID_VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: "invalid-contact",
      });
      throw new Error("Expected validation to fail");
    } catch (error) {
      expect(String(error)).toContain("VAPID_SUBJECT");
      expect(String(error)).not.toContain(privateKey);
    }
  });

  it("rejects malformed VAPID key shapes", () => {
    expect(() => parseEnvironment({
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "secret",
      VAPID_PUBLIC_KEY: "too-short",
      VAPID_PRIVATE_KEY: VALID_VAPID_PRIVATE_KEY, VAPID_SUBJECT: "mailto:test@example.com",
    })).toThrow(/VAPID_PUBLIC_KEY must be 87 characters/);
  });
});
