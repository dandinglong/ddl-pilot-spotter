"use strict";

const { Buffer } = require("buffer");

class HarBuilder {
  constructor(name, version) {
    this.creatorName = name;
    this.creatorVersion = version;
  }

  build(page, records) {
    return {
      log: {
        version: "1.2",
        creator: {
          name: this.creatorName,
          version: this.creatorVersion,
        },
        pages: [
          {
            startedDateTime: new Date().toISOString(),
            id: "page_1",
            title: page.title || "",
            pageTimings: {
              onContentLoad: -1,
              onLoad: -1,
            },
          },
        ],
        entries: records.map((record) => this.entry(record)),
      },
    };
  }

  entry(record) {
    const responseContent = {
      size: decodedSize(record.responseBodyBase64),
      mimeType: record.contentType || "",
    };
    const responseBody = decodeBody(record.responseBodyBase64);
    if (responseBody.ok) {
      responseContent.text = responseBody.text;
      if (responseBody.encoding) {
        responseContent.encoding = responseBody.encoding;
      }
    }

    const postData = {
      mimeType: headerValue(record.requestHeaders, "content-type") || "application/octet-stream",
    };
    const requestBody = decodeBody(record.requestBodyBase64);
    if (requestBody.ok) {
      postData.text = requestBody.text;
      if (requestBody.encoding) {
        postData.encoding = requestBody.encoding;
      }
    }

    return {
      startedDateTime: record.startedAt || new Date().toISOString(),
      time: elapsedMillis(record.startedAt, record.finishedAt),
      request: {
        method: record.method || "GET",
        url: record.url || "",
        httpVersion: "HTTP/1.1",
        headers: toHeaders(record.requestHeaders),
        queryString: toQueryString(record.url),
        headersSize: -1,
        bodySize: decodedSize(record.requestBodyBase64),
        postData,
      },
      response: {
        status: record.responseStatus || 0,
        statusText: record.responseStatusText || "",
        httpVersion: "HTTP/1.1",
        headers: toHeaders(record.responseHeaders),
        content: responseContent,
        redirectURL: "",
        headersSize: -1,
        bodySize: decodedSize(record.responseBodyBase64),
      },
      cache: {},
      timings: {
        send: 0,
        wait: elapsedMillis(record.startedAt, record.finishedAt),
        receive: 0,
      },
      pageref: "page_1",
      _spotter: {
        requestId: record.requestId,
        failed: !!record.failed,
        errorText: record.errorText || "",
      },
    };
  }
}

function toHeaders(headers = {}) {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function toQueryString(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const items = [];
    for (const [name, value] of parsed.searchParams.entries()) {
      items.push({ name, value });
    }
    return items;
  } catch (_) {
    return [];
  }
}

function elapsedMillis(start, end) {
  if (!start || !end) {
    return 0;
  }
  const startTime = new Date(start).getTime();
  const endTime = new Date(end).getTime();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) {
    return 0;
  }
  return endTime - startTime;
}

function decodedSize(base64Value) {
  if (!base64Value) {
    return 0;
  }
  try {
    return Buffer.from(base64Value, "base64").length;
  } catch (_) {
    return 0;
  }
}

function decodeBody(base64Value) {
  if (!base64Value) {
    return { ok: false };
  }
  try {
    const raw = Buffer.from(base64Value, "base64");
    const text = raw.toString("utf8");
    if (Buffer.from(text, "utf8").equals(raw)) {
      return { ok: true, text, encoding: "" };
    }
    return { ok: true, text: base64Value, encoding: "base64" };
  } catch (_) {
    return { ok: false };
  }
}

function headerValue(headers = {}, name) {
  const target = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === target) {
      return String(value);
    }
  }
  return "";
}

module.exports = {
  HarBuilder,
};
