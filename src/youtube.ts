import { QuotaError, redactSecrets } from "./errors.js";
import type { CommentRecord, Fetcher, VideoRecord } from "./types.js";

interface YouTubeResult {
  channelId: string;
  videos: VideoRecord[];
  comments: CommentRecord[];
  quotaUnits: number;
}

interface YouTubeOptions {
  apiKey: string;
  handleOrId: string;
  days: number;
  maxVideos: number;
  maxThreadsPerVideo: number;
  now?: Date;
  fetcher?: Fetcher;
  wait?: (milliseconds: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function durationSeconds(duration: string): number {
  const match = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  return (
    Number(match[1] ?? 0) * 3600 +
    Number(match[2] ?? 0) * 60 +
    Number(match[3] ?? 0)
  );
}

async function apiGet<T>(
  endpoint: string,
  params: Record<string, string>,
  apiKey: string,
  fetcher: Fetcher,
  wait: (milliseconds: number) => Promise<void>,
): Promise<T> {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  url.searchParams.set("key", apiKey);
  let lastError: Error = new Error("YouTube request failed.");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: { accept: "application/json" },
      });
    } catch (error) {
      lastError = new Error(
        redactSecrets(error instanceof Error ? error.message : String(error)),
      );
      if (attempt < 2) await wait(250 * 2 ** attempt);
      continue;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    if (response.ok) return body as T;
    const apiError = object(object(body).error);
    const errors = array(apiError.errors).map(object);
    const reason = string(errors[0]?.reason);
    const message = redactSecrets(
      string(apiError.message) || response.statusText || "YouTube API error.",
    );
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      throw new QuotaError(`YouTube quota exhausted: ${message}`);
    }
    if (response.status === 403 && reason === "commentsDisabled") {
      throw new Error("COMMENTS_DISABLED");
    }
    if (response.status === 429) {
      throw new QuotaError(`YouTube quota/rate limit reached: ${message}`);
    }
    if (response.status >= 500 && attempt < 2) {
      await wait(250 * 2 ** attempt);
      continue;
    }
    throw new Error(
      `YouTube API request failed (${response.status}): ${message}`,
    );
  }
  throw lastError;
}

function commentFrom(
  raw: unknown,
  videoId: string,
  totalReplyCount: number,
  creatorReplied: boolean,
  creatorReplyId?: string,
): CommentRecord {
  const snippet = object(object(raw).snippet);
  const author = object(snippet.authorChannelId);
  return {
    commentId: string(object(raw).id),
    videoId,
    text: string(snippet.textOriginal) || string(snippet.textDisplay),
    likeCount: number(snippet.likeCount),
    publishedAt: string(snippet.publishedAt),
    totalReplyCount,
    ...(string(author.value) ? { authorChannelId: string(author.value) } : {}),
    creatorReplied,
    ...(creatorReplyId ? { creatorReplyId } : {}),
  };
}

export async function fetchChannelData(
  options: YouTubeOptions,
): Promise<YouTubeResult> {
  const fetcher = options.fetcher ?? fetch;
  const wait =
    options.wait ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let quotaUnits = 0;
  const channelParam = options.handleOrId.startsWith("UC")
    ? { id: options.handleOrId }
    : { forHandle: options.handleOrId.replace(/^@/, "") };
  const channelResponse = await apiGet<{ items?: unknown[] }>(
    "channels",
    { part: "snippet,contentDetails", ...channelParam },
    options.apiKey,
    fetcher,
    wait,
  );
  quotaUnits += 1;
  const channel = object(array(channelResponse.items)[0]);
  const channelId = string(channel.id);
  const uploadsPlaylistId = string(
    object(object(channel.contentDetails).relatedPlaylists).uploads,
  );
  if (!channelId || !uploadsPlaylistId)
    throw new Error(`No public channel was found for ${options.handleOrId}.`);

  const since = new Date(
    (options.now ?? new Date()).getTime() - options.days * 86_400_000,
  );
  const videoIds: string[] = [];
  let pageToken: string | undefined;
  let stop = false;
  while (!stop) {
    const params = {
      part: "snippet,contentDetails",
      playlistId: uploadsPlaylistId,
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    };
    const page = await apiGet<{ items?: unknown[]; nextPageToken?: string }>(
      "playlistItems",
      params,
      options.apiKey,
      fetcher,
      wait,
    );
    quotaUnits += 1;
    for (const item of array(page.items)) {
      const snippet = object(object(item).snippet);
      const publishedAt = string(snippet.publishedAt);
      if (publishedAt && new Date(publishedAt) < since) {
        stop = true;
        break;
      }
      const id = string(object(snippet.resourceId).videoId);
      if (id) videoIds.push(id);
    }
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }

  const videos: VideoRecord[] = [];
  for (
    let index = 0;
    index < videoIds.length && videos.length < options.maxVideos;
    index += 50
  ) {
    const ids = videoIds.slice(index, index + 50);
    const response = await apiGet<{ items?: unknown[] }>(
      "videos",
      { part: "snippet,statistics,contentDetails", id: ids.join(",") },
      options.apiKey,
      fetcher,
      wait,
    );
    quotaUnits += 1;
    for (const raw of array(response.items)) {
      const item = object(raw);
      const snippet = object(item.snippet);
      const seconds = durationSeconds(
        string(object(item.contentDetails).duration),
      );
      const publishedAt = string(snippet.publishedAt);
      if (seconds < 70 || !publishedAt || new Date(publishedAt) < since)
        continue;
      videos.push({
        videoId: string(item.id),
        title: string(snippet.title),
        description: string(snippet.description),
        publishedAt,
        viewCount: number(object(item.statistics).viewCount),
        commentCount: number(object(item.statistics).commentCount),
        durationSeconds: seconds,
      });
      if (videos.length >= options.maxVideos) break;
    }
  }

  options.onProgress?.(`${videos.length} videos found.`);
  const comments: CommentRecord[] = [];
  for (const [videoIndex, video] of videos.entries()) {
    options.onProgress?.(
      `Fetching comments for video ${videoIndex + 1} of ${videos.length}.`,
    );
    let threadsRead = 0;
    let token: string | undefined;
    while (threadsRead < options.maxThreadsPerVideo) {
      const params = {
        part: "snippet,replies",
        videoId: video.videoId,
        maxResults: String(
          Math.min(100, options.maxThreadsPerVideo - threadsRead),
        ),
        order: "time",
        ...(token ? { pageToken: token } : {}),
      };
      let page: { items?: unknown[]; nextPageToken?: string };
      try {
        page = await apiGet(
          "commentThreads",
          params,
          options.apiKey,
          fetcher,
          wait,
        );
      } catch (error) {
        if (error instanceof Error && error.message === "COMMENTS_DISABLED")
          break;
        throw error;
      }
      quotaUnits += 1;
      const threadList = array(page.items);
      for (const threadRaw of threadList) {
        const thread = object(threadRaw);
        const threadSnippet = object(thread.snippet);
        const totalReplies = number(threadSnippet.totalReplyCount);
        const replies = array(object(thread.replies).comments);
        const creatorReply = replies.find(
          (reply) =>
            string(
              object(object(object(reply).snippet).authorChannelId).value,
            ) === channelId,
        );
        let creatorReplied = Boolean(creatorReply);
        let creatorReplyId = creatorReply
          ? string(object(creatorReply).id) || undefined
          : undefined;
        if (totalReplies > replies.length) {
          let replyToken: string | undefined;
          let repliesLoaded = 0;
          do {
            const replyPage = await apiGet<{
              items?: unknown[];
              nextPageToken?: string;
            }>(
              "comments",
              {
                part: "snippet",
                parentId: string(object(thread.topLevelComment).id),
                maxResults: "100",
                ...(replyToken ? { pageToken: replyToken } : {}),
              },
              options.apiKey,
              fetcher,
              wait,
            );
            quotaUnits += 1;
            const loaded = array(replyPage.items);
            const loadedCreatorReply = loaded.find(
              (reply) =>
                string(
                  object(object(object(reply).snippet).authorChannelId).value,
                ) === channelId,
            );
            creatorReplied ||= Boolean(loadedCreatorReply);
            creatorReplyId ||=
              (loadedCreatorReply
                ? string(object(loadedCreatorReply).id)
                : "") || undefined;
            repliesLoaded += loaded.length;
            replyToken = replyPage.nextPageToken;
          } while (replyToken && repliesLoaded < totalReplies);
        }
        comments.push(
          commentFrom(
            thread.topLevelComment,
            video.videoId,
            totalReplies,
            creatorReplied,
            creatorReplyId,
          ),
        );
      }
      threadsRead += threadList.length;
      token = page.nextPageToken;
      if (!token || threadList.length === 0) break;
    }
  }
  return { channelId, videos, comments, quotaUnits };
}

export function buildDeepLink(
  videoId: string,
  commentId: string,
  replyId?: string,
): string {
  const linkedCommentId = replyId ? `${commentId}.${replyId}` : commentId;
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&lc=${encodeURIComponent(linkedCommentId)}`;
}

export function parseDurationSeconds(value: string): number {
  return durationSeconds(value);
}
