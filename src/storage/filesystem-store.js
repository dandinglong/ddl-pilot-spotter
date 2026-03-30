"use strict";

const fs = require("fs/promises");
const path = require("path");

class FileSystemStore {
  constructor(baseDir) {
    this.baseDir = path.resolve(baseDir);
  }

  async createActionDir(sessionId, actionId) {
    const dir = path.join(this.baseDir, sessionId, actionId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async writeText(filePath, content) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }

  async writeJSON(filePath, value) {
    await this.writeBytes(filePath, Buffer.from(JSON.stringify(value, null, 2), "utf8"));
  }

  async writeBytes(filePath, data) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data);
  }
}

module.exports = {
  FileSystemStore,
};
