import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { healthRoutes } from "../../src/routes/health.js";

describe("GET /api/health", () => {
  it("should return 200 with status ok", async () => {
    const app = new Hono();
    app.route("/api", healthRoutes);
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: "ok" });
  });
});
