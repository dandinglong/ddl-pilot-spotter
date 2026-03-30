"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const { registerHostLifecycle } = require("./host-lifecycle");

function createFakeProcess() {
  const fakeProcess = new EventEmitter();
  fakeProcess.stdin = new EventEmitter();
  fakeProcess.stdin.resume = () => {};
  fakeProcess.exit = () => {};
  fakeProcess.ppid = 4321;
  return fakeProcess;
}

test("shuts down when stdin closes", async () => {
  const fakeProcess = createFakeProcess();
  let closeAllCalls = 0;
  let exitCode = null;

  registerHostLifecycle({
    processRef: fakeProcess,
    sessionManager: {
      closeAll: async () => {
        closeAllCalls += 1;
      },
    },
    exit: (code) => {
      exitCode = code;
    },
    parentInspector: { isAlive: async () => true },
    pollIntervalMs: 10000,
  });

  fakeProcess.stdin.emit("close");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closeAllCalls, 1);
  assert.equal(exitCode, 0);
});

test("shuts down when parent process disappears", async () => {
  const fakeProcess = createFakeProcess();
  let closeAllCalls = 0;
  let exitCode = null;

  registerHostLifecycle({
    processRef: fakeProcess,
    sessionManager: {
      closeAll: async () => {
        closeAllCalls += 1;
      },
    },
    exit: (code) => {
      exitCode = code;
    },
    parentInspector: { isAlive: async () => false },
    pollIntervalMs: 10,
  });

  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(closeAllCalls, 1);
  assert.equal(exitCode, 0);
});

test("shutdown runs only once even if multiple signals arrive", async () => {
  const fakeProcess = createFakeProcess();
  let closeAllCalls = 0;
  const guard = registerHostLifecycle({
    processRef: fakeProcess,
    sessionManager: {
      closeAll: async () => {
        closeAllCalls += 1;
      },
    },
    exit: () => {},
    parentInspector: { isAlive: async () => true },
    pollIntervalMs: 10000,
  });

  fakeProcess.emit("disconnect");
  fakeProcess.emit("SIGTERM");
  fakeProcess.stdin.emit("end");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closeAllCalls, 1);
  guard.dispose();
});

test("shutdown runs cleanup before closing sessions and resolves waiters", async () => {
  const fakeProcess = createFakeProcess();
  const calls = [];
  let exitCode = null;

  const guard = registerHostLifecycle({
    processRef: fakeProcess,
    sessionManager: {
      closeAll: async () => {
        calls.push("closeAll");
      },
    },
    cleanup: async () => {
      calls.push("cleanup");
    },
    exit: (code) => {
      exitCode = code;
    },
    parentInspector: { isAlive: async () => true },
    pollIntervalMs: 10000,
  });

  fakeProcess.stdin.emit("end");
  await guard.waitForShutdown();

  assert.deepEqual(calls, ["cleanup", "closeAll"]);
  assert.equal(exitCode, 0);
});
