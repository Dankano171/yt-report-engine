import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChannelConfig } from "./types.js";

export interface ChannelFileIssue {
  line: number;
  reason: string;
}

export interface ParsedChannelFile {
  channels: ChannelConfig[];
  issues: ChannelFileIssue[];
}

const exampleFile = [
  "# One channel per line:",
  "# @handle | Creator name | what they sell | recipient email(optional) | purchase link(optional)",
  "# @examplecreator | Example Creator | A gardening course | creator@example.com | https://example.com/course",
  "",
].join("\n");

function normalizedHandle(handle: string): string {
  return handle.replace(/^@/u, "").toLowerCase();
}

function validEmail(value: string): boolean {
  return /^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/u.test(value);
}

function validPurchaseLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function parseChannelFile(contents: string): ParsedChannelFile {
  const channels: ChannelConfig[] = [];
  const issues: ChannelFileIssue[] = [];
  const seen = new Set<string>();

  for (const [index, rawLine] of contents.split(/\r?\n/u).entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split("|").map((field) => field.trim());
    const [handle, creatorName, offerDescription, recipient = "", link = ""] =
      fields;
    if (
      fields.length < 3 ||
      fields.length > 5 ||
      !handle ||
      !/^@[A-Za-z0-9._-]{1,63}$/u.test(handle) ||
      !creatorName ||
      !offerDescription ||
      (recipient !== "" && !validEmail(recipient)) ||
      (link !== "" && !validPurchaseLink(link))
    ) {
      issues.push({ line: lineNumber, reason: "invalid channel line" });
      continue;
    }

    const normalized = normalizedHandle(handle);
    if (seen.has(normalized)) {
      issues.push({ line: lineNumber, reason: "duplicate channel handle" });
      continue;
    }
    seen.add(normalized);
    channels.push({
      handle: `@${normalized}`,
      creatorName,
      creatorGoal: "grow_audience",
      recipients: recipient ? [recipient] : [],
      productKeywords: [],
      enabled: true,
      offerDescription,
      ...(link ? { purchaseLink: link } : {}),
    });
  }

  return { channels, issues };
}

export async function readChannelFile(
  path = "data/channels.txt",
  onIssue: (issue: ChannelFileIssue) => void = (issue) => {
    console.error(`channels.txt line ${issue.line}: ${issue.reason}; skipped.`);
  },
): Promise<ChannelConfig[]> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, exampleFile, { encoding: "utf8", mode: 0o600 });
    return [];
  }
  const parsed = parseChannelFile(contents);
  parsed.issues.forEach(onIssue);
  return parsed.channels;
}

export async function readSkipFile(
  path = "data/skip.txt",
): Promise<Set<string>> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
  const skipped = new Set<string>();
  for (const rawLine of contents.split(/\r?\n/u)) {
    const handle = rawLine.trim();
    if (!handle || handle.startsWith("#")) continue;
    skipped.add(normalizedHandle(handle));
  }
  return skipped;
}

export function alertChannelKey(channel: ChannelConfig): string {
  return normalizedHandle(channel.handle ?? channel.channelId ?? "");
}
