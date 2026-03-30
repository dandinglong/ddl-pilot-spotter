"use strict";

function registerHostLifecycle(options) {
  const processRef = options.processRef || process;
  const sessionManager = options.sessionManager;
  const exit = options.exit || ((code) => processRef.exit(code));
  const cleanup = options.cleanup || (async () => {});
  const parentInspector = options.parentInspector || defaultParentInspector;
  const pollIntervalMs = Number.isInteger(options.pollIntervalMs) && options.pollIntervalMs > 0
    ? options.pollIntervalMs
    : 2000;

  let shuttingDown = false;
  let parentTimer = null;
  const disposers = [];
  let resolveShutdownDone;
  const shutdownDone = new Promise((resolve) => {
    resolveShutdownDone = resolve;
  });

  async function shutdown(code) {
    if (shuttingDown) {
      return shutdownDone;
    }
    shuttingDown = true;
    dispose();
    try {
      await cleanup();
      await sessionManager.closeAll();
    } finally {
      resolveShutdownDone();
      exit(code);
    }
    return shutdownDone;
  }

  function addListener(target, event, listener) {
    if (!target || typeof target.on !== "function") {
      return;
    }
    target.on(event, listener);
    disposers.push(() => {
      if (typeof target.off === "function") {
        target.off(event, listener);
        return;
      }
      if (typeof target.removeListener === "function") {
        target.removeListener(event, listener);
      }
    });
  }

  function startParentMonitor() {
    const parentPid = processRef.ppid;
    if (!Number.isInteger(parentPid) || parentPid <= 0) {
      return;
    }
    parentTimer = setInterval(() => {
      void parentInspector.isAlive(parentPid).then((alive) => {
        if (!alive) {
          return shutdown(0);
        }
      }).catch(() => {});
    }, pollIntervalMs);
    if (typeof parentTimer.unref === "function") {
      parentTimer.unref();
    }
  }

  function startStdinMonitor() {
    if (!processRef.stdin) {
      return;
    }
    const handleClosedInput = () => {
      void shutdown(0);
    };
    addListener(processRef.stdin, "end", handleClosedInput);
    addListener(processRef.stdin, "close", handleClosedInput);
  }

  function dispose() {
    while (disposers.length) {
      const disposeListener = disposers.pop();
      try {
        disposeListener();
      } catch (_) {}
    }
    if (parentTimer) {
      clearInterval(parentTimer);
      parentTimer = null;
    }
  }

  addListener(processRef, "SIGINT", () => {
    void shutdown(0);
  });
  addListener(processRef, "SIGTERM", () => {
    void shutdown(0);
  });
  addListener(processRef, "disconnect", () => {
    void shutdown(0);
  });

  startStdinMonitor();
  startParentMonitor();

  return {
    dispose,
    shutdown,
    waitForShutdown() {
      return shutdownDone;
    },
  };
}

const defaultParentInspector = {
  async isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error && error.code === "EPERM") {
        return true;
      }
      return false;
    }
  },
};

module.exports = {
  registerHostLifecycle,
};
