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
  })
  .refine((value) => Boolean(value.handle) !== Boolean(value.channelId), {
    message: "Each channel must set exactly one of handle or channelId",
  });

const configSchema = z
  .object({
    provider: z
      .enum(["gemini", "anthropic", "openai", "mock"])
      .default("gemini"),
    model: z.string().min(1).optional(),
    fallbackModel: z.string().min(1).optional(),
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
  return {
    provider: data.provider,
    ...(data.model ? { model: data.model } : {}),
    ...(data.fallbackModel ? { fallbackModel: data.fallbackModel } : {}),
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
