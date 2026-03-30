"use strict";

function isRuntimeHealthy(runtime) {
  if (!runtime || !runtime.context) {
    return false;
  }
  if (runtime.contextClosed) {
    return false;
  }
  if (runtime.browser && typeof runtime.browser.isConnected === "function" && !runtime.browser.isConnected()) {
    return false;
  }
  const page = typeof runtime.currentPageOrNull === "function" ? runtime.currentPageOrNull() : runtime.page;
  if (!page || typeof page.isClosed !== "function") {
    return false;
  }
  return !page.isClosed();
}

function classifyRuntimeError(error) {
  const message = String(error && error.message ? error.message : error || "").toLowerCase();
  if (
    message.includes("target page, context or browser has been closed") ||
    message.includes("browser has been closed") ||
    message.includes("browser closed") ||
    message.includes("browser has been disconnected") ||
    message.includes("browser disconnected") ||
    message.includes("context closed") ||
    message.includes("page closed")
  ) {
    return "runtime_closed";
  }
  return "other";
}

function shouldRecoverFromError(error) {
  return classifyRuntimeError(error) === "runtime_closed";
}

module.exports = {
  classifyRuntimeError,
  isRuntimeHealthy,
  shouldRecoverFromError,
};
