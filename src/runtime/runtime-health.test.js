"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyRuntimeError, isRuntimeHealthy, shouldRecoverFromError } = require("./runtime-health");

test("detects runtime health from browser and page state", () => {
  const healthyRuntime = {
    context: {},
    browser: { isConnected: () => true },
    currentPageOrNull: () => ({ isClosed: () => false }),
  };
  assert.equal(isRuntimeHealthy(healthyRuntime), true);

  const closedPageRuntime = {
    context: {},
    browser: { isConnected: () => true },
    currentPageOrNull: () => ({ isClosed: () => true }),
  };
  assert.equal(isRuntimeHealthy(closedPageRuntime), false);
});

test("classifies closed runtime errors for recovery", () => {
  const runtimeError = new Error("browserType.launchPersistentContext: Target page, context or browser has been closed");
  assert.equal(classifyRuntimeError(runtimeError), "runtime_closed");
  assert.equal(shouldRecoverFromError(runtimeError), true);

  const selectorError = new Error("locator.click: strict mode violation");
  assert.equal(classifyRuntimeError(selectorError), "other");
  assert.equal(shouldRecoverFromError(selectorError), false);
});
