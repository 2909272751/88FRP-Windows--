"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseJsonText(contents) {
  const text = String(contents || "").replace(/^\uFEFF/, "");
  if (!text.trim()) throw new Error("JSON 文件为空");
  return JSON.parse(text);
}

function fsyncDirectorySync(directory) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Windows does not consistently allow directory handles. The file itself
    // is still flushed before rename, which is the important durability step.
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* Best effort. */ }
    }
  }
}

function writeDurableTextSync(filePath, contents, { mode = 0o600 } = {}) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    if (fs.readFileSync(temporary, "utf8") !== contents) throw new Error("JSON 临时文件校验失败");
    return temporary;
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* Best effort. */ }
    }
    try { fs.rmSync(temporary, { force: true }); } catch { /* Best effort. */ }
    throw error;
  }
}

function replaceFileSync(temporary, filePath) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temporary, filePath);
      break;
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 9) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  fsyncDirectorySync(path.dirname(filePath));
}

function writeJsonAtomicSync(filePath, value, { mode = 0o600, backupPaths = [], validate = null } = {}) {
  const contents = serializeJson(value);
  if (validate) validate(value);

  let existingText = null;
  try { existingText = fs.readFileSync(filePath, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existingText === contents) return { changed: false, value };

  let existingValue = null;
  if (existingText !== null && backupPaths.length) {
    try {
      existingValue = parseJsonText(existingText);
      if (validate) validate(existingValue);
    } catch {
      existingValue = null;
    }
  }
  if (existingValue !== null) {
    for (const backupPath of backupPaths) {
      writeJsonAtomicSync(backupPath, existingValue, { mode, validate });
    }
  }

  const temporary = writeDurableTextSync(filePath, contents, { mode });
  try {
    replaceFileSync(temporary, filePath);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* Best effort. */ }
  }
  return { changed: true, value };
}

function archiveInvalidFileSync(filePath) {
  if (!fs.existsSync(filePath)) return "";
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  let archive = `${filePath}.corrupt-${stamp}`;
  for (let suffix = 1; fs.existsSync(archive); suffix += 1) archive = `${filePath}.corrupt-${stamp}-${suffix}`;
  try {
    const contents = fs.readFileSync(filePath);
    fs.writeFileSync(archive, contents, { flag: "wx", mode: 0o600 });
    return archive;
  } catch {
    return "";
  }
}

function readJsonWithRecoverySync(filePath, {
  mode = 0o600,
  backupPaths = [],
  validate = null,
  onRecover = null,
} = {}) {
  let primaryError = null;
  try {
    const value = parseJsonText(fs.readFileSync(filePath, "utf8"));
    if (validate) validate(value);
    return { exists: true, value, recovered: false, recoveredFrom: "", archivePath: "" };
  } catch (error) {
    primaryError = error;
  }

  for (const backupPath of backupPaths) {
    try {
      const value = parseJsonText(fs.readFileSync(backupPath, "utf8"));
      if (validate) validate(value);
      const archivePath = archiveInvalidFileSync(filePath);
      writeJsonAtomicSync(filePath, value, { mode, validate });
      if (onRecover) onRecover({ filePath, backupPath, archivePath, error: primaryError });
      return { exists: true, value, recovered: true, recoveredFrom: backupPath, archivePath };
    } catch { /* Try the next last-known-good copy. */ }
  }

  if (primaryError.code === "ENOENT") {
    return { exists: false, value: null, recovered: false, recoveredFrom: "", archivePath: "" };
  }

  const error = new Error("域名配置无法读取，自动恢复也失败。请从备份恢复后再继续。");
  error.cause = primaryError;
  throw error;
}

module.exports = {
  parseJsonText,
  readJsonWithRecoverySync,
  serializeJson,
  writeJsonAtomicSync,
};
