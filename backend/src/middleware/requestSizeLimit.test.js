"use strict";

const express = require("express");
const request = require("supertest");
const { sanitizeMiddleware } = require("./sanitize");
const {
  DEFAULT_JSON_LIMIT,
  REQUEST_SIZE_BUDGETS,
  createJsonBodyLimitMiddleware,
  createRequestSizeLimitMiddleware,
} = require("./requestSizeLimit");

describe("request body size limit and sanitization middleware", () => {
  it("rejects oversized request bodies with 413 when content-length exceeds the configured limit", () => {
    const middleware = createRequestSizeLimitMiddleware("1kb");
    const next = jest.fn();

    middleware(
      { headers: { "content-length": "1500" } },
      {},
      next,
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 413,
        message: expect.stringContaining("Request body too large"),
      }),
    );
  });

  it("strips HTML tags from nested string inputs", () => {
    const middleware = sanitizeMiddleware();
    const req = {
      body: {
        proposal: '<script>alert("xss")</script>Hello <b>world</b>',
        profile: {
          bio: '<img src=x onerror="alert(1)">Builder',
        },
      },
      query: {},
      params: {},
    };
    const next = jest.fn();

    middleware(req, {}, next);

    expect(req.body.proposal).toBe("Hello world");
    expect(req.body.profile.bio).toBe("Builder");
    expect(next).toHaveBeenCalledWith();
  });

  it("attaches the violated limit as structured details", () => {
    const middleware = createRequestSizeLimitMiddleware("1kb");
    const next = jest.fn();

    middleware({ headers: { "content-length": "1500" } }, {}, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 413,
        code: "FILE_TOO_LARGE",
        details: { limit: "1kb" },
      }),
    );
  });
});

describe("REQUEST_SIZE_BUDGETS registry (issue #1785)", () => {
  it("keeps the default JSON limit at 20kb", () => {
    expect(DEFAULT_JSON_LIMIT).toBe("20kb");
  });

  it("declares exactly the audited raised budgets", () => {
    expect(REQUEST_SIZE_BUDGETS).toEqual({
      "/api/scope": "2mb",
      "/api/messages": "50kb",
      "/api/profiles": "64kb",
    });
  });
});

describe("createJsonBodyLimitMiddleware (issue #1785)", () => {
  /** Minimal app mirroring server.js: budget parser + structured error handler. */
  function createApp(limit) {
    const app = express();
    app.use(createJsonBodyLimitMiddleware(limit));
    app.post("/payload", (req, res) => res.json({ received: req.body }));
    app.use((err, req, res, _next) => {
      const status = err.status || err.statusCode || 500;
      res.status(status).json({
        error: err.message,
        code: err.code,
        details: err.details,
      });
    });
    return app;
  }

  it("parses JSON bodies within the budget", async () => {
    const res = await request(createApp("1kb"))
      .post("/payload")
      .send({ ping: "pong" });

    expect(res.status).toBe(200);
    expect(res.body.received).toEqual({ ping: "pong" });
  });

  it("rejects oversized bodies with a structured 413 error", async () => {
    const res = await request(createApp("1kb"))
      .post("/payload")
      .send({ blob: "x".repeat(2048) });

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      code: "FILE_TOO_LARGE",
      details: { limit: "1kb" },
    });
    expect(res.body.error).toContain("Request body too large");
    expect(res.body.error).toContain("1kb");
  });

  it("forwards non-size parsing errors unchanged", async () => {
    const res = await request(createApp("1kb"))
      .post("/payload")
      .set("Content-Type", "application/json")
      .send("{ not json");

    expect(res.status).toBe(400);
    expect(res.body.code).toBeUndefined();
  });
});
