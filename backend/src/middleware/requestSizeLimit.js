"use strict";

const express = require("express");
const { createError, ErrorCodes } = require("../utils/errors");

const DEFAULT_REQUEST_SIZE_LIMIT_BYTES = 100 * 1024;

/**
 * Default JSON body limit for every route that does not declare a budget in
 * REQUEST_SIZE_BUDGETS. Keep in sync with
 * `backend/docs/request-size-budgets.md` (issue #1785).
 */
const DEFAULT_JSON_LIMIT = "20kb";

/**
 * Per-route JSON body budgets, keyed by the Express mount path used in
 * `server.js`. A budget is raised only where real payloads plausibly exceed
 * the default; the audit evidence for each entry is documented in
 * `backend/docs/request-size-budgets.md`.
 *
 * IMPORTANT: `server.js` registers these budgets BEFORE the default JSON
 * parser. body-parser only parses in the first middleware that consumes the
 * request stream (later parsers see the request as already finished and
 * skip), so a budget mounted after the default parser would never apply —
 * which is exactly the bug scope.js/messagesRoutes.js router-level limits
 * had before issue #1785.
 */
const REQUEST_SIZE_BUDGETS = Object.freeze({
  // Collaborative scope documents: MAX_CONTENT_LENGTH allows 500,000
  // characters and migration V67 stores up to 512 KiB of content, so
  // legitimate bodies live in the hundreds of kilobytes.
  "/api/scope": "2mb",
  // Messages: content up to 10,000 characters (multibyte text can triple
  // that on the wire) plus attachment metadata (V27 columns).
  "/api/messages": "50kb",
  // Profile upserts: portfolio_items (maxItems 10; `url` has no schema
  // maxLength) alongside the rest of the profile object can exceed 20 KB.
  "/api/profiles": "64kb",
});

function parseSizeLimit(limit) {
  if (typeof limit === "number" && Number.isFinite(limit)) {
    return limit;
  }

  if (typeof limit !== "string") {
    return DEFAULT_REQUEST_SIZE_LIMIT_BYTES;
  }

  const normalized = limit.trim().toLowerCase();
  const match = normalized.match(/^(\d+)(b|kb|mb)?$/);
  if (!match) {
    return DEFAULT_REQUEST_SIZE_LIMIT_BYTES;
  }

  const value = Number.parseInt(match[1], 10);
  const unit = match[2] || "b";

  if (unit === "mb") return value * 1024 * 1024;
  if (unit === "kb") return value * 1024;
  return value;
}

/**
 * Structured error for a request body that exceeds its size budget.
 *
 * Serialized by the terminal error handler in `server.js` as:
 *   { error, code: "FILE_TOO_LARGE", details: { limit } } with HTTP 413.
 *
 * @param {string|number} limit - The violated budget (e.g. "20kb").
 * @returns {Error} Error carrying code FILE_TOO_LARGE, status 413, details.
 */
function createSizeLimitError(limit) {
  return createError(
    ErrorCodes.FILE_TOO_LARGE,
    `Request body too large. Maximum size is ${limit}.`,
    413,
    { limit },
  );
}

function createRequestSizeLimitMiddleware(limit = "100kb") {
  const limitBytes = parseSizeLimit(limit);

  return function requestSizeLimitMiddleware(req, res, next) {
    const header = req.headers["content-length"];
    if (!header) {
      return next();
    }

    const contentLength = Number.parseInt(header, 10);
    if (Number.isNaN(contentLength) || contentLength <= limitBytes) {
      return next();
    }

    return next(createSizeLimitError(limit));
  };
}

/**
 * JSON body parser with an explicit size budget.
 *
 * Behaves like `express.json({ limit })`, except oversized bodies are
 * rejected with the structured FILE_TOO_LARGE error (instead of
 * body-parser's bare 413 "request entity too large") and other body-parser
 * failures (e.g. invalid JSON) pass through unchanged.
 *
 * @param {string} [limit] - Size budget, e.g. "20kb", "2mb" (default "20kb").
 * @returns {Function} Express middleware.
 */
function createJsonBodyLimitMiddleware(limit = DEFAULT_JSON_LIMIT) {
  const jsonParser = express.json({ limit });

  return function jsonBodyLimitMiddleware(req, res, next) {
    jsonParser(req, res, (err) => {
      if (!err) {
        return next();
      }
      if (err.type === "entity.too.large") {
        return next(createSizeLimitError(limit));
      }
      return next(err);
    });
  };
}

module.exports = {
  DEFAULT_JSON_LIMIT,
  DEFAULT_REQUEST_SIZE_LIMIT_BYTES,
  REQUEST_SIZE_BUDGETS,
  createJsonBodyLimitMiddleware,
  createRequestSizeLimitMiddleware,
  createSizeLimitError,
  parseSizeLimit,
};
