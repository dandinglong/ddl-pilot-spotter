"use strict";

function structuredTextResult(structuredContent, text) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

function errorToolResult(error) {
  const details = error && error.details && typeof error.details === "object"
    ? { ...error.details }
    : {};
  return {
    content: [{ type: "text", text: error.message || "Tool execution failed." }],
    structuredContent: {
      error: error.name || "Error",
      message: error.message || "Tool execution failed.",
      details,
    },
    isError: true,
  };
}

function actionToolResult(result, extra) {
  const sections = [];
  if (result.code && result.code.length) {
    sections.push(`### Ran Playwright code\n\`\`\`js\n${result.code.join("\n")}\n\`\`\``);
  }
  if (result.message) {
    sections.push(`### Result\n${result.message}`);
  }
  if (result.snapshot) {
    sections.push(`### Snapshot\n${result.snapshot.snapshot}`);
  }
  const structured = {
    code: result.code || [],
    message: result.message || "",
  };
  if (typeof result.opened_new_tab === "boolean") {
    structured.opened_new_tab = result.opened_new_tab;
  }
  if (result.new_tab) {
    structured.new_tab = result.new_tab;
    sections.push(renderNewTab(result.new_tab));
  }
  if (result.snapshot) {
    structured.snapshot = result.snapshot;
  }
  if (extra && typeof extra === "object") {
    Object.assign(structured, extra);
    if (extra.recording) {
      sections.push(renderRecording(extra.recording));
    }
  }
  return structuredTextResult(structured, filterEmpty(sections).join("\n\n"));
}

function snapshotToolResult(result) {
  return structuredTextResult(result, `### Snapshot\n${result.snapshot}`);
}

function textToolResult(result) {
  const sections = [];
  if (result.code && result.code.length) {
    sections.push(`### Ran Playwright code\n\`\`\`js\n${result.code.join("\n")}\n\`\`\``);
  }
  sections.push(`### ${result.title || "Result"}\n${result.content}`);
  return structuredTextResult(result, filterEmpty(sections).join("\n\n"));
}

function evaluateToolResult(result) {
  const sections = [];
  if (result.code && result.code.length) {
    sections.push(`### Ran Playwright code\n\`\`\`js\n${result.code.join("\n")}\n\`\`\``);
  }
  sections.push(`### Result\n\`\`\`json\n${result.output}\n\`\`\``);
  return structuredTextResult(result, sections.join("\n\n"));
}

function fileToolResult(result) {
  const sections = [];
  if (result.code && result.code.length) {
    sections.push(`### Ran Playwright code\n\`\`\`js\n${result.code.join("\n")}\n\`\`\``);
  }
  const structured = {
    path: result.path || "",
    mime_type: result.mimeType || "",
    data_base64: result.dataBase64 || "",
  };
  sections.push(`### Result\n\`\`\`json\n${JSON.stringify(structured, null, 2)}\n\`\`\``);
  return structuredTextResult(structured, sections.join("\n\n"));
}

function recordingStartResult(result) {
  const lines = [
    "### Recording",
    `- Recording ID: ${result.recording_id}`,
    `- Session ID: ${result.session_id}`,
    `- Started At: ${result.started_at}`,
  ];
  if (result.name) {
    lines.push(`- Name: ${result.name}`);
  }
  if (result.message) {
    lines.push("", "### Result", result.message);
  }
  return structuredTextResult(result, lines.join("\n"));
}

function recordingStopResult(artifacts) {
  return structuredTextResult({ recording: artifacts }, renderRecording(artifacts));
}

function tabsToolResult(result) {
  const sections = [];
  if (result.code && result.code.length) {
    sections.push(`### Ran Playwright code\n\`\`\`js\n${result.code.join("\n")}\n\`\`\``);
  }
  if (result.message) {
    sections.push(`### Result\n${result.message}`);
  }
  if (result.tabs && result.tabs.length) {
    const lines = ["### Open tabs"];
    for (const tab of result.tabs) {
      let line = `- [${tab.index}] ${tab.url || "(blank)"} | ${tab.title || "(untitled)"}`;
      if (tab.active) {
        line += " [active]";
      }
      lines.push(line);
    }
    sections.push(lines.join("\n"));
  }
  if (result.page) {
    sections.push(`### Page state\nURL: ${result.page.url || "(blank)"}\nTitle: ${result.page.title || "(untitled)"}`);
  }
  return structuredTextResult(result, filterEmpty(sections).join("\n\n"));
}

function renderRecording(artifacts) {
  return [
    "### Recording",
    `- Action ID: ${artifacts.action_id}`,
    `- Record Dir: ${artifacts.record_dir}`,
    `- Before Snapshot: ${artifacts.before_snapshot_path}`,
    `- After Snapshot: ${artifacts.after_snapshot_path}`,
    `- HAR: ${artifacts.har_path}`,
    `- Resource Manifest: ${artifacts.resource_manifest}`,
    `- Action JSON: ${artifacts.action_json_path}`,
  ].join("\n");
}

function renderNewTab(tab) {
  return [
    "### New Tab",
    `- Index: ${tab.index}`,
    `- Active: ${tab.active}`,
    `- URL: ${tab.url || "(blank)"}`,
    `- Title: ${tab.title || "(untitled)"}`,
  ].join("\n");
}

function filterEmpty(values) {
  return values.filter((value) => String(value || "").trim() !== "");
}

module.exports = {
  actionToolResult,
  errorToolResult,
  evaluateToolResult,
  fileToolResult,
  recordingStartResult,
  recordingStopResult,
  snapshotToolResult,
  tabsToolResult,
  textToolResult,
};
