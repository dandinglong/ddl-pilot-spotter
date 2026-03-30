"use strict";

const path = require("path");

class Recorder {
  constructor(store, harBuilder) {
    this.store = store;
    this.harBuilder = harBuilder;
    this.lastActionUnix = 0;
    this.lastRecordingSeq = 0;
    this.active = new Map();
  }

  async start(sessionId, runtime, request = {}) {
    if (this.active.has(sessionId)) {
      throw new Error("recording is already active for this session");
    }

    const beforePage = await runtime.getPageState();
    const beforeSnapshot = await runtime.snapshot({});
    await runtime.startNetworkCapture();

    const startedAt = new Date();
    const recordingId = this.nextRecordingId();
    const state = {
      recordingId,
      sessionId,
      name: String(request.name || "").trim(),
      startedAt,
      before: {
        ...beforePage,
        snapshot: beforeSnapshot.snapshot,
      },
    };
    this.active.set(sessionId, state);

    return {
      recording_id: recordingId,
      session_id: sessionId,
      name: state.name,
      started_at: startedAt.toISOString(),
      message: "Recording started.",
    };
  }

  async stop(sessionId, runtime, request = {}) {
    const state = this.active.get(sessionId);
    if (!state) {
      throw new Error("no active recording for this session");
    }
    if (request.recording_id && request.recording_id !== state.recordingId) {
      throw new Error("recording_id does not match active recording");
    }
    this.active.delete(sessionId);

    const network = await runtime.stopNetworkCapture();
    const afterPage = await runtime.getPageState();
    const afterSnapshot = await runtime.snapshot({});
    const after = {
      ...afterPage,
      snapshot: afterSnapshot.snapshot,
    };

    return this.writeArtifacts(sessionId, state, after, network);
  }

  nextRecordingId() {
    this.lastRecordingSeq += 1;
    return `rec-${String(this.lastRecordingSeq).padStart(6, "0")}`;
  }

  nextActionId() {
    const now = Math.floor(Date.now() / 1000);
    this.lastActionUnix = Math.max(this.lastActionUnix + 1, now);
    return String(this.lastActionUnix);
  }

  async writeArtifacts(sessionId, active, after, records) {
    const actionId = this.nextActionId();
    const recordDir = await this.store.createActionDir(sessionId, actionId);

    const beforePagePath = path.join(recordDir, "before", "page.html");
    const afterPagePath = path.join(recordDir, "after", "page.html");
    const beforeMetadataPath = path.join(recordDir, "before", "metadata.json");
    const afterMetadataPath = path.join(recordDir, "after", "metadata.json");
    const beforeSnapshotPath = path.join(recordDir, "before", "snapshot.md");
    const afterSnapshotPath = path.join(recordDir, "after", "snapshot.md");
    const harPath = path.join(recordDir, "har", "action.har");
    const manifestPath = path.join(recordDir, "resources", "manifest.json");
    const actionJsonPath = path.join(recordDir, "action.json");

    await this.store.writeText(beforePagePath, active.before.html);
    await this.store.writeText(afterPagePath, after.html);
    await this.store.writeJSON(beforeMetadataPath, {
      url: active.before.url,
      title: active.before.title,
      snapshot: active.before.snapshot,
    });
    await this.store.writeJSON(afterMetadataPath, {
      url: after.url,
      title: after.title,
      snapshot: after.snapshot,
    });
    await this.store.writeText(beforeSnapshotPath, active.before.snapshot);
    await this.store.writeText(afterSnapshotPath, after.snapshot);

    const resources = await this.writeResources(path.join(recordDir, "resources"), records);
    await this.store.writeJSON(manifestPath, resources);
    await this.store.writeJSON(harPath, this.harBuilder.build(after, records));

    const artifacts = {
      action_id: actionId,
      record_dir: recordDir,
      before_snapshot_path: beforePagePath,
      after_snapshot_path: afterPagePath,
      har_path: harPath,
      resource_manifest: manifestPath,
      action_json_path: actionJsonPath,
      resources,
      warnings: [],
    };

    await this.store.writeJSON(actionJsonPath, {
      action_id: actionId,
      session_id: sessionId,
      tool: "browser_recording",
      recorded_at: new Date().toISOString(),
      recording_id: active.recordingId,
      name: active.name,
      started_at: active.startedAt.toISOString(),
      before: active.before,
      after,
      network: records,
      artifacts,
    });

    return artifacts;
  }

  async writeResources(resourceDir, records) {
    const manifest = [];
    for (const record of records) {
      const item = {
        request_id: record.requestId,
        url: record.url,
        content_type: record.contentType || "",
        status: record.responseStatus || 0,
        path: "",
        body_saved: false,
      };
      if (!isTextual(record.contentType) || !record.responseBodyBase64) {
        manifest.push(item);
        continue;
      }
      try {
        const data = Buffer.from(record.responseBodyBase64, "base64");
        const fileName = `${sanitizeFileName(record.requestId)}${extensionFor(record.contentType)}`;
        const filePath = path.join(resourceDir, fileName);
        await this.store.writeBytes(filePath, data);
        item.path = filePath;
        item.body_saved = true;
      } catch (_) {}
      manifest.push(item);
    }
    return manifest;
  }
}

function isTextual(contentType = "") {
  const lower = contentType.toLowerCase();
  if (!lower) return false;
  if (lower.startsWith("text/")) return true;
  return ["json", "javascript", "xml", "x-www-form-urlencoded", "graphql", "svg"].some((part) => lower.includes(part));
}

function extensionFor(contentType = "") {
  const lower = contentType.toLowerCase();
  if (lower.includes("html")) return ".html";
  if (lower.includes("css")) return ".css";
  if (lower.includes("javascript")) return ".js";
  if (lower.includes("json")) return ".json";
  if (lower.includes("xml")) return ".xml";
  if (lower.includes("svg")) return ".svg";
  return ".txt";
}

function sanitizeFileName(value) {
  const input = String(value || "").trim() || "resource";
  return input.replace(/[\\/:*?"<>|]/g, "_");
}

module.exports = {
  Recorder,
};
