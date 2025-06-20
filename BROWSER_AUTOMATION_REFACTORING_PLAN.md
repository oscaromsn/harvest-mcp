# Harvest-MCP Browser Automation Refactoring Plan

This document outlines a comprehensive, sprint-based refactoring plan to implement HAR and cookie file generation capabilities in harvest-mcp by porting browser automation functionality from magnitude-mcp and magnitude-core.

## 📋 Executive Summary

**Objective**: Port browser automation capabilities from magnitude-mcp to harvest-mcp without depending on magnitude-core, enabling manual browser sessions with HAR/cookie collection for integration with Harvest's API analysis workflow.

**Approach**: Test-Driven Development (TDD) with progressive implementation across 6 sprints, each with clear acceptance criteria and deliverables.

## 🎯 Sprint Overview

| Sprint | Focus | Duration | Key Deliverables |
|--------|-------|----------|-----------------|
| 1 | Core Dependencies & Foundation | 3-5 days | Browser infrastructure, basic types |
| 2 | Browser Management & Agent | 3-5 days | BrowserAgent, BrowserProvider, connection handling |
| 3 | Artifact Collection System | 3-5 days | HAR, cookies, screenshots collection |
| 4 | Session Management | 3-5 days | Manual session lifecycle, cleanup |
| 5 | MCP Tool Integration | 3-5 days | start/stop manual session tools |
| 6 | Integration & Polish | 2-3 days | End-to-end testing, documentation |

---

## 📦 Sprint 1: Core Dependencies & Foundation

### 🎯 Goals
- Set up browser automation dependencies
- Create foundational types and interfaces
- Establish TDD structure for browser functionality

### 📝 Tasks

#### 1.1 Dependencies Setup
- **Add to `package.json`**:
  ```json
  "playwright": "^1.52.0",
  "sharp": "^0.33.5",
  "pino": "^9.6.0"
  ```

#### 1.2 Core Types & Interfaces
- **Create `src/browser/types.ts`** (ported from magnitude-core):
  ```typescript
  // Port LLMClient types from magnitude-core/src/ai/types.ts
  // Port BrowserOptions from magnitude-core/src/web/browserProvider.ts
  // Port BrowserConnectorOptions from magnitude-core/src/connectors/browserConnector.ts
  ```

#### 1.3 Logging Infrastructure
- **Create `src/browser/logger.ts`** (ported from magnitude-core):
  ```typescript
  // Port logger setup from magnitude-core/src/logger.ts
  // Integrate with existing harvest-mcp logging
  ```

#### 1.4 Test Foundation
- **Create `tests/browser/` directory structure**
- **Create `tests/browser/types.test.ts`** - Test type definitions
- **Create `tests/browser/logger.test.ts`** - Test logging setup

### ✅ Acceptance Criteria
- [ ] All new dependencies installed and building
- [ ] Core browser types defined and exported
- [ ] Logging infrastructure operational
- [ ] Tests pass: `bun test tests/browser/`
- [ ] TypeScript compilation successful: `bun run typecheck`

### 📂 Files to Reference
- **magnitude-core**: `src/ai/types.ts`, `src/web/browserProvider.ts`, `src/logger.ts`
- **harvest-mcp**: `src/types/index.ts`, `package.json`

---

## 🔧 Sprint 2: Browser Management & Agent

### 🎯 Goals
- Implement browser provider and management
- Create browser agent wrapper
- Establish browser connection handling

### 📝 Tasks

#### 2.1 Browser Provider
- **Create `src/browser/BrowserProvider.ts`** (ported from magnitude-core):
  ```typescript
  // Port BrowserProvider class from magnitude-core/src/web/browserProvider.ts
  // Adapt for harvest-mcp without BAML/AI dependencies
  // Focus on browser instance management and context creation
  ```

#### 2.2 Browser Agent
- **Create `src/browser/BrowserAgent.ts`** (simplified from magnitude-core):
  ```typescript
  // Port BrowserAgent from magnitude-core/src/agent/browserAgent.ts
  // Remove AI/LLM dependencies (extract, model interactions)
  // Keep page, context access and basic browser operations
  ```

#### 2.3 Agent Factory
- **Create `src/browser/AgentFactory.ts`** (adapted from magnitude-mcp):
  ```typescript
  // Adapt AgentFactory from magnitude-mcp/src/services/agentFactory.ts
  // Remove LLM configuration complexity
  // Focus on browser configuration and agent creation
  ```

#### 2.4 Tests
- **Create `tests/browser/BrowserProvider.test.ts`**
- **Create `tests/browser/BrowserAgent.test.ts`**
- **Create `tests/browser/AgentFactory.test.ts`**

### ✅ Acceptance Criteria
- [ ] Browser can be launched programmatically
- [ ] BrowserAgent provides page and context access
- [ ] AgentFactory creates configured browser instances
- [ ] All browser tests pass
- [ ] No memory leaks in browser lifecycle

### 📂 Files to Reference
- **magnitude-core**: `src/web/browserProvider.ts`, `src/agent/browserAgent.ts`, `src/connectors/browserConnector.ts`
- **magnitude-mcp**: `src/services/agentFactory.ts`

---

## 📊 Sprint 3: Artifact Collection System

### 🎯 Goals
- Implement HAR file generation from network traffic
- Create cookie extraction functionality
- Add screenshot capture capabilities

### 📝 Tasks

#### 3.1 Core Artifact Collector
- **Create `src/browser/ArtifactCollector.ts`** (ported from magnitude-mcp):
  ```typescript
  // Port ArtifactCollector from magnitude-mcp/src/services/artifactCollector.ts
  // Adapt network tracking for Playwright's request/response handling
  // Implement real-time HAR entry collection
  ```

#### 3.2 HAR Generation
- **Enhance `ArtifactCollector.ts`** with HAR functionality:
  ```typescript
  // Port HAR generation logic from magnitude-mcp
  // Implement network tracking with page.on('request'/'response')
  // Create proper HAR 1.2 format structure
  ```

#### 3.3 Cookie Extraction
- **Add cookie collection to `ArtifactCollector.ts`**:
  ```typescript
  // Implement context.cookies() extraction
  // Format cookies with metadata (domain, path, security flags)
  // Support Netscape cookie format for compatibility
  ```

#### 3.4 Screenshot Capture
- **Add screenshot functionality**:
  ```typescript
  // Implement page.screenshot() with configurable options
  // Support full-page and viewport screenshots
  // Handle timing and interval-based captures
  ```

#### 3.5 Tests
- **Create `tests/browser/ArtifactCollector.test.ts`**
- **Create `tests/browser/har-generation.test.ts`**
- **Create `tests/browser/cookie-extraction.test.ts`**

### ✅ Acceptance Criteria
- [ ] Valid HAR files generated from network traffic
- [ ] Browser cookies extracted with proper metadata
- [ ] Screenshots captured in PNG format
- [ ] Artifact files saved to specified directories
- [ ] HAR files compatible with existing harvest-mcp analysis tools
- [ ] All artifact collection tests pass

### 📂 Files to Reference
- **magnitude-mcp**: `src/services/artifactCollector.ts`
- **harvest-mcp**: `src/core/HARParser.ts`, `src/core/CookieParser.ts`

---

## 🔄 Sprint 4: Session Management

### 🎯 Goals
- Implement manual browser session lifecycle
- Create session state management
- Add cleanup and timeout handling

### 📝 Tasks

#### 4.1 Manual Session Manager
- **Create `src/browser/ManualSessionManager.ts`** (ported from magnitude-mcp):
  ```typescript
  // Port SessionManager from magnitude-mcp/src/services/sessionManager.ts
  // Adapt session lifecycle for harvest-mcp context
  // Implement session creation, tracking, and termination
  ```

#### 4.2 Session State & Configuration
- **Define session interfaces**:
  ```typescript
  // Port session types from magnitude-mcp
  // Define ManualSession, SessionConfig, SessionInfo interfaces
  // Support browser options, artifact configuration, timeouts
  ```

#### 4.3 Lifecycle Management
- **Implement session operations**:
  ```typescript
  // startSession() - create browser, start artifact collection
  // stopSession() - finalize artifacts, cleanup browser
  // Auto-cleanup with configurable timeouts
  // Multiple concurrent session support
  ```

#### 4.4 Integration with Artifact Collector
- **Connect session management with artifact collection**:
  ```typescript
  // Integrate ArtifactCollector into session lifecycle
  // Start network tracking on session creation
  // Collect final artifacts on session termination
  ```

#### 4.5 Tests
- **Create `tests/browser/ManualSessionManager.test.ts`**
- **Create `tests/browser/session-lifecycle.test.ts`**
- **Create `tests/browser/session-cleanup.test.ts`**

### ✅ Acceptance Criteria
- [ ] Sessions can be created with unique IDs
- [ ] Browser launches and artifact collection starts automatically
- [ ] Session state tracked throughout lifecycle
- [ ] Proper cleanup on session termination
- [ ] Auto-cleanup works with timeouts
- [ ] Multiple concurrent sessions supported
- [ ] All session management tests pass

### 📂 Files to Reference
- **magnitude-mcp**: `src/services/sessionManager.ts`
- **harvest-mcp**: `src/core/SessionManager.ts`

---

## 🔌 Sprint 5: MCP Tool Integration

### 🎯 Goals
- Implement MCP tools for manual session management
- Create tool schemas and validation
- Integrate with existing harvest-mcp server structure

### 📝 Tasks

#### 5.1 Tool Schemas
- **Create `src/browser/schemas.ts`**:
  ```typescript
  // Port manual session schemas from magnitude-mcp/src/schemas.ts
  // Define startManualSessionSchema, stopManualSessionSchema
  // Adapt for harvest-mcp naming conventions
  ```

#### 5.2 Tool Implementation
- **Create `src/browser/tools.ts`**:
  ```typescript
  // Port startManualSession, stopManualSession from magnitude-mcp/src/tools.ts
  // Adapt response formats for harvest-mcp
  // Integrate with harvest-mcp error handling (HarvestError)
  ```

#### 5.3 Server Integration
- **Modify `src/server.ts`**:
  ```typescript
  // Add manual session tools to existing HarvestMCPServer
  // Register harvest_start_manual_session, harvest_stop_manual_session
  // Integrate tool handlers with server setupTools()
  ```

#### 5.4 Tool Response Formatting
- **Implement harvest-mcp style responses**:
  ```typescript
  // Adapt response formatting to match harvest-mcp patterns
  // Use CallToolResult format consistently
  // Provide detailed session information and artifact paths
  ```

#### 5.5 Tests
- **Create `tests/tools/manual-session.test.ts`**
- **Create `tests/integration/mcp-tools.test.ts`**
- **Create `tests/integration/server-integration.test.ts`**

### ✅ Acceptance Criteria
- [ ] `harvest_start_manual_session` tool operational
- [ ] `harvest_stop_manual_session` tool operational
- [ ] Tool schemas validate input correctly
- [ ] Tools integrated with existing MCP server structure
- [ ] Proper error handling with HarvestError
- [ ] Tool responses follow harvest-mcp conventions
- [ ] All tool integration tests pass

### 📂 Files to Reference
- **magnitude-mcp**: `src/schemas.ts`, `src/tools.ts`, `src/toolService.ts`
- **harvest-mcp**: `src/server.ts`, `src/types/index.ts`

---

## 🚀 Sprint 6: Integration & Polish

### 🎯 Goals
- End-to-end workflow testing
- Documentation and examples
- Performance optimization and cleanup

### 📝 Tasks

#### 6.1 End-to-End Workflow
- **Create `tests/e2e/manual-session-to-analysis.test.ts`**:
  ```typescript
  // Test complete workflow: manual session → HAR generation → harvest analysis
  // Verify HAR files work with existing harvest-mcp analysis tools
  // Test cookie integration with existing cookie parsing
  ```

#### 6.2 Documentation
- **Update `CLAUDE.md`** with new tools and workflows
- **Create examples** showing manual session usage
- **Document browser configuration options**

#### 6.3 Resource Integration
- **Add MCP resources for manual sessions**:
  ```typescript
  // harvest://{sessionId}/manual-artifacts.json
  // harvest://{sessionId}/session-log.txt
  // Integration with existing resource structure
  ```

#### 6.4 Performance & Cleanup
- **Optimize artifact collection performance**
- **Ensure proper memory management**
- **Add comprehensive error handling**

#### 6.5 Validation
- **Run complete test suite**
- **Verify `bun validate:quick` passes**
- **Test with real-world scenarios**

### ✅ Acceptance Criteria
- [ ] Complete workflow tested end-to-end
- [ ] Generated HAR files work with existing harvest analysis
- [ ] All documentation updated and accurate
- [ ] Performance optimized for production use
- [ ] Memory leaks eliminated
- [ ] All tests pass including existing harvest-mcp tests
- [ ] `bun validate:quick` completes successfully

### 📂 Files to Reference
- **harvest-mcp**: All existing files for integration testing
- **magnitude-mcp**: Complete implementation for reference

---

## 🏗️ Implementation Guidelines

### TDD Approach
1. **Red**: Write failing test for each feature
2. **Green**: Write minimal code to pass test
3. **Refactor**: Improve code while maintaining tests
4. **Commit**: After each red-green-refactor cycle

### Code Standards
- **TypeScript strict mode**: No `any` types
- **Error handling**: Use HarvestError consistently
- **Logging**: Integrate with existing harvest-mcp logging
- **File organization**: Follow harvest-mcp patterns

### Quality Gates
- All tests must pass before sprint completion
- TypeScript compilation must succeed
- `bun validate:quick` must pass
- No memory leaks in browser operations
- Compatible with existing harvest-mcp workflows

### Key Dependencies to Port
From **magnitude-core**:
- Browser management (`BrowserProvider`, `BrowserAgent`)
- Playwright integration patterns
- Browser configuration handling

From **magnitude-mcp**:
- Artifact collection logic (`ArtifactCollector`)
- Session management (`SessionManager`)
- MCP tool implementations
- Schema definitions

### Integration Points
- **HAR files** → existing `HARParser.ts`
- **Cookie files** → existing `CookieParser.ts`
- **Error handling** → existing `HarvestError` system
- **MCP server** → existing tool registration patterns
- **Type system** → existing harvest-mcp type definitions

This plan ensures a systematic, test-driven implementation that maintains harvest-mcp's quality standards while adding powerful browser automation capabilities for HAR and cookie generation.