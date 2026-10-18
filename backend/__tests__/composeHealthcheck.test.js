"use strict";

/**
 * __tests__/composeHealthcheck.test.js
 *
 * Regression guard for issue #1761: docker-compose probed
 * `http://localhost:4000/api/health` while `backend/src/server.js` mounts the
 * health router at `/health`, so `/api/health` fell through to the 404 handler,
 * the backend container was reported unhealthy forever, and
 * `depends_on: condition: service_healthy` chains never advanced.
 *
 * Cross-checks the three artifacts that must stay in sync:
 *   1. backend/src/server.js          — app.use("/health", healthRoutes)
 *   2. backend/Dockerfile             — HEALTHCHECK (reference implementation)
 *   3. docker-compose.yml / docker-compose.prod.yml — healthcheck test commands
 */

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BACKEND_PORT = 4000;
const HEALTHY_MARKER = '"status":"healthy"';

function read(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

/**
 * Healthcheck `test:` command lines that probe the backend port.
 * Comments and non-healthcheck occurrences of the port (e.g. the frontend's
 * NEXT_PUBLIC_API_URL=http://localhost:4000) are ignored.
 *
 * @param {string} composeSource - Raw docker-compose YAML.
 * @returns {string[]} Matching `test:` lines (trimmed).
 */
function backendHealthcheckLines(composeSource) {
  return composeSource
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.startsWith("test:") && line.includes(`localhost:${BACKEND_PORT}`),
    );
}

/**
 * Undo double-quote escaping so assertions can compare a raw YAML `test:` line
 * against the shell command it evaluates to (`\"` in YAML source → `"`).
 *
 * @param {string} yamlLine - A raw `test:` line from a compose file.
 * @returns {string} The line with YAML double-quote escapes resolved.
 */
function resolveYamlQuotes(yamlLine) {
  return yamlLine.split('\\"').join('"');
}

/**
 * The path each backend healthcheck probes (e.g. "/health").
 *
 * @param {string} composeSource - Raw docker-compose YAML.
 * @returns {string[]} Probed path per matching healthcheck, in file order.
 */
function backendHealthcheckProbes(composeSource) {
  return backendHealthcheckLines(composeSource).map((line) => {
    const match = line.match(
      new RegExp(`localhost:${BACKEND_PORT}([^"'\\s|]*)`),
    );
    return match ? match[1] : null;
  });
}

describe("backend healthcheck configuration (issue #1761)", () => {
  describe("backend/src/server.js route mount", () => {
    it("mounts the health router at /health", () => {
      expect(read("backend/src/server.js")).toMatch(
        /app\.use\(\s*"\/health"\s*,\s*healthRoutes\s*\)/,
      );
    });

    it("does not mount the health router at /api/health", () => {
      expect(read("backend/src/server.js")).not.toMatch(
        /app\.use\(\s*"\/api\/health"/,
      );
    });
  });

  describe("backend/Dockerfile HEALTHCHECK (reference implementation)", () => {
    const dockerfile = read("backend/Dockerfile");

    it(`probes http://localhost:${BACKEND_PORT}/health`, () => {
      expect(dockerfile).toContain(
        `wget -qO- http://localhost:${BACKEND_PORT}/health`,
      );
    });

    it(`asserts the ${HEALTHY_MARKER} marker emitted by the health route`, () => {
      expect(dockerfile).toContain(`grep -q '${HEALTHY_MARKER}'`);
      // The health route reports "healthy" only when every dependency is up.
      expect(read("backend/src/routes/health.js")).toMatch(
        /allUp \? "healthy" : "degraded"/,
      );
    });
  });

  describe.each(["docker-compose.yml", "docker-compose.prod.yml"])(
    "%s",
    (composeFile) => {
      const composeSource = read(composeFile);
      const healthcheckLines = backendHealthcheckLines(composeSource);

      it("defines a backend healthcheck on the backend port", () => {
        expect(healthcheckLines.length).toBeGreaterThan(0);
      });

      it("probes the mounted /health path — never /api/health", () => {
        const probes = backendHealthcheckProbes(composeSource);
        expect(probes.length).toBeGreaterThan(0);
        for (const probe of probes) {
          expect(probe).toBe("/health");
        }
        for (const line of healthcheckLines) {
          expect(line).not.toContain("/api/health");
        }
      });

      it("probes the same URL and healthy-status marker as the Dockerfile", () => {
        const dockerfile = read("backend/Dockerfile");
        for (const rawLine of healthcheckLines) {
          const line = resolveYamlQuotes(rawLine);
          expect(line).toContain(`http://localhost:${BACKEND_PORT}/health`);
          expect(line).toContain(`grep -q '${HEALTHY_MARKER}'`);
          expect(dockerfile).toContain(`grep -q '${HEALTHY_MARKER}'`);
        }
      });
    },
  );
});
