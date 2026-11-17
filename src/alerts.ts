import { QuotaError, redactSecrets } from "./errors.js";
import { qualifyBuyerComments, type BuyerQualification } from "./llm.js";
import { buildDeepLink } from "./youtube.js";
import type { AppConfig, ChannelConfig, Fetcher } from "./types.js";

const DAY_MS = 86_400_000;

export interface BuyerAlertCandidate {
  commentId: string;
  text: string;
  videoId: string;
  videoTitle: string;
  postedAt: string;
  videoPostedAt: string;
  link: string;
  creatorReplied: boolean;
}

export interface EvaluatedBuyerAlertCandidate extends BuyerAlertCandidate {
  qualifies: boolean;
  reason?: string;
}

export interface FetchAlertCandidatesOptions {
  apiKey: string;
  handleOrId: string;
  now?: Date;
  lastSuccessfulPass?: Date;
  fetcher?: Fetcher;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface QualifiedBuyerAlert extends BuyerAlertCandidate {
  reason: string;
}

export type AlertsCheckResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      comments: QualifiedBuyerAlert[];
      candidates?: EvaluatedBuyerAlertCandidate[];
    };

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
      if (response.ok)
        throw new Error("YouTube API returned an invalid JSON response.");
      body = {};
    }
    if (response.ok) return body as T;
    const apiError = object(object(body).error);
    const errors = array(apiError.errors).map(object);
    const reason = string(errors[0]?.reason);
    const message = redactSecrets(
      string(apiError.message) || response.statusText || "YouTube API error.",
    );
    if (reason === "commentsDisabled") throw new Error("COMMENTS_DISABLED");
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded")
      throw new QuotaError(`YouTube quota exhausted: ${message}`);
    if (response.status === 429)
      throw new QuotaError(`YouTube quota/rate limit reached: ${message}`);
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

function getTimestamp(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function replyAuthorId(reply: unknown): string {
  return string(object(object(object(reply).snippet).authorChannelId).value);
}

export async function fetchAlertCandidates(
  options: FetchAlertCandidatesOptions,
): Promise<BuyerAlertCandidate[]> {
  const fetcher = options.fetcher ?? fetch;
  const wait =
    options.wait ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? new Date();
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) throw new Error("Invalid alert check time.");
  const lastSuccessfulTime = options.lastSuccessfulPass?.getTime();
  if (
    lastSuccessfulTime !== undefined &&
    !Number.isFinite(lastSuccessfulTime)
  ) {
    throw new Error("Invalid last successful pass time.");
  }
  const commentCutoff =
    lastSuccessfulTime === undefined
      ? nowTime - 7 * DAY_MS
      : lastSuccessfulTime - DAY_MS;
  const videoCutoff = nowTime - 30 * DAY_MS;

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
  const channel = object(array(channelResponse.items)[0]);
  const channelId = string(channel.id);
  const uploadsPlaylistId = string(
    object(object(channel.contentDetails).relatedPlaylists).uploads,
  );
  if (!channelId || !uploadsPlaylistId)
    throw new Error(`No public channel was found for ${options.handleOrId}.`);

  const videoIds: string[] = [];
  let pageToken: string | undefined;
  let stopPlaylistPaging = false;
  while (!stopPlaylistPaging) {
    const page = await apiGet<{
      items?: unknown[];
      nextPageToken?: string;
    }>(
      "playlistItems",
      {
        part: "snippet,contentDetails",
        playlistId: uploadsPlaylistId,
        maxResults: "50",
        ...(pageToken ? { pageToken } : {}),
      },
      options.apiKey,
      fetcher,
      wait,
    );
    for (const item of array(page.items)) {
      const snippet = object(object(item).snippet);
      const publishedTime = getTimestamp(string(snippet.publishedAt));
      if (publishedTime !== undefined && publishedTime < videoCutoff) {
        stopPlaylistPaging = true;
        break;
      }
      const videoId = string(object(snippet.resourceId).videoId);
      if (videoId) videoIds.push(videoId);
    }
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }

  const videos: { videoId: string; title: string; publishedAt: string }[] = [];
  for (let index = 0; index < videoIds.length; index += 50) {
    const page = await apiGet<{ items?: unknown[] }>(
      "videos",
      {
        part: "snippet",
        id: videoIds.slice(index, index + 50).join(","),
      },
      options.apiKey,
      fetcher,
      wait,
    );
    for (const raw of array(page.items)) {
      const item = object(raw);
      const snippet = object(item.snippet);
      const publishedAt = string(snippet.publishedAt);
      const publishedTime = getTimestamp(publishedAt);
      if (
        !string(item.id) ||
        publishedTime === undefined ||
        publishedTime < videoCutoff
      )
        continue;
      videos.push({
        videoId: string(item.id),
        title: string(snippet.title),
        publishedAt,
      });
    }
  }

  const candidates: BuyerAlertCandidate[] = [];
  for (const video of videos) {
    let token: string | undefined;
    let stopCommentPaging = false;
    while (!stopCommentPaging) {
      let page: { items?: unknown[]; nextPageToken?: string };
      try {
        page = await apiGet(
          "commentThreads",
          {
            part: "snippet,replies",
            videoId: video.videoId,
            textFormat: "plainText",
            maxResults: "100",
            order: "time",
            ...(token ? { pageToken: token } : {}),
          },
          options.apiKey,
          fetcher,
          wait,
        );
      } catch (error) {
        if (error instanceof Error && error.message === "COMMENTS_DISABLED")
          break;
        throw error;
      }
      for (const threadRaw of array(page.items)) {
        const thread = object(threadRaw);
        const threadSnippet = object(thread.snippet);
        const topLevelComment = object(threadSnippet.topLevelComment);
        const commentSnippet = object(topLevelComment.snippet);
        const commentId = string(topLevelComment.id);
        const postedAt = string(commentSnippet.publishedAt);
        const postedTime = getTimestamp(postedAt);
        if (postedTime !== undefined && postedTime < commentCutoff) {
          stopCommentPaging = true;
          break;
        }
        if (!commentId || postedTime === undefined || postedTime > nowTime)
          continue;

        const totalReplyCount = Number(threadSnippet.totalReplyCount ?? 0);
        const replies = array(object(thread.replies).comments);
        let creatorReplied = replies.some(
          (reply) => replyAuthorId(reply) === channelId,
        );
        if (totalReplyCount > replies.length) {
          let replyToken: string | undefined;
          do {
            const replyPage = await apiGet<{
              items?: unknown[];
              nextPageToken?: string;
            }>(
              "comments",
              {
                part: "snippet",
                parentId: commentId,
                textFormat: "plainText",
                maxResults: "100",
                ...(replyToken ? { pageToken: replyToken } : {}),
              },
              options.apiKey,
              fetcher,
              wait,
            );
            creatorReplied ||= array(replyPage.items).some(
              (reply) => replyAuthorId(reply) === channelId,
            );
            replyToken = replyPage.nextPageToken;
          } while (replyToken);
        }

        candidates.push({
          commentId,
          text:
            string(commentSnippet.textOriginal) ||
            string(commentSnippet.textDisplay),
          videoId: video.videoId,
          videoTitle: video.title,
          postedAt,
          videoPostedAt: video.publishedAt,
          link: buildDeepLink(video.videoId, commentId),
          creatorReplied,
        });
      }
      token = page.nextPageToken;
      if (stopCommentPaging || !token) break;
    }
  }
  return candidates;
}

export function isBuyerAlertChannelEnabled(channel: ChannelConfig): boolean {
  return channel.enabled === true && Boolean(channel.offerDescription?.trim());
}

export function filterQualifiedBuyerCandidates(
  candidates: BuyerAlertCandidate[],
  qualifications: BuyerQualification[],
  now = new Date(),
): QualifiedBuyerAlert[] {
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) throw new Error("Invalid alert check time.");
  const qualificationsByComment = new Map(
    qualifications.map((qualification) => [
      qualification.commentId,
      qualification,
    ]),
  );
  const commentCutoff = nowTime - 7 * DAY_MS;
  const videoCutoff = nowTime - 30 * DAY_MS;
  return candidates.flatMap((candidate) => {
    const qualification = qualificationsByComment.get(candidate.commentId);
    const postedTime = getTimestamp(candidate.postedAt);
    const videoPostedTime = getTimestamp(candidate.videoPostedAt);
    if (
      !qualification?.verdict ||
      qualification.reason.trim().length === 0 ||
      candidate.creatorReplied ||
      postedTime === undefined ||
      postedTime < commentCutoff ||
      postedTime > nowTime ||
      videoPostedTime === undefined ||
      videoPostedTime < videoCutoff ||
      videoPostedTime > nowTime
    )
      return [];
    return [{ ...candidate, reason: qualification.reason }];
  });
}

export async function runAlertsCheck(options: {
  channel: ChannelConfig;
  config: AppConfig;
  now?: Date;
  lastSuccessfulPass?: Date;
  youtubeApiKey?: string;
  llmApiKey?: string;
  fetcher?: Fetcher;
  wait?: (milliseconds: number) => Promise<void>;
  includeAllCandidates?: boolean;
}): Promise<AlertsCheckResult> {
  if (options.channel.enabled !== true)
    return {
      skipped: true,
      reason: "Buyer alerts are not enabled for this channel.",
    };
  const offerDescription = options.channel.offerDescription?.trim();
  if (!offerDescription)
    return {
      skipped: true,
      reason: "No offerDescription is configured for this channel.",
    };

  const handleOrId = options.channel.handle ?? options.channel.channelId;
  if (!handleOrId)
    throw new Error("The configured channel needs a handle or channelId.");
  const youtubeApiKey = options.youtubeApiKey ?? process.env.YOUTUBE_API_KEY;
  if (!youtubeApiKey)
    throw new Error("YOUTUBE_API_KEY is required to fetch alert candidates.");
  const candidates = await fetchAlertCandidates({
    apiKey: youtubeApiKey,
    handleOrId,
    ...(options.now ? { now: options.now } : {}),
    ...(options.lastSuccessfulPass
      ? { lastSuccessfulPass: options.lastSuccessfulPass }
      : {}),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.wait ? { wait: options.wait } : {}),
  });
  if (candidates.length === 0)
    return {
      skipped: false,
      comments: [],
      ...(options.includeAllCandidates ? { candidates: [] } : {}),
    };
  const llmApiKey = options.llmApiKey ?? process.env.LLM_API_KEY;
  const qualifications = await qualifyBuyerComments(
    candidates.map(({ commentId, text, videoTitle }) => ({
      commentId,
      text,
      videoTitle,
    })),
    offerDescription,
    {
      provider: options.config.provider,
      ...((options.config.classificationModel ?? options.config.model)
        ? { model: options.config.classificationModel ?? options.config.model }
        : {}),
      ...((options.config.classificationFallbackModel ??
      options.config.fallbackModel)
        ? {
            fallbackModel:
              options.config.classificationFallbackModel ??
              options.config.fallbackModel,
          }
        : {}),
      ...(llmApiKey ? { apiKey: llmApiKey } : {}),
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      ...(options.wait ? { wait: options.wait } : {}),
    },
  );
  const comments = filterQualifiedBuyerCandidates(
    candidates,
    qualifications,
    options.now,
  );
  return {
    skipped: false,
    comments,
    ...(options.includeAllCandidates
      ? {
          candidates: candidates.map((candidate) => {
            const qualified = comments.find(
              (comment) => comment.commentId === candidate.commentId,
            );
            return {
              ...candidate,
              qualifies: qualified !== undefined,
              ...(qualified ? { reason: qualified.reason } : {}),
            };
          }),
        }
      : {}),
  };
}
