"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { BrowserRuntime } = require("./browser-runtime");
const { OwnershipConflictError } = require("./runtime-errors");

function createFakePage(url = "about:blank") {
  let closed = false;
  return {
    on() {},
    url: () => url,
    title: async () => "Fake Page",
    isClosed: () => closed,
    close: async () => { closed = true; },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    goto: async (nextUrl) => { url = nextUrl; },
    content: async () => "<html></html>",
    bringToFront: async () => {},
  };
}

function createFakeContext(page) {
  let closed = false;
  const fakeBrowser = {
    isConnected: () => !closed,
    on() {},
    close: async () => { closed = true; },
  };
  return {
    on() {},
    browser: () => fakeBrowser,
    pages: () => (closed ? [] : [page]),
    newPage: async () => page,
    newCDPSession: async () => ({ on() {}, send: async () => ({}) }),
    addInitScript: async () => {},
    close: async () => { closed = true; },
  };
}

test("start rejects when another live instance owns the same profile", async () => {
  let launches = 0;
  const runtime = new BrowserRuntime({
    userDataDir: "D:\\workspace\\chrome_profiles\\spotter",
    browserEngine: {
      launchPersistentContext: async () => {
        launches += 1;
        return createFakeContext(createFakePage());
      },
    },
  });

  runtime.ownership.readOwnership = async () => ({
    instance_id: "spotter-other",
    owner_pid: process.pid + 999,
    started_at: "2026-03-30T00:00:00.000Z",
  });
  runtime.ownership.processInspector = { isAlive: async () => true };

  await assert.rejects(() => runtime.start(), (error) => {
    assert.equal(error instanceof OwnershipConflictError, true);
    return true;
  });
  assert.equal(launches, 0);
});

test("claimOwnership acquires profile ownership without launching the browser", async () => {
  let launches = 0;
  const runtime = new BrowserRuntime({
    userDataDir: "D:\\workspace\\chrome_profiles\\spotter",
    browserEngine: {
      launchPersistentContext: async () => {
        launches += 1;
        return createFakeContext(createFakePage());
      },
    },
  });

  runtime.ownership.prepareForLaunch = async () => ({ mode: "new" });
  runtime.ownership.writeOwnership = async () => ({ instance_id: runtime.ownership.instanceId, owner_pid: process.pid });
  runtime.ownership.refreshOwnershipHeartbeat = async () => {};

  await runtime.claimOwnership();

  assert.equal(runtime.ownershipClaimed, true);
  assert.equal(runtime.started, false);
  assert.equal(launches, 0);

  await runtime.close();
});

test("navigate rebuilds runtime after a closed-page error for the current owner", async () => {
  let launches = 0;
  let failOnFirstGoto = true;
  const runtime = new BrowserRuntime({
    userDataDir: "D:\\workspace\\chrome_profiles\\spotter",
    browserEngine: {
      launchPersistentContext: async () => {
        launches += 1;
        const page = createFakePage();
        page.goto = async (nextUrl) => {
          if (failOnFirstGoto) {
            failOnFirstGoto = false;
            throw new Error("Target page, context or browser has been closed");
          }
          page.url = () => nextUrl;
        };
        return createFakeContext(page);
      },
    },
  });

  runtime.ownership.prepareForLaunch = async () => ({ mode: launches === 0 ? "new" : "reentrant" });
  runtime.ownership.writeOwnership = async () => ({ instance_id: runtime.ownership.instanceId, owner_pid: process.pid });
  runtime.ownership.assertCurrentOwner = async () => {};
  runtime.ownership.refreshOwnershipHeartbeat = async () => {};

  const result = await runtime.navigate("https://example.com");
  assert.equal(result.message, "Navigated to https://example.com/");
  assert.equal(launches, 2);

  await runtime.close();
});
