import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sendEmail } from "./email.js";
import { analyzeComments, type FailedBatch } from "./llm.js";
import { renderReport } from "./report.js";
import { appendUsage, cacheComments } from "./storage.js";
import { fetchChannelData } from "./youtube.js";
import type {
  AppConfig,
  Category,
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
  debug?: boolean;
  classifyOnly?: boolean;
}

export interface RunStats {
  date: string;
  videosAnalyzed: number;
  commentsFetched: number;
  commentsSentToLlm: number;
  classificationSucceeded: boolean;
  failureReason?: string;
  classifyOnly?: boolean;
  stoppedReason?: string;
  batches: {
    total: number;
    successful: number;
    failed: FailedBatch[];
  };
  classificationsByCategory: Record<Category, number>;
  reportItemsBySection: {
    money: number;
    ideas: number;
    fixes: number;
    proofs: number;
    answered: number;
  };
  droppedQuotes: {
    emptyQuote: number;
    quoteNotFound: number;
    unknownComment: number;
    missingVideo: number;
  };
}

export interface RunResult {
  reportFolder: string;
  sent: boolean;
  videosAnalyzed: number;
  commentsFetched: number;
  stats: RunStats;
  classifyOnly: boolean;
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
  console.log(`Resolving channel ${handleOrId}.`);
  const data = await fetchChannelData({
    apiKey: youtubeKey,
    handleOrId,
    days: options.days,
    maxVideos: options.config.limits.maxVideos,
    maxThreadsPerVideo: options.config.limits.maxThreadsPerVideo,
    now,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.wait ? { wait: options.wait } : {}),
    onProgress: (message) => console.log(message),
  });
  const cacheRoot = options.cacheRoot ?? "cache";
  await cacheComments(
    channelKey(options.channel),
    data.comments,
    cacheRoot,
    now,
  );
  const analysisComments = options.classifyOnly
    ? data.comments.slice(0, 20)
    : data.comments;
  const analysis = await analyzeComments(analysisComments, {
    provider: options.config.provider,
    ...(options.config.model ? { model: options.config.model } : {}),
    ...(options.config.fallbackModel
      ? { fallbackModel: options.config.fallbackModel }
      : {}),
    maxUsdPerRun: options.config.limits.maxUsdPerRun,
    maxUsdPerDay: options.config.limits.maxUsdPerDay,
    ...(options.config.limits.maxOutputTokensPerComment !== undefined
      ? {
          maxOutputTokensPerComment:
            options.config.limits.maxOutputTokensPerComment,
        }
      : {}),
    ...(options.config.limits.outputTokenOverhead !== undefined
      ? { outputTokenOverhead: options.config.limits.outputTokenOverhead }
      : {}),
    now,
    ...(process.env.LLM_API_KEY ? { apiKey: process.env.LLM_API_KEY } : {}),
    ...(options.usagePath ? { usagePath: options.usagePath } : {}),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.wait ? { wait: options.wait } : {}),
    onProgress: (message) => console.log(message),
    ...(options.debug || options.classifyOnly
      ? {
          onBatchEvent: (event) => {
            console.log(
              `LLM batch: ${JSON.stringify({
                batch: `${event.batch}/${event.totalBatches}`,
                chunk: event.chunk ?? "1",
                attempt: event.attempt,
                commentsSent: event.commentsSent ?? 0,
                itemsReturned: event.itemsReturned ?? 0,
                itemsValid: event.itemsValid ?? 0,
                finishReason: event.finishReason ?? null,
                promptFeedbackBlockReason:
                  event.promptFeedbackBlockReason ?? null,
                usageMetadata: event.usageMetadata ?? null,
                rawResponseTextLength: event.rawResponseTextLength ?? 0,
                outcome: event.outcome,
              })}`,
            );
          },
        }
      : {}),
    onUsage: (record) => appendUsage(record, options.usagePath),
  });
  const range = {
    from: new Date(now.getTime() - options.days * 86_400_000)
      .toISOString()
      .slice(0, 10),
    to: now.toISOString().slice(0, 10),
  };
  console.log("Verifying quotes.");
  const rendered = renderReport({
    channel: options.channel,
    videos: data.videos,
    comments: data.comments,
    classifications: analysis.classifications,
    dateRange: range,
    classificationSucceeded: analysis.classificationSucceeded,
    ...(analysis.stoppedReason || analysis.failedBatches.length > 0
      ? {
          stoppedReason:
            analysis.stoppedReason ??
            `${analysis.failedBatches.length} classification batch(es) failed after retry; see stats.json.`,
        }
      : {}),
  });
  const folder = resolve(
    options.outputRoot ?? "output",
    channelKey(options.channel),
    now.toISOString().slice(0, 10),
  );
  await mkdir(folder, { recursive: true });
  const classificationsByCategory: Record<Category, number> = {
    buying_or_sponsor_inquiry: 0,
    how_to_question: 0,
    confusion_or_error: 0,
    complaint_or_objection: 0,
    testimonial_or_result: 0,
    topic_request: 0,
    language_or_subtitles_request: 0,
    alternative_or_tool_request: 0,
    format_request: 0,
    praise: 0,
    spam_or_noise: 0,
  };
  for (const classification of analysis.classifications)
    classificationsByCategory[classification.category] += 1;
  const classifiedCount = Object.values(classificationsByCategory).reduce(
    (total, count) => total + count,
    0,
  );
  const zeroClassifications =
    analysis.commentsSentToLlm > 0 && classifiedCount === 0;
  const zeroClassificationReason =
    "No comments were classified despite sending comments to the LLM.";
  const stats: RunStats = {
    date: now.toISOString().slice(0, 10),
    videosAnalyzed: data.videos.length,
    commentsFetched: data.comments.length,
    commentsSentToLlm: analysis.commentsSentToLlm,
    classificationSucceeded:
      analysis.classificationSucceeded && !zeroClassifications,
    ...(zeroClassifications
      ? {
          stoppedReason: zeroClassificationReason,
          failureReason: zeroClassificationReason,
        }
      : analysis.stoppedReason
        ? { stoppedReason: analysis.stoppedReason }
        : {}),
    ...(options.classifyOnly ? { classifyOnly: true } : {}),
    batches: {
      total: analysis.batchCount,
      successful: analysis.successfulBatches,
      failed: analysis.failedBatches,
    },
    classificationsByCategory,
    reportItemsBySection: rendered.sectionItemCounts,
    droppedQuotes: rendered.droppedQuotes,
  };
  await writeFile(
    resolve(folder, "stats.json"),
    `${JSON.stringify(stats, null, 2)}\n`,
    { mode: 0o600 },
  );
  const usage: UsageRecord = {
    date: now.toISOString().slice(0, 10),
    youtubeQuotaUnits: data.quotaUnits,
    llmInputTokens: 0,
    llmOutputTokens: 0,
    estimatedUsd: 0,
  };
  await appendUsage(usage, options.usagePath);
  printRunSummary(stats);
  if (zeroClassifications) {
    throw new Error(
      `${zeroClassificationReason} Stats were saved to ${resolve(folder, "stats.json")}; no report was produced.`,
    );
  }
  const totalFailures = analysis.failedBatches.length;
  const exceedsFailureThreshold =
    analysis.batchCount > 0 && totalFailures / analysis.batchCount > 0.3;
  if (exceedsFailureThreshold) {
    throw new Error(
      `Analysis failed for ${totalFailures} of ${analysis.batchCount} batches (>30%). Stats were saved to ${resolve(folder, "stats.json")}; no report was produced.`,
    );
  }
  if (options.classifyOnly) {
    console.log("Classification-only mode: no report was written.");
    return {
      reportFolder: folder,
      sent: false,
      videosAnalyzed: data.videos.length,
      commentsFetched: data.comments.length,
      stats,
      classifyOnly: true,
    };
  }
  console.log("Writing report.");
  await Promise.all([
    writeFile(resolve(folder, "report.html"), rendered.html, { mode: 0o600 }),
    writeFile(resolve(folder, "report.md"), rendered.markdown, { mode: 0o600 }),
  ]);
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
    stats,
    classifyOnly: false,
  };
}

function printRunSummary(stats: RunStats): void {
  const classified = Object.values(stats.classificationsByCategory).reduce(
    (total, count) => total + count,
    0,
  );
  const droppedTotal = Object.values(stats.droppedQuotes).reduce(
    (total, count) => total + count,
    0,
  );
  console.log("Run summary:");
  console.log(`  Videos analyzed: ${stats.videosAnalyzed}`);
  console.log(`  Comments fetched: ${stats.commentsFetched}`);
  console.log(`  Comments sent to the LLM: ${stats.commentsSentToLlm}`);
  console.log(
    `  Classification status: ${stats.classificationSucceeded ? "complete" : "incomplete"}${stats.stoppedReason ? ` (${stats.stoppedReason})` : ""}`,
  );
  console.log(`  Comments classified: ${classified}`);
  console.log(
    `  Categories: ${Object.entries(stats.classificationsByCategory)
      .map(([category, count]) => `${category}=${count}`)
      .join(", ")}`,
  );
  console.log(
    `  Report items: ${Object.entries(stats.reportItemsBySection)
      .map(([section, count]) => `${section}=${count}`)
      .join(", ")}`,
  );
  console.log(
    `  Quotes dropped: ${droppedTotal} (empty=${stats.droppedQuotes.emptyQuote}, not found=${stats.droppedQuotes.quoteNotFound}, unknown comment=${stats.droppedQuotes.unknownComment}, missing video=${stats.droppedQuotes.missingVideo})`,
  );
  console.log(
    `  Classification batches: ${stats.batches.successful} succeeded, ${stats.batches.failed.length} failed of ${stats.batches.total}`,
  );
}
