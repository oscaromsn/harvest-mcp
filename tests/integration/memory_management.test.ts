import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manualSessionManager } from "../../src/core/ManualSessionManager.js";
import type { SessionConfig } from "../../src/types/index.js";
import { MemoryMonitor, memoryMonitor } from "../../src/utils/memoryMonitor.js";

/**
 * Memory Management Integration Tests
 *
 * These tests validate Sprint 6 memory management requirements:
 * - Memory leak detection
 * - Resource cleanup after sessions
 * - Memory monitoring and reporting
 * - Garbage collection
 */
describe("Sprint 6: Memory Management & Performance", () => {
  let testOutputDir: string;

  beforeEach(() => {
    testOutputDir = join(tmpdir(), `harvest-memory-test-${randomUUID()}`);
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

  describe("Memory Monitoring", () => {
    test("should track memory usage during session lifecycle", async () => {
      const initialMemory = memoryMonitor.getCurrentMemoryUsage();
      expect(initialMemory.heapUsed).toBeGreaterThan(0);
      expect(initialMemory.heapTotal).toBeGreaterThan(0);

      // Create a session
      const sessionConfig: SessionConfig = {
        artifactConfig: {
          enabled: true,
          outputDir: testOutputDir,
        },
        browserOptions: {
          headless: true,
        },
      };

      const sessionInfo =
        await manualSessionManager.startSession(sessionConfig);
      expect(sessionInfo.id).toBeDefined();

      // Check memory after session creation
      const afterCreateMemory = memoryMonitor.getCurrentMemoryUsage();
      expect(afterCreateMemory.heapUsed).toBeGreaterThanOrEqual(
        initialMemory.heapUsed
      );

      // Wait a bit to allow memory to settle
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Stop the session
      await manualSessionManager.stopSession(sessionInfo.id, {
        reason: "memory_test",
      });

      // Check memory after cleanup
      const afterCleanupMemory = memoryMonitor.getCurrentMemoryUsage();
      expect(afterCleanupMemory.heapUsed).toBeGreaterThan(0);

      // Verify session-specific memory tracking
      const sessionMemoryHistory = manualSessionManager.getSessionMemoryUsage(
        sessionInfo.id
      );
      expect(sessionMemoryHistory.length).toBeGreaterThan(0);

      // Should have snapshots for session start and stop
      const startSnapshots = sessionMemoryHistory.filter((s) =>
        s.operation?.includes("session_start")
      );
      const stopSnapshots = sessionMemoryHistory.filter((s) =>
        s.operation?.includes("session_stop")
      );

      expect(startSnapshots.length).toBeGreaterThan(0);
      expect(stopSnapshots.length).toBeGreaterThan(0);
    }, 15000);

    test("should detect memory leaks over multiple sessions", async () => {
      const sessionCount = 3;
      const sessionIds: string[] = [];

      // Create and destroy multiple sessions
      for (let i = 0; i < sessionCount; i++) {
        const sessionConfig: SessionConfig = {
          artifactConfig: {
            enabled: true,
            outputDir: join(testOutputDir, `session-${i}`),
          },
          browserOptions: {
            headless: true,
          },
        };

        const sessionInfo =
          await manualSessionManager.startSession(sessionConfig);
        sessionIds.push(sessionInfo.id);

        // Let session run briefly
        await new Promise((resolve) => setTimeout(resolve, 200));

        await manualSessionManager.stopSession(sessionInfo.id, {
          reason: `memory_leak_test_${i}`,
        });

        // Force garbage collection between sessions
        manualSessionManager.performCleanup();
      }

      // Check for memory leaks
      const memoryStats = manualSessionManager.getMemoryStats();
      expect(memoryStats.activeSessions).toBe(0);
      expect(memoryStats.snapshotCount).toBeGreaterThan(sessionCount * 2); // At least 2 snapshots per session

      // Leak detection should not indicate a severe leak for such a short test
      expect(memoryStats.leakDetection.growth).toBeLessThan(100); // Less than 100MB/hour growth
    }, 20000);

    test("should provide detailed memory statistics", () => {
      const stats = manualSessionManager.getMemoryStats();

      expect(stats.current).toBeDefined();
      expect(stats.current.heapUsed).toBeGreaterThan(0);
      expect(stats.current.heapTotal).toBeGreaterThan(0);
      expect(stats.current.rss).toBeGreaterThan(0);

      expect(stats.peak).toBeDefined();
      expect(stats.average).toBeDefined();
      expect(stats.snapshotCount).toBeGreaterThanOrEqual(0);
      expect(stats.activeSessions).toBe(0);

      expect(stats.leakDetection).toBeDefined();
      expect(stats.leakDetection.isLeaking).toBeDefined();
      expect(stats.leakDetection.trend).toMatch(/increasing|stable|decreasing/);
      expect(typeof stats.leakDetection.growth).toBe("number");
    });

    test("should format memory sizes correctly", () => {
      expect(MemoryMonitor.formatMemorySize(1024)).toBe("1.00 KB");
      expect(MemoryMonitor.formatMemorySize(1024 * 1024)).toBe("1.00 MB");
      expect(MemoryMonitor.formatMemorySize(1024 * 1024 * 1024)).toBe(
        "1.00 GB"
      );
      expect(MemoryMonitor.formatMemorySize(512)).toBe("512.00 B");
    });
  });

  describe("Resource Cleanup", () => {
    test("should properly clean up browser resources", async () => {
      const sessionConfig: SessionConfig = {
        artifactConfig: {
          enabled: true,
          outputDir: testOutputDir,
        },
        browserOptions: {
          headless: true,
        },
      };

      // Create session
      const sessionInfo =
        await manualSessionManager.startSession(sessionConfig);
      expect(manualSessionManager.listActiveSessions().length).toBe(1);

      // Get initial memory
      const beforeCleanup = memoryMonitor.getCurrentMemoryUsage();

      // Stop session
      const result = await manualSessionManager.stopSession(sessionInfo.id, {
        reason: "cleanup_test",
      });

      expect(result.id).toBe(sessionInfo.id);
      expect(manualSessionManager.listActiveSessions().length).toBe(0);

      // Verify cleanup with explicit garbage collection
      const cleanupResult = manualSessionManager.performCleanup();
      expect(cleanupResult.gcForced).toBeDefined(); // May be true or false depending on environment
      expect(cleanupResult.memoryBefore).toBeGreaterThan(0);
      expect(cleanupResult.memoryAfter).toBeGreaterThan(0);

      // Memory should be stable or reduced after cleanup
      const afterCleanup = memoryMonitor.getCurrentMemoryUsage();
      expect(afterCleanup.heapUsed).toBeLessThanOrEqual(
        beforeCleanup.heapUsed * 1.1
      ); // Allow 10% tolerance
    }, 10000);

    test("should handle concurrent session cleanup", async () => {
      const concurrentSessions = 3;
      const sessionPromises: Promise<string>[] = [];

      // Start multiple sessions concurrently
      for (let i = 0; i < concurrentSessions; i++) {
        const promise = manualSessionManager
          .startSession({
            artifactConfig: {
              enabled: true,
              outputDir: join(testOutputDir, `concurrent-${i}`),
            },
            browserOptions: {
              headless: true,
            },
          })
          .then((info) => info.id);

        sessionPromises.push(promise);
      }

      const sessionIds = await Promise.all(sessionPromises);
      expect(sessionIds.length).toBe(concurrentSessions);
      expect(manualSessionManager.listActiveSessions().length).toBe(
        concurrentSessions
      );

      // Stop all sessions concurrently
      const stopPromises = sessionIds.map((id) =>
        manualSessionManager.stopSession(id, {
          reason: "concurrent_cleanup_test",
        })
      );

      const results = await Promise.all(stopPromises);
      expect(results.length).toBe(concurrentSessions);
      expect(manualSessionManager.listActiveSessions().length).toBe(0);

      // Verify memory state after concurrent cleanup
      const memoryStats = manualSessionManager.getMemoryStats();
      expect(memoryStats.activeSessions).toBe(0);
    }, 15000);
  });

  describe("Performance Monitoring", () => {
    test("should maintain acceptable memory usage under load", async () => {
      const maxSessions = 5;
      const sessionIds: string[] = [];

      try {
        // Create multiple sessions to simulate load
        for (let i = 0; i < maxSessions; i++) {
          const sessionInfo = await manualSessionManager.startSession({
            artifactConfig: {
              enabled: false, // Disable artifacts to focus on core memory usage
            },
            browserOptions: {
              headless: true,
            },
          });

          sessionIds.push(sessionInfo.id);

          // Take memory snapshot after each session
          const memory = memoryMonitor.getCurrentMemoryUsage();
          const memoryMB = memory.heapUsed / (1024 * 1024);

          // Each session should not add more than reasonable amount of memory
          // This is a rough heuristic - adjust based on actual requirements
          expect(memoryMB).toBeLessThan(500); // Less than 500MB total
        }

        expect(manualSessionManager.listActiveSessions().length).toBe(
          maxSessions
        );

        // Clean up all sessions
        await Promise.all(
          sessionIds.map((id) =>
            manualSessionManager.stopSession(id, { reason: "load_test" })
          )
        );

        expect(manualSessionManager.listActiveSessions().length).toBe(0);
      } catch (error) {
        // Clean up on error
        await Promise.allSettled(
          sessionIds.map((id) =>
            manualSessionManager
              .stopSession(id, { reason: "error_cleanup" })
              .catch(() => {
                // Ignore cleanup errors
              })
          )
        );
        throw error;
      }
    }, 30000);

    test("should detect and warn about memory leaks", async () => {
      // This test simulates a leak by creating many memory snapshots quickly
      const snapshotCount = 15;

      for (let i = 0; i < snapshotCount; i++) {
        memoryMonitor.takeSnapshot(undefined, `leak_test_${i}`);
        // Small delay to simulate different timestamps
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const leakDetection = memoryMonitor.detectMemoryLeaks();

      expect(leakDetection.isLeaking).toBeDefined();
      expect(leakDetection.trend).toMatch(/increasing|stable|decreasing/);
      expect(typeof leakDetection.growth).toBe("number");

      if (leakDetection.isLeaking) {
        expect(leakDetection.recommendation).toBeDefined();
        expect(leakDetection.recommendation).toContain("memory leak");
      }
    });
  });
});
