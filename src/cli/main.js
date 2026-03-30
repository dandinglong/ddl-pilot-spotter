"use strict";

const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const configModule = require("./config");
const { SessionManager } = require("../session/session-manager");
const { FileSystemStore } = require("../storage/filesystem-store");
const { HarBuilder } = require("../har/builder");
const { Recorder } = require("../recording/recorder");
const { BrowserService } = require("../service/browser-service");
const { createMcpServer } = require("../mcp/server");
const hostLifecycleModule = require("./host-lifecycle");

async function runCli(argv, dependencies = {}) {
  const parseMcpConfig = dependencies.parseMcpConfig || configModule.parseMcpConfig;
  const printUsage = dependencies.printUsage || configModule.printUsage;
  const SessionManagerClass = dependencies.SessionManager || SessionManager;
  const FileSystemStoreClass = dependencies.FileSystemStore || FileSystemStore;
  const HarBuilderClass = dependencies.HarBuilder || HarBuilder;
  const RecorderClass = dependencies.Recorder || Recorder;
  const BrowserServiceClass = dependencies.BrowserService || BrowserService;
  const createServer = dependencies.createMcpServer || createMcpServer;
  const registerHostLifecycle = dependencies.registerHostLifecycle || hostLifecycleModule.registerHostLifecycle;
  const createTransport = dependencies.createTransport || (() => new StdioServerTransport());

  try {
    if (argv.length < 3 || argv[2] !== "mcp") {
      printUsage(process.stderr);
      process.exitCode = 2;
      return;
    }

    const parsed = parseMcpConfig(argv.slice(3));
    if (parsed.help) {
      printUsage(process.stdout);
      return;
    }

    const sessionManager = new SessionManagerClass(parsed.config);
    const store = new FileSystemStoreClass(parsed.config.outputDir);
    const harBuilder = new HarBuilderClass("ddl-pilot-spotter", "0.1.0");
    const recorder = new RecorderClass(store, harBuilder);
    const service = new BrowserServiceClass(sessionManager, recorder);
    const server = createServer(service);
    const transport = createTransport();
    let lifecycle = null;
    let cleanupStarted = false;

    async function cleanupServer() {
      if (cleanupStarted) {
        return;
      }
      cleanupStarted = true;
      await server.close().catch(() => {});
    }

    try {
      await server.connect(transport);
      lifecycle = registerHostLifecycle({
        sessionManager,
        cleanup: cleanupServer,
      });
      await lifecycle.waitForShutdown();
    } catch (error) {
      lifecycle?.dispose();
      await cleanupServer();
      await sessionManager.closeAll().catch(() => {});
      throw error;
    }
  } catch (error) {
    process.stderr.write(`${error.name || "Error"}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  runCli,
};
