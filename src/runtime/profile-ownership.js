"use strict";

const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");
const {
  OwnershipConflictError,
  StaleOwnershipRecoveryError,
} = require("./runtime-errors");

const SPOTTER_DIR_NAME = ".spotter";
const SESSION_FILE_NAME = "session.json";
const CHROME_LOCK_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket"];

class ProfileOwnership {
  constructor(options = {}) {
    this.userDataDir = options.userDataDir ? path.resolve(options.userDataDir) : "";
    this.instanceId = options.instanceId || `spotter-${randomUUID()}`;
    this.sessionId = options.sessionId || "default";
    this.runtimeVersion = options.runtimeVersion || "0.1.0";
    this.processInspector = options.processInspector || defaultProcessInspector;
    this.now = options.now || (() => new Date());
  }

  enabled() {
    return this.userDataDir !== "";
  }

  spotterDir() {
    return path.join(this.userDataDir, SPOTTER_DIR_NAME);
  }

  sessionFilePath() {
    return path.join(this.spotterDir(), SESSION_FILE_NAME);
  }

  async readOwnership() {
    if (!this.enabled()) {
      return null;
    }
    try {
      const raw = await fs.readFile(this.sessionFilePath(), "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async writeOwnership(extra = {}) {
    if (!this.enabled()) {
      return null;
    }
    const current = await this.readOwnership();
    const nowIso = this.now().toISOString();
    const ownership = {
      instance_id: this.instanceId,
      session_id: this.sessionId,
      owner_pid: process.pid,
      owner_ppid: process.ppid,
      started_at: current && current.instance_id === this.instanceId ? current.started_at : nowIso,
      updated_at: nowIso,
      user_data_dir: this.userDataDir,
      command_line: process.argv.join(" "),
      runtime_version: this.runtimeVersion,
      ...extra,
    };
    await fs.mkdir(this.spotterDir(), { recursive: true });
    await fs.writeFile(this.sessionFilePath(), JSON.stringify(ownership, null, 2), "utf8");
    return ownership;
  }

  async refreshOwnershipHeartbeat() {
    if (!this.enabled()) {
      return null;
    }
    const current = await this.readOwnership();
    if (!current) {
      return this.writeOwnership();
    }
    if (current.instance_id !== this.instanceId || current.owner_pid !== process.pid) {
      throw new OwnershipConflictError("user-data-dir is already in use by another spotter instance", {
        user_data_dir: this.userDataDir,
        instance_id: current.instance_id,
        owner_pid: current.owner_pid,
        started_at: current.started_at,
      });
    }
    return this.writeOwnership({ started_at: current.started_at || this.now().toISOString() });
  }

  async removeOwnership() {
    if (!this.enabled()) {
      return;
    }
    const current = await this.readOwnership();
    if (current && current.instance_id && current.instance_id !== this.instanceId) {
      return;
    }
    await fs.rm(this.sessionFilePath(), { force: true }).catch(() => {});
    await fs.rm(this.spotterDir(), { recursive: true, force: true }).catch(() => {});
  }

  async assertCurrentOwner() {
    if (!this.enabled()) {
      return;
    }
    const current = await this.readOwnership();
    if (!current) {
      throw new OwnershipConflictError("spotter ownership metadata is missing for the current user-data-dir", {
        user_data_dir: this.userDataDir,
      });
    }
    if (current.instance_id !== this.instanceId || current.owner_pid !== process.pid) {
      throw new OwnershipConflictError("user-data-dir is already in use by another spotter instance", {
        user_data_dir: this.userDataDir,
        instance_id: current.instance_id,
        owner_pid: current.owner_pid,
        started_at: current.started_at,
      });
    }
  }

  async prepareForLaunch() {
    if (!this.enabled()) {
      return { mode: "ephemeral" };
    }

    const current = await this.readOwnership();
    if (!current) {
      await this.cleanupLockFiles();
      return { mode: "new" };
    }

    const alive = await this.processInspector.isAlive(current.owner_pid);
    if (alive) {
      if (current.owner_pid === process.pid && current.instance_id === this.instanceId) {
        return { mode: "reentrant", ownership: current };
      }
      throw new OwnershipConflictError("user-data-dir is already in use by another spotter instance", {
        user_data_dir: this.userDataDir,
        instance_id: current.instance_id,
        owner_pid: current.owner_pid,
        started_at: current.started_at,
      });
    }

    try {
      await this.removeStaleArtifacts();
    } catch (error) {
      throw new StaleOwnershipRecoveryError("failed to recover stale user-data-dir ownership", {
        user_data_dir: this.userDataDir,
        previous_owner_pid: current.owner_pid,
        recovery_stage: "cleanup",
        cause: error.message,
      });
    }
    return { mode: "recovered", ownership: current };
  }

  async removeStaleArtifacts() {
    if (!this.enabled()) {
      return;
    }
    await fs.rm(this.sessionFilePath(), { force: true }).catch(() => {});
    await this.cleanupLockFiles();
  }

  async cleanupLockFiles() {
    if (!this.enabled()) {
      return;
    }
    await Promise.all(CHROME_LOCK_FILES.map(async (name) => {
      await fs.rm(path.join(this.userDataDir, name), { force: true }).catch(() => {});
    }));
  }
}

const defaultProcessInspector = {
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
  CHROME_LOCK_FILES,
  ProfileOwnership,
};
