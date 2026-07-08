#!/usr/bin/env node
const fs = require("fs/promises");
const path = require("path");
const { execFileSync } = require("child_process");
const { build } = require("esbuild");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SEA_DIR = path.join(PROJECT_ROOT, ".sea");
const SEA_CACHE_DIR = path.join(SEA_DIR, "cache");
const DIST_DIR = path.join(PROJECT_ROOT, "dist");
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const POSTJECT_CLI_PATH = require.resolve("postject/dist/cli.js");
const NODE_VERSION = process.version;

const TARGETS = {
  "win32-x64": {
    platform: "win32",
    arch: "x64",
    archDir: "amd64",
    nodeDistArch: "x64",
    outputFileName: "88frp-web.exe",
  },
  "linux-x64": {
    platform: "linux",
    arch: "x64",
    archDir: "amd64",
    nodeDistArch: "x64",
    outputFileName: "88frp-web-linux-amd64",
  },
  "linux-arm64": {
    platform: "linux",
    arch: "arm64",
    archDir: "arm64",
    nodeDistArch: "arm64",
    outputFileName: "88frp-web-linux-arm64",
  },
};

function toPosixPath(filePath) {
  return filePath.split(path.sep).join(path.posix.sep);
}

async function listFilesRecursively(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const items = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      items.push(...(await listFilesRecursively(fullPath)));
      continue;
    }
    items.push(fullPath);
  }

  return items;
}

function getTargetKey(target) {
  return `${target.platform}-${target.arch}`;
}

function parseArgs(argv) {
  let targetArg = "win32-x64";

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--target" && argv[index + 1]) {
      targetArg = argv[index + 1];
      index += 1;
    }
  }

  const targetKeys = targetArg === "all"
    ? Object.keys(TARGETS)
    : targetArg.split(",").map((value) => value.trim()).filter(Boolean);

  if (!targetKeys.length) {
    throw new Error("至少需要一个构建目标。");
  }

  return targetKeys.map((targetKey) => {
    const target = TARGETS[targetKey];
    if (!target) {
      throw new Error(`不支持的构建目标：${targetKey}`);
    }
    return target;
  });
}

function getTargetWorkDir(target) {
  return path.join(SEA_DIR, getTargetKey(target));
}

function getTargetBundlePath(target) {
  return path.join(getTargetWorkDir(target), "web.bundle.cjs");
}

function getTargetBlobPath(target) {
  return path.join(getTargetWorkDir(target), "web.blob");
}

function getTargetSeaConfigPath(target) {
  return path.join(getTargetWorkDir(target), "sea-config.web.json");
}

function getTargetManifestPath(target) {
  return path.join(getTargetWorkDir(target), "sea-assets.json");
}

function getTargetOutputPath(target) {
  return path.join(DIST_DIR, target.outputFileName);
}

function getFrpcFileName(target) {
  return target.platform === "win32" ? "88frpc.exe" : "88frpc";
}

function getFrpcSourcePath(target) {
  return path.join(PROJECT_ROOT, "bin", target.archDir, getFrpcFileName(target));
}

async function buildSeaAssets(target) {
  const publicRoot = path.join(PROJECT_ROOT, "src", "web", "public");
  const publicFiles = await listFilesRecursively(publicRoot);
  const assets = {};
  const publicAssets = [];

  for (const filePath of publicFiles) {
    const relativePath = path.relative(publicRoot, filePath);
    const assetKey = path.posix.join("public", toPosixPath(relativePath));
    assets[assetKey] = filePath;
    publicAssets.push({
      assetKey,
      relativePath: toPosixPath(relativePath),
    });
  }

  const frpcPath = getFrpcSourcePath(target);
  await fs.access(frpcPath);
  const frpcAssetKey = `bin/${target.archDir}/${getFrpcFileName(target)}`;
  assets[frpcAssetKey] = frpcPath;

  const manifest = {
    frpcAssetKey,
    publicAssets,
  };
  const manifestPath = getTargetManifestPath(target);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  assets["meta/sea-assets.json"] = manifestPath;

  return assets;
}

function runCommand(command, args) {
  execFileSync(command, args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
}

async function downloadFile(url, filePath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载失败：${url}，状态码=${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
}

async function ensureDownloadedNodeBinary(target) {
  if (target.platform === process.platform && target.arch === process.arch) {
    return process.execPath;
  }

  const archiveBaseName = `node-${NODE_VERSION}-${target.platform}-${target.nodeDistArch}.tar.xz`;
  const archiveUrl = `https://nodejs.org/dist/${NODE_VERSION}/${archiveBaseName}`;
  const archivePath = path.join(SEA_CACHE_DIR, archiveBaseName);
  const extractedRoot = path.join(SEA_CACHE_DIR, `node-${NODE_VERSION}-${target.platform}-${target.nodeDistArch}`);
  const archiveEntryPath = `node-${NODE_VERSION}-${target.platform}-${target.nodeDistArch}/bin/node`;
  const extractedNodePath = path.join(extractedRoot, archiveEntryPath);

  try {
    await fs.access(extractedNodePath);
    return extractedNodePath;
  } catch {
    // Continue with download/extract.
  }

  try {
    await fs.access(archivePath);
  } catch {
    await downloadFile(archiveUrl, archivePath);
  }

  await fs.rm(extractedRoot, { recursive: true, force: true });
  await fs.mkdir(extractedRoot, { recursive: true });
  runCommand("tar", ["-xf", archivePath, "-C", extractedRoot, archiveEntryPath]);
  await fs.access(extractedNodePath);
  return extractedNodePath;
}

async function buildTarget(target) {
  const targetWorkDir = getTargetWorkDir(target);
  const targetBundlePath = getTargetBundlePath(target);
  const targetBlobPath = getTargetBlobPath(target);
  const targetSeaConfigPath = getTargetSeaConfigPath(target);
  const targetOutputPath = getTargetOutputPath(target);

  await fs.rm(targetWorkDir, { recursive: true, force: true });
  await fs.mkdir(targetWorkDir, { recursive: true });

  await build({
    entryPoints: [path.join(PROJECT_ROOT, "src", "web", "server.js")],
    bundle: true,
    format: "cjs",
    outfile: targetBundlePath,
    platform: "node",
    target: "node22",
  });

  const seaConfig = {
    main: targetBundlePath,
    output: targetBlobPath,
    disableExperimentalSEAWarning: true,
    assets: await buildSeaAssets(target),
  };
  await fs.writeFile(targetSeaConfigPath, JSON.stringify(seaConfig, null, 2), "utf8");

  runCommand(process.execPath, ["--experimental-sea-config", targetSeaConfigPath]);
  const baseBinaryPath = await ensureDownloadedNodeBinary(target);
  await fs.copyFile(baseBinaryPath, targetOutputPath);

  runCommand(process.execPath, [
    POSTJECT_CLI_PATH,
    targetOutputPath,
    "NODE_SEA_BLOB",
    targetBlobPath,
    "--sentinel-fuse",
    SEA_FUSE,
  ]);

  if (target.platform !== "win32") {
    await fs.chmod(targetOutputPath, 0o755);
  }

  console.log(`单文件构建完成：${targetOutputPath}`);
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("当前构建机需为 Windows amd64。");
  }

  const targets = parseArgs(process.argv.slice(2));

  await fs.mkdir(SEA_DIR, { recursive: true });
  await fs.mkdir(SEA_CACHE_DIR, { recursive: true });
  await fs.mkdir(DIST_DIR, { recursive: true });

  for (const target of targets) {
    await buildTarget(target);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
