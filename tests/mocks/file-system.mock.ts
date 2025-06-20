import { vi } from "vitest";

/**
 * File system mocks for testing file operations
 * Use these for unit tests that need to mock file I/O
 */

export const createMockFileSystem = () => {
  const mockFiles = new Map<string, string | Buffer>();

  return {
    // Mock file content storage
    setFileContent: (path: string, content: string | Buffer) => {
      mockFiles.set(path, content);
    },

    removeFile: (path: string) => {
      mockFiles.delete(path);
    },

    clear: () => {
      mockFiles.clear();
    },

    // Mock fs functions
    readFile: vi.fn((path: string) => {
      if (!mockFiles.has(path)) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return mockFiles.get(path);
    }),

    access: vi.fn((path: string) => {
      if (!mockFiles.has(path)) {
        throw new Error(`ENOENT: no such file or directory, access '${path}'`);
      }
    }),

    stat: vi.fn(async (path: string) => {
      if (!mockFiles.has(path)) {
        throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
      }
      return {
        isFile: () => true,
        isDirectory: () => false,
        size: mockFiles.get(path)?.toString().length || 0,
      };
    }),
  };
};

/**
 * Common HAR file mock content
 */
export const MOCK_HAR_CONTENT = JSON.stringify({
  log: {
    version: "1.2",
    creator: { name: "test", version: "1.0" },
    entries: [
      {
        request: {
          method: "GET",
          url: "https://api.example.com/test",
          headers: [],
          queryString: [],
          postData: undefined,
        },
        response: {
          status: 200,
          headers: [{ name: "content-type", value: "application/json" }],
          content: { text: '{"result": "success"}' },
        },
        timings: { wait: 100, receive: 50 },
      },
    ],
  },
});

/**
 * Common cookie file mock content
 */
export const MOCK_COOKIE_CONTENT = JSON.stringify([
  {
    name: "session_id",
    value: "test-session-123",
    domain: ".example.com",
    path: "/",
  },
]);
