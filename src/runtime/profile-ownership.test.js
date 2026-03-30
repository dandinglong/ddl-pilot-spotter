"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { ProfileOwnership, CHROME_LOCK_FILES } = require("./profile-ownership");
const { OwnershipConflictError } = require("./runtime-errors");

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "spotter-ownership-"));
}

test("writes and refreshes ownership metadata", async () => {
  const userDataDir = await makeTempDir();
  const ownership = new ProfileOwnership({
    userDataDir,
    instanceId: "spotter-test",
    processInspector: { isAlive: async () => true },
  });

  const written = await ownership.writeOwnership();
  assert.equal(written.instance_id, "spotter-test");

  const refreshed = await ownership.refreshOwnershipHeartbeat();
  assert.equal(refreshed.instance_id, "spotter-test");

  const loaded = await ownership.readOwnership();
  assert.equal(loaded.instance_id, "spotter-test");
});

test("prepareForLaunch throws when another live instance owns the profile", async () => {
  const userDataDir = await makeTempDir();
  const ownership = new ProfileOwnership({
    userDataDir,
    instanceId: "spotter-live",
    processInspector: { isAlive: async () => true },
  });

  await fs.mkdir(path.join(userDataDir, ".spotter"), { recursive: true });
  await fs.writeFile(path.join(userDataDir, ".spotter", "session.json"), JSON.stringify({
    instance_id: "spotter-other",
    owner_pid: process.pid + 9999,
    started_at: "2026-03-30T00:00:00.000Z",
    updated_at: "2026-03-30T00:00:05.000Z",
    user_data_dir: userDataDir,
  }), "utf8");

  await assert.rejects(() => ownership.prepareForLaunch(), (error) => {
    assert.equal(error instanceof OwnershipConflictError, true);
    assert.equal(error.details.instance_id, "spotter-other");
    return true;
  });
});

test("prepareForLaunch clears stale ownership and chrome lock files", async () => {
  const userDataDir = await makeTempDir();
  const ownership = new ProfileOwnership({
    userDataDir,
    instanceId: "spotter-recover",
    processInspector: { isAlive: async () => false },
  });

  await fs.mkdir(path.join(userDataDir, ".spotter"), { recursive: true });
  await fs.writeFile(path.join(userDataDir, ".spotter", "session.json"), JSON.stringify({
    instance_id: "spotter-old",
    owner_pid: 123456,
    started_at: "2026-03-30T00:00:00.000Z",
    updated_at: "2026-03-30T00:00:05.000Z",
    user_data_dir: userDataDir,
  }), "utf8");
  await Promise.all(CHROME_LOCK_FILES.map((name) => fs.writeFile(path.join(userDataDir, name), "lock", "utf8")));

  const result = await ownership.prepareForLaunch();
  assert.equal(result.mode, "recovered");

  const current = await ownership.readOwnership();
  assert.equal(current, null);
  for (const name of CHROME_LOCK_FILES) {
    await assert.rejects(() => fs.access(path.join(userDataDir, name)));
  }
});
