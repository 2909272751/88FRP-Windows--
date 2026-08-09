const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
const DEFAULT_LOG_BACKUPS = 2;
const DEFAULT_TAIL_READ_BYTES = 2 * 1024 * 1024;

async function removeIfPresent(filePath) {
  try {
    await fsp.rm(filePath, { force: true });
  } catch {
    // Log maintenance must never stop the managed service.
  }
}

async function rotateLogFile(filePath, options = {}) {
  const maxBytes = Number(options.maxBytes || DEFAULT_MAX_LOG_BYTES);
  const backups = Math.max(1, Number(options.backups || DEFAULT_LOG_BACKUPS));
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return false;
  }
  if (!options.force && stat.size < maxBytes) return false;

  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  for (let index = backups; index >= 1; index -= 1) {
    const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
    const target = `${filePath}.${index}`;
    await removeIfPresent(target);
    try {
      await fsp.rename(source, target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return true;
}

class RotatingLogWriter {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.maxBytes = Number(options.maxBytes || DEFAULT_MAX_LOG_BYTES);
    this.backups = Math.max(1, Number(options.backups || DEFAULT_LOG_BACKUPS));
    this.currentBytes = null;
    this.queue = Promise.resolve();
  }

  write(value) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    this.queue = this.queue
      .then(() => this.writeBuffer(buffer))
      .catch(() => undefined);
    return this.queue;
  }

  async writeBuffer(buffer) {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    if (this.currentBytes === null) {
      try {
        this.currentBytes = (await fsp.stat(this.filePath)).size;
      } catch {
        this.currentBytes = 0;
      }
    }
    if (this.currentBytes > 0 && this.currentBytes + buffer.length > this.maxBytes) {
      await rotateLogFile(this.filePath, { maxBytes: this.maxBytes, backups: this.backups, force: true });
      this.currentBytes = 0;
    }
    await fsp.appendFile(this.filePath, buffer);
    this.currentBytes += buffer.length;
  }

  end() {
    return this.queue;
  }
}

async function readLogTail(filePath, lineLimit = 200, options = {}) {
  const limit = Math.max(1, Number(lineLimit) || 200);
  const maxReadBytes = Math.max(64 * 1024, Number(options.maxReadBytes || DEFAULT_TAIL_READ_BYTES));
  const chunkSize = 64 * 1024;
  let handle;
  try {
    handle = await fsp.open(filePath, "r");
    const stat = await handle.stat();
    let position = stat.size;
    let bytesReadTotal = 0;
    let newlineCount = 0;
    const chunks = [];

    while (position > 0 && bytesReadTotal < maxReadBytes && newlineCount <= limit) {
      const readLength = Math.min(chunkSize, position, maxReadBytes - bytesReadTotal);
      position -= readLength;
      const buffer = Buffer.allocUnsafe(readLength);
      const { bytesRead } = await handle.read(buffer, 0, readLength, position);
      const chunk = buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      bytesReadTotal += bytesRead;
      for (const byte of chunk) {
        if (byte === 0x0a) newlineCount += 1;
      }
    }

    return Buffer.concat(chunks)
      .toString("utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .join("\n");
  } catch {
    return "";
  } finally {
    if (handle) await handle.close();
  }
}

module.exports = {
  DEFAULT_LOG_BACKUPS,
  DEFAULT_MAX_LOG_BYTES,
  RotatingLogWriter,
  readLogTail,
  rotateLogFile,
};
