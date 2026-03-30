"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");

const { parseMcpConfig } = require("./config");

test("parseMcpConfig defaults outputDir to ~/.spotter/records", () => {
  const result = parseMcpConfig([]);

  assert.equal(result.config.outputDir, path.join(os.homedir(), ".spotter", "records"));
});
