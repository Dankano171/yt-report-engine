import { describe, expect, it } from "vitest";
import { buildDeepLink, fetchChannelData } from "../src/youtube.js";
import type { Fetcher } from "../src/types.js";

const publishedAt = "2026-03-10T12:00:00Z";
const now = new Date("2026-03-15T00:00:00Z");

function fakeYouTubeFetch(): Fetcher {
  return async (input) => {
    const url = new URL(String(input));
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
      payload = {
        items: ["short1", "video2"].map((videoId) => ({
          snippet: { publishedAt, resourceId: { videoId } },
        })),
      };
    } else if (endpoint === "videos") {
      payload = {
        items: [
          {
            id: "short1",
            snippet: { title: "Short", description: "", publishedAt },
            statistics: { viewCount: "500", commentCount: "0" },
            contentDetails: { duration: "PT45S" },
          },
          {
            id: "video2",
            snippet: {
              title: "Long video",
              description: "Links and chapters",
              publishedAt,
            },
            statistics: { viewCount: "1200", commentCount: "1" },
            contentDetails: { duration: "PT2M10S" },
          },
        ],
      };
    } else if (endpoint === "commentThreads") {
      payload = {
        items: [
          {
            snippet: {
              totalReplyCount: 1,
              topLevelComment: {
                id: "comment-1",
                snippet: {
                  textOriginal: "How do I use this?",
                  textDisplay: "How do I use this?",
                  likeCount: 7,
                  publishedAt,
                  authorChannelId: { value: "UCviewer" },
                },
              },
            },
            replies: {
              comments: [
                {
                  id: "comment-1.reply-1",
                  snippet: { authorChannelId: { value: "UCcreator" } },
                },
              ],
            },
          },
        ],
      };
    }
    return new Response(JSON.stringify(payload), { status: 200 });
  };
}

describe("YouTube data", () => {
  it("filters short videos and detects creator replies", async () => {
    const result = await fetchChannelData({
      apiKey: "test-key",
      handleOrId: "@creator",
      days: 30,
      maxVideos: 8,
      maxThreadsPerVideo: 300,
      now,
      fetcher: fakeYouTubeFetch(),
      wait: async () => {},
    });
    expect(result.videos.map((video) => video.videoId)).toEqual(["video2"]);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.text).toBe("How do I use this?");
    expect(result.comments[0]?.likeCount).toBe(7);
    expect(result.comments[0]?.authorChannelId).toBe("UCviewer");
    expect(result.comments[0]?.publishedAt).toBe(publishedAt);
    expect(result.comments[0]?.creatorReplied).toBe(true);
    expect(result.comments[0]?.creatorReplyId).toBe("comment-1.reply-1");
    expect(result.comments[0]?.totalReplyCount).toBe(1);
  });

  it("builds the canonical comment deep link", () => {
    expect(buildDeepLink("video 1", "comment/2")).toBe(
      "https://www.youtube.com/watch?v=video%201&lc=comment%2F2",
    );
  });

  it("uses the complete API reply id without duplicating its parent id", () => {
    expect(buildDeepLink("video1", "comment1", "comment1.reply1")).toBe(
      "https://www.youtube.com/watch?v=video1&lc=comment1.reply1",
    );
  });

  it("requests plain text and decodes the textDisplay fallback", async () => {
    const requestedUrls: URL[] = [];
    const baseFetch = fakeYouTubeFetch();
    const fetcher: Fetcher = async (input, init) => {
      const url = new URL(String(input));
      requestedUrls.push(url);
      const response = await baseFetch(input, init);
      const payload = (await response.json()) as {
        items?: {
          snippet?: {
            totalReplyCount?: number;
            topLevelComment?: { snippet?: Record<string, unknown> };
          };
        }[];
      };
      const thread = payload.items?.[0];
      const snippet = thread?.snippet?.topLevelComment?.snippet;
      if (snippet) {
        delete snippet.textOriginal;
        snippet.textDisplay = "<b>How</b> &amp; where?";
        if (thread?.snippet) thread.snippet.totalReplyCount = 2;
      }
      return new Response(JSON.stringify(payload), { status: 200 });
    };
    const result = await fetchChannelData({
      apiKey: "test-key",
      handleOrId: "@creator",
      days: 30,
      maxVideos: 8,
      maxThreadsPerVideo: 300,
      now,
      fetcher,
      wait: async () => {},
    });
    expect(result.comments[0]?.text).toBe("How & where?");
    expect(
      requestedUrls
        .filter((url) => /\/(?:commentThreads|comments)$/.test(url.pathname))
        .every((url) => url.searchParams.get("textFormat") === "plainText"),
    ).toBe(true);
    const threadRequest = requestedUrls.find((url) =>
      url.pathname.endsWith("/commentThreads"),
    );
    expect(threadRequest?.searchParams.get("part")).toBe("snippet,replies");
    expect(
      requestedUrls.some((url) => url.pathname.endsWith("/comments")),
    ).toBe(true);
  });
});
