import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/SessionManager.js";
import type { SessionStartParams } from "../../../src/types/index.js";

describe("SessionManager", () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    sessionManager = new SessionManager();
  });

  afterEach(() => {
    sessionManager.clearAllSessions();
  });

  describe("createSession", () => {
    it("should create a new session with valid parameters", async () => {
      const params: SessionStartParams = {
        harPath: "tests/fixtures/test-data/pangea_search.har",
        cookiePath: "tests/fixtures/test-data/pangea_cookies.json",
        prompt: "search for documents",
        inputVariables: { query: "test" },
      };

      const sessionId = await sessionManager.createSession(params);

      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe("string");
      expect(sessionManager.hasSession(sessionId)).toBe(true);

      const session = sessionManager.getSession(sessionId);
      expect(session.prompt).toBe(params.prompt);
      expect(session.state.inputVariables).toEqual(params.inputVariables);
    });

    it("should create session without cookie file", async () => {
      const params: SessionStartParams = {
        harPath: "tests/fixtures/test-data/pangea_search.har",
        prompt: "search for documents",
      };

      const sessionId = await sessionManager.createSession(params);
      const session = sessionManager.getSession(sessionId);

      expect(session.cookieData).toBeUndefined();
    });

    it("should throw error for invalid HAR path", async () => {
      const params: SessionStartParams = {
        harPath: "nonexistent.har",
        prompt: "test",
      };

      await expect(sessionManager.createSession(params)).rejects.toThrow();
    });
  });

  describe("getSession", () => {
    it("should return session when it exists", async () => {
      const params: SessionStartParams = {
        harPath: "tests/fixtures/test-data/pangea_search.har",
        prompt: "test",
      };

      const sessionId = await sessionManager.createSession(params);
      const session = sessionManager.getSession(sessionId);

      expect(session.id).toBe(sessionId);
      expect(session.prompt).toBe(params.prompt);
    });

    it("should throw SessionNotFoundError when session does not exist", () => {
      expect(() => sessionManager.getSession("nonexistent")).toThrow(
        "Session nonexistent not found"
      );
    });
  });

  describe("deleteSession", () => {
    it("should delete existing session", async () => {
      const params: SessionStartParams = {
        harPath: "tests/fixtures/test-data/pangea_search.har",
        prompt: "test",
      };

      const sessionId = await sessionManager.createSession(params);
      expect(sessionManager.hasSession(sessionId)).toBe(true);

      const deleted = sessionManager.deleteSession(sessionId);
      expect(deleted).toBe(true);
      expect(sessionManager.hasSession(sessionId)).toBe(false);
    });

    it("should return false for nonexistent session", () => {
      const deleted = sessionManager.deleteSession("nonexistent");
      expect(deleted).toBe(false);
    });
  });

  describe("listSessions", () => {
    it("should return empty array when no sessions exist", () => {
      const sessions = sessionManager.listSessions();
      expect(sessions).toEqual([]);
    });

    it("should list all active sessions", async () => {
      const params1: SessionStartParams = {
        harPath: "tests/fixtures/test-data/pangea_search.har",
        prompt: "first session",
      };

      const params2: SessionStartParams = {
        harPath: "tests/fixtures/test-data/pangea_search.har",
        prompt: "second session",
      };

      const sessionId1 = await sessionManager.createSession(params1);
      const sessionId2 = await sessionManager.createSession(params2);

      const sessions = sessionManager.listSessions();
      expect(sessions).toHaveLength(2);

      const sessionIds = sessions.map((s) => s.id);
      expect(sessionIds).toContain(sessionId1);
      expect(sessionIds).toContain(sessionId2);
    });
  });

  describe("addLog", () => {
    it("should add log entry to session", async () => {
      const params: SessionStartParams = {
        harPath: "tests/fixtures/test-data/pangea_search.har",
        prompt: "test",
      };

      const sessionId = await sessionManager.createSession(params);
      sessionManager.addLog(sessionId, "info", "Test log message", {
        data: "test",
      });

      const logs = sessionManager.getSessionLogs(sessionId);
      expect(logs).toHaveLength(2); // 1 for creation + 1 for our log

      const lastLog = logs[logs.length - 1];
      expect(lastLog?.level).toBe("info");
      expect(lastLog?.message).toBe("Test log message");
      expect(lastLog?.data).toEqual({ data: "test" });
    });

    it("should not add log to nonexistent session", () => {
      sessionManager.addLog("nonexistent", "info", "Test");
      // Should not throw, just silently ignore
    });
  });

  describe("getStats", () => {
    it("should return correct statistics", async () => {
      const params: SessionStartParams = {
        harPath: "tests/fixtures/test-data/pangea_search.har",
        prompt: "test",
      };

      await sessionManager.createSession(params);

      const stats = sessionManager.getStats();
      expect(stats.totalSessions).toBe(1);
      expect(stats.activeSessions).toBe(1);
      expect(stats.completedSessions).toBe(0);
      expect(stats.averageNodeCount).toBeGreaterThanOrEqual(0);
    });
  });
});
