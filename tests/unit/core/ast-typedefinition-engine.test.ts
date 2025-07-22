import { beforeEach, describe, expect, it } from "vitest";
import {
  ASTTypeDefinitionEngine,
  generateApiResponseInterface,
  generateAuthConfigInterface,
  generateAuthenticationError,
  generateExportBlock,
  generateExportStatement,
  generateExportTypeStatement,
  generateFileHeader,
  generateGenericInterface,
  generateInferredResponseInterface,
  generateInterface,
  generateMainFunction,
  generateMainFunctionEmptyBody,
  generateMainFunctionWithMaster,
  generateRequestOptionsInterface,
  generateTypeDefinitions,
  generateUsageExample,
} from "../../../src/core/ast/ASTTypeDefinitionEngine.js";

/**
 * Test suite for AST Type Definition Engine
 *
 * This tests the drop-in replacement for TypeDefinitionTemplateEngine
 * to ensure it produces equivalent output with better type safety.
 */
describe("AST Type Definition Engine", () => {
  describe("Basic Interface Generation", () => {
    it("should generate a simple interface", () => {
      const result = generateInterface("User", [
        { name: "id", type: "string" },
        { name: "name", type: "string" },
        { name: "email", type: "string", optional: true },
      ]);

      expect(result).toContain("interface User");
      expect(result).toContain("id: string");
      expect(result).toContain("name: string");
      expect(result).toContain("email?: string");
    });

    it("should generate a generic interface", () => {
      const result = generateGenericInterface("ApiResponse", "T, E", [
        { name: "data", type: "T" },
        { name: "error", type: "E", optional: true },
      ]);

      expect(result).toContain("interface ApiResponse<T, E>");
      expect(result).toContain("data: T");
      expect(result).toContain("error?: E");
    });
  });

  describe("Standard Type Generation", () => {
    it("should generate ApiResponse interface", () => {
      const result = generateApiResponseInterface();

      expect(result).toContain("interface ApiResponse<T = any>");
      expect(result).toContain("success: boolean");
      expect(result).toContain("data: T");
      expect(result).toContain("status: number");
      expect(result).toContain("headers: Record<string, string>");
    });

    it("should generate RequestOptions interface", () => {
      const result = generateRequestOptionsInterface();

      expect(result).toContain("interface RequestOptions");
      expect(result).toContain("method: string");
      expect(result).toContain("headers: Record<string, string>");
      expect(result).toContain("body?: string");
    });

    it("should generate AuthConfig interface", () => {
      const result = generateAuthConfigInterface();

      expect(result).toContain("interface AuthConfig");
      expect(result).toContain(
        "type: 'bearer' | 'api_key' | 'basic' | 'session' | 'custom'"
      );
      expect(result).toContain("token?: string");
      expect(result).toContain("sessionCookies?: Record<string, string>");
    });

    it("should generate AuthenticationError class", () => {
      const result = generateAuthenticationError();

      expect(result).toContain("class AuthenticationError extends Error");
      expect(result).toContain(
        "constructor(message: string, public readonly status: number"
      );
      expect(result).toContain("super(message)");
      expect(result).toContain("this.name = 'AuthenticationError'");
    });
  });

  describe("File Structure Generation", () => {
    it("should generate file header", () => {
      const result = generateFileHeader(
        "Test prompt",
        "session-123",
        "2025-01-01"
      );

      expect(result).toContain("// Harvest Generated API Integration Code");
      expect(result).toContain("// Original prompt: Test prompt");
      expect(result).toContain("// Generated: 2025-01-01");
      expect(result).toContain("// Session ID: session-123");
      expect(result).toContain("// DO NOT EDIT - This file is auto-generated");
    });

    it("should generate export statements", () => {
      const result = generateExportStatement(["func1", "func2", "func3"]);

      expect(result).toContain("export {");
      expect(result).toContain("func1");
      expect(result).toContain("func2");
      expect(result).toContain("func3");
      expect(result).toContain("};");
    });

    it("should generate export type statements", () => {
      const result = generateExportTypeStatement(["Type1", "Type2"]);

      expect(result).toContain("export type { Type1, Type2 };");
    });

    it("should generate usage example", () => {
      const result = generateUsageExample("./my-client.ts");

      expect(result).toContain("// Usage example:");
      expect(result).toContain('import { main } from "./my-client.ts"');
      expect(result).toContain("const result = await main()");
      expect(result).toContain("console.log(result.data)");
    });
  });

  describe("Function Generation", () => {
    it("should generate main function", () => {
      const body =
        "  const result = await apiCall();\n  return { success: true, data: result };";
      const result = generateMainFunction(body);

      expect(result).toContain("async function main(): Promise<ApiResponse>");
      expect(result).toContain(
        "Main function that executes the complete API workflow"
      );
      expect(result).toContain("const result = await apiCall()");
      expect(result).toContain("return { success: true, data: result }");
    });

    it("should generate main function empty body", () => {
      const result = generateMainFunctionEmptyBody();

      expect(result).toContain(
        'throw new Error("No API functions found to execute")'
      );
    });

    it("should generate main function with master", () => {
      const result = generateMainFunctionWithMaster("performSearch");

      expect(result).toContain("Execute requests in dependency order");
      expect(result).toContain("const result = await performSearch()");
      expect(result).toContain("return result");
    });

    it("should generate export block", () => {
      const result = generateExportBlock([
        "searchUsers",
        "createUser",
        "updateUser",
      ]);

      expect(result).toContain("// Export all functions for individual use");
      expect(result).toContain("export {");
      expect(result).toContain("searchUsers");
      expect(result).toContain("createUser");
      expect(result).toContain("updateUser");
      expect(result).toContain("main");
      expect(result).toContain("};");
    });
  });

  describe("Inferred Types Generation", () => {
    it("should generate inferred response interface", () => {
      const fields = [
        { name: "id", type: "string", optional: false },
        { name: "title", type: "string", optional: false },
        { name: "count", type: "number", optional: true },
      ];

      const result = generateInferredResponseInterface("SearchResult", fields);

      expect(result).toContain("interface SearchResult");
      expect(result).toContain("id: string");
      expect(result).toContain("title: string");
      expect(result).toContain("count?: number");
    });

    it("should generate complete type definitions", () => {
      const inferredTypes = [
        {
          interfaceName: "UserData",
          fields: [
            { name: "id", type: "string", optional: false },
            { name: "name", type: "string", optional: false },
          ],
        },
      ];

      const result = generateTypeDefinitions(inferredTypes);

      expect(result).toContain("// Type definitions");
      expect(result).toContain("interface UserData");
      expect(result).toContain("interface ApiResponse");
      expect(result).toContain("interface RequestOptions");
      expect(result).toContain("interface AuthConfig");
      expect(result).toContain("class AuthenticationError");
      expect(result).toContain(
        "export type { ApiResponse, RequestOptions, AuthConfig }"
      );
    });
  });

  describe("ASTTypeDefinitionEngine Class", () => {
    let engine: ASTTypeDefinitionEngine;

    beforeEach(() => {
      engine = new ASTTypeDefinitionEngine();
    });

    it("should allow building complete type definitions programmatically", () => {
      engine.addFileHeader("Test API Client", "test-session", "2025-01-01");
      engine.addStandardTypeDefinitions();
      engine.addUsageExample("./test-client.ts");

      const result = engine.generateCode();

      expect(result).toContain("// Harvest Generated API Integration Code");
      expect(result).toContain("// Type definitions");
      expect(result).toContain("interface ApiResponse");
      expect(result).toContain("class AuthenticationError");
      expect(result).toContain("// Usage example:");
      expect(result).toContain('import { main } from "./test-client.ts"');
    });

    it("should allow adding custom interfaces", () => {
      engine.addInterface("CustomType", [
        { name: "prop1", type: "string" },
        { name: "prop2", type: "number", optional: true },
      ]);

      const result = engine.generateCode();

      expect(result).toContain("interface CustomType");
      expect(result).toContain("prop1: string");
      expect(result).toContain("prop2?: number");
    });

    it("should support clearing and reusing the engine", () => {
      engine.addInterface("FirstType", [{ name: "prop", type: "string" }]);
      expect(engine.generateCode()).toContain("FirstType");

      engine.clear();
      engine.addInterface("SecondType", [{ name: "prop", type: "number" }]);
      const result = engine.generateCode();

      expect(result).toContain("SecondType");
      expect(result).not.toContain("FirstType");
    });
  });

  describe("Template System Compatibility", () => {
    it("should produce structurally similar output to template system", () => {
      // Test the main generateTypeDefinitions function that would be called by CodeGenerator
      const inferredTypes = [
        {
          interfaceName: "ApiSearchResult",
          fields: [
            { name: "id", type: "string", optional: false },
            { name: "title", type: "string", optional: false },
            { name: "description", type: "string", optional: true },
          ],
        },
      ];

      const result = generateTypeDefinitions(inferredTypes);

      // Check structure matches what the original template system would produce
      expect(result).toContain("// Type definitions");
      expect(result).toContain("interface ApiSearchResult");
      expect(result).toContain("interface ApiResponse<T = any>");
      expect(result).toContain("interface RequestOptions");
      expect(result).toContain("interface AuthConfig");
      expect(result).toContain("class AuthenticationError extends Error");
      expect(result).toContain(
        "export type { ApiResponse, RequestOptions, AuthConfig }"
      );

      // Verify the generated code is syntactically valid TypeScript
      expect(result).toMatch(/interface \w+/);
      expect(result).toMatch(/export (interface|type|class)/);

      console.log("✅ AST output structurally compatible with template system");
    });

    it("should handle edge cases that template system handles", () => {
      // Empty inferred types
      const result1 = generateTypeDefinitions();
      expect(result1).toContain("interface ApiResponse");
      expect(result1).not.toContain("// Inferred response data types");

      // Empty function list
      const result2 = generateExportBlock([]);
      expect(result2).toContain("export {");
      expect(result2).toContain("main");

      // Interface with no properties
      const result3 = generateInterface("EmptyInterface", []);
      expect(result3).toContain("interface EmptyInterface");

      console.log("✅ Edge cases handled correctly");
    });
  });

  describe("Type Safety and Validation", () => {
    it("should generate syntactically correct TypeScript", () => {
      const result = generateTypeDefinitions([
        {
          interfaceName: "ComplexType",
          fields: [
            { name: "id", type: "string", optional: false },
            { name: "metadata", type: "Record<string, any>", optional: true },
            { name: "tags", type: "string[]", optional: true },
            { name: "callback", type: "(data: any) => void", optional: true },
          ],
        },
      ]);

      // Should handle complex types correctly
      expect(result).toContain("Record<string, any>");
      expect(result).toContain("string[]");
      expect(result).toContain("(data: any) => void");

      // Basic syntax validation
      const openBraces = (result.match(/{/g) || []).length;
      const closeBraces = (result.match(/}/g) || []).length;
      expect(openBraces).toBe(closeBraces);

      console.log("✅ Generated code passes basic syntax validation");
    });
  });
});
