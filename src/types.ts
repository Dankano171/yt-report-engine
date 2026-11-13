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
  | "praise"
  | "spam_or_noise";

export interface ChannelConfig {
  handle?: string;
  channelId?: string;
  creatorName: string;
  creatorGoal: CreatorGoal;
  recipients: string[];
  productKeywords: string[];
}

export interface AppConfig {
  provider: ProviderName;
  model?: string;
  fallbackModel?: string;
  emailFrom?: string;
  limits: {
    maxVideos: number;
    maxThreadsPerVideo: number;
    maxUsdPerRun: number;
    maxUsdPerDay: number;
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
