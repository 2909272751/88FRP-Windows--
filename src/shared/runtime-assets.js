const fsp = require("fs/promises");
const path = require("path");

const {
  getArchDir,
  getDefaultFrpcBinaryName,
  getDefaultFrpcBinaryPath,
  getPublicDir,
  getSeaModule,
  isSeaRuntime,
} = require("./runtime-env");

let preparedPromise = null;
const ASSET_MANIFEST_KEY = "meta/sea-assets.json";

function toBuffer(asset) {
  if (Buffer.isBuffer(asset)) {
    return asset;
  }
  return Buffer.from(asset);
}

function getAssetBuffer(assetKey) {
  const sea = getSeaModule();
  if (!sea || typeof sea.getAsset !== "function") {
    throw new Error("当前环境不支持读取 SEA 资源。");
  }

  return toBuffer(sea.getAsset(assetKey));
}

function getAssetManifest() {
  if (!isSeaRuntime()) {
    return null;
  }

  const sea = getSeaModule();
  if (!sea || typeof sea.getAsset !== "function") {
    throw new Error("当前环境不支持读取 SEA 资源清单。");
  }

  try {
    return JSON.parse(sea.getAsset(ASSET_MANIFEST_KEY, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 SEA 资源清单：${error.message}`);
  }
}

async function writeFileIfChanged(filePath, content) {
  try {
    const existing = await fsp.readFile(filePath);
    if (existing.equals(content)) {
      return false;
    }
  } catch {
    // Ignore file read failures and rewrite below.
  }

  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content);
  return true;
}

async function ensureExecutableFileMode(filePath) {
  if (process.platform === "win32") {
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    const nextMode = stat.mode | 0o111;
    if (nextMode !== stat.mode) {
      await fsp.chmod(filePath, nextMode);
    }
  } catch {
    // Ignore chmod failures here; startup checks will surface missing execute access.
  }
}

async function extractSeaAssets() {
  if (!isSeaRuntime()) {
    return {
      frpcBinaryPath: getDefaultFrpcBinaryPath(),
      publicDir: getPublicDir(),
    };
  }

  const publicDir = getPublicDir();
  const frpcBinaryPath = getDefaultFrpcBinaryPath();
  const frpcAssetKey = path.posix.join("bin", getArchDir(), getDefaultFrpcBinaryName());
  const manifest = getAssetManifest();

  if (!manifest || !Array.isArray(manifest.publicAssets) || !manifest.publicAssets.length) {
    throw new Error("SEA 包缺少 Web 静态资源，无法启动单文件 Web 程序。");
  }

  if (manifest.frpcAssetKey !== frpcAssetKey) {
    throw new Error(`SEA 包缺少 frpc 资源：${frpcAssetKey}`);
  }

  for (const asset of manifest.publicAssets) {
    await writeFileIfChanged(path.join(publicDir, asset.relativePath), getAssetBuffer(asset.assetKey));
  }

  await writeFileIfChanged(frpcBinaryPath, getAssetBuffer(frpcAssetKey));
  await ensureExecutableFileMode(frpcBinaryPath);
  return {
    frpcBinaryPath,
    publicDir,
  };
}

async function prepareRuntimeAssets() {
  if (!preparedPromise) {
    preparedPromise = extractSeaAssets();
  }
  return preparedPromise;
}

module.exports = {
  ensureExecutableFileMode,
  prepareRuntimeAssets,
};
