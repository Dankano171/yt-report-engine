import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ignored = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "output",
  "cache",
  "usage_logs",
]);
const keyPatterns = [
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bre_[A-Za-z0-9_-]{20,}\b/g,
];
const placeholder =
  /replace_with_|your[_-].*(key|token)|example|dummy|placeholder/i;
const findings = [];

function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name)) inspect(join(directory, entry.name));
      continue;
    }
    if (
      entry.name === ".env" ||
      (entry.name.startsWith(".env.") && entry.name !== ".env.example")
    )
      continue;
    if (!entry.isFile()) continue;
    const path = join(directory, entry.name);
    if (statSync(path).size > 1_000_000) continue;
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const pattern of keyPatterns) {
      for (const match of text.matchAll(pattern)) {
        if (!placeholder.test(match[0])) findings.push(path);
      }
    }
  }
}

inspect(".");
if (findings.length) {
  console.error(
    `Potential API key pattern found in: ${[...new Set(findings)].join(", ")}`,
  );
  process.exitCode = 1;
} else {
  console.log("No API key patterns found.");
}
