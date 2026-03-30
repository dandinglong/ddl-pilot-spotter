"use strict";

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod/v4");
const {
  actionToolResult,
  errorToolResult,
  evaluateToolResult,
  fileToolResult,
  recordingStartResult,
  recordingStopResult,
  snapshotToolResult,
  tabsToolResult,
  textToolResult,
} = require("./response");
const { ProfileUnavailableError } = require("../runtime/runtime-errors");

function createMcpServer(service) {
  const server = new McpServer({
    name: "ddl-pilot-spotter",
    version: "0.1.0",
    instructions: "Playwright-enhanced MCP server with explicit browser recording controls.",
  });

  function toolHandler(formatter, handler) {
    return async (args = {}) => {
      try {
        const result = await handler(args);
        return formatter(result);
      } catch (error) {
        if (error instanceof ProfileUnavailableError) {
          return errorToolResult(error);
        }
        throw error;
      }
    };
  }

  server.registerTool("browser_navigate", {
    description: "Navigate to a URL",
    inputSchema: { url: z.string() },
  }, toolHandler(actionToolResult, ({ url }) => service.navigate(url)));

  server.registerTool("browser_navigate_back", {
    description: "Go back to the previous page",
  }, toolHandler(actionToolResult, () => service.navigateBack()));

  server.registerTool("browser_snapshot", {
    description: "Capture accessibility-style page snapshot",
    inputSchema: {
      filename: z.string().optional(),
      selector: z.string().optional(),
    },
  }, toolHandler(snapshotToolResult, (args) => service.snapshot(args)));

  server.registerTool("browser_type", {
    description: "Type text into editable element",
    inputSchema: {
      element: z.string().optional(),
      ref: z.string().optional(),
      selector: z.string().optional(),
      text: z.string(),
      submit: z.boolean().optional(),
      slowly: z.boolean().optional(),
    },
  }, toolHandler(actionToolResult, (args) => service.type(args)));

  server.registerTool("browser_click", {
    description: "Click an element.",
    inputSchema: {
      element: z.string().optional(),
      ref: z.string().optional(),
      selector: z.string().optional(),
      doubleClick: z.boolean().optional(),
      button: z.string().optional(),
      modifiers: z.array(z.string()).optional(),
    },
  }, toolHandler((payload) => {
    const { result, artifacts } = payload;
    return actionToolResult(result, artifacts ? { recording: artifacts } : undefined);
  }, async (args) => {
    const { result, artifacts } = await service.click(args);
    return { result, artifacts };
  }));

  server.registerTool("browser_recording_start", {
    description: "Start a recording window for subsequent browser actions.",
    inputSchema: { name: z.string().optional() },
  }, toolHandler(recordingStartResult, (args) => service.startRecording(args)));

  server.registerTool("browser_recording_stop", {
    description: "Stop the active recording window and persist artifacts.",
    inputSchema: { recording_id: z.string().optional() },
  }, toolHandler(recordingStopResult, (args) => service.stopRecording(args)));

  server.registerTool("browser_hover", {
    description: "Hover over an element",
    inputSchema: {
      element: z.string().optional(),
      ref: z.string().optional(),
      selector: z.string().optional(),
    },
  }, toolHandler(actionToolResult, (args) => service.hover(args)));

  server.registerTool("browser_drag", {
    description: "Perform drag and drop between two elements",
    inputSchema: {
      startElement: z.string(),
      startRef: z.string(),
      startSelector: z.string().optional(),
      endElement: z.string(),
      endRef: z.string(),
      endSelector: z.string().optional(),
    },
  }, toolHandler(actionToolResult, (args) => service.drag(args)));

  server.registerTool("browser_select_option", {
    description: "Select value(s) in a dropdown",
    inputSchema: {
      element: z.string().optional(),
      ref: z.string().optional(),
      selector: z.string().optional(),
      values: z.array(z.string()),
    },
  }, toolHandler(actionToolResult, (args) => service.selectOption(args)));

  server.registerTool("browser_press_key", {
    description: "Press a keyboard key",
    inputSchema: { key: z.string() },
  }, toolHandler(actionToolResult, (args) => service.pressKey(args)));

  server.registerTool("browser_wait_for", {
    description: "Wait for time or text condition",
    inputSchema: {
      time: z.number().optional(),
      text: z.string().optional(),
      textGone: z.string().optional(),
    },
  }, toolHandler(actionToolResult, (args) => service.waitFor(args)));

  server.registerTool("browser_resize", {
    description: "Resize browser viewport",
    inputSchema: {
      width: z.number(),
      height: z.number(),
    },
  }, toolHandler(actionToolResult, (args) => service.resize(args)));

  server.registerTool("browser_evaluate", {
    description: "Evaluate JavaScript on the page or an element",
    inputSchema: {
      element: z.string().optional(),
      ref: z.string().optional(),
      selector: z.string().optional(),
      function: z.string(),
    },
  }, toolHandler(evaluateToolResult, (args) => service.evaluate(args)));

  server.registerTool("browser_run_code", {
    description: "Run Playwright code snippet",
    inputSchema: { code: z.string() },
  }, toolHandler(evaluateToolResult, (args) => service.runCode(args)));

  server.registerTool("browser_take_screenshot", {
    description: "Take a screenshot of the page or an element",
    inputSchema: {
      type: z.string().optional(),
      filename: z.string().optional(),
      element: z.string().optional(),
      ref: z.string().optional(),
      selector: z.string().optional(),
      fullPage: z.boolean().optional(),
    },
  }, toolHandler(fileToolResult, (args) => service.takeScreenshot(args)));

  server.registerTool("browser_network_requests", {
    description: "List network requests since the current page load",
    inputSchema: {
      includeStatic: z.boolean().optional(),
      filename: z.string().optional(),
    },
  }, toolHandler(textToolResult, (args) => service.networkRequests(args)));

  server.registerTool("browser_console_messages", {
    description: "Get console messages",
    inputSchema: {
      level: z.string().optional(),
      all: z.boolean().optional(),
      filename: z.string().optional(),
    },
  }, toolHandler(textToolResult, (args) => service.consoleMessages(args)));

  server.registerTool("browser_handle_dialog", {
    description: "Accept or dismiss the current dialog",
    inputSchema: {
      accept: z.boolean(),
      promptText: z.string().optional(),
    },
  }, toolHandler(actionToolResult, (args) => service.handleDialog(args)));

  server.registerTool("browser_file_upload", {
    description: "Upload file(s) to the currently open chooser",
    inputSchema: { paths: z.array(z.string()).optional() },
  }, toolHandler(actionToolResult, (args) => service.fileUpload(args)));

  server.registerTool("browser_fill_form", {
    description: "Fill multiple form fields",
    inputSchema: {
      fields: z.array(z.object({
        name: z.string(),
        type: z.string(),
        ref: z.string(),
        selector: z.string().optional(),
        value: z.string(),
      })),
    },
  }, toolHandler(actionToolResult, (args) => service.fillForm(args)));

  server.registerTool("browser_tabs", {
    description: "List, create, close, or select a browser tab.",
    inputSchema: {
      action: z.string(),
      index: z.number().int().optional(),
    },
  }, toolHandler(tabsToolResult, (args) => service.browserTabs(args)));

  server.registerTool("browser_close", {
    description: "Close the browser session",
  }, toolHandler(actionToolResult, () => service.closeBrowser()));

  return server;
}

module.exports = {
  createMcpServer,
};
