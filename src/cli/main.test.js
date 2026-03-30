"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const { runCli } = require("./main");

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("runCli keeps lifecycle active after connect returns immediately", async () => {
  const shutdownDeferred = createDeferred();
  let connectCalls = 0;
  let disposeCalls = 0;
  let cleanupCalls = 0;
  let waitCalls = 0;

  const runPromise = runCli(["node", "spotter", "mcp"], {
    parseMcpConfig: () => ({
      config: {
        outputDir: "records",
        executablePath: "",
        userDataDir: "",
        headless: true,
        workingDir: process.cwd(),
      },
    }),
    SessionManager: class {
      async closeAll() {}
    },
    FileSystemStore: class {},
    HarBuilder: class {},
    Recorder: class {},
    BrowserService: class {},
    createMcpServer: () => ({
      async connect() {
        connectCalls += 1;
      },
      async close() {
        cleanupCalls += 1;
      },
    }),
    createTransport: () => ({}),
    registerHostLifecycle: ({ cleanup }) => ({
      dispose() {
        disposeCalls += 1;
      },
      async waitForShutdown() {
        waitCalls += 1;
        await shutdownDeferred.promise;
        await cleanup();
      },
    }),
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(connectCalls, 1);
  assert.equal(waitCalls, 1);
  assert.equal(disposeCalls, 0);
  assert.equal(cleanupCalls, 0);

  shutdownDeferred.resolve();
  await runPromise;

  assert.equal(cleanupCalls, 1);
  assert.equal(disposeCalls, 0);
});

test("runCli cleans up server and sessions when connect fails", async () => {
  let disposeCalls = 0;
  let cleanupCalls = 0;
  let closeAllCalls = 0;
  const originalExitCode = process.exitCode;

  try {
    await runCli(["node", "spotter", "mcp"], {
      parseMcpConfig: () => ({
        config: {
          outputDir: "records",
          executablePath: "",
          userDataDir: "",
          headless: true,
          workingDir: process.cwd(),
        },
      }),
      SessionManager: class {
        async closeAll() {
          closeAllCalls += 1;
        }
      },
      FileSystemStore: class {},
      HarBuilder: class {},
      Recorder: class {},
      BrowserService: class {},
      createMcpServer: () => ({
        async connect() {
          throw new Error("connect failed");
        },
        async close() {
          cleanupCalls += 1;
        },
      }),
      createTransport: () => ({}),
      registerHostLifecycle: () => ({
        dispose() {
          disposeCalls += 1;
        },
        async waitForShutdown() {},
      }),
    });
  } finally {
    process.exitCode = originalExitCode;
  }

  assert.equal(disposeCalls, 0);
  assert.equal(cleanupCalls, 1);
  assert.equal(closeAllCalls, 1);
});

test("runCli completes stdio MCP handshake without losing initialize", async () => {
  const childScript = `
    const { runCli } = require(${JSON.stringify(require.resolve("./main"))});
    const { createMcpServer } = require(${JSON.stringify(require.resolve("../mcp/server"))});

    class SessionManager {
      async closeAll() {}
      async claim() {}
    }

    class FileSystemStore {}
    class HarBuilder {}
    class Recorder {}

    class BrowserService {
      async navigate(url) {
        return { code: [\`await page.goto(\${JSON.stringify(url)});\`], message: \`Navigated to \${url}\` };
      }
      async navigateBack() {
        return { code: ["await page.goBack();"], message: "Navigated back." };
      }
      async snapshot() {
        return { snapshot: "stub snapshot" };
      }
      async type() {
        return { code: ["await locator.fill('stub');"], message: "Typing completed." };
      }
      async click() {
        return { result: { code: ["await locator.click();"], message: "Click completed." } };
      }
      async startRecording() {
        return {
          recording_id: "rec-1",
          session_id: "default",
          started_at: "2026-03-30T00:00:00.000Z",
          message: "Recording started.",
        };
      }
      async stopRecording() {
        return {
          action_id: "action-1",
          record_dir: "/tmp/recordings/action-1",
          before_snapshot_path: "/tmp/recordings/action-1/before.html",
          after_snapshot_path: "/tmp/recordings/action-1/after.html",
          har_path: "/tmp/recordings/action-1/action.har",
          resource_manifest: "/tmp/recordings/action-1/resources.json",
          action_json_path: "/tmp/recordings/action-1/action.json",
        };
      }
      async hover() {
        return { code: ["await locator.hover();"], message: "Hover completed." };
      }
      async drag() {
        return { code: ["await start.dragTo(end);"], message: "Drag completed." };
      }
      async selectOption() {
        return { code: ["await locator.selectOption(['stub']);"], message: "Select option completed." };
      }
      async pressKey(args) {
        return { code: [\`await page.keyboard.press(\${JSON.stringify(args.key)});\`], message: \`Pressed key \${args.key}.\` };
      }
      async waitFor() {
        return { code: ["// wait completed"], message: "Waited." };
      }
      async resize(args) {
        return { code: [\`await page.setViewportSize({ width: \${args.width}, height: \${args.height} });\`], message: "Viewport resized." };
      }
      async evaluate() {
        return { code: ["await page.evaluate(() => 1);"], output: "1" };
      }
      async runCode() {
        return { code: ["await (() => 1)();"], output: "1" };
      }
      async takeScreenshot() {
        return { path: "", mimeType: "image/png", dataBase64: "" };
      }
      async networkRequests() {
        return { title: "Network", content: "No requests." };
      }
      async consoleMessages() {
        return { title: "Console", content: "No messages." };
      }
      async handleDialog() {
        return { code: ["await dialog.dismiss();"], message: "Dialog dismissed." };
      }
      async fileUpload() {
        return { code: ["await fileChooser.setFiles([]);"], message: "File upload completed." };
      }
      async fillForm() {
        return { code: ["// form fields filled"], message: "Form filled." };
      }
      async browserTabs() {
        return {
          message: "Listed 1 tabs.",
          tabs: [{ index: 0, active: true, url: "about:blank", title: "Blank" }],
          page: { url: "about:blank", title: "Blank" },
        };
      }
      async closeBrowser() {
        return { code: ["await browser.close();"], message: "Browser session closed." };
      }
    }

    runCli(["node", "spotter", "mcp"], {
      parseMcpConfig: () => ({
        config: {
          outputDir: "records",
          executablePath: "",
          userDataDir: "",
          headless: true,
          workingDir: process.cwd(),
        },
      }),
      SessionManager,
      FileSystemStore,
      HarBuilder,
      Recorder,
      BrowserService,
      createMcpServer,
    });
  `;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["-e", childScript],
    stderr: "pipe",
  });
  const client = new Client({ name: "cli-test", version: "0.0.1" }, { capabilities: {} });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "browser_navigate"));
    assert.ok(tools.tools.some((tool) => tool.name === "browser_tabs"));
  } finally {
    await client.close().catch(() => {});
  }
});

test("runCli keeps MCP handshake alive when profile is occupied and returns tool unavailability", async () => {
  const occupiedDir = "D:\\workspace\\chrome_profiles\\spotter";
  const childScript = `
    const { runCli } = require(${JSON.stringify(require.resolve("./main"))});
    const { createMcpServer } = require(${JSON.stringify(require.resolve("../mcp/server"))});
    const { BrowserService } = require(${JSON.stringify(require.resolve("../service/browser-service"))});
    const { OwnershipConflictError } = require(${JSON.stringify(require.resolve("../runtime/runtime-errors"))});

    class SessionManager {
      constructor(options) {
        this.options = { ...options };
      }

      async get() {
        throw new OwnershipConflictError("user-data-dir is already in use by another spotter instance", {
          user_data_dir: this.options.userDataDir,
          instance_id: "spotter-owner",
          owner_pid: 4321,
          started_at: "2026-03-30T00:00:00.000Z",
        });
      }

      async claim() {
        throw new OwnershipConflictError("user-data-dir is already in use by another spotter instance", {
          user_data_dir: this.options.userDataDir,
          instance_id: "spotter-owner",
          owner_pid: 4321,
          started_at: "2026-03-30T00:00:00.000Z",
        });
      }

      async close() {}
      async closeAll() {}
    }

    class FileSystemStore {}
    class HarBuilder {}
    class Recorder {}

    runCli(["node", "spotter", "mcp"], {
      parseMcpConfig: () => ({
        config: {
          outputDir: "records",
          executablePath: "",
          userDataDir: ${JSON.stringify(occupiedDir)},
          headless: true,
          workingDir: process.cwd(),
        },
      }),
      SessionManager,
      FileSystemStore,
      HarBuilder,
      Recorder,
      BrowserService,
      createMcpServer,
    });
  `;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["-e", childScript],
    stderr: "pipe",
  });
  const client = new Client({ name: "cli-test", version: "0.0.1" }, { capabilities: {} });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "browser_navigate"));

    const result = await client.callTool({
      name: "browser_navigate",
      arguments: {
        url: "https://example.com",
      },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /user-data-dir/);
    assert.match(result.content[0].text, /暂时不可用/);
    assert.equal(result.structuredContent.details.user_data_dir, occupiedDir);
    assert.equal(result.structuredContent.details.reason, "profile_in_use");

    const closeResult = await client.callTool({
      name: "browser_close",
      arguments: {},
    });

    assert.equal(closeResult.isError, undefined);
    assert.match(closeResult.content[0].text, /Browser session closed\./);
  } finally {
    await client.close().catch(() => {});
  }
});
