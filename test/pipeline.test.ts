import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runChannel } from "../src/pipeline.js";
import type { AppConfig, ChannelConfig, Fetcher } from "../src/types.js";

let root: string | undefined;
const channel: ChannelConfig = {
  handle: "@creator",
  creatorName: "Creator",
  creatorGoal: "grow_audience",
  recipients: ["creator@example.com"],
  productKeywords: [],
};
const config: AppConfig = {
  provider: "mock",
  emailFrom: "Reports <reports@example.com>",
  limits: {
    maxVideos: 8,
    maxThreadsPerVideo: 300,
    maxUsdPerRun: 0.5,
    maxUsdPerDay: 2,
  },
  channels: [channel],
};

function fetcher(commentCount = 1): Fetcher {
  return async (input) => {
    const endpoint = new URL(String(input)).pathname.split("/").at(-1);
    const data: Record<string, unknown> = {
      channels: {
        items: [
          {
            id: "UCcreator",
            contentDetails: { relatedPlaylists: { uploads: "UUcreator" } },
          },
        ],
      },
      playlistItems: {
        items: [
          {
            snippet: {
              publishedAt: "2026-03-10T12:00:00Z",
              resourceId: { videoId: "video1" },
            },
          },
        ],
      },
      videos: {
        items: [
          {
            id: "video1",
            snippet: {
              title: "Tutorial",
              description: "",
              publishedAt: "2026-03-10T12:00:00Z",
            },
            statistics: { viewCount: "10", commentCount: "1" },
            contentDetails: { duration: "PT120S" },
          },
        ],
      },
      commentThreads: {
        items: Array.from({ length: commentCount }, (_, index) => ({
          snippet: {
            totalReplyCount: 0,
          },
          topLevelComment: {
            id: `comment${index + 1}`,
            snippet: {
              textOriginal:
                index === 0
                  ? "How do I set this up?"
                  : `How do I set this up ${index + 1}?`,
              likeCount: 8,
              publishedAt: "2026-03-11T12:00:00Z",
              authorChannelId: { value: "UCviewer" },
            },
          },
        })),
      },
    };
    return new Response(JSON.stringify(data[endpoint ?? ""]), { status: 200 });
  };
}

function partiallyClassifyingFetcher(
  commentCount: number,
  firstResponseIds: number[],
): Fetcher {
  const youtubeFetcher = fetcher(commentCount);
  let llmCalls = 0;
  return async (input, init) => {
    if (new URL(String(input)).hostname === "www.googleapis.com")
      return youtubeFetcher(input, init);
    const content =
      llmCalls++ === 0
        ? JSON.stringify(
            firstResponseIds.map((id) => ({
              id,
              category: "how_to_question",
              timestamp: null,
            })),
          )
        : "[]";
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200 },
    );
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  delete process.env.YOUTUBE_API_KEY;
  delete process.env.LLM_API_KEY;
});

describe("run pipeline", () => {
  it("writes a mocked end-to-end dry-run report without sending email", async () => {
    root = await mkdtemp(join(tmpdir(), "yt-report-run-"));
    process.env.YOUTUBE_API_KEY = "test-key";
    const sendEmailFn = vi.fn();
    const now = new Date("2026-03-15T00:00:00Z");
    const result = await runChannel({
      channel,
      config,
      days: 30,
      send: false,
      outputRoot: join(root, "output"),
      cacheRoot: join(root, "cache"),
      usagePath: join(root, "usage", "usage.jsonl"),
      now,
      fetcher: fetcher(),
      wait: async () => {},
      sendEmailFn,
    });
    expect(result.sent).toBe(false);
    expect(sendEmailFn).not.toHaveBeenCalled();
    await expect(
      readFile(join(result.reportFolder, "report.md"), "utf8"),
    ).resolves.toContain("How do I set this up?");
    await expect(
      readFile(join(result.reportFolder, "report.html"), "utf8"),
    ).resolves.toContain("Audience intelligence");
    const stats = JSON.parse(
      await readFile(join(result.reportFolder, "stats.json"), "utf8"),
    ) as {
      videosAnalyzed: number;
      commentsFetched: number;
      commentsSentToLlm: number;
      classificationsByCategory: Record<string, number>;
      reportItemsBySection: Record<string, number>;
      droppedQuotes: Record<string, number>;
    };
    expect(stats).toMatchObject({
      videosAnalyzed: 1,
      commentsFetched: 1,
      commentsSentToLlm: 0,
      classificationsByCategory: { how_to_question: 1 },
      reportItemsBySection: { money: 1 },
      droppedQuotes: {
        emptyQuote: 0,
        quoteNotFound: 0,
        unknownComment: 0,
        missingVideo: 0,
      },
    });
  });

  it("classifies only the first batch and writes diagnostic stats without a report", async () => {
    root = await mkdtemp(join(tmpdir(), "yt-report-classify-only-"));
    process.env.YOUTUBE_API_KEY = "test-key";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await runChannel({
      channel,
      config,
      days: 30,
      send: false,
      classifyOnly: true,
      debug: true,
      outputRoot: join(root, "output"),
      cacheRoot: join(root, "cache"),
      usagePath: join(root, "usage", "usage.jsonl"),
      now: new Date("2026-03-15T00:00:00Z"),
      fetcher: fetcher(),
      wait: async () => {},
    });
    expect(result.classifyOnly).toBe(true);
    expect(result.stats.classifyOnly).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"itemsValid":1'));
    await expect(
      readFile(join(result.reportFolder, "stats.json"), "utf8"),
    ).resolves.toContain('"classifyOnly": true');
    await expect(
      readFile(join(result.reportFolder, "report.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("writes a report when at most 30% of analyzed comments are unclassified", async () => {
    root = await mkdtemp(join(tmpdir(), "yt-report-partial-"));
    process.env.YOUTUBE_API_KEY = "test-key";
    process.env.LLM_API_KEY = "test-llm-key";
    const outputRoot = join(root, "output");
    const result = await runChannel({
      channel,
      config: { ...config, provider: "openai", model: "test-model" },
      days: 30,
      send: false,
      outputRoot,
      cacheRoot: join(root, "cache"),
      usagePath: join(root, "usage", "usage.jsonl"),
      now: new Date("2026-03-15T00:00:00Z"),
      fetcher: partiallyClassifyingFetcher(4, [1, 2, 3]),
      wait: async () => {},
    });
    expect(result.stats.unclassified).toBe(1);
    expect(result.stats.classificationSucceeded).toBe(false);
    expect(result.stats.classificationsByCategory.how_to_question).toBe(3);
    await expect(
      readFile(join(result.reportFolder, "report.md"), "utf8"),
    ).resolves.not.toContain("How do I set this up 4?");
  });

  it("fails when more than 30% of analyzed comments are unclassified", async () => {
    root = await mkdtemp(join(tmpdir(), "yt-report-unclassified-"));
    process.env.YOUTUBE_API_KEY = "test-key";
    process.env.LLM_API_KEY = "test-llm-key";
    const outputRoot = join(root, "output");
    await expect(
      runChannel({
        channel,
        config: { ...config, provider: "openai", model: "test-model" },
        days: 30,
        send: false,
        outputRoot,
        cacheRoot: join(root, "cache"),
        usagePath: join(root, "usage", "usage.jsonl"),
        now: new Date("2026-03-15T00:00:00Z"),
        fetcher: partiallyClassifyingFetcher(3, [1]),
        wait: async () => {},
      }),
    ).rejects.toThrow(/2 of 3 analyzed comments remained unclassified/i);
    const folder = join(outputRoot, "@creator", "2026-03-15");
    const stats = JSON.parse(
      await readFile(join(folder, "stats.json"), "utf8"),
    ) as { unclassified: number; failureReason: string };
    expect(stats).toMatchObject({
      unclassified: 2,
      failureReason: "More than 30% of analyzed comments were unclassified.",
    });
    await expect(readFile(join(folder, "report.md"), "utf8")).rejects.toThrow();
  });

  it("saves failed-batch stats and aborts instead of writing an empty report", async () => {
    root = await mkdtemp(join(tmpdir(), "yt-report-run-failed-"));
    process.env.YOUTUBE_API_KEY = "test-key";
    process.env.LLM_API_KEY = "test-llm-key";
    const youtubeFetcher = fetcher();
    const llmPrompts: string[] = [];
    const invalidJsonFetcher: Fetcher = async (input, init) => {
      if (new URL(String(input)).hostname === "www.googleapis.com")
        return youtubeFetcher(input, init);
      const request = JSON.parse(String(init?.body)) as {
        messages: { content: string }[];
      };
      llmPrompts.push(request.messages[0]?.content ?? "");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "not json" } }] }),
        { status: 200 },
      );
    };
    const outputRoot = join(root, "output");
    await expect(
      runChannel({
        channel,
        config: { ...config, provider: "openai", model: "test-model" },
        days: 30,
        send: false,
        outputRoot,
        cacheRoot: join(root, "cache"),
        usagePath: join(root, "usage", "usage.jsonl"),
        now: new Date("2026-03-15T00:00:00Z"),
        fetcher: invalidJsonFetcher,
        wait: async () => {},
      }),
    ).rejects.toThrow(/remained unclassified.*more than 30%/i);
    const folder = join(outputRoot, "@creator", "2026-03-15");
    const stats = JSON.parse(
      await readFile(join(folder, "stats.json"), "utf8"),
    ) as {
      batches: { failed: { reason: string }[] };
      commentsSentToLlm: number;
    };
    expect(stats.batches.failed).toEqual([
      { batch: 1, reason: "json_parse_failure" },
    ]);
    expect(stats.commentsSentToLlm).toBe(1);
    expect(llmPrompts).toHaveLength(2);
    expect(llmPrompts[1]).toContain("STRICT FORMAT REMINDER");
    await expect(readFile(join(folder, "report.md"), "utf8")).rejects.toThrow();
  });

  it("fails with saved stats when no comments are classified", async () => {
    root = await mkdtemp(join(tmpdir(), "yt-report-run-empty-"));
    process.env.YOUTUBE_API_KEY = "test-key";
    process.env.LLM_API_KEY = "test-llm-key";
    const youtubeFetcher = fetcher();
    const emptyResultFetcher: Fetcher = async (input, init) => {
      if (new URL(String(input)).hostname === "www.googleapis.com")
        return youtubeFetcher(input, init);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "[]" } }],
        }),
        { status: 200 },
      );
    };
    const outputRoot = join(root, "output");
    await expect(
      runChannel({
        channel,
        config: { ...config, provider: "openai", model: "test-model" },
        days: 30,
        send: false,
        outputRoot,
        cacheRoot: join(root, "cache"),
        usagePath: join(root, "usage", "usage.jsonl"),
        now: new Date("2026-03-15T00:00:00Z"),
        fetcher: emptyResultFetcher,
        wait: async () => {},
      }),
    ).rejects.toThrow(/remained unclassified.*more than 30%/i);
    const folder = join(outputRoot, "@creator", "2026-03-15");
    const stats = JSON.parse(
      await readFile(join(folder, "stats.json"), "utf8"),
    ) as {
      failureReason: string;
      classificationSucceeded: boolean;
      commentsSentToLlm: number;
      unclassified: number;
      batches: { failed: { reason: string }[] };
    };
    expect(stats).toMatchObject({
      classificationSucceeded: false,
      commentsSentToLlm: 1,
      unclassified: 1,
      failureReason: "More than 30% of analyzed comments were unclassified.",
      batches: { failed: [{ reason: "coverage_failure" }] },
    });
    await expect(
      readFile(join(folder, "report.html"), "utf8"),
    ).rejects.toThrow();
    await expect(readFile(join(folder, "report.md"), "utf8")).rejects.toThrow();
  });
});
