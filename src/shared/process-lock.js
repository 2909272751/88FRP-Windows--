const fs = require("fs");
const path = require("path");

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function createAlreadyRunningError(lockPath, pid) {
  const error = new Error(`88frp web backend is already running${pid ? ` (PID ${pid})` : ""}.`);
  error.code = "EALREADYRUNNING";
  error.lockPath = lockPath;
  error.pid = pid || null;
  return error;
}

function acquireProcessLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let descriptor = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = fs.openSync(lockPath, "wx");
      fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      let ownerPid = 0;
      let ageMs = 0;
      try {
        ownerPid = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10) || 0;
        ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        ageMs = 0;
      }

      if (isProcessRunning(ownerPid) || (!ownerPid && ageMs < 5000)) {
        throw createAlreadyRunningError(lockPath, ownerPid);
      }

      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError.code !== "ENOENT") {
          throw createAlreadyRunningError(lockPath, ownerPid);
        }
      }
    }
  }

  if (descriptor === null) {
    throw createAlreadyRunningError(lockPath, 0);
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener("exit", release);
    try {
      fs.closeSync(descriptor);
    } catch {
      // The descriptor may already be closed during process shutdown.
    }
    try {
      const ownerPid = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
      if (ownerPid === process.pid) fs.unlinkSync(lockPath);
    } catch {
      // A missing or replaced lock must not prevent shutdown.
    }
  };

  process.once("exit", release);
  return {
    lockPath,
    release,
  };
}

module.exports = {
  acquireProcessLock,
  isProcessRunning,
};
