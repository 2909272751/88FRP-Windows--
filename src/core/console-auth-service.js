const crypto = require("crypto");

const PASSWORD_ITERATIONS = 210000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const REMEMBER_TTL_MS = 5 * 365 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 2 * 60 * 1000;

function tokenHash(token) { return crypto.createHash("sha256").update(String(token)).digest("base64url"); }
function safeEqual(left, right) {
  const a = Buffer.from(String(left || "")); const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class ConsoleAuthService {
  constructor({ store, credentialStore }) {
    this.store = store;
    this.credentialStore = credentialStore;
    this.challenges = new Map();
    this.failures = new Map();
  }

  async getStatus() {
    const config = await this.store.getConsoleAuth();
    return { configured: Boolean(config.username && config.passwordSalt && config.encryptedVerifier), username: config.username || "" };
  }

  async configure({ username, password }) {
    const cleanUsername = String(username || "").trim().slice(0, 80);
    const cleanPassword = String(password || "");
    if (!cleanUsername) throw new Error("请输入控制台用户名。");
    if (!cleanPassword) throw new Error("请输入控制台密码。");
    const salt = crypto.randomBytes(16).toString("base64");
    const verifier = crypto.pbkdf2Sync(cleanPassword, Buffer.from(salt, "base64"), PASSWORD_ITERATIONS, 32, "sha256");
    await this.store.saveConsoleAuth({ username: cleanUsername, passwordSalt: salt, passwordIterations: PASSWORD_ITERATIONS, encryptedVerifier: await this.credentialStore.protect(verifier.toString("base64")), sessions: [] });
    this.challenges.clear(); this.failures.clear();
    return this.getStatus();
  }

  async revokeSessions() { await this.store.saveConsoleAuth({ sessions: [] }); }

  async createChallenge() {
    const config = await this.store.getConsoleAuth();
    if (!config.username || !config.passwordSalt || !config.encryptedVerifier) throw new Error("控制台尚未设置管理员账号。");
    const id = crypto.randomBytes(18).toString("base64url");
    const nonce = crypto.randomBytes(32).toString("base64url");
    this.challenges.set(id, { nonce, expiresAt: Date.now() + CHALLENGE_TTL_MS });
    return { challengeId: id, nonce, salt: config.passwordSalt, iterations: Number(config.passwordIterations) || PASSWORD_ITERATIONS };
  }

  async login({ challengeId, username, proof, remember }, remoteAddress) {
    let state = this.failures.get(remoteAddress);
    if (!state || state.resetAt < Date.now()) state = { count: 0, resetAt: Date.now() + 60000 };
    if (state.count >= 5) throw new Error("登录尝试过多，请一分钟后再试。");
    const challenge = this.challenges.get(String(challengeId || "")); this.challenges.delete(String(challengeId || ""));
    if (!challenge || challenge.expiresAt < Date.now()) throw new Error("登录校验已过期，请重试。");
    const config = await this.store.getConsoleAuth();
    const verifier = await this.credentialStore.unprotect(config.encryptedVerifier);
    const loginName = String(username || "").trim();
    const expected = crypto.createHmac("sha256", Buffer.from(verifier, "base64")).update(`${challenge.nonce}\n${loginName}`).digest("base64url");
    if (!safeEqual(config.username, loginName) || !safeEqual(expected, proof)) { this.failures.set(remoteAddress, { count: state.count + 1, resetAt: state.resetAt }); throw new Error("用户名或密码不正确。"); }
    this.failures.delete(remoteAddress);
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + (remember ? REMEMBER_TTL_MS : SESSION_TTL_MS);
    const sessions = config.sessions.filter((item) => item && (!item.expiresAt || item.expiresAt > Date.now())).slice(-11);
    sessions.push({ hash: tokenHash(token), expiresAt, remember: Boolean(remember), createdAt: new Date().toISOString() });
    await this.store.saveConsoleAuth({ sessions });
    return { token, maxAge: Math.floor((remember ? REMEMBER_TTL_MS : SESSION_TTL_MS) / 1000), remember: Boolean(remember) };
  }

  async verify(token) {
    if (!token) return false;
    const config = await this.store.getConsoleAuth();
    const now = Date.now(); const hash = tokenHash(token);
    const valid = config.sessions.some((item) => item && item.expiresAt > now && safeEqual(item.hash, hash));
    const live = config.sessions.filter((item) => item && item.expiresAt > now);
    if (live.length !== config.sessions.length) await this.store.saveConsoleAuth({ sessions: live });
    return valid;
  }
}

module.exports = { ConsoleAuthService };
