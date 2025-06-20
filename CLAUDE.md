# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Harvest MCP Server is a TypeScript-based Model Context Protocol server that provides AI-powered API analysis and integration code generation. It analyzes browser network traffic (HAR files) to generate executable code that reproduces entire API workflows.

## Development Commands

### Essential Commands
```bash
# Install dependencies
bun install

# Development
bun run dev             # Development server with hot reload
bun run start           # Start the MCP server

# Testing
bun test                # Run all tests
bun test:unit           # Unit tests only
bun test:integration    # Integration tests only
bun test:e2e            # End-to-end tests only
bun test:watch          # Watch mode
bun test:coverage       # With coverage report

# Code Quality (run before committing)
bun run check           # Lint and format check
bun run typecheck       # TypeScript type checking

# Build
bun run build           # Lint, format, and build for production
```

**IMPORTANT**: before assume a task as done your last command always is `bun validate:quick` and only all issues underlying causes are adressed. on every todo list you write run `validate:quick` is its last task.

### Testing Single Files
```bash
# Run a single test file
bun test tests/unit/core/HARParser.test.ts

# Run tests matching a pattern
bun test -t "HARParser"
```

## Directory Structure

```
src/
├── agents/              # AI-powered analysis modules using OpenAI function calling
│   ├── DependencyAgent.ts      # Analyzes requests to identify dependencies between them
│   ├── DynamicPartsAgent.ts    # Detects dynamic elements (timestamps, IDs) in requests
│   ├── InputVariablesAgent.ts  # Identifies user input requirements in requests
│   └── URLIdentificationAgent.ts # Finds the target action URL from HAR entries
├── core/               # Core business logic and services
│   ├── CodeGenerator.ts         # Generates executable TypeScript code from analysis
│   ├── CookieParser.ts          # Parses Netscape cookie files for authentication
│   ├── DAGManager.ts            # Manages dependency graphs using graphlib
│   ├── HARParser.ts             # Parses HAR files into structured request models
│   ├── LLMClient.ts             # OpenAI client with function calling capabilities
│   └── SessionManager.ts        # Stateful session management with FSM pattern
├── models/             # Data models and domain objects
│   └── Request.ts          # HTTP request representation with headers, body, etc.
├── types/              # TypeScript type definitions and schemas
│   ├── index.ts            # Centralized types, interfaces, and Zod schemas
├── tools/              # MCP tool implementations (currently empty)
├── utils/              # Utility functions and helpers
└── server.ts           # Main MCP server entry point and tool handlers

tests/
├── unit/               # Isolated component tests with mocks
├── integration/        # Multi-component interaction tests
├── e2e/               # Full workflow tests with real HAR files
├── fixtures/          # Test data including sample HAR files
├── manual/            # Scripts for manual testing and debugging
├── mocks/             # Mock implementations for testing
└── setup/             # Test configuration and helper functions

## Architecture

### Core Components

1. **Agents** (`src/agents/`): AI-powered analysis modules using OpenAI function calling
   - `DependencyAgent`: Identifies request dependencies and builds DAG
   - `DynamicPartsAgent`: Detects dynamic elements in requests
   - `InputVariablesAgent`: Finds user input requirements
   - `URLIdentificationAgent`: Identifies target action URLs

2. **Core Services** (`src/core/`):
   - `SessionManager`: Manages stateful MCP sessions with FSM pattern
   - `DAGManager`: Builds and manages dependency graphs using graphlib
   - `CodeGenerator`: Generates executable TypeScript code
   - `HARParser`: Processes HAR files into request models
   - `LLMClient`: OpenAI integration with function calling

3. **MCP Server** (`src/server.ts`): Main entry point implementing MCP protocol with:
   - **Analysis Tools**: session_start, analysis_run_initial_analysis, analysis_process_next_node, analysis_is_complete
   - **Debug Tools**: debug_get_unresolved_nodes, debug_get_node_details, debug_list_all_requests, debug_force_dependency
   - **Code Generation**: codegen_generate_wrapper_script
   - **Resources**: session DAG, logs, status, generated code

### Session State Flow
```
START → INITIAL_ANALYSIS → [USER_REVIEW] → [DEPENDENCY_GRAPH] → CODE_READY → COMPLETE
```

Sessions are managed statewide with transitions controlled by SessionManager's FSM implementation.

### Testing Strategy
- Unit tests: Individual component testing with mocks
- Integration tests: Multi-component interaction testing
- E2E tests: Full workflow testing with real HAR files
- Minimum 80% coverage requirement

## Key Development Patterns

1. **TypeScript**: Strict typing enabled, avoid `any` types
2. **Error Handling**: Use proper error types and logging via SessionManager
3. **Async Operations**: All agent and LLM operations are async
4. **State Management**: Session state persists across tool calls
5. **Testing**: Write tests for all new functionality, maintain coverage
