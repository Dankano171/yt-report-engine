import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AppConfig, ChannelConfig } from "./types.js";

const channelSchema = z
  .object({
    handle: z.string().min(1).optional(),
    channelId: z.string().min(1).optional(),
    creatorName: z.string().min(1),
    creatorGoal: z.enum([
      "sell_course",
      "sell_tool",
      "sponsorships",
      "grow_audience",
    ]),
    recipients: z.array(z.string().email()).min(1),
    productKeywords: z.array(z.string()).default([]),
    enabled: z.boolean().optional(),
    offerDescription: z.string().optional(),
    purchaseLink: z.string().url().optional(),
    runTime: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "runTime must be HH:MM")
      .optional(),
    timezone: z
      .string()
      .min(1)
      .refine(
        (value) => {
          try {
            new Intl.DateTimeFormat("en-US", { timeZone: value });
            return true;
          } catch {
            return false;
          }
        },
        { message: "timezone must be a valid IANA timezone" },
      )
      .optional(),
  })
  .refine((value) => Boolean(value.handle) !== Boolean(value.channelId), {
    message: "Each channel must set exactly one of handle or channelId",
  })
  .superRefine((value, context) => {
    if (value.enabled !== true || !value.offerDescription?.trim()) return;
    if (!value.runTime) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "runTime is required for an enabled alert channel",
        path: ["runTime"],
      });
    }
    if (!value.timezone) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "timezone is required for an enabled alert channel",
        path: ["timezone"],
      });
    }
  });

const configSchema = z
  .object({
    provider: z
      .enum(["gemini", "anthropic", "openai", "mock"])
      .default("gemini"),
    model: z.string().min(1).optional(),
    fallbackModel: z.string().min(1).optional(),
    classificationModel: z.string().min(1).optional(),
    classificationFallbackModel: z.string().min(1).optional(),
    writingModel: z.string().min(1).optional(),
    writingFallbackModel: z.string().min(1).optional(),
    modelOptions: z
      .record(
        z.object({
          responseMimeType: z.string().min(1).optional(),
          responseSchema: z.record(z.unknown()).optional(),
          thinkingBudget: z.number().int().optional(),
          maxOutputTokens: z.number().int().min(1).optional(),
        }),
      )
      .optional(),
    emailFrom: z.string().min(1).optional(),
    limits: z
      .object({
        maxVideos: z.number().int().min(1).max(50).default(8),
        maxThreadsPerVideo: z.number().int().min(1).max(300).default(300),
        maxUsdPerRun: z.number().nonnegative().default(0.5),
        maxUsdPerDay: z.number().nonnegative().default(2),
        maxOutputTokensPerComment: z.number().int().min(1).default(60),
        outputTokenOverhead: z.number().int().min(0).default(256),
      })
      .default({}),
    channels: z.array(channelSchema).min(1),
  })
  .superRefine((value, context) => {
    if (value.provider !== "mock" && !value.model) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "model is required when using an LLM provider",
        path: ["model"],
      });
    }
  });

export async function loadConfig(path = "config.json"): Promise<AppConfig> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `Could not read ${path}. Copy config.example.json to config.json and edit it.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid configuration: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const data = result.data;
  const classificationModel = data.classificationModel ?? data.model;
  const writingModel = data.writingModel ?? data.model;
  const classificationFallbackModel =
    data.classificationFallbackModel ?? data.fallbackModel;
  const writingFallbackModel = data.writingFallbackModel ?? data.fallbackModel;
  return {
    provider: data.provider,
    ...(data.model ? { model: data.model } : {}),
    ...(data.fallbackModel ? { fallbackModel: data.fallbackModel } : {}),
    ...(classificationModel ? { classificationModel } : {}),
    ...(classificationFallbackModel ? { classificationFallbackModel } : {}),
    ...(writingModel ? { writingModel } : {}),
    ...(writingFallbackModel ? { writingFallbackModel } : {}),
    ...(data.modelOptions ? { modelOptions: data.modelOptions } : {}),
    ...(data.emailFrom ? { emailFrom: data.emailFrom } : {}),
    limits: data.limits,
    channels: data.channels.map((channel) => ({
      ...(channel.handle ? { handle: channel.handle } : {}),
      ...(channel.channelId ? { channelId: channel.channelId } : {}),
      creatorName: channel.creatorName,
      creatorGoal: channel.creatorGoal,
      recipients: channel.recipients,
      productKeywords: channel.productKeywords,
      ...(channel.enabled !== undefined ? { enabled: channel.enabled } : {}),
      ...(channel.offerDescription !== undefined
        ? { offerDescription: channel.offerDescription }
        : {}),
      ...(channel.purchaseLink ? { purchaseLink: channel.purchaseLink } : {}),
      ...(channel.runTime ? { runTime: channel.runTime } : {}),
      ...(channel.timezone ? { timezone: channel.timezone } : {}),
    })),
  };
}

export function matchChannel(
  channels: ChannelConfig[],
  handle: string,
): ChannelConfig {
  const normalized = handle.replace(/^@/, "").toLowerCase();
  const channel = channels.find((item) => {
    if (
      item.handle &&
      item.handle.replace(/^@/, "").toLowerCase() === normalized
    )
      return true;
    return item.channelId?.toLowerCase() === handle.toLowerCase();
  });
  if (!channel)
    throw new Error(`Channel ${handle} is not configured in config.json.`);
  return channel;
}
