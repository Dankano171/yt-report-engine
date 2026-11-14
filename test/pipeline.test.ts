import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

function fetcher(commentCount = 1, texts?: string[]): Fetcher {
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
            topLevelComment: {
              id: `comment${index + 1}`,
              snippet: {
                textOriginal:
                  texts?.[index] ??
                  (index === 0
                    ? "How do I set this up?"
                    : `How do I set this up ${index + 1}?`),
                textDisplay:
                  texts?.[index] ??
                  (index === 0
                    ? "How do I set this up?"
                    : `How do I set this up ${index + 1}?`),
                likeCount: 8,
                publishedAt: "2026-03-11T12:00:00Z",
                authorChannelId: { value: "UCviewer" },
              },
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

function categorizedFetcher(texts: string[], categories: string[]): Fetcher {
  const youtubeFetcher = fetcher(texts.length, texts);
  return async (input, init) => {
    if (new URL(String(input)).hostname === "www.googleapis.com")
      return youtubeFetcher(input, init);
    const request = JSON.parse(String(init?.body)) as {
      messages: { content: string }[];
    };
    const prompt = request.messages[0]?.content ?? "";
    const dataStart = prompt.indexOf("COMMENT DATA START");
    const dataEnd = prompt.indexOf("COMMENT DATA END");
    const dataJsonStart = prompt.indexOf("\n", dataStart) + 1;
    const suppliedComments = JSON.parse(
      prompt.slice(dataJsonStart, dataEnd).trim(),
    ) as { id: number }[];
    const content = JSON.stringify(
      suppliedComments.map(({ id }) => ({
        id,
        category: categories[id - 1],
        timestamp: null,
      })),
    );
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
      reportItemsBySection: { money: 0 },
      droppedQuotes: {
        emptyQuote: 0,
        quoteNotFound: 0,
        unknownComment: 0,
        missingVideo: 0,
      },
    });
  });

  it("excludes creator comments and reconciles fetched, classified, and unclassified counts", async () => {
    root = await mkdtemp(join(tmpdir(), "yt-report-creator-exclusion-"));
    process.env.YOUTUBE_API_KEY = "test-youtube-secret";
    process.env.LLM_API_KEY = "test-llm-secret";
    vi.spyOn(console, "log").mockImplementation(() => {});
    const texts = [
      "I am the creator promoting my affiliate course",
      "",
      "How much does access cost?",
      "This price is wrong and expensive",
      "Please add a lesson",
      "Great explanation",
    ];
    const baseFetcher = categorizedFetcher(texts, [
      "buying_or_sponsor_inquiry",
      "complaint",
      "topic_request",
      "praise",
    ]);
    const dataFetcher: Fetcher = async (input, init) => {
      if (new URL(String(input)).hostname !== "www.googleapis.com")
        return baseFetcher(input, init);
      const response = await baseFetcher(input, init);
      if (!new URL(String(input)).pathname.endsWith("/commentThreads"))
        return response;
      const payload = (await response.json()) as {
        items: {
          snippet: {
            topLevelComment: { snippet: Record<string, unknown> };
          };
        }[];
      };
      payload.items[0]!.snippet.topLevelComment.snippet.authorChannelId = {
        value: "UCcreator",
      };
      payload.items[1]!.snippet.topLevelComment.snippet.textOriginal = "";
      payload.items[1]!.snippet.topLevelComment.snippet.textDisplay = "";
      return new Response(JSON.stringify(payload), { status: 200 });
    };
    const result = await runChannel({
      channel,
      config: { ...config, provider: "openai", model: "test-model" },
      days: 30,
      send: false,
      outputRoot: join(root, "output"),
      cacheRoot: join(root, "cache"),
      usagePath: join(root, "usage", "usage.jsonl"),
      now: new Date("2026-03-15T00:00:00Z"),
      fetcher: dataFetcher,
      wait: async () => {},
    });
    expect(result.stats).toMatchObject({
      commentsFetched: 6,
      creatorComments: 1,
      emptyText: 1,
      commentsExcluded: 2,
      commentsSentToLlm: 4,
      commentsClassified: 4,
      commentsNotAnalyzed: 0,
      unclassified: 0,
      classificationsByCategory: {
        buying_or_sponsor_inquiry: 1,
        complaint_or_objection: 1,
        topic_request: 1,
        praise: 1,
      },
    });
    expect(result.stats.commentsFetched).toBe(
      result.stats.commentsExcluded +
        result.stats.commentsNotAnalyzed +
        result.stats.commentsClassified +
        result.stats.unclassified,
    );
    expect(result.stats.commentsClassified).toBe(
      result.stats.commentsClassifiedByLlm +
        result.stats.commentsClassifiedByRules,
    );
    const markdown = await readFile(
      join(result.reportFolder, "report.md"),
      "utf8",
    );
    expect(markdown).not.toContain(texts[0]);
    expect(markdown).toContain(texts[2]);
    expect(markdown).toContain(texts[3]);
  });

  it("accounts for deterministic noise rules separately from LLM classifications", async () => {
    root = await mkdtemp(join(tmpdir(), "yt-report-accounting-"));
    process.env.YOUTUBE_API_KEY = "test-youtube-secret";
    const result = await runChannel({
      channel,
      config,
      days: 30,
      send: false,
      outputRoot: join(root, "output"),
      cacheRoot: join(root, "cache"),
      usagePath: join(root, "usage", "usage.jsonl"),
      now: new Date("2026-03-15T00:00:00Z"),
      fetcher: fetcher(2, ["How do I set this up?", "thanks"]),
      wait: async () => {},
    });
    expect(result.stats.commentsClassified).toBe(
      result.stats.commentsClassifiedByLlm +
        result.stats.commentsClassifiedByRules,
    );
    expect(result.stats.commentsClassifiedByRules).toBe(1);
    expect(result.stats.commentsClassifiedByLlm).toBe(1);
    expect(result.stats.commentsFetched).toBe(
      result.stats.commentsExcluded +
        result.stats.commentsNotAnalyzed +
        result.stats.commentsClassified +
        result.stats.unclassified,
    );
  });

  it("classifies repeated short phrases as keyword responses without an LLM call", async () => {
    root = await mkdtemp(join(tmpdir(), "yt-report-keyword-response-"));
    process.env.YOUTUBE_API_KEY = "test-youtube-secret";
    let llmCalls = 0;
    const youtubeFetcher = fetcher(5, [
      "FULL course!!!",
      "full course",
      "Full course 🔥",
      "full course?",
      "full course.",
    ]);
    const dataFetcher: Fetcher = async (input, init) => {
      if (new URL(String(input)).hostname === "www.googleapis.com") {
        const response = await youtubeFetcher(input, init);
        if (!new URL(String(input)).pathname.endsWith("/commentThreads"))
          return response;
        const payload = (await response.json()) as {
          items: {
            snippet: {
              topLevelComment: { snippet: Record<string, unknown> };
            };
          }[];
        };
        for (const [index, item] of payload.items.entries())
          item.snippet.topLevelComment.snippet.authorChannelId = {
            value: `viewer-${index + 1}`,
          };
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      llmCalls += 1;
      return new Response("unexpected LLM call", { status: 500 });
    };
    const result = await runChannel({
      channel,
      config,
      days: 30,
      send: false,
      outputRoot: join(root, "output"),
      cacheRoot: join(root, "cache"),
      usagePath: join(root, "usage", "usage.jsonl"),
      now: new Date("2026-03-15T00:00:00Z"),
      fetcher: dataFetcher,
      wait: async () => {},
    });
    expect(llmCalls).toBe(0);
    expect(result.stats.commentsClassified).toBe(5);
    expect(result.stats.classificationsByCategory.keyword_response).toBe(5);
    const markdown = await readFile(
      join(result.reportFolder, "report.md"),
      "utf8",
    );
    expect(markdown).toContain(
      "5 viewers commented a 'full course' variant; the creator replied to 0",
    );
    expect(markdown).toContain("— 5 comments");
    expect(markdown).toContain("comment1");
    expect(markdown).toContain("comment2");
    expect(markdown).toContain("comment3");
    expect(markdown).not.toContain("comment4");
    expect(markdown).not.toContain("comment5");
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

  it("writes prompt and raw response dumps without credentials", async () => {
    root = await mkdtemp(join(tmpdir(), "yt-report-prompt-dump-"));
    process.env.YOUTUBE_API_KEY = "test-youtube-secret";
    process.env.LLM_API_KEY = "test-llm-secret";
    const youtubeFetcher = fetcher(4);
    const geminiFetcher: Fetcher = async (input, init) => {
      if (new URL(String(input)).hostname === "www.googleapis.com")
        return youtubeFetcher(input, init);
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: JSON.stringify(
                      Array.from({ length: 4 }, (_, index) => ({
                        id: index + 1,
                        category: "how_to_question",
                        timestamp: null,
                      })),
                    ),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    };
    const result = await runChannel({
      channel,
      config: { ...config, provider: "gemini", model: "test-model" },
      days: 30,
      send: false,
      dumpPrompt: true,
      dumpYoutube: true,
      outputRoot: join(root, "output"),
      cacheRoot: join(root, "cache"),
      usagePath: join(root, "usage", "usage.jsonl"),
      now: new Date("2026-03-15T00:00:00Z"),
      fetcher: geminiFetcher,
      wait: async () => {},
    });
    const debugFolder = join(result.reportFolder, "debug");
    const prompt = await readFile(
      join(debugFolder, "batch-1-prompt.txt"),
      "utf8",
    );
    const response = await readFile(
      join(debugFolder, "batch-1-response.txt"),
      "utf8",
    );
    expect(prompt).toContain(
      "SYSTEM INSTRUCTION\nClassify each supplied comment",
    );
    expect(prompt).toContain("USER CONTENT");
    expect(prompt).toContain("How do I set this up?");
    expect(prompt).toContain('"likeCount":8');
    expect(response).toContain('\\"category\\":\\"how_to_question\\"');
    expect(prompt).not.toContain("test-llm-secret");
    expect(response).not.toContain("test-llm-secret");
    expect(prompt).not.toContain("test-youtube-secret");
    expect(prompt).not.toContain("generativelanguage.googleapis.com");
    const youtubeSample = await readFile(
      join(debugFolder, "youtube-sample.json"),
      "utf8",
    );
    expect(JSON.parse(youtubeSample)).toHaveLength(3);
    expect(youtubeSample).toContain('"textOriginal": "How do I set this up?"');
    expect(youtubeSample).not.toContain("test-youtube-secret");
    expect(youtubeSample).not.toContain("googleapis.com");
    expect(
      await stat(join(debugFolder, "batch-1-prompt.txt")).then(
        (file) => file.mode & 0o777,
      ),
    ).toBe(0o600);
  });

  it("aborts before classification and records empty YouTube text in stats", async () => {
    root = await mkdtemp(join(tmpdir(), "yt-report-empty-text-"));
    process.env.YOUTUBE_API_KEY = "test-youtube-secret";
    process.env.LLM_API_KEY = "test-llm-secret";
    const youtubeFetcher = fetcher(4);
    let llmCalls = 0;
    const emptyTextFetcher: Fetcher = async (input, init) => {
      if (new URL(String(input)).hostname !== "www.googleapis.com") {
        llmCalls += 1;
        throw new Error("LLM must not be called for blank comments");
      }
      const response = await youtubeFetcher(input, init);
      if (!new URL(String(input)).pathname.endsWith("/commentThreads"))
        return response;
      const payload = (await response.json()) as {
        items: {
          snippet: {
            topLevelComment: { snippet: Record<string, unknown> };
          };
        }[];
      };
      for (const thread of payload.items) {
        thread.snippet.topLevelComment.snippet.textOriginal = "";
        thread.snippet.topLevelComment.snippet.textDisplay = "";
      }
      return new Response(JSON.stringify(payload), { status: 200 });
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
        fetcher: emptyTextFetcher,
        wait: async () => {},
      }),
    ).rejects.toThrow(/text was lost during YouTube commentThreads parsing/i);
    expect(llmCalls).toBe(0);
    const stats = JSON.parse(
      await readFile(
        join(outputRoot, "@creator", "2026-03-15", "stats.json"),
        "utf8",
      ),
    ) as {
      emptyText: number;
      commentsSentToLlm: number;
      failureReason: string;
    };
    expect(stats).toMatchObject({
      emptyText: 4,
      commentsSentToLlm: 0,
    });
    expect(stats.failureReason).toMatch(/commentThreads parsing/);
  });

  it("records suspicious all-noise batches and retries the fallback model", async () => {
    root = await mkdtemp(join(tmpdir(), "yt-report-suspicious-noise-"));
    process.env.YOUTUBE_API_KEY = "test-youtube-secret";
    process.env.LLM_API_KEY = "test-llm-secret";
    const models: string[] = [];
    const youtubeFetcher = fetcher(10);
    const fetcherWithNoise: Fetcher = async (input, init) => {
      if (new URL(String(input)).hostname === "www.googleapis.com")
        return youtubeFetcher(input, init);
      const request = JSON.parse(String(init?.body)) as {
        model: string;
        messages: { content: string }[];
      };
      models.push(request.model);
      const prompt = request.messages[0]?.content ?? "";
      const start = prompt.indexOf("COMMENT DATA START");
      const end = prompt.indexOf("COMMENT DATA END");
      const jsonStart = prompt.indexOf("\n", start) + 1;
      const items = JSON.parse(prompt.slice(jsonStart, end).trim()) as {
        id: number;
      }[];
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  items.map(({ id }) => ({ id, category: "spam_or_noise" })),
                ),
              },
            },
          ],
        }),
        { status: 200 },
      );
    };
    const outputRoot = join(root, "output");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await runChannel({
      channel,
      config: {
        ...config,
        provider: "openai",
        model: "primary-model",
        fallbackModel: "fallback-model",
      },
      days: 30,
      send: false,
      outputRoot,
      cacheRoot: join(root, "cache"),
      usagePath: join(root, "usage", "usage.jsonl"),
      now: new Date("2026-03-15T00:00:00Z"),
      fetcher: fetcherWithNoise,
      wait: async () => {},
    });
    expect(models).toEqual(["primary-model", "fallback-model"]);
    expect(result.stats.suspiciousAllNoise).toBe(true);
    expect(result.stats.classificationSucceeded).toBe(false);
    expect(warning).toHaveBeenCalledWith(
      expect.stringMatching(/suspicious.*spam_or_noise/i),
    );
    const stats = JSON.parse(
      await readFile(join(result.reportFolder, "stats.json"), "utf8"),
    ) as { suspiciousAllNoise: boolean };
    expect(stats.suspiciousAllNoise).toBe(true);
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

  it("classifies 20 comments into report sections using real categories and source quotes", async () => {
    root = await mkdtemp(join(tmpdir(), "yt-report-20-comments-"));
    process.env.YOUTUBE_API_KEY = "test-key";
    process.env.LLM_API_KEY = "test-llm-key";
    const texts = [
      "How much does the course cost?",
      "How do I connect the account?",
      "What is the next setup step?",
      "Please cover monthly budgeting.",
      "This workflow is too expensive.",
      "I saved two hours every week.",
      "Please add French captions.",
      "Could you compare another app?",
      "Make a shorter version please.",
      "Great walkthrough, very clear.",
      ...Array.from(
        { length: 10 },
        (_, index) => `How can I apply lesson ${index + 1}?`,
      ),
    ];
    const categories = [
      "buying_or_sponsor_inquiry",
      "how_to_question",
      "question",
      "request",
      "complaint",
      "testimonial",
      "language_or_subtitles_request",
      "alternative_or_tool_request",
      "format_request",
      "praise",
      ...Array.from({ length: 10 }, () => "how_to_question"),
    ];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await runChannel({
      channel,
      config: { ...config, provider: "openai", model: "test-model" },
      days: 30,
      send: false,
      debug: true,
      outputRoot: join(root, "output"),
      cacheRoot: join(root, "cache"),
      usagePath: join(root, "usage", "usage.jsonl"),
      now: new Date("2026-03-15T00:00:00Z"),
      fetcher: categorizedFetcher(texts, categories),
      wait: async () => {},
    });
    expect(result.stats.unclassified).toBe(0);
    expect(result.stats.classificationsByCategory).toMatchObject({
      buying_or_sponsor_inquiry: 1,
      how_to_question: 12,
      complaint_or_objection: 1,
      testimonial_or_result: 1,
      topic_request: 1,
    });
    expect(result.stats.reportItemsBySection.money).toBeGreaterThan(0);
    expect(result.stats.reportItemsBySection.ideas).toBeGreaterThan(0);
    expect(result.stats.reportItemsBySection.fixes).toBeGreaterThan(0);
    expect(result.stats.reportItemsBySection.proofs).toBeGreaterThan(0);
    const debugOutput = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(debugOutput).toContain('"rawCategoryHistogram"');
    expect(debugOutput).toContain('"mappedCategoryHistogram"');
    expect(debugOutput).toContain('"unmappedCount":0');
    expect(debugOutput).not.toContain(texts[0]);
    const markdown = await readFile(
      join(result.reportFolder, "report.md"),
      "utf8",
    );
    expect(markdown).toContain(texts[0]);
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
