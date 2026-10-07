import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { once } from "node:events";
import type { Server } from "node:http";
import pino from "pino";
import request from "supertest";

import { createApp } from "@/server";

const app = createApp(pino({ enabled: false }));
let server: Server;

beforeAll(async () => {
  server = app.listen(0);
  await once(server, "listening");
});

afterAll(() => {
  server.close();
});

describe("HTTP API", () => {
  it("returns a typed health response", async () => {
    const response = await request(server).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("returns the centralized response for an unknown route", async () => {
    const response = await request(server).get("/does-not-exist");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  });
});
