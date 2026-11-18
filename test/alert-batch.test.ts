import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runDailyAlerts,
  runWeeklyAlerts,
  skipTodayAlert,
} from "../src/alert-batch.js";
import { parseChannelFile, readChannelFile } from "../src/alert-channels.js";
import { createAlertDraft } from "../src/alert-drafts.js";
import { AlertBudgetExceededError } from "../src/errors.js";
import type { AppConfig, ChannelConfig } from "../src/types.js";
import type { EvaluatedBuyerAlertCandidate } from "../src/alerts.js";

const now = new Date("2026-03-15T12:00:00.000Z");
const config: AppConfig = {
  provider: "openai",
  model: "test-model",
  limits: {
    maxVideos: 8,
    maxThreadsPerVideo: 300,
    maxUsdPerRun: 0.5,
    maxUsdPerDay: 2,
  },
  channels: [],
};
let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function setup(contents: string) {
  root = await mkdtemp(join(tmpdir(), "yt-report-alert-batch-"));
  const channelsPath = join(root, "channels.txt");
  await writeFile(channelsPath, contents);
  return {
    root,
    channelsPath,
    outputRoot: join(root, "output"),
    dbPath: join(root, "data", "alerts.db"),
    skipPath: join(root, "skip.txt"),
    usagePath: join(root, "usage.jsonl"),
  };
}

function channel(handle: string, name = handle): ChannelConfig {
  return {
    handle,
    creatorName: name,
    creatorGoal: "grow_audience",
    recipients: [`${handle.slice(1)}@example.com`],
    productKeywords: [],
    enabled: true,
    offerDescription: "A gardening course.",
  };
}

function candidate(
  handle: string,
  overrides: Partial<EvaluatedBuyerAlertCandidate> = {},
): EvaluatedBuyerAlertCandidate {
  return {
    commentId: `${handle}-comment`,
    text: "How do I buy the course?",
    videoId: "video-1",
    videoTitle: "Growing vegetables",
    postedAt: now.toISOString(),
    videoPostedAt: "2026-03-10T12:00:00.000Z",
    link: "https://www.youtube.com/watch?v=video-1&lc=comment-1",
    creatorReplied: false,
    qualifies: true,
    ...overrides,
  };
}

async function makeDraft(options: {
  root: string;
  outputRoot: string;
  dbPath: string;
  channel: ChannelConfig;
  at: Date;
  text?: string;
}) {
  const date = options.at.toISOString().slice(0, 10);
  return createAlertDraft({
    channel: options.channel,
    config,
    now: options.at,
    dbPath: options.dbPath,
    outputDirectory: join(options.outputRoot, date),
    fileBase: options.channel.handle!,
    check: async () => ({
      skipped: false,
      comments: [],
      candidates: [
        candidate(options.channel.handle!, {
          postedAt: options.at.toISOString(),
          ...(options.text ? { text: options.text } : {}),
        }),
      ],
    }),
    makeReply: async () => "Please see the course details.",
  });
}

describe("channel list parsing", () => {
  it("ignores comments, reports invalid and case-insensitive duplicate handles, and reads optional fields", () => {
    const parsed = parseChannelFile(
      [
        "# example",
        "",
        "@Gardening | Garden Creator | A gardening course",
        "@GARDENING | Duplicate | Something else |",
        "not-a-handle | Bad | Offer",
        "@Shop | Shop Creator | Useful tools | hello@example.com | https://example.com/buy",
        "@BadLink | Name | Offer | | ftp://example.com/item",
        "@NoMail | No Mail | A tool |",
      ].join("\n"),
    );

    expect(parsed.channels.map((item) => item.handle)).toEqual([
      "@gardening",
      "@shop",
      "@nomail",
    ]);
    expect(parsed.channels[0]).toMatchObject({
      recipients: [],
      offerDescription: "A gardening course",
    });
    expect(parsed.channels[1]).toMatchObject({
      recipients: ["hello@example.com"],
      purchaseLink: "https://example.com/buy",
    });
    expect(parsed.issues).toEqual([
      { line: 4, reason: "duplicate channel handle" },
      { line: 5, reason: "invalid channel line" },
      { line: 7, reason: "invalid channel line" },
    ]);
  });

  it("creates a commented example channel file when the file is missing", async () => {
    root = await mkdtemp(join(tmpdir(), "yt-report-alert-missing-channels-"));
    const path = join(root, "data", "channels.txt");

    await expect(readChannelFile(path, () => {})).resolves.toEqual([]);
    expect(await readFile(path, "utf8")).toContain("# @handle | Creator name");
  });
});

describe("daily alert batches", () => {
  it("auto-confirms only older, unskipped drafts and isolates one failing channel", async () => {
    const paths = await setup(
      [
        "@garden | Garden | Gardening course",
        "@skipme | Skip Me | Gardening course",
        "@broken | Broken | Gardening course",
      ].join("\n"),
    );
    const garden = channel("@garden", "Garden");
    const skipme = channel("@skipme", "Skip Me");
    const yesterday = new Date("2026-03-14T12:00:00.000Z");
    await makeDraft({ ...paths, channel: garden, at: yesterday });
    await makeDraft({ ...paths, channel: skipme, at: yesterday });
    await makeDraft({ ...paths, channel: garden, at: now });
    await writeFile(paths.skipPath, "# temporary skip\n@SKIPME\n");
    const warnings: string[] = [];

    const result = await runDailyAlerts({
      config,
      ...paths,
      now,
      warn: (message) => warnings.push(message),
      createDraft: async (draftOptions) => {
        if (draftOptions.channel.handle === "@broken")
          throw new Error("channel failure");
        if (draftOptions.channel.handle === "@garden")
          return createAlertDraft({
            ...draftOptions,
            check: async () => ({
              skipped: false,
              comments: [],
              candidates: [
                candidate("@garden", { commentId: "today-comment" }),
              ],
            }),
            makeReply: async () => "Please see the course details.",
          });
        return { status: "nothing" };
      },
    });

    expect(warnings).toEqual(["@broken failed: channel failure"]);
    expect(result.autoConfirmed).toBe(1);
    expect(result.channels.map(({ status }) => status)).toEqual([
      "drafted",
      "nothing",
      "failed",
    ]);
    const todayDirectory = join(paths.outputRoot, "2026-03-15");
    await expect(
      access(join(todayDirectory, "@garden.pending.json")),
    ).resolves.toBeUndefined();
    const yesterdayFiles = await readdir(join(paths.outputRoot, "2026-03-14"));
    expect(yesterdayFiles).toContain("@garden.sent.json");
    expect(yesterdayFiles).toContain("@skipme.pending.json");
    expect(yesterdayFiles).not.toContain("@garden.pending.json");
    expect(result.allFailed).toBe(false);
  });

  it("writes same-day markdown and pending files, overwrites reruns, and escapes dashboard content", async () => {
    const paths = await setup(
      [
        "@safe | Safe Creator | Gardening course | safe@example.com",
        "@bad | Bad Creator | Gardening course",
      ].join("\n"),
    );
    let text = "<script>alert(1)</script>";
    const run = () =>
      runDailyAlerts({
        config,
        ...paths,
        now,
        createDraft: async (draftOptions) => {
          if (draftOptions.channel.handle === "@bad")
            throw new Error("temporary provider failure");
          return createAlertDraft({
            ...draftOptions,
            check: async () => ({
              skipped: false,
              comments: [],
              candidates: [candidate("@safe", { text })],
            }),
            makeReply: async () => "Thanks for asking!",
          });
        },
      });

    const first = await run();
    const firstHtml = await readFile(
      join(paths.outputRoot, "2026-03-15", "dashboard.html"),
      "utf8",
    );
    text = "Updated question";
    const result = await run();
    const day = join(paths.outputRoot, "2026-03-15");
    const files = await readdir(day);
    expect(files).toEqual(
      expect.arrayContaining([
        "@safe.md",
        "@safe.pending.json",
        "summary.json",
        "dashboard.html",
      ]),
    );
    expect(files.filter((file) => file === "@safe.md")).toHaveLength(1);
    expect(await readFile(join(day, "@safe.md"), "utf8")).toContain(
      "Updated question",
    );
    expect(firstHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(firstHtml).not.toContain("<script>alert(1)</script>");
    expect(firstHtml).toContain("safe@example.com");
    expect(firstHtml).toContain("Growing vegetables");
    expect(firstHtml).toContain("Copy");
    expect(firstHtml).not.toMatch(/<(?:script|link)[^>]+(?:src|href)=/iu);
    const summary = await readFile(join(day, "summary.json"), "utf8");
    expect(summary).not.toContain("LLM_API_KEY");
    expect(summary).not.toContain("Updated question");
    expect(result.dashboardPath).toBe(join(day, "dashboard.html"));
    expect(first.channels[0]?.status).toBe("drafted");
  });

  it("marks a budget-limited channel and reports all-channel failure", async () => {
    const paths = await setup(
      "@budget | Budget | A course\n@error | Error | A course",
    );
    const budget = await runDailyAlerts({
      config,
      ...paths,
      now,
      createDraft: async (draftOptions) => {
        if (draftOptions.channel.handle === "@budget")
          throw new AlertBudgetExceededError();
        throw new Error("failed");
      },
    });
    expect(budget.channels.map(({ status }) => status)).toEqual([
      "skipped: budget",
      "failed",
    ]);

    const failed = await runDailyAlerts({
      config,
      ...paths,
      now,
      createDraft: async () => {
        throw new Error("failed");
      },
    });
    expect(failed.allFailed).toBe(true);
  });

  it("writes no channel draft files when no comments qualify", async () => {
    const paths = await setup("@empty | Empty | A course");
    await runDailyAlerts({
      config,
      ...paths,
      now,
      createDraft: (draftOptions) =>
        createAlertDraft({
          ...draftOptions,
          check: async () => ({
            skipped: false,
            comments: [],
            candidates: [],
          }),
          makeReply: async () => "unused",
        }),
    });

    const files = await readdir(join(paths.outputRoot, "2026-03-15"));
    expect(files).toEqual(
      expect.arrayContaining(["dashboard.html", "summary.json"]),
    );
    expect(files.some((file) => file.endsWith(".md"))).toBe(false);
    expect(files.some((file) => file.endsWith(".pending.json"))).toBe(false);
  });

  it("skip removes only today's pending sidecar", async () => {
    const paths = await setup("@skipme | Skip Me | Gardening course");
    const channelConfig = channel("@skipme");
    await makeDraft({ ...paths, channel: channelConfig, at: now });

    await expect(
      skipTodayAlert({
        channel: "@SKIPME",
        now,
        outputRoot: paths.outputRoot,
      }),
    ).resolves.toBe(true);
    await expect(
      access(join(paths.outputRoot, "2026-03-15", "@skipme.pending.json")),
    ).rejects.toThrow();
    await expect(
      skipTodayAlert({
        channel: "@skipme",
        now,
        outputRoot: paths.outputRoot,
      }),
    ).resolves.toBe(false);
  });
});

describe("weekly viewer requests", () => {
  it("writes one repeated request, stays silent for other channels, and backs up the database", async () => {
    const paths = await setup(
      "@repeat | Repeating Creator | A course\n@quiet | Quiet Creator | A course",
    );
    const viewerComments = (handle: string) => [
      {
        ...candidate(handle, {
          commentId: `${handle}-1`,
          text: "Please make a video about growing herbs.",
          authorChannelId: "viewer-1",
        }),
        videoTitle: "Herb garden basics",
      },
      {
        ...candidate(handle, {
          commentId: `${handle}-2`,
          text: "Could you make a video about growing herbs?",
          authorChannelId: "viewer-2",
        }),
        videoTitle: "Herb garden basics",
      },
    ];
    const weekly = await runWeeklyAlerts({
      config,
      ...paths,
      now,
      fetchComments: async (selected) =>
        selected.handle === "@repeat"
          ? viewerComments(selected.handle)
          : viewerComments(selected.handle),
      classify: async (comments, selected) =>
        selected.handle === "@repeat"
          ? comments.map(({ commentId }) => ({
              commentId,
              category: "topic_request",
            }))
          : [],
      cluster: async (comments) =>
        comments.length > 1 ? [{ title: "Growing herbs", ids: [1, 2] }] : [],
    });

    expect(weekly.findings).toHaveLength(1);
    expect(weekly.findings[0]).toMatchObject({
      count: 2,
      request: "Please make a video about growing herbs.",
    });
    const weeklyDirectory = join(paths.outputRoot, "2026-03-15", "weekly");
    expect(await readdir(weeklyDirectory)).toEqual(["@repeat.md"]);
    const markdown = await readFile(
      join(weeklyDirectory, "@repeat.md"),
      "utf8",
    );
    expect(markdown).toContain("2 distinct viewers");
    expect(markdown).toContain("Please make a video about growing herbs.");
    expect(
      await readFile(
        join(paths.outputRoot, "2026-03-15", "weekly.html"),
        "utf8",
      ),
    ).toContain("2 distinct viewers");
    await expect(
      access(join(paths.outputRoot, "backups", "alerts-2026-03-15.db")),
    ).resolves.toBeUndefined();
  });
});
