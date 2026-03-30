"use strict";

const fs = require("fs/promises");
const path = require("path");
const {
  OwnershipConflictError,
  ProfileUnavailableError,
} = require("../runtime/runtime-errors");

class BrowserService {
  constructor(sessionManager, recorder) {
    this.sessions = sessionManager;
    this.recorder = recorder;
  }

  async session() {
    return this.withSession(async (runtime, sessionId) => ({ runtime, sessionId }));
  }

  async closeBrowser() {
    await this.sessions.close("default");
    return {
      code: ["await page.close();"],
      message: "Browser session closed.",
    };
  }

  async navigate(url) {
    return this.withSession((runtime) => runtime.navigate(url));
  }

  async navigateBack() {
    return this.withSession((runtime) => runtime.navigateBack());
  }

  async snapshot(request) {
    const result = await this.withSession((runtime) => runtime.snapshot(request));
    if (request && request.filename) {
      await writeOutputFile(request.filename, Buffer.from(result.snapshot, "utf8"));
    }
    return result;
  }

  async type(request) {
    return this.withSession((runtime) => runtime.type(request));
  }

  async click(request) {
    const result = await this.withSession((runtime) => runtime.click(request));
    return { result, artifacts: null };
  }

  async startRecording(request) {
    return this.withSession((runtime, sessionId) => this.recorder.start(sessionId, runtime, request));
  }

  async stopRecording(request) {
    return this.withSession((runtime, sessionId) => this.recorder.stop(sessionId, runtime, request));
  }

  async hover(request) {
    return this.withSession((runtime) => runtime.hover(request));
  }

  async drag(request) {
    return this.withSession((runtime) => runtime.drag(request));
  }

  async selectOption(request) {
    return this.withSession((runtime) => runtime.selectOption(request));
  }

  async pressKey(request) {
    return this.withSession((runtime) => runtime.pressKey(request));
  }

  async waitFor(request) {
    return this.withSession((runtime) => runtime.waitFor(request));
  }

  async resize(request) {
    return this.withSession((runtime) => runtime.resize(request));
  }

  async evaluate(request) {
    return this.withSession((runtime) => runtime.evaluate(request));
  }

  async runCode(request) {
    return this.withSession((runtime) => runtime.runCode(request));
  }

  async takeScreenshot(request) {
    const result = await this.withSession((runtime) => runtime.takeScreenshot(request));
    if (request && request.filename && result.dataBase64) {
      await writeOutputFile(request.filename, Buffer.from(result.dataBase64, "base64"));
      result.path = path.resolve(request.filename);
    }
    return result;
  }

  async networkRequests(request) {
    const result = await this.withSession((runtime) => runtime.networkRequests({
      includeStatic: !!request.includeStatic,
      includeAll: false,
    }));
    if (request && request.filename) {
      await writeOutputFile(request.filename, Buffer.from(result.content, "utf8"));
    }
    return result;
  }

  async consoleMessages(request) {
    const result = await this.withSession((runtime) => runtime.consoleMessages(request));
    if (request && request.filename) {
      await writeOutputFile(request.filename, Buffer.from(result.content, "utf8"));
    }
    return result;
  }

  async handleDialog(request) {
    return this.withSession((runtime) => runtime.handleDialog(request));
  }

  async fileUpload(request) {
    return this.withSession((runtime) => runtime.fileUpload(request));
  }

  async fillForm(request) {
    return this.withSession((runtime) => runtime.fillForm(request));
  }

  async browserTabs(request) {
    return this.withSession((runtime) => runtime.browserTabs(request));
  }

  async withSession(operation) {
    return this.translateAvailabilityError(async () => {
      const sessionId = "default";
      const runtime = await this.sessions.get(sessionId);
      return operation(runtime, sessionId);
    });
  }

  async translateAvailabilityError(operation) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof OwnershipConflictError)) {
        throw error;
      }
      throw buildProfileUnavailableError(this.sessions, error);
    }
  }
}

function buildProfileUnavailableError(sessionManager, cause) {
  const fallbackUserDataDir = sessionManager && sessionManager.options
    ? sessionManager.options.userDataDir || ""
    : "";
  const details = {
    reason: "profile_in_use",
    user_data_dir: cause && cause.details && cause.details.user_data_dir
      ? cause.details.user_data_dir
      : fallbackUserDataDir,
  };

  if (cause && cause.details) {
    if (cause.details.instance_id) {
      details.instance_id = cause.details.instance_id;
    }
    if (cause.details.owner_pid) {
      details.owner_pid = cause.details.owner_pid;
    }
    if (cause.details.started_at) {
      details.started_at = cause.details.started_at;
    }
  }

  const message = `另一个进程正在占用 user-data-dir: ${details.user_data_dir || "(empty)"}，当前 spotter 进程暂时不可用。`;
  return new ProfileUnavailableError(message, details);
}

async function writeOutputFile(filePath, data) {
  const absolutePath = path.resolve(filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, data);
}

module.exports = {
  BrowserService,
};
