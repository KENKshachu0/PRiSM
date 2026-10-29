import { describe, expect, it } from "bun:test";
import { createApp } from "../src/app.js";

/** Membership must be reachable from the production app, not only a router. */
describe("membership routes", () => {
  const routes = new Set(
    createApp().routes.map(({ method, path }) => `${method.toUpperCase()} ${path}`),
  );

  it("registers player catalogue and purchase endpoints", () => {
    expect(routes.has("GET /api/v1/shops/:shopCode/player/member")).toBe(true);
    expect(routes.has("POST /api/v1/shops/:shopCode/player/member/purchase")).toBe(true);
  });

  it("registers staff programme, plan and player grant endpoints", () => {
    for (const route of [
      "GET /api/v1/shops/:shopCode/staff/member",
      "PUT /api/v1/shops/:shopCode/staff/member",
      "POST /api/v1/shops/:shopCode/staff/member/plans",
      "PUT /api/v1/shops/:shopCode/staff/member/plans/:planId",
      "POST /api/v1/shops/:shopCode/staff/member/plans/:planId/archive",
      "POST /api/v1/shops/:shopCode/staff/member/plans/:planId/restore",
      "GET /api/v1/shops/:shopCode/staff/players/:playerId/member",
      "POST /api/v1/shops/:shopCode/staff/players/:playerId/member/grant",
      "POST /api/v1/shops/:shopCode/staff/players/:playerId/member/revoke",
    ]) {
      expect(routes.has(route)).toBe(true);
    }
  });
});
