const test = require("node:test");
const assert = require("node:assert/strict");

const { areSamePath, isPidAlive } = require("../src/shared/process-utils");

test("Windows 可执行文件路径比较不区分大小写", () => {
  assert.equal(areSamePath("C:\\Apps\\88FRP.exe", "c:\\apps\\88frp.EXE", "win32"), true);
});

test("Windows EPERM 表示进程存在但当前权限不足", () => {
  const signalProcess = () => {
    const error = new Error("operation not permitted");
    error.code = "EPERM";
    throw error;
  };

  assert.equal(isPidAlive(1234, signalProcess), true);
});

test("ESRCH 表示进程已经退出", () => {
  const signalProcess = () => {
    const error = new Error("no such process");
    error.code = "ESRCH";
    throw error;
  };

  assert.equal(isPidAlive(1234, signalProcess), false);
});
