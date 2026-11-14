import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { detectKeywordResponses } from "./classification.js";
import { sendEmail } from "./email.js";
import { analyzeComments, type FailedBatch } from "./llm.js";
import { renderReport } from "./report.js";
import { appendUsage, cacheComments } from "./storage.js";
import { fetchChannelData } from "./youtube.js";
import { redactSecrets } from "./errors.js";
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
  dumpPrompt?: boolean;
  dumpYoutube?: boolean;
}

export interface RunStats {
  date: string;
  videosAnalyzed: number;
  commentsFetched: number;
  creatorComments: number;
  commentsSentToLlm: number;
  commentsClassified: number;
  commentsExcluded: number;
  commentsNotAnalyzed: number;
  emptyText: number;
  unclassified: number;
  suspiciousAllNoise: boolean;
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

function emptyCategoryCounts(): Record<Category, number> {
  return {
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
    keyword_response: 0,
  };
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
  const folder = resolve(
    options.outputRoot ?? "output",
    channelKey(options.channel),
    now.toISOString().slice(0, 10),
  );
  const debugFolder = resolve(folder, "debug");
  if (options.dumpPrompt || options.dumpYoutube)
    await mkdir(debugFolder, { recursive: true });
  const sanitizeDump = (text: string): string => {
    let sanitized = redactSecrets(text);
    for (const key of [
      process.env.LLM_API_KEY,
      process.env.YOUTUBE_API_KEY,
      process.env.RESEND_API_KEY,
    ]) {
      if (key) sanitized = sanitized.replaceAll(key, "[REDACTED]");
    }
    return sanitized;
  };
  let youtubeSampleWritten = false;
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
    ...(options.dumpYoutube
      ? {
          onCommentThreadsSample: async (items: unknown[]) => {
            await writeFile(
              resolve(debugFolder, "youtube-sample.json"),
              `${sanitizeDump(JSON.stringify(items, null, 2))}\n`,
              { encoding: "utf8", mode: 0o600 },
            );
            youtubeSampleWritten = true;
          },
        }
      : {}),
  });
  if (options.dumpYoutube && !youtubeSampleWritten) {
    await writeFile(resolve(debugFolder, "youtube-sample.json"), "[]\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  const cacheRoot = options.cacheRoot ?? "cache";
  await cacheComments(
    channelKey(options.channel),
    data.comments,
    cacheRoot,
    now,
  );
  const creatorComments = data.comments.filter(
    (comment) => comment.authorChannelId === data.channelId,
  ).length;
  const viewerComments = data.comments.filter(
    (comment) => comment.authorChannelId !== data.channelId,
  );
  const emptyText = viewerComments.filter(
    (comment) => !comment.text.trim(),
  ).length;
  const textLossRatio =
    viewerComments.length > 0 ? emptyText / viewerComments.length : 0;
  if (textLossRatio > 0.2) {
    const failureReason =
      `${emptyText} of ${viewerComments.length} viewer comments have empty text. ` +
      "Text was lost during YouTube commentThreads parsing; expected " +
      "item.snippet.topLevelComment.snippet.textOriginal or textDisplay.";
    const stats: RunStats = {
      date: now.toISOString().slice(0, 10),
      videosAnalyzed: data.videos.length,
      commentsFetched: data.comments.length,
      creatorComments,
      commentsSentToLlm: 0,
      commentsClassified: 0,
      commentsExcluded: creatorComments + emptyText,
      commentsNotAnalyzed: 0,
      emptyText,
      unclassified: 0,
      suspiciousAllNoise: false,
      classificationSucceeded: false,
      failureReason,
      stoppedReason: failureReason,
      ...(options.classifyOnly ? { classifyOnly: true } : {}),
      batches: {
        total: 0,
        successful: 0,
        failed: [],
      },
      classificationsByCategory: emptyCategoryCounts(),
      reportItemsBySection: {
        money: 0,
        ideas: 0,
        fixes: 0,
        proofs: 0,
        answered: 0,
      },
      droppedQuotes: {
        emptyQuote: 0,
        quoteNotFound: 0,
        unknownComment: 0,
        missingVideo: 0,
      },
    };
    await mkdir(folder, { recursive: true });
    await writeFile(
      resolve(folder, "stats.json"),
      `${JSON.stringify(stats, null, 2)}\n`,
      { mode: 0o600 },
    );
    throw new Error(
      `${failureReason} Aborting before LLM classification; stats were saved to ${resolve(folder, "stats.json")}.`,
    );
  }
  const nonEmptyComments = viewerComments.filter((comment) =>
    comment.text.trim(),
  );
  const keywordResponses = detectKeywordResponses(nonEmptyComments);
  const selectedComments = options.classifyOnly
    ? nonEmptyComments.slice(0, 20)
    : nonEmptyComments;
  const selectedCommentIds = new Set(
    selectedComments.map((comment) => comment.commentId),
  );
  const keywordClassifications = selectedComments.flatMap((comment) =>
    keywordResponses.has(comment.commentId)
      ? [
          {
            commentId: comment.commentId,
            category: "keyword_response" as const,
            quote: comment.text.trim(),
          },
        ]
      : [],
  );
  const analysisComments = selectedComments.filter(
    (comment) => !keywordResponses.has(comment.commentId),
  );
  const commentsNotAnalyzed = nonEmptyComments.filter(
    (comment) => !selectedCommentIds.has(comment.commentId),
  ).length;
  const dumpedBatches = new Set<number>();
  const analysis = await analyzeComments(analysisComments, {
    provider: options.config.provider,
    ...(options.config.model ? { model: options.config.model } : {}),
    ...(options.config.fallbackModel
      ? { fallbackModel: options.config.fallbackModel }
      : {}),
    ...(options.config.modelOptions
      ? { modelOptions: options.config.modelOptions }
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
    ...(options.dumpPrompt
      ? {
          onProviderExchange: async ({
            batch,
            attempt,
            prompt,
            systemInstruction,
            rawResponse,
          }: {
            batch: number;
            attempt: number;
            prompt: string;
            systemInstruction?: string;
            rawResponse: string;
          }) => {
            const promptPath = resolve(
              debugFolder,
              `batch-${batch}-prompt.txt`,
            );
            const responsePath = resolve(
              debugFolder,
              `batch-${batch}-response.txt`,
            );
            const prefix = dumpedBatches.has(batch)
              ? `\n\n===== attempt ${attempt} =====\n`
              : `===== attempt ${attempt} =====\n`;
            const promptText = systemInstruction
              ? `SYSTEM INSTRUCTION\n${systemInstruction}\n\nUSER CONTENT\n${prompt}`
              : prompt;
            await appendFile(
              promptPath,
              `${prefix}${sanitizeDump(promptText)}\n`,
              {
                encoding: "utf8",
                mode: 0o600,
              },
            );
            await appendFile(
              responsePath,
              `${prefix}${sanitizeDump(rawResponse)}\n`,
              { encoding: "utf8", mode: 0o600 },
            );
            dumpedBatches.add(batch);
          },
        }
      : {}),
    ...(options.debug || options.classifyOnly || options.dumpPrompt
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
                missingCount: event.missingCount ?? 0,
                duplicateCount: event.duplicateCount ?? 0,
                unknownIdCount: event.unknownIdCount ?? 0,
                firstRawIds: event.firstRawIds ?? [],
                rawCategoryHistogram: event.rawCategoryHistogram ?? {},
                mappedCategoryHistogram: event.mappedCategoryHistogram ?? {},
                unmappedCount: event.unmappedCount ?? 0,
                nonEmptyTextCount: event.nonEmptyTextCount ?? 0,
                averageTextLength: event.averageTextLength ?? 0,
                minimumTextLength: event.minimumTextLength ?? 0,
                finishReason: event.finishReason ?? null,
                promptFeedbackBlockReason:
                  event.promptFeedbackBlockReason ?? null,
                usageMetadata: event.usageMetadata ?? null,
                rawResponseTextLength: event.rawResponseTextLength ?? 0,
                outcome: event.outcome,
                ...(event.reason ? { reason: event.reason } : {}),
                ...(event.droppedFields
                  ? { droppedFields: event.droppedFields }
                  : {}),
              })}`,
            );
          },
        }
      : {}),
    onUsage: (record) => appendUsage(record, options.usagePath),
  });
  const classifications = [
    ...analysis.classifications,
    ...keywordClassifications,
  ];
  const range = {
    from: new Date(now.getTime() - options.days * 86_400_000)
      .toISOString()
      .slice(0, 10),
    to: now.toISOString().slice(0, 10),
  };
  const unclassifiedRatio =
    analysisComments.length > 0
      ? analysis.unclassifiedCount / analysisComments.length
      : 0;
  const exceedsUnclassifiedThreshold = unclassifiedRatio > 0.3;
  const unclassifiedReason = `${analysis.unclassifiedCount} of ${analysisComments.length} analyzed comments remained unclassified after retry.`;
  const suspiciousReason =
    "A batch remained more than 90% spam_or_noise after fallback-model verification.";
  console.log("Verifying quotes.");
  const rendered = renderReport({
    channel: options.channel,
    videos: data.videos,
    comments: nonEmptyComments,
    classifications,
    dateRange: range,
    classificationSucceeded: analysis.classificationSucceeded,
    ...(analysis.stoppedReason ||
    analysis.unclassifiedCount > 0 ||
    analysis.suspiciousAllNoise ||
    analysis.failedBatches.length > 0
      ? {
          stoppedReason:
            analysis.stoppedReason ??
            (analysis.suspiciousAllNoise
              ? suspiciousReason
              : analysis.unclassifiedCount > 0
                ? unclassifiedReason
                : `${analysis.failedBatches.length} classification batch(es) failed after retry; see stats.json.`),
        }
      : {}),
  });
  await mkdir(folder, { recursive: true });
  const classificationsByCategory = emptyCategoryCounts();
  for (const classification of classifications)
    classificationsByCategory[classification.category] += 1;
  const commentsClassified = classifications.length;
  const stats: RunStats = {
    date: now.toISOString().slice(0, 10),
    videosAnalyzed: data.videos.length,
    commentsFetched: data.comments.length,
    creatorComments,
    commentsSentToLlm: analysis.commentsSentToLlm,
    commentsClassified,
    commentsExcluded: creatorComments + emptyText,
    commentsNotAnalyzed,
    emptyText,
    unclassified: analysis.unclassifiedCount,
    suspiciousAllNoise: analysis.suspiciousAllNoise,
    classificationSucceeded: analysis.classificationSucceeded,
    ...(exceedsUnclassifiedThreshold
      ? {
          stoppedReason: unclassifiedReason,
          failureReason:
            "More than 30% of analyzed comments were unclassified.",
        }
      : analysis.stoppedReason
        ? { stoppedReason: analysis.stoppedReason }
        : analysis.suspiciousAllNoise
          ? {
              stoppedReason: suspiciousReason,
              failureReason: "Suspicious all-noise classification persisted.",
            }
          : analysis.unclassifiedCount > 0
            ? { stoppedReason: unclassifiedReason }
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
  if (exceedsUnclassifiedThreshold) {
    throw new Error(
      `${unclassifiedReason} More than 30% is unclassified; stats were saved to ${resolve(folder, "stats.json")}; no report was produced.`,
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
  const classified = stats.commentsClassified;
  const droppedTotal = Object.values(stats.droppedQuotes).reduce(
    (total, count) => total + count,
    0,
  );
  console.log("Run summary:");
  console.log(`  Videos analyzed: ${stats.videosAnalyzed}`);
  console.log(`  Comments fetched: ${stats.commentsFetched}`);
  console.log(`  Creator comments excluded: ${stats.creatorComments}`);
  console.log(`  Comments sent to the LLM: ${stats.commentsSentToLlm}`);
  console.log(`  Comments classified: ${stats.commentsClassified}`);
  console.log(`  Comments excluded: ${stats.commentsExcluded}`);
  console.log(`  Comments not analyzed: ${stats.commentsNotAnalyzed}`);
  console.log(`  Comments with empty text: ${stats.emptyText}`);
  console.log(`  Comments unclassified: ${stats.unclassified}`);
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
