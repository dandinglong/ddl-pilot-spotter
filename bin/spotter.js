#!/usr/bin/env node
"use strict";

const { runCli } = require("../src/cli/main");

runCli(process.argv).catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
