import { describe, expect, it } from "vitest";
import { LLMClient } from "../../../src/core/LLMClient.js";

describe("LLMClient", () => {
  describe("constructor", () => {
    it("should throw error without API key", () => {
      process.env.OPENAI_API_KEY = undefined;

      expect(() => new LLMClient()).toThrow(
        "OPENAI_API_KEY environment variable is required"
      );
    });

    it("should create instance with API key", () => {
      process.env.OPENAI_API_KEY = "test-api-key";

      const client = new LLMClient();
      expect(client).toBeInstanceOf(LLMClient);
      expect(client.getModel()).toBe("gpt-4o");
    });

    it("should create instance with custom model", () => {
      process.env.OPENAI_API_KEY = "test-api-key";

      const client = new LLMClient("gpt-4");
      expect(client.getModel()).toBe("gpt-4");
    });
  });

  describe("setModel", () => {
    it("should update the model", () => {
      process.env.OPENAI_API_KEY = "test-api-key";

      const client = new LLMClient();
      client.setModel("gpt-3.5-turbo");
      expect(client.getModel()).toBe("gpt-3.5-turbo");
    });
  });

  // Note: LLM function call tests require OpenAI API mocking
  // These will be tested in integration tests with proper mocking setup
});
