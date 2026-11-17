import { describe, expect, it } from "vitest";
import {
  fetchAlertCandidates,
  filterQualifiedBuyerCandidates,
  runAlertsCheck,
  type BuyerAlertCandidate,
} from "../src/alerts.js";
import type { AppConfig, ChannelConfig, Fetcher } from "../src/types.js";

const now = new Date("2026-03-15T12:00:00Z");
const channel: ChannelConfig = {
  handle: "@creator",
  creatorName: "Creator",
  creatorGoal: "sell_course",
  recipients: ["creator@example.com"],
  productKeywords: [],
  enabled: true,
  offerDescription: "An online course, coaching service, and nursery.",
  runTime: "08:30",
  timezone: "America/Los_Angeles",
};
const config: AppConfig = {
  provider: "openai",
  model: "test-model",
  limits: {
    maxVideos: 8,
    maxThreadsPerVideo: 300,
    maxUsdPerRun: 0.5,
    maxUsdPerDay: 2,
  },
  channels: [channel],
};

interface MockComment {
  commentId: string;
  text: string;
  postedAt?: string;
  videoId?: string;
  videoTitle?: string;
  videoPostedAt?: string;
  replies?: { authorChannelId: string; text?: string }[];
}

interface MockYouTubeOptions {
  comments?: MockComment[];
  pageComments?: Record<string, MockComment[]>;
}

function alertsFetcher(
  options: MockYouTubeOptions = {},
  qualifiedTexts: Set<string> = new Set(),
  prompts: string[] = [],
  youtubeRequests: URL[] = [],
): Fetcher {
  const comments = options.comments ?? [];
  const allComments = [
    ...comments,
    ...Object.values(options.pageComments ?? {}).flat(),
  ];
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.openai.com") {
      const request = JSON.parse(String(init?.body)) as {
        messages?: { content?: string }[];
      };
      const prompt = request.messages?.[0]?.content ?? "";
      prompts.push(prompt);
      const start = prompt.indexOf("COMMENT DATA START\n");
      const end = prompt.indexOf("\nCOMMENT DATA END", start);
      const supplied = JSON.parse(
        prompt.slice(start + "COMMENT DATA START\n".length, end),
      ) as { id: number; text: string }[];
      const response = supplied.map(({ id, text }) => ({
        id,
        verdict: qualifiedTexts.has(text),
        reason: qualifiedTexts.has(text)
          ? "It asks about this offer.\nThe request is commercial."
          : "It is not a purchase request.",
      }));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(response) } }],
        }),
        { status: 200 },
      );
    }

    youtubeRequests.push(url);
    const endpoint = url.pathname.split("/").at(-1);
    let payload: unknown = {};
    if (endpoint === "channels") {
      payload = {
        items: [
          {
            id: "UCcreator",
            contentDetails: { relatedPlaylists: { uploads: "UUcreator" } },
          },
        ],
      };
    } else if (endpoint === "playlistItems") {
      const videoIds = [
        ...new Set(allComments.map((comment) => comment.videoId ?? "video1")),
      ];
      payload = {
        items: videoIds.map((videoId) => ({
          snippet: {
            publishedAt: "2026-03-14T12:00:00Z",
            resourceId: { videoId },
          },
        })),
      };
    } else if (endpoint === "videos") {
      const requestedIds = (url.searchParams.get("id") ?? "").split(",");
      payload = {
        items: requestedIds.map((videoId) => ({
          id: videoId,
          snippet: {
            title:
              allComments.find((comment) => comment.videoId === videoId)
                ?.videoTitle ?? "Video",
            publishedAt:
              allComments.find((comment) => comment.videoId === videoId)
                ?.videoPostedAt ?? "2026-03-10T12:00:00Z",
          },
        })),
      };
    } else if (endpoint === "commentThreads") {
      const videoId = url.searchParams.get("videoId") ?? "video1";
      const pageToken = url.searchParams.get("pageToken") ?? "first";
      const pageComments =
        options.pageComments?.[pageToken] ??
        comments.filter((comment) => (comment.videoId ?? "video1") === videoId);
      payload = {
        items: pageComments.map((comment) => {
          const replies = comment.replies ?? [];
          return {
            snippet: {
              totalReplyCount: replies.length,
              topLevelComment: {
                id: comment.commentId,
                snippet: {
                  textOriginal: comment.text,
                  publishedAt: comment.postedAt ?? "2026-03-14T12:00:00Z",
                  authorChannelId: { value: "UCviewer" },
                },
              },
            },
            replies: {
              comments: replies.map((reply, index) => ({
                id: `${comment.commentId}.reply${index + 1}`,
                snippet: {
                  authorChannelId: { value: reply.authorChannelId },
                  textOriginal: reply.text ?? "Reply",
                },
              })),
            },
          };
        }),
        ...(pageToken === "first" && options.pageComments?.second
          ? { nextPageToken: "second" }
          : {}),
      };
    }
    return new Response(JSON.stringify(payload), { status: 200 });
  };
}

function candidate(
  values: Partial<BuyerAlertCandidate> & Pick<BuyerAlertCandidate, "commentId">,
): BuyerAlertCandidate {
  return {
    text: "I would like to buy this.",
    videoId: "video1",
    videoTitle: "Video",
    postedAt: "2026-03-14T12:00:00Z",
    videoPostedAt: "2026-03-10T12:00:00Z",
    link: "https://www.youtube.com/watch?v=video1&lc=comment1",
    creatorReplied: false,
    ...values,
  };
}

describe("buyer alert checks", () => {
  it("qualifies buyer-intent types and excludes unrelated comment classes", async () => {
    const buyerComments = [
      "Do you sell tomato, pepper plants and a variety of veggies, strawberry plants?",
      "How can I enroll in the course?",
      "Are spots still open for coaching?",
      "What is included in the course?",
      "How much does coaching cost?",
      "Can I pay from Canada for the course?",
      "Do you ship nursery plants to Canada?",
      "I paid but cannot log in to the course",
    ];
    const excludedComments = [
      "What is the difference between the Bubble Beauty Berry and the Pearl Glam?",
      "Almost worth renewing my Adobe subscription.",
      "Thanks, this video is great!",
      "What camera do you use?",
      "Please make a future video about garden soil.",
      "This video is bad.",
      "I sell marketing services; DM me for a great deal.",
    ];
    const allComments = [...buyerComments, ...excludedComments].map(
      (text, index) => ({
        commentId: `comment${index + 1}`,
        text,
      }),
    );
    const prompts: string[] = [];
    const youtubeRequests: URL[] = [];
    const fetcher = alertsFetcher(
      { comments: allComments },
      new Set(buyerComments),
      prompts,
      youtubeRequests,
    );
    const result = await runAlertsCheck({
      channel,
      config,
      now,
      youtubeApiKey: "test-youtube-key",
      llmApiKey: "test-llm-key",
      fetcher,
      wait: async () => {},
    });

    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("Expected an alert check result.");
    expect(result.comments.map(({ text }) => text)).toEqual(buyerComments);
    expect(result.comments[0]?.reason).toBe(
      "It asks about this offer. The request is commercial.",
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("praise");
    expect(prompts[0]).toContain("general questions about the video's topic");
    expect(prompts[0]).toContain(
      "gear questions unless that gear is the offer",
    );
    expect(prompts[0]).toContain("requests for a future video");
    expect(prompts[0]).toContain("complaints that are not about the offer");
    expect(prompts[0]).toContain("people pitching/promoting themselves");
    expect(prompts[0]).toContain(channel.offerDescription);
    expect(
      youtubeRequests.every((url) => url.hostname === "www.googleapis.com"),
    ).toBe(true);
  });

  it("fetches more than eight recent videos and does not exclude short videos", async () => {
    const comments = Array.from({ length: 9 }, (_, index) => ({
      commentId: `comment${index + 1}`,
      text: `How do I enroll in the course ${index + 1}?`,
      videoId: `video${index + 1}`,
      videoTitle: `Video ${index + 1}`,
    }));
    const fetcher = alertsFetcher(
      { comments },
      new Set(comments.map(({ text }) => text)),
    );

    const result = await runAlertsCheck({
      channel,
      config,
      now,
      youtubeApiKey: "test-youtube-key",
      llmApiKey: "test-llm-key",
      fetcher,
      wait: async () => {},
    });

    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("Expected an alert check result.");
    expect(result.comments).toHaveLength(9);
    expect(new Set(result.comments.map(({ videoId }) => videoId)).size).toBe(9);
  });

  it("does not mistake a viewer reply for a creator reply, but excludes a channel reply", async () => {
    const viewerReplyText = "How can I enroll in the course?";
    const creatorReplyText = "Are spots still open for coaching?";
    const fetcher = alertsFetcher(
      {
        comments: [
          {
            commentId: "viewer-replied",
            text: viewerReplyText,
            replies: [{ authorChannelId: "UCviewer2" }],
          },
          {
            commentId: "creator-replied",
            text: creatorReplyText,
            replies: [{ authorChannelId: "UCcreator" }],
          },
        ],
      },
      new Set([viewerReplyText, creatorReplyText]),
    );

    const result = await runAlertsCheck({
      channel,
      config,
      now,
      youtubeApiKey: "test-youtube-key",
      llmApiKey: "test-llm-key",
      fetcher,
      wait: async () => {},
    });

    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("Expected an alert check result.");
    expect(result.comments.map(({ commentId }) => commentId)).toEqual([
      "viewer-replied",
    ]);
  });

  it("applies the seven-day comment and 30-day video limits in code", () => {
    const candidates = [
      candidate({
        commentId: "eight-days",
        postedAt: "2026-03-07T12:00:00Z",
      }),
      candidate({
        commentId: "old-video",
        videoPostedAt: "2026-02-12T12:00:00Z",
      }),
      candidate({ commentId: "eligible" }),
    ];
    const qualifications = candidates.map(({ commentId }) => ({
      commentId,
      verdict: true,
      reason: "It is about buying the offer.",
    }));

    expect(
      filterQualifiedBuyerCandidates(candidates, qualifications, now).map(
        ({ commentId }) => commentId,
      ),
    ).toEqual(["eligible"]);
  });

  it("does not fetch videos older than 30 days", async () => {
    const requests: URL[] = [];
    const fetcher = alertsFetcher(
      {
        comments: [
          {
            commentId: "old-video-comment",
            text: "How do I buy the course?",
            videoId: "old-video",
            videoPostedAt: "2026-02-12T12:00:00Z",
          },
        ],
      },
      new Set(),
      [],
      requests,
    );

    const candidates = await fetchAlertCandidates({
      apiKey: "test-youtube-key",
      handleOrId: "@creator",
      now,
      fetcher,
      wait: async () => {},
    });

    expect(candidates).toEqual([]);
    expect(requests.some((url) => url.pathname.endsWith("/videos"))).toBe(true);
  });

  it("stops comment paging as soon as a thread is older than the cutoff", async () => {
    const requests: URL[] = [];
    const fetcher = alertsFetcher(
      {
        pageComments: {
          first: [
            {
              commentId: "recent",
              text: "Recent comment",
              postedAt: "2026-03-14T12:00:00Z",
            },
            {
              commentId: "past-cutoff",
              text: "Old comment",
              postedAt: "2026-03-07T12:00:00Z",
            },
          ],
          second: [
            {
              commentId: "must-not-fetch",
              text: "Older comment",
              postedAt: "2026-03-06T12:00:00Z",
            },
          ],
        },
      },
      new Set(),
      [],
      requests,
    );

    const candidates = await fetchAlertCandidates({
      apiKey: "test-youtube-key",
      handleOrId: "@creator",
      now,
      fetcher,
      wait: async () => {},
    });

    const commentThreadRequests = requests.filter((url) =>
      url.pathname.endsWith("/commentThreads"),
    );
    expect(candidates.map(({ commentId }) => commentId)).toEqual(["recent"]);
    expect(commentThreadRequests).toHaveLength(1);
    expect(commentThreadRequests[0]?.searchParams.get("order")).toBe("time");
  });

  it("uses the last successful pass with one day of overlap", async () => {
    const requests: URL[] = [];
    const fetcher = alertsFetcher(
      {
        pageComments: {
          first: [
            {
              commentId: "overlap",
              text: "Comment in overlap",
              postedAt: "2026-03-13T00:00:00Z",
            },
            {
              commentId: "before-overlap",
              text: "Before overlap",
              postedAt: "2026-03-10T23:59:59Z",
            },
          ],
        },
      },
      new Set(),
      [],
      requests,
    );

    const candidates = await fetchAlertCandidates({
      apiKey: "test-youtube-key",
      handleOrId: "@creator",
      now,
      lastSuccessfulPass: new Date("2026-03-12T00:00:00Z"),
      fetcher,
      wait: async () => {},
    });

    expect(candidates.map(({ commentId }) => commentId)).toEqual(["overlap"]);
  });

  it("returns an empty result without calling email or persistence code", async () => {
    const requests: URL[] = [];
    const fetcher = alertsFetcher({}, new Set(), [], requests);

    const result = await runAlertsCheck({
      channel,
      config,
      now,
      youtubeApiKey: "test-youtube-key",
      fetcher,
      wait: async () => {},
    });

    expect(result).toEqual({ skipped: false, comments: [] });
    expect(requests.every((url) => url.hostname === "www.googleapis.com")).toBe(
      true,
    );
  });

  it("skips a disabled channel without fetching or calling the LLM", async () => {
    const disabledChannel = { ...channel, enabled: false };
    const requests: URL[] = [];
    const fetcher = alertsFetcher({}, new Set(), [], requests);

    const result = await runAlertsCheck({
      channel: disabledChannel,
      config,
      now,
      fetcher,
    });

    expect(result).toEqual({
      skipped: true,
      reason: "Buyer alerts are not enabled for this channel.",
    });
    expect(requests).toEqual([]);
  });
});
