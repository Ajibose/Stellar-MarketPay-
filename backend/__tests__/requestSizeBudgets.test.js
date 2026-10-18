"use strict";

/**
 * __tests__/requestSizeBudgets.test.js
 *
 * End-to-end coverage of the per-route JSON body size budgets wired into
 * server.js (issue #1785):
 *
 *   - a raised-limit route (/api/scope) accepts bodies far above the 20 KB
 *     default instead of failing with a silent 413,
 *   - oversized bodies are rejected with a structured JSON error carrying a
 *     machine-readable code and the violated limit,
 *   - unbudgeted routes keep the 20 KB default.
 */

jest.mock("../src/db/pool", () => {
  const { createPgMock } = require("../src/testUtils/pgMock");
  return createPgMock();
});

const request = require("supertest");
const pool = require("../src/db/pool");
const app = require("../src/server");
const {
  REQUEST_SIZE_BUDGETS,
} = require("../src/middleware/requestSizeLimit");
const { MAX_CONTENT_LENGTH } = require("../src/routes/scope");

const SCOPE_SESSION_ROW = {
  session_id: "budget-test-session",
  content: "",
  cursors: {},
  finalized: false,
  finalized_hash: null,
  finalized_payload: null,
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  updated_at: new Date().toISOString(),
};

describe("per-route JSON body size budgets (issue #1785)", () => {
  beforeEach(() => {
    pool.reset();
    pool.query.mockResolvedValue({ rows: [SCOPE_SESSION_ROW] });
  });

  describe("raised budget: /api/scope", () => {
    it("accepts a ~60 KB session payload the 20 KB default would reject", async () => {
      const res = await request(app)
        .post("/api/scope/budget-test-session")
        .send({ content: "a".repeat(60_000), cursors: {} });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("rejects content above MAX_CONTENT_LENGTH with a structured 413", async () => {
      const res = await request(app)
        .post("/api/scope/budget-test-session")
        .send({ content: "a".repeat(MAX_CONTENT_LENGTH + 1) });

      expect(res.status).toBe(413);
      expect(res.body.code).toBe("PAYLOAD_TOO_LARGE");
      expect(res.body.error).toContain("Payload Too Large");
    });

    it("enforces the raised budget itself with a structured 413", async () => {
      const res = await request(app)
        .post("/api/scope/budget-test-session")
        .send({ content: "a".repeat(2 * 1024 * 1024 + 1024) });

      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({
        code: "FILE_TOO_LARGE",
        details: { limit: REQUEST_SIZE_BUDGETS["/api/scope"] },
      });
    });
  });

  describe("default budget", () => {
    it("keeps unbudgeted routes at 20 KB with a structured 413", async () => {
      const res = await request(app)
        .post("/api/jobs")
        .send({ title: "x".repeat(30_000) });

      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({
        code: "FILE_TOO_LARGE",
        details: { limit: "20kb" },
      });
    });
  });
});
