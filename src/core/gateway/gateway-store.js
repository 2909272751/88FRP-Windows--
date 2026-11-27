"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  DEFAULT_STATE,
  normalizeState,
  redactSensitive,
  validateStateForWrite,
} = require("./gateway-model");
const { readJsonWithRecoverySync, writeJsonAtomicSync } = require("../../shared/atomic-json-file");
const { RotatingLogWriter, readLogTail } = require("../../shared/log-files");

const DEFAULT_RUNTIME = {
  caddy: {
    status: "stopped",
    pid: null,
    lastStartedAt: "",
    lastExitCode: null,
    lastError: "",
  },
  frpc: {
    status: "stopped",
    pid: null,
    lastStartedAt: "",
    lastExitCode: null,
    lastError: "",
  },
  scheduler: {
    lastTickAt: "",
    lastSuccessAt: "",
    lastError: "",
    ipv6Address: "",
    nodeIpv4: "",
  },
  source: {
    lastCheckAt: "",
    lastSuccessAt: "",
    lastChangedAt: "",
    lastError: "",
    intervalMs: 0,
  },
  updatedAt: "",
};

function mergeRuntime(raw) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    ...DEFAULT_RUNTIME,
    ...value,
    caddy: { ...DEFAULT_RUNTIME.caddy, ...(value.caddy || {}) },
    frpc: { ...DEFAULT_RUNTIME.frpc, ...(value.frpc || {}) },
    scheduler: { ...DEFAULT_RUNTIME.scheduler, ...(value.scheduler || {}) },
    source: { ...DEFAULT_RUNTIME.source, ...(value.source || {}) },
  };
}

function writeTextAtomicSync(filePath, contents, { backupPaths = [], mode = 0o600 } = {}) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const text = String(contents ?? "");
  let existing = null;
  try {
    existing = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing === text) return false;
  if (existing !== null) {
    for (const backupPath of backupPaths) {
      try {
        writeTextAtomicSync(backupPath, existing, { mode });
      } catch {
        // A backup failure must not destroy the current good file.
      }
    }
  }
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
    fs.writeFileSync(descriptor, text, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(temporary, filePath);
        break;
      } catch (error) {
        if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 9) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* Best effort. */ }
    }
    try { fs.rmSync(temporary, { force: true }); } catch { /* Best effort. */ }
  }
  return true;
}

class GatewayStore {
  constructor({ store }) {
    this.store = store;
    this.rootDir = path.join(store.dataDir, "gateway");
    this.stateFile = path.join(this.rootDir, "state.json");
    this.runtimeFile = path.join(this.rootDir, "runtime.json");
    this.caddyfilePath = path.join(this.rootDir, "Caddyfile");
    this.frpcConfigPath = path.join(this.rootDir, "frpc.toml");
    this.caddyStorageDir = path.join(this.rootDir, "caddy-storage");
    this.logsDir = path.join(this.rootDir, "logs");
    this.caddyLogPath = path.join(this.logsDir, "caddy.log");
    this.caddyAccessLogPath = path.join(this.logsDir, "caddy-access.log");
    this.frpcLogPath = path.join(this.logsDir, "frpc.log");
    this.auditLogPath = path.join(this.rootDir, "audit.log");
    this.logWriters = new Map();
  }

  async initialize() {
    await fsp.mkdir(this.rootDir, { recursive: true });
    await fsp.mkdir(this.logsDir, { recursive: true });
    await fsp.mkdir(this.caddyStorageDir, { recursive: true });
    if (!fs.existsSync(this.stateFile)) {
      const initial = normalizeState({ ...DEFAULT_STATE });
      this.saveState(initial);
    }
    if (!fs.existsSync(this.runtimeFile)) {
      writeJsonAtomicSync(this.runtimeFile, { ...DEFAULT_RUNTIME, updatedAt: new Date().toISOString() });
    }
    for (const filePath of [this.caddyLogPath, this.frpcLogPath, this.auditLogPath]) {
      if (!fs.existsSync(filePath)) await fsp.writeFile(filePath, "", { encoding: "utf8", mode: 0o600 });
    }
  }

  readState() {
    const recovery = readJsonWithRecoverySync(this.stateFile, {
      backupPaths: [`${this.stateFile}.previous`],
      validate(raw) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid gateway state");
      },
      onRecover: ({ backupPath }) => {
        this.appendAuditSync("state.recovered", "success", {
          recoveredFrom: path.basename(backupPath),
        });
      },
    });
    return normalizeState(recovery.value || DEFAULT_STATE);
  }

  saveState(state) {
    const normalized = normalizeState(state);
    validateStateForWrite(normalized);
    return writeJsonAtomicSync(this.stateFile, normalized, {
      backupPaths: [`${this.stateFile}.previous`],
      validate: validateStateForWrite,
    });
  }

  readRuntime() {
    try {
      return mergeRuntime(JSON.parse(fs.readFileSync(this.runtimeFile, "utf8")));
    } catch {
      return mergeRuntime({});
    }
  }

  saveRuntime(patch) {
    const current = this.readRuntime();
    const next = mergeRuntime({
      ...current,
      ...(patch || {}),
      caddy: { ...current.caddy, ...(patch?.caddy || {}) },
      frpc: { ...current.frpc, ...(patch?.frpc || {}) },
      scheduler: { ...current.scheduler, ...(patch?.scheduler || {}) },
      source: { ...current.source, ...(patch?.source || {}) },
      updatedAt: new Date().toISOString(),
    });
    writeJsonAtomicSync(this.runtimeFile, next, {
      backupPaths: [`${this.runtimeFile}.previous`],
    });
    return next;
  }

  readCaddyfile() {
    try { return fs.readFileSync(this.caddyfilePath, "utf8"); }
    catch { return ""; }
  }

  writeCaddyfile(contents) {
    return writeTextAtomicSync(this.caddyfilePath, contents, {
      backupPaths: [`${this.caddyfilePath}.previous`],
    });
  }

  readFrpcConfig() {
    try { return fs.readFileSync(this.frpcConfigPath, "utf8"); }
    catch { return ""; }
  }

  writeFrpcConfig(contents) {
    return writeTextAtomicSync(this.frpcConfigPath, contents, {
      backupPaths: [`${this.frpcConfigPath}.previous`],
    });
  }

  appendOneLine(filePath, line, { redact = true } = {}) {
    if (!this.logWriters.has(filePath)) this.logWriters.set(filePath, new RotatingLogWriter(filePath));
    const text = redact ? redactSensitive(String(line)) : String(line);
    return this.logWriters.get(filePath).write(`${text}\n`);
  }

  appendAudit(action, outcome, detail = {}) {
    const entry = {
      ts: new Date().toISOString(),
      action: String(action || "unknown"),
      outcome: String(outcome || "info"),
      detail: redactSensitive(detail),
    };
    return this.appendOneLine(this.auditLogPath, JSON.stringify(entry), { redact: false });
  }

  appendAuditSync(action, outcome, detail = {}) {
    const entry = {
      ts: new Date().toISOString(),
      action: String(action || "unknown"),
      outcome: String(outcome || "info"),
      detail: redactSensitive(detail),
    };
    fs.appendFileSync(this.auditLogPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  appendCaddyLog(text) {
    return this.appendOneLine(this.caddyLogPath, text);
  }

  appendFrpcLog(text) {
    return this.appendOneLine(this.frpcLogPath, text);
  }

  async readLogs(lineLimit = 200) {
    const [audit, caddy, frpc] = await Promise.all([
      readLogTail(this.auditLogPath, lineLimit),
      readLogTail(this.caddyLogPath, lineLimit),
      readLogTail(this.frpcLogPath, lineLimit),
    ]);
    return { audit, caddy, frpc };
  }

  async close() {
    await Promise.all([...this.logWriters.values()].map((writer) => writer.end()));
    this.logWriters.clear();
  }
}

module.exports = {
  DEFAULT_RUNTIME,
  GatewayStore,
  mergeRuntime,
  writeTextAtomicSync,
};
