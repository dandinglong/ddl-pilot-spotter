"use strict";

function createNetworkStore() {
  return {
    records: new Map(),
    order: [],
  };
}

function createSessionTracker(sessionKey) {
  return {
    sessionKey,
    requestMap: new Map(),
    redirectCounts: new Map(),
    pendingRequestExtraHeaders: new Map(),
    pendingResponseExtraHeaders: new Map(),
    pendingResponseExtraInfo: new Map(),
  };
}

function createRecord(store, recordId) {
  const existing = store.records.get(recordId);
  if (existing) {
    return existing;
  }
  const entry = {
    requestId: recordId,
    requestHeaders: {},
    responseHeaders: {},
  };
  store.records.set(recordId, entry);
  store.order.push(recordId);
  return entry;
}

function currentRecordId(tracker, requestId) {
  return tracker.requestMap.get(requestId) || null;
}

function normalizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (typeof value === "undefined" || value === null) {
      continue;
    }
    out[String(key).toLowerCase()] = Array.isArray(value)
      ? value.map((item) => String(item)).join(", ")
      : String(value);
  }
  return out;
}

function mergeHeaders(target, headers) {
  return Object.assign(target || {}, normalizeHeaders(headers));
}

function isoFromWallTime(wallTime) {
  if (typeof wallTime === "number" && Number.isFinite(wallTime) && wallTime > 0) {
    return new Date(wallTime * 1000).toISOString();
  }
  return new Date().toISOString();
}

function ensureRecordForRequest(store, tracker, requestId, nextRecordId) {
  const recordId = nextRecordId || currentRecordId(tracker, requestId) || `${tracker.sessionKey}:${requestId}`;
  tracker.requestMap.set(requestId, recordId);
  return createRecord(store, recordId);
}

function finalizeRedirectIfNeeded(store, tracker, event) {
  if (!event.redirectResponse) {
    return null;
  }
  const previousId = currentRecordId(tracker, event.requestId);
  if (!previousId) {
    return null;
  }
  const previous = createRecord(store, previousId);
  applyResponse(previous, event.redirectResponse);
  previous.finishedAt = isoFromWallTime(event.wallTime);
  const nextIndex = (tracker.redirectCounts.get(event.requestId) || 0) + 1;
  tracker.redirectCounts.set(event.requestId, nextIndex);
  return `${tracker.sessionKey}:${event.requestId}:r${nextIndex}`;
}

function recordRequestWillBeSent(store, tracker, event) {
  const nextRecordId = finalizeRedirectIfNeeded(store, tracker, event);
  const entry = ensureRecordForRequest(store, tracker, event.requestId, nextRecordId);
  entry.url = event.request && event.request.url ? event.request.url : entry.url || "";
  entry.method = event.request && event.request.method ? event.request.method : entry.method || "GET";
  entry.resourceType = event.type ? String(event.type).toLowerCase() : entry.resourceType || "";
  entry.startedAt = entry.startedAt || isoFromWallTime(event.wallTime);
  entry.requestHeaders = mergeHeaders(entry.requestHeaders, event.request && event.request.headers);

  if (event.request && typeof event.request.postData === "string") {
    entry.requestBodyBase64 = Buffer.from(event.request.postData, "utf8").toString("base64");
  }

  const pendingRequestHeaders = tracker.pendingRequestExtraHeaders.get(event.requestId);
  if (pendingRequestHeaders) {
    entry.requestHeaders = mergeHeaders(entry.requestHeaders, pendingRequestHeaders);
    tracker.pendingRequestExtraHeaders.delete(event.requestId);
  }

  const pendingResponseHeaders = tracker.pendingResponseExtraHeaders.get(event.requestId);
  if (pendingResponseHeaders) {
    entry.responseHeaders = mergeHeaders(entry.responseHeaders, pendingResponseHeaders);
    entry.contentType = headerValue(entry.responseHeaders, "content-type") || entry.contentType || "";
    tracker.pendingResponseExtraHeaders.delete(event.requestId);
  }

  const pendingResponseInfo = tracker.pendingResponseExtraInfo.get(event.requestId);
  if (pendingResponseInfo) {
    entry.responseStatus = pendingResponseInfo.statusCode || entry.responseStatus || 0;
    if (pendingResponseInfo.headers) {
      entry.responseHeaders = mergeHeaders(entry.responseHeaders, pendingResponseInfo.headers);
      entry.contentType = headerValue(entry.responseHeaders, "content-type") || entry.contentType || "";
    }
    tracker.pendingResponseExtraInfo.delete(event.requestId);
  }

  return entry;
}

function recordRequestWillBeSentExtraInfo(store, tracker, event) {
  const recordId = currentRecordId(tracker, event.requestId);
  if (!recordId) {
    tracker.pendingRequestExtraHeaders.set(event.requestId, event.headers || {});
    return null;
  }
  const entry = createRecord(store, recordId);
  entry.requestHeaders = mergeHeaders(entry.requestHeaders, event.headers);
  return entry;
}

function applyResponse(entry, response) {
  entry.responseStatus = typeof response.status === "number" ? response.status : entry.responseStatus || 0;
  entry.responseStatusText = response.statusText || entry.responseStatusText || "";
  entry.responseHeaders = mergeHeaders(entry.responseHeaders, response.headers);
  entry.contentType = headerValue(entry.responseHeaders, "content-type") || response.mimeType || entry.contentType || "";
}

function recordResponseReceived(store, tracker, event) {
  const entry = ensureRecordForRequest(store, tracker, event.requestId);
  applyResponse(entry, event.response || {});
  return entry;
}

function recordResponseReceivedExtraInfo(store, tracker, event) {
  const recordId = currentRecordId(tracker, event.requestId);
  if (!recordId) {
    tracker.pendingResponseExtraHeaders.set(event.requestId, event.headers || {});
    tracker.pendingResponseExtraInfo.set(event.requestId, {
      statusCode: event.statusCode || 0,
      headers: event.headers || {},
    });
    return null;
  }
  const entry = createRecord(store, recordId);
  if (typeof event.statusCode === "number" && event.statusCode > 0) {
    entry.responseStatus = event.statusCode;
  }
  entry.responseHeaders = mergeHeaders(entry.responseHeaders, event.headers);
  entry.contentType = headerValue(entry.responseHeaders, "content-type") || entry.contentType || "";
  return entry;
}

function recordLoadingFinished(store, tracker, event) {
  const recordId = currentRecordId(tracker, event.requestId);
  if (!recordId) {
    return null;
  }
  const entry = createRecord(store, recordId);
  entry.finishedAt = new Date().toISOString();
  return entry;
}

function recordLoadingFailed(store, tracker, event) {
  const recordId = currentRecordId(tracker, event.requestId);
  if (!recordId) {
    return null;
  }
  const entry = createRecord(store, recordId);
  entry.failed = true;
  entry.errorText = event.errorText || "Unknown error";
  entry.finishedAt = new Date().toISOString();
  return entry;
}

function applyRequestPostData(store, tracker, requestId, postData) {
  if (typeof postData !== "string") {
    return null;
  }
  const recordId = currentRecordId(tracker, requestId);
  if (!recordId) {
    return null;
  }
  const entry = createRecord(store, recordId);
  entry.requestBodyBase64 = Buffer.from(postData, "utf8").toString("base64");
  return entry;
}

function applyResponseBody(store, tracker, requestId, body, base64Encoded) {
  if (typeof body !== "string") {
    return null;
  }
  const recordId = currentRecordId(tracker, requestId);
  if (!recordId) {
    return null;
  }
  const entry = createRecord(store, recordId);
  entry.responseBodyBase64 = base64Encoded ? body : Buffer.from(body, "utf8").toString("base64");
  return entry;
}

function headerValue(headers, name) {
  const lower = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === lower) {
      return String(value);
    }
  }
  return "";
}

module.exports = {
  applyRequestPostData,
  applyResponseBody,
  createNetworkStore,
  createSessionTracker,
  headerValue,
  normalizeHeaders,
  recordLoadingFailed,
  recordLoadingFinished,
  recordRequestWillBeSent,
  recordRequestWillBeSentExtraInfo,
  recordResponseReceived,
  recordResponseReceivedExtraInfo,
};
