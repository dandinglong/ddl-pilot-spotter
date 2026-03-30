"use strict";

const os = require("os");
const path = require("path");

function printUsage(stream) {
  stream.write("usage: spotter mcp [--output-dir DIR] [--executable-path PATH] [--user-data-dir DIR] [--headless=true|false]\n");
  stream.write("\n");
  stream.write("Environment variables override the corresponding flags:\n");
  stream.write("  PLAYWRIGHT_MCP_OUTPUT_DIR\n");
  stream.write("  PLAYWRIGHT_MCP_EXECUTABLE_PATH\n");
  stream.write("  PLAYWRIGHT_MCP_USER_DATA_DIR\n");
  stream.write("  PLAYWRIGHT_MCP_HEADLESS\n");
}

function parseBoolean(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }
  switch (value.trim().toLowerCase()) {
    case "1":
    case "t":
    case "true":
    case "y":
    case "yes":
    case "on":
      return true;
    case "0":
    case "f":
    case "false":
    case "n":
    case "no":
    case "off":
      return false;
    default:
      return fallback;
  }
}

function envOrDefault(fallback, ...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return fallback;
}

function parseMcpConfig(argv) {
  const cwd = process.cwd();
  const config = {
    outputDir: path.join(os.homedir(), ".spotter", "records"),
    executablePath: "",
    userDataDir: "",
    headless: true,
    workingDir: cwd,
  };

  const args = [...argv];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (arg === "--output-dir") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--output-dir requires a value");
      }
      config.outputDir = path.resolve(cwd, value);
      index += 1;
      continue;
    }
    if (arg === "--executable-path") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--executable-path requires a value");
      }
      config.executablePath = value;
      index += 1;
      continue;
    }
    if (arg === "--user-data-dir") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--user-data-dir requires a value");
      }
      config.userDataDir = path.resolve(cwd, value);
      index += 1;
      continue;
    }
    if (arg === "--headless") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--headless requires a value");
      }
      config.headless = parseBoolean(value, config.headless);
      index += 1;
      continue;
    }
    if (arg.startsWith("--headless=")) {
      config.headless = parseBoolean(arg.slice("--headless=".length), config.headless);
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }

  config.outputDir = path.resolve(envOrDefault(config.outputDir, "PLAYWRIGHT_MCP_OUTPUT_DIR"));
  config.executablePath = envOrDefault(config.executablePath, "PLAYWRIGHT_MCP_EXECUTABLE_PATH", "SPOTTER_BROWSER_PATH");
  config.userDataDir = envOrDefault(config.userDataDir, "PLAYWRIGHT_MCP_USER_DATA_DIR");
  config.headless = parseBoolean(envOrDefault("", "PLAYWRIGHT_MCP_HEADLESS", "SPOTTER_HEADLESS"), config.headless);
  if (config.userDataDir) {
    config.userDataDir = path.resolve(config.userDataDir);
  }
  return { config };
}

module.exports = {
  parseMcpConfig,
  printUsage,
};
