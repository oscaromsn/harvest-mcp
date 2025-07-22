/**
 * AST-Based Type Definition Engine
 *
 * Drop-in replacement for TypeDefinitionTemplateEngine.ts that uses AST builders
 * instead of string templates. Provides the same interface for backward compatibility
 * while offering the benefits of AST-based generation.
 */

import { ASTProject } from "./ASTProject.js";
import { TypeBuilder } from "./TypeBuilder.js";

/**
 * AST-based type definition engine that replaces the template system
 */
export class ASTTypeDefinitionEngine {
  public astProject: ASTProject;
  private currentSourceFile = "generated.ts";

  constructor(astProject?: ASTProject) {
    this.astProject =
      astProject ||
      new ASTProject({
        useInMemoryFileSystem: true,
        formatCode: true,
        organizeImports: false, // Avoid removing unused imports during generation
      });
  }

  /**
   * Set the current source file for generation
   */
  setSourceFile(fileName: string): void {
    this.currentSourceFile = fileName;
  }

  /**
   * Get the current TypeBuilder instance
   */
  public getTypeBuilder(): TypeBuilder {
    const sourceFile = this.astProject.createSourceFile(this.currentSourceFile);
    return new TypeBuilder(this.astProject, sourceFile);
  }

  /**
   * Generate the final code
   */
  generateCode(): string {
    return this.astProject.generateCode(this.currentSourceFile);
  }

  /**
   * Clear all generated content
   */
  clear(): void {
    this.astProject.reset();
  }

  /**
   * Add file header with metadata - generates comment block
   */
  addFileHeader(prompt: string, sessionId: string, date?: string): void {
    const sourceFile = this.astProject.createSourceFile(this.currentSourceFile);
    const headerDate = date || new Date().toISOString().split("T")[0];

    const header = `// Harvest Generated API Integration Code
// ==========================================
//
// Original prompt: ${prompt}
// Generated: ${headerDate}
// Session ID: ${sessionId}
//
// DO NOT EDIT - This file is auto-generated
// To modify the API integration, re-run the Harvest analysis`;

    // Insert at the beginning of the file
    sourceFile.insertText(0, `${header}\n\n`);
  }

  /**
   * Generate standard type definitions
   * @param useSharedImports - If true, import from SharedTypes.ts instead of generating inline
   * @param inferredTypes - Custom response type interfaces to generate
   */
  addStandardTypeDefinitions(
    useSharedImports = false,
    inferredTypes?: Array<{
      interfaceName: string;
      fields: Array<{ name: string; type: string; optional: boolean }>;
    }>
  ): void {
    const typeBuilder = this.getTypeBuilder();

    // Add comment for type definitions section
    const sourceFile = this.astProject.getSourceFile(this.currentSourceFile);
    if (sourceFile) {
      const comment = useSharedImports
        ? "// Type definitions\n\n"
        : "// Type definitions\n\n";
      sourceFile.insertText(sourceFile.getFullText().length, comment);
    }

    // Add inferred response types if provided (these are always generated inline)
    if (inferredTypes && inferredTypes.length > 0) {
      for (const responseType of inferredTypes) {
        typeBuilder.createResponseInterface(
          responseType.interfaceName,
          responseType.fields
        );
      }
    }

    // Generate standard types (shared imports or inline)
    typeBuilder.generateStandardTypes(useSharedImports);

    // Only add export statements if using inline generation
    if (!useSharedImports) {
      // Add export statements for types (except AuthenticationError which is exported by the class)
      this.addExportTypeStatement([
        "ApiResponse",
        "RequestOptions",
        "AuthConfig",
      ]);
    }
  }

  /**
   * Add export statement for functions
   */
  addExportStatement(exports: string[]): void {
    const sourceFile = this.astProject.getSourceFile(this.currentSourceFile);
    if (!sourceFile) {
      return;
    }

    const exportText = `export {\n  ${exports.join(",\n  ")}\n};`;
    sourceFile.insertText(sourceFile.getFullText().length, `\n${exportText}\n`);
  }

  /**
   * Add export type statement
   */
  addExportTypeStatement(types: string[]): void {
    const sourceFile = this.astProject.getSourceFile(this.currentSourceFile);
    if (!sourceFile) {
      return;
    }

    const exportText = `export type { ${types.join(", ")} };`;
    sourceFile.insertText(sourceFile.getFullText().length, `${exportText}\n`);
  }

  /**
   * Add usage example comment
   */
  addUsageExample(importPath = "./generated-api-integration.ts"): void {
    const sourceFile = this.astProject.getSourceFile(this.currentSourceFile);
    if (!sourceFile) {
      return;
    }

    const example = `\n// Usage example:
// import { main } from "${importPath}";
// const result = await main();
// console.log(result.data);\n`;

    sourceFile.insertText(sourceFile.getFullText().length, example);
  }

  /**
   * Add main function
   */
  addMainFunction(body: string): void {
    const sourceFile = this.astProject.getSourceFile(this.currentSourceFile);
    if (!sourceFile) {
      return;
    }

    sourceFile.addFunction({
      name: "main",
      isAsync: true,
      isExported: false, // Will be exported in export block
      returnType: "Promise<ApiResponse>",
      docs: [
        {
          description: "Main function that executes the complete API workflow",
        },
      ],
      statements: body
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line),
    });
  }

  /**
   * Add custom interface
   */
  addInterface(
    interfaceName: string,
    properties: Array<{ name: string; type: string; optional?: boolean }>
  ): void {
    const typeBuilder = this.getTypeBuilder();

    typeBuilder
      .interface(interfaceName)
      .addProperties(
        properties.map((prop) => ({
          name: prop.name,
          type: prop.type,
          optional: prop.optional ?? false,
        }))
      )
      .export();
  }

  /**
   * Add generic interface
   */
  addGenericInterface(
    interfaceName: string,
    genericParams: string,
    properties: Array<{ name: string; type: string; optional?: boolean }>
  ): void {
    const typeBuilder = this.getTypeBuilder();

    // Parse generic parameters (simple parsing for now)
    const typeParams = genericParams.split(",").map((param) => ({
      name: param.trim(),
    }));

    typeBuilder
      .interface(interfaceName)
      .withTypeParameters(typeParams)
      .addProperties(
        properties.map((prop) => ({
          name: prop.name,
          type: prop.type,
          optional: prop.optional ?? false,
        }))
      )
      .export();
  }
}

/**
 * Create singleton instance for backward compatibility
 */
// Exported for backward compatibility - remove when migration is complete
export const astTypeDefinitionEngine = new ASTTypeDefinitionEngine();

/**
 * Drop-in replacements for the template engine functions
 * These maintain the exact same interface as TypeDefinitionTemplateEngine.ts
 */

/**
 * Generate TypeScript interface
 */
export function generateInterface(
  interfaceName: string,
  properties: Array<{ name: string; type: string; optional?: boolean }>
): string {
  const engine = new ASTTypeDefinitionEngine();
  engine.addInterface(interfaceName, properties);
  return engine.generateCode();
}

/**
 * Generate generic interface
 */
export function generateGenericInterface(
  interfaceName: string,
  genericParams: string,
  properties: Array<{ name: string; type: string; optional?: boolean }>
): string {
  const engine = new ASTTypeDefinitionEngine();
  engine.addGenericInterface(interfaceName, genericParams, properties);
  return engine.generateCode();
}

/**
 * Generate file header with metadata
 */
export function generateFileHeader(
  prompt: string,
  sessionId: string,
  date?: string
): string {
  const engine = new ASTTypeDefinitionEngine();
  engine.addFileHeader(prompt, sessionId, date);
  return engine.generateCode();
}

/**
 * Generate standard API response interface
 */
export function generateApiResponseInterface(): string {
  const engine = new ASTTypeDefinitionEngine();
  const typeBuilder = engine.getTypeBuilder();
  typeBuilder.createApiResponseInterface();
  return engine.generateCode();
}

/**
 * Generate request options interface
 */
export function generateRequestOptionsInterface(): string {
  const engine = new ASTTypeDefinitionEngine();
  const typeBuilder = engine.getTypeBuilder();
  typeBuilder.createRequestOptionsInterface();
  return engine.generateCode();
}

/**
 * Generate auth config interface
 */
export function generateAuthConfigInterface(): string {
  const engine = new ASTTypeDefinitionEngine();
  const typeBuilder = engine.getTypeBuilder();
  typeBuilder.createAuthConfigInterface();
  return engine.generateCode();
}

/**
 * Generate authentication error class
 */
export function generateAuthenticationError(): string {
  const engine = new ASTTypeDefinitionEngine();

  // Generate just the AuthenticationError class
  const sourceFile = engine.astProject.createSourceFile("temp.ts");
  sourceFile.addClass({
    name: "AuthenticationError",
    extends: "Error",
    isExported: true,
    ctors: [
      {
        parameters: [
          { name: "message", type: "string" },
          {
            name: "status",
            type: "number",
            isReadonly: true,
          },
          {
            name: "response",
            type: "unknown",
            hasQuestionToken: true,
            isReadonly: true,
          },
        ],
        statements: ["super(message);", "this.name = 'AuthenticationError';"],
      },
    ],
  });

  return engine.astProject.generateCode("temp.ts");
}

/**
 * Generate export statement
 */
export function generateExportStatement(exports: string[]): string {
  return `export {\n  ${exports.join(",\n  ")}\n};`;
}

/**
 * Generate export type statement
 */
export function generateExportTypeStatement(types: string[]): string {
  return `export type { ${types.join(", ")} };`;
}

/**
 * Generate inferred response interface
 */
export function generateInferredResponseInterface(
  interfaceName: string,
  fields: Array<{ name: string; type: string; optional: boolean }>
): string {
  const engine = new ASTTypeDefinitionEngine();
  const typeBuilder = engine.getTypeBuilder();
  typeBuilder.createResponseInterface(interfaceName, fields);
  return engine.generateCode();
}

/**
 * Generate main function
 */
export function generateMainFunction(body: string): string {
  const engine = new ASTTypeDefinitionEngine();
  const sourceFile = engine.astProject.createSourceFile("main.ts");

  sourceFile.addFunction({
    name: "main",
    isAsync: true,
    returnType: "Promise<ApiResponse>",
    docs: [
      {
        description: "Main function that executes the complete API workflow",
      },
    ],
    statements: body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line),
  });

  return engine.astProject.generateCode("main.ts");
}

/**
 * Generate complete type definitions section
 */
export function generateTypeDefinitions(
  inferredTypes?: Array<{
    interfaceName: string;
    fields: Array<{ name: string; type: string; optional: boolean }>;
  }>
): string {
  const engine = new ASTTypeDefinitionEngine();
  engine.addStandardTypeDefinitions(false, inferredTypes);
  return engine.generateCode();
}

/**
 * Generate main function body when no API functions exist
 */
export function generateMainFunctionEmptyBody(): string {
  return '  throw new Error("No API functions found to execute");';
}

/**
 * Generate main function body with master function call
 */
export function generateMainFunctionWithMaster(
  masterFunctionName: string
): string {
  return `  // Execute requests in dependency order
  const result = await ${masterFunctionName}();
  return result;`;
}

/**
 * Generate export block for functions
 */
export function generateExportBlock(functionNames: string[]): string {
  return `// Export all functions for individual use
export {
${functionNames.map((name) => `  ${name}`).join(",\n")}${functionNames.length > 0 ? "," : ""}
  main
};`;
}

/**
 * Generate usage example comment
 */
export function generateUsageExample(importPath: string): string {
  return `// Usage example:
// import { main } from "${importPath}";
// const result = await main();
// console.log(result.data);`;
}

/**
 * Generate TypeScript class definition
 */
export function generateClassDefinition(
  className: string,
  properties: string,
  methods: string,
  classModifier = ""
): string {
  const engine = new ASTTypeDefinitionEngine();
  const sourceFile = engine.astProject.createSourceFile("class.ts");

  // Create class with raw content (this is a fallback for complex class generation)
  const classCode = `${classModifier ? `${classModifier} ` : ""}class ${className} {
${properties}
${methods}
}`;

  sourceFile.insertText(0, classCode);
  return engine.astProject.generateCode("class.ts");
}
