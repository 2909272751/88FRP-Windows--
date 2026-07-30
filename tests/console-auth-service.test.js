const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { Store } = require("../src/core/store");
const { ConsoleAuthService } = require("../src/core/console-auth-service");

const credentialStore = {
  async protect(value) { return value; },
  async unprotect(value) { return value; },
};

function createProof(password, username, challenge) {
  const verifier = crypto.pbkdf2Sync(password, Buffer.from(challenge.salt, "base64"), challenge.iterations, 32, "sha256");
  return crypto.createHmac("sha256", verifier).update(`${challenge.nonce}\n${username}`).digest("base64url");
}

test("控制台认证使用一次性挑战、可撤销会话且不保存明文密码", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-console-auth-"));
  try {
    const store = new Store({ dataDir });
    await store.initialize();
    const service = new ConsoleAuthService({ store, credentialStore });
    await service.configure({ username: "admin", password: "short" });

    const configured = await service.getStatus();
    const stored = await store.getConsoleAuth();
    assert.equal(configured.configured, true);
    assert.equal(stored.encryptedVerifier.includes("short"), false);

    const challenge = await service.createChallenge();
    const login = await service.login({
      challengeId: challenge.challengeId,
      username: "admin",
      proof: createProof("short", "admin", challenge),
      remember: false,
    }, "127.0.0.1");
    assert.equal(login.maxAge, 24 * 60 * 60);
    assert.equal(await service.verify(login.token), true);
    await assert.rejects(
      service.login({ challengeId: challenge.challengeId, username: "admin", proof: createProof("short", "admin", challenge) }, "127.0.0.1"),
      /过期/
    );

    await service.revokeSessions();
    assert.equal(await service.verify(login.token), false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
