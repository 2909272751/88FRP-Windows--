const fs = require("fs");
const path = require("path");

function stripWrappingQuotes(value) {
  if (!value) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }

  return value;
}

function parseEnvText(content) {
  const result = {};
  const lines = String(content || "").split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalizedLine = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalizedLine.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    const value = stripWrappingQuotes(normalizedLine.slice(separatorIndex + 1).trim());
    result[key] = value;
  }

  return result;
}

function resolveEnvFilePath(argv = process.argv.slice(2), cwd = process.cwd()) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--env-file" && argv[index + 1]) {
      return path.resolve(cwd, argv[index + 1]);
    }
  }

  return null;
}

function getCleanArgv(argv = process.argv.slice(2)) {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--env-file") {
      index += 1;
      continue;
    }
    result.push(argv[index]);
  }
  return result;
}

function loadEnvFile(envFilePath, { override = true } = {}) {
  const raw = fs.readFileSync(envFilePath, "utf8");
  const parsed = parseEnvText(raw);

  for (const [key, value] of Object.entries(parsed)) {
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return parsed;
}

function preloadEnvFromArgv(options = {}) {
  const envFilePath = resolveEnvFilePath(options.argv, options.cwd);
  if (!envFilePath) {
    return null;
  }

  loadEnvFile(envFilePath, { override: options.override !== false });
  return envFilePath;
}

module.exports = {
  getCleanArgv,
  loadEnvFile,
  parseEnvText,
  preloadEnvFromArgv,
  resolveEnvFilePath,
};
