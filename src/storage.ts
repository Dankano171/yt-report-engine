import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { CommentRecord, UsageRecord } from "./types.js";

export async function cacheComments(
  channel: string,
  comments: CommentRecord[],
  root = "cache",
  now = new Date(),
): Promise<void> {
  await purgeOldCache(root, now);
  await mkdir(root, { recursive: true });
  const day = now.toISOString().slice(0, 10);
  const safeChannel = channel.replace(/[^A-Za-z0-9._-]/g, "_");
  await writeFile(
    join(root, `${day}-${safeChannel}.json`),
    JSON.stringify({ cachedAt: now.toISOString(), comments }),
  );
}

export async function purgeOldCache(
  root = "cache",
  now = new Date(),
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let deleted = 0;
  const expiry = now.getTime() - 30 * 86_400_000;
  for (const entry of entries) {
    const path = join(root, entry);
    const info = await stat(path);
    if (info.isFile() && info.mtimeMs < expiry) {
      await unlink(path);
      deleted += 1;
    }
  }
  return deleted;
}

export async function purgeOldDebugDumps(
  root = "output",
  now = new Date(),
): Promise<number> {
  let channels: string[];
  try {
    channels = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const expiry = now.getTime() - 30 * 86_400_000;
  let deleted = 0;
  for (const channel of channels) {
    const channelPath = join(root, channel);
    if (!(await stat(channelPath)).isDirectory()) continue;
    const dates = await readdir(channelPath);
    for (const date of dates) {
      const debugPath = join(channelPath, date, "debug");
      let entries: string[];
      try {
        entries = await readdir(debugPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        if (!/^batch-\d+-(?:prompt|response)\.txt$/.test(entry)) continue;
        const path = join(debugPath, entry);
        const info = await stat(path);
        if (info.isFile() && info.mtimeMs < expiry) {
          await unlink(path);
          deleted += 1;
        }
      }
    }
  }
  return deleted;
}

export async function readUsage(
  path = "usage_logs/usage.jsonl",
): Promise<UsageRecord[]> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: UsageRecord[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as UsageRecord;
      if (typeof value.date === "string") rows.push(value);
    } catch {
      // Ignore an incomplete final record after an interrupted write.
    }
  }
  return rows;
}

export async function appendUsage(
  record: UsageRecord,
  path = "usage_logs/usage.jsonl",
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}
