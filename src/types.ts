export type CreatorGoal =
  "sell_course" | "sell_tool" | "sponsorships" | "grow_audience";
export type ProviderName = "gemini" | "anthropic" | "openai" | "mock";
export type Category =
  | "buying_or_sponsor_inquiry"
  | "how_to_question"
  | "confusion_or_error"
  | "complaint_or_objection"
  | "testimonial_or_result"
  | "topic_request"
  | "language_or_subtitles_request"
  | "alternative_or_tool_request"
  | "format_request"
  | "praise"
  | "spam_or_noise"
  | "keyword_response"
  | "suspected_bot_or_promo"
  | "purchase_intent";

export interface ChannelConfig {
  handle?: string;
  channelId?: string;
  creatorName: string;
  creatorGoal: CreatorGoal;
  recipients: string[];
  productKeywords: string[];
}

export interface GeminiModelOptions {
  responseMimeType?: string | undefined;
  responseSchema?: Record<string, unknown> | undefined;
  thinkingBudget?: number | undefined;
  maxOutputTokens?: number | undefined;
}

export interface AppConfig {
  provider: ProviderName;
  model?: string;
  fallbackModel?: string;
  classificationModel?: string;
  classificationFallbackModel?: string;
  writingModel?: string;
  writingFallbackModel?: string;
  modelOptions?: Record<string, GeminiModelOptions>;
  emailFrom?: string;
  limits: {
    maxVideos: number;
    maxThreadsPerVideo: number;
    maxUsdPerRun: number;
    maxUsdPerDay: number;
    maxOutputTokensPerComment?: number;
    outputTokenOverhead?: number;
  };
  channels: ChannelConfig[];
}

export interface VideoRecord {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  viewCount: number;
  commentCount: number;
  durationSeconds: number;
}

export interface CommentRecord {
  commentId: string;
  videoId: string;
  text: string;
  likeCount: number;
  publishedAt: string;
  totalReplyCount: number;
  authorChannelId?: string;
  creatorReplied: boolean;
  creatorReplyId?: string;
  creatorReplyText?: string;
}

export interface Classification {
  commentId: string;
  category: Category;
  quote: string;
  timestamp?: string;
  draftReply?: string;
  idea?: string;
}

export interface UsageRecord {
  date: string;
  youtubeQuotaUnits: number;
  llmInputTokens: number;
  llmOutputTokens: number;
  estimatedUsd: number;
}

export type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
