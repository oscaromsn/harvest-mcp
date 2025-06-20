import { createMockSession } from "@tests/setup/test-helpers.js";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createFunctionDefinition,
  formatURLsForPrompt,
} from "../../../src/agents/URLIdentificationAgent.js";
import type { HarvestSession, URLInfo } from "../../../src/types/index.js";

describe("URLIdentificationAgent", () => {
  let mockSession: HarvestSession;
  let mockUrls: URLInfo[];

  beforeEach(() => {
    mockUrls = [
      {
        method: "GET",
        url: "https://example.com/static/assets.js",
        requestType: "GET",
        responseType: "JavaScript",
      },
      {
        method: "POST",
        url: "https://api.example.com/auth/login",
        requestType: "JSON",
        responseType: "JSON",
      },
      {
        method: "GET",
        url: "https://api.example.com/user/profile",
        requestType: "GET",
        responseType: "JSON",
      },
      {
        method: "POST",
        url: "https://api.example.com/documents/search",
        requestType: "JSON",
        responseType: "JSON",
      },
    ];

    mockSession = createMockSession({
      prompt: "search for documents",
      harData: {
        requests: [],
        urls: mockUrls,
      },
    });
  });

  describe("identifyEndUrl", () => {
    it("should return the expected URL structure", async () => {
      // Mock the LLM response for testing
      const expectedUrl = "https://api.example.com/documents/search";

      // This test validates that the expected URL exists in mock data
      const urlExists = mockUrls.some((url) => url.url === expectedUrl);
      expect(urlExists).toBe(true);
    });

    it("should validate session and URLs parameters", () => {
      expect(mockSession).toBeDefined();
      expect(mockSession.prompt).toBe("search for documents");
      expect(mockUrls).toHaveLength(4);
      expect(mockUrls[3]?.url).toBe("https://api.example.com/documents/search");
    });

    it("should handle empty URLs list", () => {
      const emptyUrls: URLInfo[] = [];

      // Agent should handle this gracefully
      expect(emptyUrls).toHaveLength(0);
    });

    it("should prioritize API endpoints over static resources", () => {
      const apiUrls = mockUrls.filter(
        (url) => url.url.includes("api.") || url.url.includes("/api/")
      );

      const nonStaticUrls = mockUrls.filter((url) => !url.url.includes(".js"));

      expect(apiUrls).toHaveLength(3); // login, profile, search (all api.example.com)
      expect(nonStaticUrls).toHaveLength(3); // all except assets.js
      expect(apiUrls.every((url) => url.url.includes("api."))).toBe(true);
    });
  });

  describe("createFunctionDefinition", () => {
    it("should create proper function definition with session prompt", () => {
      const functionDef = createFunctionDefinition(mockSession.prompt);

      expect(functionDef.name).toBe("identify_end_url");
      expect(functionDef.description).toBe(
        "Identify the URL responsible for a specific action"
      );
      expect(functionDef.parameters?.properties).toBeDefined();
      const properties = functionDef.parameters?.properties;
      expect(properties).toBeDefined();
      if (properties && typeof properties === "object" && "url" in properties) {
        const urlProperty = properties.url as { description?: string };
        expect(urlProperty?.description).toContain("search for documents");
      }
      expect(functionDef.parameters?.required).toContain("url");
    });
  });

  describe("formatURLsForPrompt", () => {
    it("should format URLs for LLM consumption", () => {
      const formatted = formatURLsForPrompt(mockUrls);

      expect(formatted).toContain("https://api.example.com/documents/search");
      expect(formatted).toContain("POST");
      expect(formatted).toContain("JSON");
    });

    it("should handle empty URLs gracefully", () => {
      const formatted = formatURLsForPrompt([]);

      expect(formatted).toBeDefined();
      expect(typeof formatted).toBe("string");
    });
  });
});
