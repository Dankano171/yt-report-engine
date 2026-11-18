import { readFile, readdir, rename, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  runAlertsCheck,
  type AlertsCheckResult,
  type EvaluatedBuyerAlertCandidate,
} from "./alerts.js";
import {
  AlertStateStore,
  DEFAULT_ALERT_DB_PATH,
  classifyCandidates,
  readAlertStateIfExists,
  type AlertCandidate,
  type AlertClosure,
} from "./alert-state.js";
import { AlertBudgetExceededError, redactSecrets } from "./errors.js";
import { generateSuggestedReply } from "./alert-reply.js";
import type { AppConfig, ChannelConfig, Fetcher } from "./types.js";

interface PendingDraft {
  version: 1;
  channelHandle: string;
  date: string;
  createdAt: string;
  newCommentIds: string[];
  remindedCommentIds: string[];
  newItems: Omit<AlertCandidate, "channelHandle">[];
  toClose: AlertClosure[];
}

export interface AlertDraftFiles {
  status: "drafted";
  textPath: string;
  pendingPath: string;
  newCount: number;
  reminderCount: number;
  items: AlertDraftItem[];
}

export interface AlertDraftItem {
  videoId: string;
  videoTitle: string;
  comments: {
    text: string;
    link: string;
    firstNotifiedAt?: string | null;
  }[];
  suggestedReply: string;
}

interface AlertDraftGroup {
  videoId: string;
  videoTitle: string;
  candidates: EvaluatedBuyerAlertCandidate[];
  firstNotifiedAtByCommentId: Map<string, string | null>;
}

export interface AlertDraftOptions {
  channel: ChannelConfig;
  config: AppConfig;
  now?: Date;
  dbPath?: string;
  outputRoot?: string;
  outputDirectory?: string;
  fileBase?: string;
  fetcher?: Fetcher;
  wait?: (milliseconds: number) => Promise<void>;
  warn?: (message: string) => void;
  budget?: {
    reserveUsd: (estimate: number) => boolean;
    onUsage: (record: {
      date: string;
      youtubeQuotaUnits: number;
      llmInputTokens: number;
      llmOutputTokens: number;
      estimatedUsd: number;
    }) => Promise<void>;
  };
  check?: (options: {
    channel: ChannelConfig;
    config: AppConfig;
    now: Date;
    lastSuccessfulPass?: Date;
    includeAllCandidates: true;
    fetcher?: Fetcher;
    wait?: (milliseconds: number) => Promise<void>;
    budget?: AlertDraftOptions["budget"];
  }) => Promise<AlertsCheckResult>;
  makeReply?: (
    candidate: EvaluatedBuyerAlertCandidate,
    channel: ChannelConfig,
    config: AppConfig,
    fetcher?: Fetcher,
    budget?: AlertDraftOptions["budget"],
    wait?: (milliseconds: number) => Promise<void>,
  ) => Promise<string>;
}

function channelSlug(channel: ChannelConfig): string {
  const handle = (channel.handle ?? channel.channelId ?? "").replace(/^@/u, "");
  const slug = handle.replace(/[^A-Za-z0-9._-]/gu, "_");
  if (!slug)
    throw new Error("Cannot create an alert draft without a channel handle.");
  return slug;
}

function dateStamp(now: Date): string {
  if (!Number.isFinite(now.getTime()))
    throw new Error("Invalid alert draft time.");
  return now.toISOString().slice(0, 10);
}

function defaultReply(
  candidate: EvaluatedBuyerAlertCandidate,
  channel: ChannelConfig,
  config: AppConfig,
  fetcher?: Fetcher,
  budget?: AlertDraftOptions["budget"],
  wait?: (milliseconds: number) => Promise<void>,
): Promise<string> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey)
    throw new Error("LLM_API_KEY is required to draft suggested replies.");
  const model = config.writingModel ?? config.model;
  if (!model)
    throw new Error("An LLM model is required to draft suggested replies.");
  return generateSuggestedReply(
    {
      commentText: candidate.text,
      videoTitle: candidate.videoTitle,
      channel,
    },
    {
      provider: config.provider,
      model,
      apiKey,
      ...(fetcher ? { fetcher } : {}),
      ...(wait ? { wait } : {}),
      ...(budget ? { budget } : {}),
    },
  );
}

function normalizeQuestion(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\bwhat['’]s\b/gu, "what is")
    .replace(/\b(?:a|an|the)\b/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function groupDraftCandidates(
  candidates: EvaluatedBuyerAlertCandidate[],
  reminders: EvaluatedBuyerAlertCandidate[],
  state: ReturnType<
    NonNullable<ReturnType<typeof readAlertStateIfExists>>["getComments"]
  >,
): AlertDraftGroup[] {
  const reminderIds = new Set(reminders.map(({ commentId }) => commentId));
  const stateByComment = new Map(
    state.map((record) => [record.commentId, record]),
  );
  const videos = new Map<
    string,
    { groups: AlertDraftGroup[]; questions: Map<string, AlertDraftGroup> }
  >();

  for (const candidate of candidates) {
    let video = videos.get(candidate.videoId);
    if (!video) {
      video = { groups: [], questions: new Map() };
      videos.set(candidate.videoId, video);
    }
    const normalized = normalizeQuestion(candidate.text);
    const questionKey = normalized || candidate.commentId;
    let group = video.questions.get(questionKey);
    if (!group) {
      group = {
        videoId: candidate.videoId,
        videoTitle: candidate.videoTitle,
        candidates: [],
        firstNotifiedAtByCommentId: new Map(),
      };
      video.questions.set(questionKey, group);
      video.groups.push(group);
    }
    group.candidates.push(candidate);
    if (reminderIds.has(candidate.commentId)) {
      group.firstNotifiedAtByCommentId.set(
        candidate.commentId,
        stateByComment.get(candidate.commentId)?.firstNotifiedAt ?? null,
      );
    }
  }

  return [...videos.values()]
    .sort(
      (left, right) =>
        right.groups.reduce((sum, group) => sum + group.candidates.length, 0) -
        left.groups.reduce((sum, group) => sum + group.candidates.length, 0),
    )
    .flatMap(({ groups }) => groups);
}

function renderDraft(
  channel: ChannelConfig,
  items: AlertDraftItem[],
  newCount: number,
  reminderCount: number,
): string {
  const total = items.reduce((sum, item) => sum + item.comments.length, 0);
  const subjectStatus =
    reminderCount > 0 && newCount === 0 ? "still unanswered" : "waiting";
  const lines = [
    `Subject: ${total} buyer comment${total === 1 ? "" : "s"} ${subjectStatus} - ${channel.creatorName}`,
    "",
  ];
  let currentVideoId: string | undefined;
  for (const item of items) {
    if (item.videoId !== currentVideoId) {
      currentVideoId = item.videoId;
      const videoCount = items
        .filter((entry) => entry.videoId === item.videoId)
        .reduce((sum, entry) => sum + entry.comments.length, 0);
      lines.push(
        `VIDEO: ${item.videoTitle} (${videoCount} buyer comment${videoCount === 1 ? "" : "s"})`,
        "",
      );
    }
    lines.push(
      `Question group (${item.comments.length} viewer${item.comments.length === 1 ? "" : "s"}):`,
    );
    for (const [index, comment] of item.comments.entries()) {
      lines.push(`Viewer ${index + 1} exact words: ${comment.text}`);
      lines.push(`Link: ${comment.link}`);
      if (comment.firstNotifiedAt !== undefined)
        lines.push(
          `First sent ${comment.firstNotifiedAt?.slice(0, 10) ?? "unknown date"}, still no reply from you.`,
        );
    }
    lines.push(`Suggested reply: ${item.suggestedReply}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export async function createAlertDraft(
  options: AlertDraftOptions,
): Promise<AlertDraftFiles | { status: "nothing" }> {
  const now = options.now ?? new Date();
  const dbPath = options.dbPath ?? DEFAULT_ALERT_DB_PATH;
  const store = readAlertStateIfExists(dbPath);
  try {
    const channelHandle =
      options.channel.handle ?? options.channel.channelId ?? "";
    const state = store?.getComments(channelHandle) ?? [];
    const lastSuccessfulPass = state.some(
      (record) => record.state === "notified",
    )
      ? undefined
      : store?.getWatermark(channelHandle);
    const check = options.check ?? runAlertsCheck;
    const result = await check({
      channel: options.channel,
      config: options.config,
      now,
      ...(lastSuccessfulPass ? { lastSuccessfulPass } : {}),
      includeAllCandidates: true,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      ...(options.wait ? { wait: options.wait } : {}),
      ...(options.budget ? { budget: options.budget } : {}),
    });
    if (result.skipped || !result.candidates?.length)
      return { status: "nothing" };

    const candidates = result.candidates.map((candidate) => ({
      ...candidate,
      channelHandle,
    }));
    const classification = classifyCandidates(candidates, state, now);
    if (
      classification.newItems.length === 0 &&
      classification.reminders.length === 0
    )
      return { status: "nothing" };

    const newItems = classification.newItems as EvaluatedBuyerAlertCandidate[];
    const reminders =
      classification.reminders as EvaluatedBuyerAlertCandidate[];
    const groups = groupDraftCandidates(
      [...newItems, ...reminders],
      reminders,
      state,
    );
    const replyMaker = options.makeReply ?? defaultReply;
    const items: AlertDraftItem[] = [];
    for (const group of groups) {
      const representative = group.candidates[0]!;
      let suggestedReply: string;
      try {
        suggestedReply = await replyMaker(
          representative,
          options.channel,
          options.config,
          options.fetcher,
          options.budget,
          options.wait,
        );
      } catch (error) {
        if (error instanceof AlertBudgetExceededError) throw error;
        options.warn?.(
          `Suggested reply failed for ${representative.commentId}; using fallback: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
        );
        suggestedReply = "Thanks for asking! [Add your reply]";
      }
      items.push({
        videoId: group.videoId,
        videoTitle: group.videoTitle,
        comments: group.candidates.map((candidate) => ({
          text: candidate.text,
          link: candidate.link,
          ...(group.firstNotifiedAtByCommentId.has(candidate.commentId)
            ? {
                firstNotifiedAt:
                  group.firstNotifiedAtByCommentId.get(candidate.commentId) ??
                  null,
              }
            : {}),
        })),
        suggestedReply,
      });
    }

    const date = dateStamp(now);
    const slug = channelSlug(options.channel);
    const folder =
      options.outputDirectory ?? join(options.outputRoot ?? "output", "alerts");
    const base = options.fileBase
      ? join(folder, options.fileBase)
      : join(folder, `${date}-${slug}`);
    const textPath = `${base}${options.fileBase ? ".md" : ".txt"}`;
    const pendingPath = `${base}.pending.json`;
    const pending: PendingDraft = {
      version: 1,
      channelHandle,
      date,
      createdAt: now.toISOString(),
      newCommentIds: newItems.map((candidate) => candidate.commentId),
      remindedCommentIds: reminders.map((candidate) => candidate.commentId),
      newItems: newItems.map(
        ({ commentId, text, videoId, link, postedAt, creatorReplied }) => ({
          commentId,
          text,
          videoId,
          link,
          postedAt,
          creatorReplied,
        }),
      ),
      toClose: classification.toClose,
    };

    await mkdir(folder, { recursive: true });
    await writeFile(
      textPath,
      renderDraft(options.channel, items, newItems.length, reminders.length),
      { encoding: "utf8", mode: 0o600 },
    );
    await writeFile(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return {
      status: "drafted",
      textPath,
      pendingPath,
      newCount: newItems.length,
      reminderCount: reminders.length,
      items,
    };
  } finally {
    store?.close();
  }
}

function isPendingDraft(value: unknown): value is PendingDraft {
  if (!value || typeof value !== "object") return false;
  const pending = value as Partial<PendingDraft>;
  return (
    pending.version === 1 &&
    typeof pending.channelHandle === "string" &&
    typeof pending.date === "string" &&
    typeof pending.createdAt === "string" &&
    Array.isArray(pending.newCommentIds) &&
    pending.newCommentIds.every((id) => typeof id === "string") &&
    Array.isArray(pending.remindedCommentIds) &&
    pending.remindedCommentIds.every((id) => typeof id === "string") &&
    Array.isArray(pending.newItems) &&
    pending.newItems.every(
      (item) =>
        item &&
        typeof item.commentId === "string" &&
        typeof item.text === "string" &&
        typeof item.videoId === "string" &&
        typeof item.link === "string" &&
        typeof item.postedAt === "string" &&
        typeof item.creatorReplied === "boolean",
    ) &&
    Array.isArray(pending.toClose) &&
    pending.toClose.every(
      (item) =>
        item &&
        typeof item.commentId === "string" &&
        (item.reason === "channel_replied" ||
          item.reason === "no_longer_qualifies"),
    )
  );
}

export async function confirmAlertDraftSent(options: {
  channel: ChannelConfig;
  dbPath?: string;
  outputRoot?: string;
  now?: Date;
  pendingPath?: string;
}): Promise<{ status: "sent"; sentPath: string }> {
  const slug = channelSlug(options.channel);
  const folder = join(options.outputRoot ?? "output", "alerts");
  let pendingPath = options.pendingPath;
  if (!pendingPath) {
    let names: string[];
    try {
      names = await readdir(folder);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        throw new Error(
          `No pending alert draft for ${options.channel.handle ?? slug}.`,
        );
      throw error;
    }
    const suffix = `-${slug}.pending.json`;
    const pendingName = names
      .filter(
        (name) => /^\d{4}-\d{2}-\d{2}-/u.test(name) && name.endsWith(suffix),
      )
      .sort()
      .at(-1);
    if (!pendingName)
      throw new Error(
        `No pending alert draft for ${options.channel.handle ?? slug}.`,
      );
    pendingPath = join(folder, pendingName);
  }
  const parsed: unknown = JSON.parse(await readFile(pendingPath, "utf8"));
  if (!isPendingDraft(parsed))
    throw new Error(`Invalid pending alert draft: ${pendingPath}`);
  const channelHandle =
    options.channel.handle ?? options.channel.channelId ?? "";
  if (parsed.channelHandle !== channelHandle)
    throw new Error(
      "Pending alert draft channel does not match the requested channel.",
    );
  if (
    parsed.newCommentIds.length !== parsed.newItems.length ||
    parsed.newCommentIds.some(
      (commentId, index) => commentId !== parsed.newItems[index]?.commentId,
    )
  )
    throw new Error("Pending alert draft comment data is inconsistent.");

  const store = new AlertStateStore(options.dbPath ?? DEFAULT_ALERT_DB_PATH);
  try {
    store.recordDraftSent(
      channelHandle,
      parsed.newItems,
      parsed.remindedCommentIds,
      parsed.toClose,
      options.now ?? new Date(),
    );
  } finally {
    store.close();
  }
  const sentPath = pendingPath.replace(/\.pending\.json$/u, ".sent.json");
  await rename(pendingPath, sentPath);
  return { status: "sent", sentPath };
}
