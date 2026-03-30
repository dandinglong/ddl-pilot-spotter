"use strict";

const { BrowserRuntime } = require("../runtime/browser-runtime");

class SessionManager {
  constructor(options) {
    this.options = { ...options };
    this.items = new Map();
  }

  async get(key = "default") {
    if (this.items.has(key)) {
      const runtime = this.items.get(key);
      await runtime.ensureStarted();
      return runtime;
    }
    const runtime = new BrowserRuntime(this.options);
    await runtime.start();
    this.items.set(key, runtime);
    return runtime;
  }

  async claim(key = "default") {
    if (this.items.has(key)) {
      const runtime = this.items.get(key);
      await runtime.claimOwnership();
      return runtime;
    }
    const runtime = new BrowserRuntime(this.options);
    await runtime.claimOwnership();
    this.items.set(key, runtime);
    return runtime;
  }

  async close(key = "default") {
    const item = this.items.get(key);
    if (!item) {
      return;
    }
    this.items.delete(key);
    await item.close();
  }

  async closeAll() {
    const items = [...this.items.values()];
    this.items.clear();
    let firstError = null;
    for (const item of items) {
      try {
        await item.close();
      } catch (error) {
        if (!firstError) {
          firstError = error;
        }
      }
    }
    if (firstError) {
      throw firstError;
    }
  }
}

module.exports = {
  SessionManager,
};
