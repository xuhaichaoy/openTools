#!/usr/bin/env node

function parseVersion(raw) {
  return raw
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersion(a, b) {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

function isSupportedNode(version) {
  const parsed = parseVersion(version);
  const minV20 = [20, 19, 0];
  const minV22 = [22, 12, 0];

  return (
    (parsed[0] === 20 && compareVersion(parsed, minV20) >= 0) ||
    compareVersion(parsed, minV22) >= 0
  );
}

if (!isSupportedNode(process.version)) {
  console.error("");
  console.error("Unsupported Node.js version for 51ToolBox.");
  console.error(`Current: ${process.version}`);
  console.error("Required: ^20.19.0 || >=22.12.0");
  console.error("Recommended: nvm use 20.19.6");
  console.error("");
  process.exit(1);
}
