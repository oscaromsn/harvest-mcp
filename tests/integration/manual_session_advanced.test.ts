/**
 * Advanced Manual Session Integration Tests
 *
 * Tests advanced error scenarios, edge cases, and integration patterns
 * for the manual session functionality. These tests complement the
 * basic end-to-end tests with more complex validation scenarios.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { manualSessionManager } from "../../src/core/ManualSessionManager.js";
import { HarvestMCPServer } from "../../src/server.js";
// Advanced integration tests for manual sessions

// Helper function for parsing MCP tool responses
function parseToolResponse(response: any): any {
  return JSON.parse(response.content[0]?.text as string);
}

describe("Sprint 5.5: Advanced Manual Session Integration", () => {
  let server: HarvestMCPServer;
  let testOutputDir: string;

  beforeEach(() => {
    server = new HarvestMCPServer();
    testOutputDir = `${tmpdir()}/harvest-advanced-test-${randomUUID()}`;
  });

  afterEach(async () => {
    // Clean up any active sessions
    const activeSessions = manualSessionManager.listActiveSessions();
    for (const session of activeSessions) {
      try {
        await manualSessionManager.stopSession(session.id, {
          reason: "test_cleanup",
        });
      } catch (_error) {
        // Ignore cleanup errors
      }
    }
  });

  describe("Schema Validation Edge Cases", () => {
    test("should handle boundary values in viewport configuration", async () => {
      // Test minimum valid viewport
      const minResponse = await server.handleStartManualSession({
        config: {
          browserOptions: {
            viewport: {
              width: 320, // Minimum valid
              height: 240, // Minimum valid
            },
          },
          artifactConfig: {
            enabled: true,
            outputDir: testOutputDir,
          },
        },
      });

      const minData = parseToolResponse(minResponse);
      expect(minData.success).toBe(true);

      await server.handleStopManualSession({
        sessionId: minData.sessionId,
        reason: "boundary_test",
      });

      // Test maximum valid viewport
      const maxResponse = await server.handleStartManualSession({
        config: {
          browserOptions: {
            viewport: {
              width: 7680, // Maximum valid
              height: 4320, // Maximum valid
            },
          },
          artifactConfig: {
            enabled: true,
            outputDir: testOutputDir,
          },
        },
      });

      const maxData = parseToolResponse(maxResponse);
      expect(maxData.success).toBe(true);

      await server.handleStopManualSession({
        sessionId: maxData.sessionId,
        reason: "boundary_test",
      });
    }, 15000);

    test("should validate device scale factor boundaries", async () => {
      // Test minimum device scale factor
      const response = await server.handleStartManualSession({
        config: {
          browserOptions: {
            contextOptions: {
              deviceScaleFactor: 0.25, // Minimum valid
            },
          },
          artifactConfig: {
            enabled: true,
            outputDir: testOutputDir,
          },
        },
      });

      const data = parseToolResponse(response);
      expect(data.success).toBe(true);

      await server.handleStopManualSession({
        sessionId: data.sessionId,
        reason: "scale_test",
      });
    }, 10000);

    test("should reject invalid URL formats and sanitize valid ones", async () => {
      // Test URL sanitization
      const response = await server.handleStartManualSession({
        url: "example.com", // Missing protocol - should be sanitized
        config: {
          artifactConfig: {
            enabled: true,
            outputDir: testOutputDir,
          },
        },
      });

      const data = parseToolResponse(response);
      expect(data.success).toBe(true);
      expect(data.validation.urlSanitized).toBe(true);
      expect(data.currentUrl).toMatch(/^https:\/\/example\.com/);

      await server.handleStopManualSession({
        sessionId: data.sessionId,
        reason: "url_sanitization_test",
      });

      // Test invalid URL (this will still fail after sanitization)
      await expect(async () => {
        await server.handleStartManualSession({
          url: "not://a-url-at-all", // Invalid protocol
        });
      }).toThrow(/URL must be a valid HTTP\/HTTPS URL/);
    }, 10000);

    test("should validate timeout boundaries", async () => {
      // Test valid timeout boundaries
      const response = await server.handleStartManualSession({
        config: {
          timeout: 1440, // Maximum valid (24 hours)
          artifactConfig: {
            enabled: true,
            outputDir: testOutputDir,
          },
        },
      });

      const data = parseToolResponse(response);
      expect(data.success).toBe(true);

      await server.handleStopManualSession({
        sessionId: data.sessionId,
        reason: "timeout_boundary_test",
      });

      // Test invalid timeout (too large)
      await expect(async () => {
        await server.handleStartManualSession({
          config: {
            timeout: 1441, // Exceeds maximum
          },
        });
      }).toThrow(/Timeout cannot exceed 24 hours/);
    }, 10000);
  });

  describe("Concurrent Session Management", () => {
    test("should handle multiple concurrent sessions correctly", async () => {
      const sessionConfigs = [
        { url: "https://example.com", outputDir: `${testOutputDir}/session1` },
        {
          url: "https://httpbin.org/get",
          outputDir: `${testOutputDir}/session2`,
        },
        { outputDir: `${testOutputDir}/session3` }, // No URL
      ];

      // Start multiple sessions concurrently
      const startPromises = sessionConfigs.map((config) =>
        server.handleStartManualSession({
          config: {
            artifactConfig: {
              enabled: true,
              outputDir: config.outputDir,
            },
          },
          ...(config.url && { url: config.url }),
        })
      );

      const startResponses = await Promise.all(startPromises);

      // Verify all sessions started successfully
      const sessionIds = startResponses.map((response) => {
        const data = parseToolResponse(response);
        expect(data.success).toBe(true);
        return data.sessionId;
      });

      expect(sessionIds).toHaveLength(3);
      expect(new Set(sessionIds).size).toBe(3); // All unique

      // Verify session list shows all sessions
      const listResponse = await server.handleListManualSessions();
      const listData = parseToolResponse(listResponse);
      expect(listData.totalSessions).toBe(3);

      // Stop all sessions
      const stopPromises = sessionIds.map((sessionId) =>
        server.handleStopManualSession({
          sessionId,
          reason: "concurrent_test_cleanup",
        })
      );

      const stopResponses = await Promise.all(stopPromises);

      // Verify all sessions stopped successfully
      for (const response of stopResponses) {
        const data = parseToolResponse(response);
        expect(data.success).toBe(true);
      }

      // Verify no sessions remain
      const finalListResponse = await server.handleListManualSessions();
      const finalListData = parseToolResponse(finalListResponse);
      expect(finalListData.totalSessions).toBe(0);
    }, 30000);

    test("should handle session cleanup on process termination", async () => {
      // Start a session
      const response = await server.handleStartManualSession({
        config: {
          artifactConfig: {
            enabled: true,
            outputDir: testOutputDir,
          },
        },
      });

      const data = parseToolResponse(response);
      const sessionId = data.sessionId;

      // Verify session is active
      const listResponse = await server.handleListManualSessions();
      const listData = parseToolResponse(listResponse);
      expect(listData.totalSessions).toBe(1);

      // Force cleanup (simulates process termination)
      await manualSessionManager.forceStopSession(sessionId);

      // Verify session is cleaned up
      const finalListResponse = await server.handleListManualSessions();
      const finalListData = parseToolResponse(finalListResponse);
      expect(finalListData.totalSessions).toBe(0);
    }, 10000);
  });

  describe("Artifact Collection Edge Cases", () => {
    test("should handle disabled artifact collection", async () => {
      const response = await server.handleStartManualSession({
        config: {
          artifactConfig: {
            enabled: false, // Disabled
          },
        },
      });

      const startData = parseToolResponse(response);
      expect(startData.success).toBe(true);

      const sessionId = startData.sessionId;

      const stopResponse = await server.handleStopManualSession({
        sessionId,
        reason: "disabled_artifacts_test",
      });

      const stopData = parseToolResponse(stopResponse);
      expect(stopData.success).toBe(true);
      expect(stopData.artifactsCollected).toBe(0);
    }, 10000);

    test("should handle selective artifact collection", async () => {
      const response = await server.handleStartManualSession({
        config: {
          artifactConfig: {
            enabled: true,
            outputDir: testOutputDir,
            saveHar: false, // Only disable HAR
            saveCookies: true,
            saveScreenshots: true,
          },
        },
      });

      const startData = parseToolResponse(response);
      const sessionId = startData.sessionId;

      const stopResponse = await server.handleStopManualSession({
        sessionId,
        artifactTypes: ["cookies", "screenshot"], // Only request specific types
        reason: "selective_artifacts_test",
      });

      const stopData = parseToolResponse(stopResponse);
      expect(stopData.success).toBe(true);
      expect(stopData.artifactsCollected).toBeGreaterThan(0);

      // Should not have HAR artifacts
      const harArtifacts = stopData.artifacts.filter(
        (a: any) => a.type === "har"
      );
      expect(harArtifacts).toHaveLength(0);

      // Should have other types
      const cookieArtifacts = stopData.artifacts.filter(
        (a: any) => a.type === "cookies"
      );
      const screenshotArtifacts = stopData.artifacts.filter(
        (a: any) => a.type === "screenshot"
      );
      expect(
        cookieArtifacts.length + screenshotArtifacts.length
      ).toBeGreaterThan(0);
    }, 10000);

    test("should validate output directory security", async () => {
      // Test path traversal protection
      await expect(async () => {
        await server.handleStartManualSession({
          config: {
            artifactConfig: {
              outputDir: "../../../etc/passwd", // Path traversal attempt
            },
          },
        });
      }).toThrow(/Output directory path cannot contain/);
    });
  });

  describe("Session State Management", () => {
    test("should track session duration accurately", async () => {
      const response = await server.handleStartManualSession({
        config: {
          artifactConfig: {
            enabled: true,
            outputDir: testOutputDir,
          },
        },
      });

      const startData = parseToolResponse(response);
      const sessionId = startData.sessionId;

      // Wait a known duration
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const stopResponse = await server.handleStopManualSession({
        sessionId,
        reason: "duration_test",
      });

      const stopData = parseToolResponse(stopResponse);
      const actualDuration = stopData.duration;
      const expectedMinDuration = 1000; // At least 1 second

      expect(actualDuration).toBeGreaterThanOrEqual(expectedMinDuration);
      expect(actualDuration).toBeLessThan(5000); // Should be less than 5 seconds
    }, 10000);

    test("should handle session information queries", async () => {
      const response = await server.handleStartManualSession({
        url: "https://example.com",
        config: {
          artifactConfig: {
            enabled: true,
            outputDir: testOutputDir,
          },
        },
      });

      const startData = parseToolResponse(response);
      const sessionId = startData.sessionId;

      // Query session info through the manager
      const sessionInfo = manualSessionManager.getSessionInfo(sessionId);
      expect(sessionInfo).toBeDefined();
      expect(sessionInfo?.id).toBe(sessionId);
      expect(sessionInfo?.outputDir).toBe(testOutputDir);

      // Test listing sessions
      const listResponse = await server.handleListManualSessions();
      const listData = parseToolResponse(listResponse);
      expect(listData.sessions[0]?.id).toBe(sessionId);
      expect(listData.summary.totalActiveSessions).toBe(1);

      await server.handleStopManualSession({
        sessionId,
        reason: "info_query_test",
      });
    }, 10000);
  });

  describe("Error Recovery and Resilience", () => {
    test("should handle browser launch failures gracefully", async () => {
      // Test with an invalid browser configuration that might cause launch issues
      await expect(async () => {
        await server.handleStartManualSession({
          config: {
            browserOptions: {
              viewport: {
                width: -1, // Invalid viewport
                height: -1,
              },
            },
          },
        });
      }).toThrow(/Viewport width must be at least/);
    });

    test("should handle malformed session parameters", async () => {
      // Test with completely invalid data
      await expect(async () => {
        await server.handleStartManualSession({
          config: {
            timeout: "not-a-number" as any,
          },
        });
      }).toThrow(/Invalid parameters for manual session start/);

      // Test with mixed valid/invalid data
      await expect(async () => {
        await server.handleStartManualSession({
          config: {
            timeout: 5, // Valid
            artifactConfig: {
              autoScreenshotInterval: -1, // Invalid
            },
          },
        });
      }).toThrow(/Auto-screenshot interval must be at least/);
    });

    test("should handle session operations on non-existent sessions", async () => {
      const fakeSessionId = randomUUID();

      // Test getting info for non-existent session
      const sessionInfo = manualSessionManager.getSessionInfo(fakeSessionId);
      expect(sessionInfo).toBeNull();

      // Test stopping non-existent session
      await expect(async () => {
        await server.handleStopManualSession({
          sessionId: fakeSessionId,
        });
      }).toThrow(/Manual session not found/);
    });
  });

  describe("Performance and Resource Management", () => {
    test("should handle rapid session creation and cleanup", async () => {
      const sessionCount = 3; // Reduced for performance
      const sessionIds: string[] = [];

      // Rapidly create sessions
      for (let i = 0; i < sessionCount; i++) {
        const response = await server.handleStartManualSession({
          config: {
            artifactConfig: {
              enabled: false, // Disable artifacts for speed
              outputDir: `${testOutputDir}/rapid-${i}`,
            },
          },
        });

        const data = parseToolResponse(response);
        expect(data.success).toBe(true);
        sessionIds.push(data.sessionId);
      }

      // Verify all sessions are tracked
      const listResponse = await server.handleListManualSessions();
      const listData = parseToolResponse(listResponse);
      expect(listData.totalSessions).toBe(sessionCount);

      // Rapidly clean up sessions
      for (const sessionId of sessionIds) {
        const stopResponse = await server.handleStopManualSession({
          sessionId,
          reason: "rapid_cleanup_test",
        });

        const stopData = parseToolResponse(stopResponse);
        expect(stopData.success).toBe(true);
      }

      // Verify all sessions are cleaned up
      const finalListResponse = await server.handleListManualSessions();
      const finalListData = parseToolResponse(finalListResponse);
      expect(finalListData.totalSessions).toBe(0);
    }, 20000);
  });
});
