"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const cdpNetwork = require("./cdp-network");

test("captures request and response details from cdp events", () => {
  const store = cdpNetwork.createNetworkStore();
  const tracker = cdpNetwork.createSessionTracker("cdp-1");

  cdpNetwork.recordRequestWillBeSent(store, tracker, {
    requestId: "request-1",
    wallTime: 1710000000,
    type: "Fetch",
    request: {
      url: "https://example.test/feed",
      method: "POST",
      headers: { Referer: "https://example.test/" },
      postData: "hello",
    },
  });
  cdpNetwork.recordRequestWillBeSentExtraInfo(store, tracker, {
    requestId: "request-1",
    headers: { Cookie: "sid=1" },
  });
  cdpNetwork.recordResponseReceived(store, tracker, {
    requestId: "request-1",
    response: {
      status: 200,
      statusText: "OK",
      mimeType: "application/octet-stream",
      headers: { "Content-Type": "application/octet-stream" },
    },
  });
  cdpNetwork.recordResponseReceivedExtraInfo(store, tracker, {
    requestId: "request-1",
    statusCode: 200,
    headers: { "X-Test": "1" },
  });
  cdpNetwork.recordLoadingFinished(store, tracker, { requestId: "request-1" });
  cdpNetwork.applyResponseBody(store, tracker, "request-1", "AAEC", true);

  const record = store.records.get("cdp-1:request-1");
  assert.equal(record.method, "POST");
  assert.equal(record.resourceType, "fetch");
  assert.equal(record.requestHeaders.referer, "https://example.test/");
  assert.equal(record.requestHeaders.cookie, "sid=1");
  assert.equal(Buffer.from(record.requestBodyBase64, "base64").toString("utf8"), "hello");
  assert.equal(record.responseStatus, 200);
  assert.equal(record.responseHeaders["content-type"], "application/octet-stream");
  assert.equal(record.responseHeaders["x-test"], "1");
  assert.equal(record.responseBodyBase64, "AAEC");
});

test("creates a second record when cdp reuses requestId for redirect", () => {
  const store = cdpNetwork.createNetworkStore();
  const tracker = cdpNetwork.createSessionTracker("cdp-2");

  cdpNetwork.recordRequestWillBeSent(store, tracker, {
    requestId: "request-2",
    wallTime: 1710000000,
    type: "Document",
    request: {
      url: "https://example.test/start",
      method: "GET",
      headers: {},
    },
  });
  cdpNetwork.recordRequestWillBeSent(store, tracker, {
    requestId: "request-2",
    wallTime: 1710000001,
    type: "Document",
    redirectResponse: {
      status: 302,
      statusText: "Found",
      headers: { Location: "https://example.test/next" },
      mimeType: "text/html",
    },
    request: {
      url: "https://example.test/next",
      method: "GET",
      headers: {},
    },
  });

  assert.deepEqual(store.order, ["cdp-2:request-2", "cdp-2:request-2:r1"]);
  const first = store.records.get("cdp-2:request-2");
  const second = store.records.get("cdp-2:request-2:r1");
  assert.equal(first.responseStatus, 302);
  assert.equal(second.url, "https://example.test/next");
});
