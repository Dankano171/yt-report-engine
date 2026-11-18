import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  alertChannelKey,
  readChannelFile,
  readSkipFile,
} from "./alert-channels.js";
import { createAlertBudget } from "./alert-budget.js";
import {
  confirmAlertDraftSent,
  createAlertDraft,
  type AlertDraftOptions,
  type AlertDraftFiles,
} from "./alert-drafts.js";
import { fetchAlertCandidates, type BuyerAlertCandidate } from "./alerts.js";
import { AlertStateStore, DEFAULT_ALERT_DB_PATH } from "./alert-state.js";
import { AlertBudgetExceededError, redactSecrets } from "./errors.js";
import {
  analyzeComments,
  clusterComments,
  type WritingCluster,
} from "./llm.js";
import { appendUsage } from "./storage.js";
import type {
  AppConfig,
  ChannelConfig,
  CommentRecord,
  Fetcher,
} from "./types.js";

type ChannelRunStatus = "drafted" | "nothing" | "skipped: budget" | "failed";

interface DailyChannelResult {
  handle: string;
  name: string;
  recipient: string;
  status: ChannelRunStatus;
  newCount: number;
  reminderCount: number;
  items: NonNullable<AlertDraftFiles["items"]>;
}

export interface DailyAlertResult {
  date: string;
  autoConfirmed: number;
  channels: DailyChannelResult[];
  dashboardPath: string;
  allFailed: boolean;
}

export interface AlertBatchOptions {
  config: AppConfig;
  now?: Date;
  dbPath?: string;
  channelsPath?: string;
  outputRoot?: string;
  skipPath?: string;
  usagePath?: string;
  fetcher?: Fetcher;
  wait?: (milliseconds: number) => Promise<void>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  createDraft?: (
    options: AlertDraftOptions,
  ) => Promise<AlertDraftFiles | { status: "nothing" }>;
}

function stamp(now: Date): string {
  if (!Number.isFinite(now.getTime()))
    throw new Error("Invalid alert run time.");
  return now.toISOString().slice(0, 10);
}

function safeFileHandle(channel: ChannelConfig): string {
  const handle = channel.handle ?? channel.channelId ?? "";
  const fileHandle = handle.replace(/[^A-Za-z0-9@._-]/gu, "_");
  if (!fileHandle) throw new Error("Channel handle is required.");
  return fileHandle;
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function escaped(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function dashboardHtml(date: string, channels: DailyChannelResult[]): string {
  const content = channels
    .map((channel) => {
      const comments = channel.items
        .map(
          (item) => `<article class="comment">
  <p class="viewer-comment">${escaped(item.text)}</p>
  <p><strong>Video:</strong> ${escaped(item.videoTitle)}</p>
  <p><strong>Link:</strong> <a href="${escaped(item.link)}">${escaped(item.link)}</a></p>
  ${item.firstNotifiedAt !== undefined ? `<p class="first-sent">First sent ${escaped(item.firstNotifiedAt?.slice(0, 10) ?? "unknown date")} — reminder</p>` : ""}
  <p><strong>Suggested reply:</strong> <span class="reply">${escaped(item.suggestedReply)}</span>
    <button type="button" class="copy" data-reply="${escaped(item.suggestedReply)}">Copy</button>
  </p>
</article>`,
        )
        .join("\n");
      return `<section>
  <h2>${escaped(channel.name)} <span class="handle">${escaped(channel.handle)}</span></h2>
  <p><strong>Recipient:</strong> ${escaped(channel.recipient || "Not specified")}</p>
  <p><strong>Status:</strong> ${escaped(channel.status)} (${channel.newCount} new, ${channel.reminderCount} reminders)</p>
  ${comments || "<p>No qualifying comments.</p>"}
</section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Buyer alerts — ${escaped(date)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#1f2937}
section{border:1px solid #d1d5db;border-radius:8px;padding:1rem;margin:1rem 0}
.comment{border-top:1px solid #e5e7eb;padding:.75rem 0}.viewer-comment{white-space:pre-wrap}
.first-sent{color:#92400e}.handle{font-size:.8em;color:#6b7280}button{margin-left:.5rem}
</style>
</head>
<body>
<h1>Buyer alerts — ${escaped(date)}</h1>
${content}
<script>
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button.copy");
  if (button) await navigator.clipboard.writeText(button.dataset.reply || "");
});
</script>
</body>
</html>
`;
}

interface PendingSidecar {
  channelHandle?: unknown;
  date?: unknown;
}

async function olderPendingPaths(
  outputRoot: string,
  date: string,
  channels: ChannelConfig[],
): Promise<Map<string, string[]>> {
  const eligible = new Set(channels.map(alertChannelKey));
  const result = new Map<string, string[]>();
  let directories: string[];
  try {
    directories = await readdir(outputRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  for (const directory of directories.sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(directory) || directory >= date) continue;
    const folder = join(outputRoot, directory);
    const names = await readdir(folder, { withFileTypes: true });
    for (const entry of names) {
      if (!entry.isFile() || !entry.name.endsWith(".pending.json")) continue;
      const path = join(folder, entry.name);
      let pending: PendingSidecar;
      try {
        pending = JSON.parse(await readFile(path, "utf8")) as PendingSidecar;
      } catch {
        continue;
      }
      if (
        typeof pending.channelHandle !== "string" ||
        typeof pending.date !== "string" ||
        pending.date >= date
      )
        continue;
      const key = pending.channelHandle.replace(/^@/u, "").toLowerCase();
      if (!eligible.has(key)) continue;
      result.set(key, [...(result.get(key) ?? []), path]);
    }
  }
  return result;
}

export async function runDailyAlerts(
  options: AlertBatchOptions,
): Promise<DailyAlertResult> {
  const now = options.now ?? new Date();
  const date = stamp(now);
  const outputRoot = options.outputRoot ?? "output";
  const dbPath = options.dbPath ?? DEFAULT_ALERT_DB_PATH;
  const channels = await readChannelFile(options.channelsPath);
  const skipped = await readSkipFile(options.skipPath);
  const oldPending = await olderPendingPaths(outputRoot, date, channels);
  let autoConfirmed = 0;
  for (const channel of channels) {
    const key = alertChannelKey(channel);
    if (skipped.has(key)) continue;
    for (const pendingPath of oldPending.get(key) ?? []) {
      try {
        await confirmAlertDraftSent({
          channel,
          dbPath,
          now,
          pendingPath,
        });
        autoConfirmed += 1;
      } catch (error) {
        options.warn?.(
          `Could not auto-confirm an older draft for ${channel.handle}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
        );
      }
    }
  }
  options.log?.(`Auto-confirmed ${autoConfirmed} older pending draft(s).`);

  const outputDirectory = join(outputRoot, date);
  const budget = await createAlertBudget({
    config: options.config,
    now,
    ...(options.usagePath ? { usagePath: options.usagePath } : {}),
  });
  const channelsResult: DailyChannelResult[] = [];
  const wait =
    options.wait ??
    ((milliseconds: number) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (const [index, channel] of channels.entries()) {
    if (index > 0) await wait(250);
    const handle = channel.handle ?? channel.channelId ?? "";
    const fileBase = safeFileHandle(channel);
    try {
      const createDraft = options.createDraft ?? createAlertDraft;
      const draft = await createDraft({
        channel,
        config: options.config,
        now,
        dbPath,
        outputDirectory,
        fileBase,
        budget,
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        ...(options.wait ? { wait: options.wait } : {}),
        ...(options.warn ? { warn: options.warn } : {}),
      });
      if (draft.status === "nothing") {
        await removeIfExists(join(outputDirectory, `${fileBase}.md`));
        await removeIfExists(join(outputDirectory, `${fileBase}.pending.json`));
      }
      channelsResult.push({
        handle,
        name: channel.creatorName,
        recipient: channel.recipients[0] ?? "",
        status: draft.status,
        newCount: draft.status === "drafted" ? draft.newCount : 0,
        reminderCount: draft.status === "drafted" ? draft.reminderCount : 0,
        items: draft.status === "drafted" ? draft.items : [],
      });
    } catch (error) {
      const status: ChannelRunStatus =
        error instanceof AlertBudgetExceededError
          ? "skipped: budget"
          : "failed";
      if (status === "failed")
        options.warn?.(
          `${handle} failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
        );
      channelsResult.push({
        handle,
        name: channel.creatorName,
        recipient: channel.recipients[0] ?? "",
        status,
        newCount: 0,
        reminderCount: 0,
        items: [],
      });
    }
  }

  await mkdir(outputDirectory, { recursive: true });
  const dashboardPath = join(outputDirectory, "dashboard.html");
  await writeFile(
    join(outputDirectory, "summary.json"),
    `${JSON.stringify(
      {
        date,
        autoConfirmed,
        channels: channelsResult.map(
          ({ handle, name, status, newCount, reminderCount }) => ({
            handle,
            name,
            status,
            newCount,
            reminderCount,
          }),
        ),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await writeFile(dashboardPath, dashboardHtml(date, channelsResult), {
    encoding: "utf8",
    mode: 0o600,
  });

  const rows = [
    ["Channel", "New", "Reminders", "Status"],
    ...channelsResult.map((item) => [
      item.handle,
      String(item.newCount),
      String(item.reminderCount),
      item.status,
    ]),
  ];
  const widths = rows[0]!.map((_, index) =>
    Math.max(...rows.map((row) => row[index]!.length)),
  );
  options.log?.(
    rows
      .map((row) =>
        row
          .map((cell, index) => cell.padEnd(widths[index]!))
          .join("  ")
          .trimEnd(),
      )
      .join("\n"),
  );
  options.log?.(`Dashboard: ${dashboardPath}`);
  return {
    date,
    autoConfirmed,
    channels: channelsResult,
    dashboardPath,
    allFailed:
      channelsResult.length > 0 &&
      channelsResult.every((channel) => channel.status === "failed"),
  };
}

export async function skipTodayAlert(options: {
  channel: string;
  now?: Date;
  outputRoot?: string;
}): Promise<boolean> {
  const handle = options.channel.replace(/^@/u, "");
  if (!/^[A-Za-z0-9._-]{1,63}$/u.test(handle))
    throw new Error("Invalid channel handle.");
  const date = stamp(options.now ?? new Date());
  const path = join(
    options.outputRoot ?? "output",
    date,
    `@${handle.toLowerCase()}.pending.json`,
  );
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface WeeklyFinding {
  channel: ChannelConfig;
  count: number;
  request: string;
  videoTitle: string;
  link: string;
}

function weeklyHtml(date: string, findings: WeeklyFinding[]): string {
  const sections = findings
    .map(
      (finding) => `<section>
<h2>${escaped(finding.channel.creatorName)} — ${escaped(finding.channel.handle ?? "")}</h2>
<p><strong>${finding.count} distinct viewers</strong> asked for:</p>
<blockquote>${escaped(finding.request)}</blockquote>
<p>Video: ${escaped(finding.videoTitle)} — <a href="${escaped(finding.link)}">${escaped(finding.link)}</a></p>
</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Weekly viewer requests — ${escaped(date)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem}section{border:1px solid #d1d5db;border-radius:8px;padding:1rem;margin:1rem 0}blockquote{white-space:pre-wrap}</style>
</head><body><h1>Repeated viewer requests — ${escaped(date)}</h1>
${sections || "<p>No repeated viewer requests found.</p>"}
</body></html>\n`;
}

function toCommentRecord(candidate: BuyerAlertCandidate): CommentRecord {
  return {
    commentId: candidate.commentId,
    videoId: candidate.videoId,
    text: candidate.text,
    likeCount: 0,
    publishedAt: candidate.postedAt,
    totalReplyCount: 0,
    ...(candidate.authorChannelId
      ? { authorChannelId: candidate.authorChannelId }
      : {}),
    creatorReplied: candidate.creatorReplied,
  };
}

const requestCategories = new Set([
  "topic_request",
  "language_or_subtitles_request",
  "alternative_or_tool_request",
  "format_request",
  "mentoring_or_personal_request",
]);

export async function runWeeklyAlerts(
  options: AlertBatchOptions & {
    fetchComments?: (
      channel: ChannelConfig,
      now: Date,
      fetcher?: Fetcher,
      wait?: (milliseconds: number) => Promise<void>,
    ) => Promise<BuyerAlertCandidate[]>;
    classify?: (
      comments: CommentRecord[],
      channel: ChannelConfig,
      config: AppConfig,
      now: Date,
    ) => Promise<{ commentId: string; category: string }[]>;
    cluster?: (
      comments: CommentRecord[],
      config: AppConfig,
      date: string,
    ) => Promise<WritingCluster[]>;
  },
): Promise<{ date: string; findings: WeeklyFinding[] }> {
  const now = options.now ?? new Date();
  const date = stamp(now);
  const outputRoot = options.outputRoot ?? "output";
  const dbPath = options.dbPath ?? DEFAULT_ALERT_DB_PATH;
  const channels = await readChannelFile(options.channelsPath);
  const findings: WeeklyFinding[] = [];

  const fetchComments =
    options.fetchComments ??
    (async (channel, currentTime, fetcher, wait) => {
      const apiKey = process.env.YOUTUBE_API_KEY;
      if (!apiKey)
        throw new Error(
          "YOUTUBE_API_KEY is required to fetch alert candidates.",
        );
      return fetchAlertCandidates({
        apiKey,
        handleOrId: channel.handle ?? channel.channelId ?? "",
        now: currentTime,
        ...(fetcher ? { fetcher } : {}),
        ...(wait ? { wait } : {}),
      });
    });
  const classify =
    options.classify ??
    (async (comments, _channel, config, currentTime) => {
      const usagePath = options.usagePath ?? "usage_logs/usage.jsonl";
      const result = await analyzeComments(comments, {
        provider: config.provider,
        ...((config.classificationModel ?? config.model)
          ? { model: config.classificationModel ?? config.model }
          : {}),
        ...((config.classificationFallbackModel ?? config.fallbackModel)
          ? {
              fallbackModel:
                config.classificationFallbackModel ?? config.fallbackModel,
            }
          : {}),
        ...(process.env.LLM_API_KEY ? { apiKey: process.env.LLM_API_KEY } : {}),
        maxUsdPerRun: config.limits.maxUsdPerRun,
        maxUsdPerDay: config.limits.maxUsdPerDay,
        ...(config.modelOptions ? { modelOptions: config.modelOptions } : {}),
        now: currentTime,
        usagePath,
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        ...(options.wait ? { wait: options.wait } : {}),
        onUsage: (record) => appendUsage(record, usagePath),
      });
      return result.classifications;
    });
  const cluster =
    options.cluster ??
    (async (comments, config, currentDate) =>
      clusterComments(comments, {
        provider: config.provider,
        ...((config.writingModel ?? config.model)
          ? { model: config.writingModel ?? config.model }
          : {}),
        ...((config.writingFallbackModel ?? config.fallbackModel)
          ? {
              fallbackModel:
                config.writingFallbackModel ?? config.fallbackModel,
            }
          : {}),
        ...(process.env.LLM_API_KEY ? { apiKey: process.env.LLM_API_KEY } : {}),
        ...(config.modelOptions ? { modelOptions: config.modelOptions } : {}),
        section: "weekly repeated viewer requests",
        date: currentDate,
        onUsage: (record) =>
          appendUsage(record, options.usagePath ?? "usage_logs/usage.jsonl"),
      }));

  const dateDirectory = join(outputRoot, date);
  const weeklyDirectory = join(dateDirectory, "weekly");
  await mkdir(weeklyDirectory, { recursive: true });
  for (const channel of channels) {
    await removeIfExists(
      join(weeklyDirectory, `${safeFileHandle(channel)}.md`),
    );
    try {
      const fetched = await fetchComments(
        channel,
        now,
        options.fetcher,
        options.wait,
      );
      const comments = fetched.map(toCommentRecord);
      if (comments.length === 0) continue;
      const classifications = await classify(
        comments,
        channel,
        options.config,
        now,
      );
      const requestIds = new Set(
        classifications
          .filter((item) => requestCategories.has(item.category))
          .map((item) => item.commentId),
      );
      const requests = comments.filter((item) =>
        requestIds.has(item.commentId),
      );
      if (requests.length < 2) continue;
      const clusters = await cluster(requests, options.config, date);
      const viewerById = new Map(
        requests.map((comment, index) => [index + 1, comment.authorChannelId]),
      );
      const repeated = clusters
        .map((item) => {
          const members = item.ids
            .map((id) => requests[id - 1])
            .filter(
              (comment): comment is CommentRecord => comment !== undefined,
            );
          const viewers = new Set(
            item.ids
              .map((id) => viewerById.get(id))
              .filter((author): author is string => Boolean(author)),
          );
          return { item, members, viewers };
        })
        .filter((candidate) => candidate.viewers.size >= 2)
        .sort(
          (left, right) =>
            right.viewers.size - left.viewers.size ||
            right.members.length - left.members.length,
        )[0];
      if (!repeated) continue;
      const commentIds = new Set(
        repeated.members.map((item) => item.commentId),
      );
      const source = fetched.find((item) => commentIds.has(item.commentId));
      if (!source) continue;
      findings.push({
        channel,
        count: repeated.viewers.size,
        request: source.text,
        videoTitle: source.videoTitle,
        link: source.link,
      });
    } catch (error) {
      options.warn?.(
        `${channel.handle} weekly analysis failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }

  for (const finding of findings) {
    const file = `${safeFileHandle(finding.channel)}.md`;
    await writeFile(
      join(weeklyDirectory, file),
      [
        `# Repeated request — ${finding.channel.creatorName}`,
        "",
        `**${finding.count} distinct viewers** requested:`,
        "",
        `> ${finding.request.replace(/\n/gu, "\n> ")}`,
        "",
        `Video: ${finding.videoTitle}`,
        `Link: ${finding.link}`,
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
  }
  await writeFile(
    join(dateDirectory, "weekly.html"),
    weeklyHtml(date, findings),
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );

  const state = new AlertStateStore(dbPath);
  state.close();
  const backupDirectory = join(outputRoot, "backups");
  await mkdir(backupDirectory, { recursive: true });
  await copyFile(dbPath, join(backupDirectory, `alerts-${date}.db`));
  return { date, findings };
}
