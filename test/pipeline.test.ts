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

function fetcher(): Fetcher {
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
        items: [
          {
            snippet: {
              totalReplyCount: 0,
            },
            topLevelComment: {
              id: "comment1",
              snippet: {
                textOriginal: "How do I set this up?",
                likeCount: 8,
                publishedAt: "2026-03-11T12:00:00Z",
                authorChannelId: { value: "UCviewer" },
              },
            },
          },
        ],
      },
    };
    return new Response(JSON.stringify(data[endpoint ?? ""]), { status: 200 });
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
  });
});
