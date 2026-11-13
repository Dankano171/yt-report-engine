import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sendEmail } from "./email.js";
import { analyzeComments } from "./llm.js";
import { renderReport } from "./report.js";
import { appendUsage, cacheComments } from "./storage.js";
import { fetchChannelData } from "./youtube.js";
import type {
  AppConfig,
  ChannelConfig,
  Fetcher,
  UsageRecord,
} from "./types.js";

export interface RunOptions {
  channel: ChannelConfig;
  config: AppConfig;
  days: number;
  send: boolean;
  outputRoot?: string;
  cacheRoot?: string;
  usagePath?: string;
  now?: Date;
  fetcher?: Fetcher;
  wait?: (milliseconds: number) => Promise<void>;
  sendEmailFn?: typeof sendEmail;
}

export interface RunResult {
  reportFolder: string;
  sent: boolean;
  videosAnalyzed: number;
  commentsFetched: number;
}

function channelKey(channel: ChannelConfig): string {
  return (channel.handle ?? channel.channelId ?? "channel").replace(
    /[^A-Za-z0-9@._-]/g,
    "_",
  );
}

export async function runChannel(options: RunOptions): Promise<RunResult> {
  if (
    !Number.isInteger(options.days) ||
    options.days < 1 ||
    options.days > 365
  ) {
    throw new Error("--days must be an integer between 1 and 365.");
  }
  const handleOrId = options.channel.handle ?? options.channel.channelId;
  if (!handleOrId)
    throw new Error("The configured channel needs a handle or channelId.");
  const youtubeKey = process.env.YOUTUBE_API_KEY;
  if (!youtubeKey)
    throw new Error("YOUTUBE_API_KEY is required to fetch channel data.");
  const now = options.now ?? new Date();
  const data = await fetchChannelData({
    apiKey: youtubeKey,
    handleOrId,
    days: options.days,
    maxVideos: options.config.limits.maxVideos,
    maxThreadsPerVideo: options.config.limits.maxThreadsPerVideo,
    now,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.wait ? { wait: options.wait } : {}),
  });
  const cacheRoot = options.cacheRoot ?? "cache";
  await cacheComments(
    channelKey(options.channel),
    data.comments,
    cacheRoot,
    now,
  );
  const analysis = await analyzeComments(data.comments, {
    provider: options.config.provider,
    maxUsdPerRun: options.config.limits.maxUsdPerRun,
    maxUsdPerDay: options.config.limits.maxUsdPerDay,
    now,
    ...(process.env.LLM_API_KEY ? { apiKey: process.env.LLM_API_KEY } : {}),
    ...(options.usagePath ? { usagePath: options.usagePath } : {}),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.wait ? { wait: options.wait } : {}),
    onUsage: (record) => appendUsage(record, options.usagePath),
  });
  const range = {
    from: new Date(now.getTime() - options.days * 86_400_000)
      .toISOString()
      .slice(0, 10),
    to: now.toISOString().slice(0, 10),
  };
  const rendered = renderReport({
    channel: options.channel,
    videos: data.videos,
    comments: data.comments,
    classifications: analysis.classifications,
    dateRange: range,
    ...(analysis.stoppedReason
      ? { stoppedReason: analysis.stoppedReason }
      : {}),
  });
  const folder = resolve(
    options.outputRoot ?? "output",
    channelKey(options.channel),
    now.toISOString().slice(0, 10),
  );
  await mkdir(folder, { recursive: true });
  await Promise.all([
    writeFile(resolve(folder, "report.html"), rendered.html, { mode: 0o600 }),
    writeFile(resolve(folder, "report.md"), rendered.markdown, { mode: 0o600 }),
  ]);
  const usage: UsageRecord = {
    date: now.toISOString().slice(0, 10),
    youtubeQuotaUnits: data.quotaUnits,
    llmInputTokens: 0,
    llmOutputTokens: 0,
    estimatedUsd: 0,
  };
  await appendUsage(usage, options.usagePath);
  let sent = false;
  if (options.send) {
    if (!options.channel.recipients.length)
      throw new Error("No recipients are configured; email was not sent.");
    if (!options.config.emailFrom)
      throw new Error(
        "emailFrom is required for sending; report was saved but not sent.",
      );
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey)
      throw new Error(
        "RESEND_API_KEY is required for sending; report was saved but not sent.",
      );
    await (options.sendEmailFn ?? sendEmail)(
      options.channel.recipients,
      options.config.emailFrom,
      `${options.channel.creatorName} — Audience intelligence (${range.from} to ${range.to})`,
      rendered.html,
      resendKey,
      options.fetcher,
    );
    sent = true;
  }
  return {
    reportFolder: folder,
    sent,
    videosAnalyzed: data.videos.length,
    commentsFetched: data.comments.length,
  };
}
