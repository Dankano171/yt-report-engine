import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmAlertDraftSent,
  createAlertDraft,
} from "../src/alert-drafts.js";
import { generateSuggestedReply } from "../src/alert-reply.js";
import { AlertStateStore } from "../src/alert-state.js";
import type { EvaluatedBuyerAlertCandidate } from "../src/alerts.js";
import type { AppConfig, ChannelConfig, Fetcher } from "../src/types.js";

const now = new Date("2026-03-15T12:00:00.000Z");
const channel: ChannelConfig = {
  handle: "@creator",
  creatorName: "Creator",
  creatorGoal: "sell_course",
  recipients: ["creator@example.com"],
  productKeywords: [],
  enabled: true,
  offerDescription: "A gardening course.",
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
let root: string | undefined;

type DraftCandidate = EvaluatedBuyerAlertCandidate & {
  channelHandle: string;
};

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function setup() {
  root = await mkdtemp(join(tmpdir(), "yt-report-alert-draft-"));
  return {
    root,
    dbPath: join(root, "alerts.db"),
    outputRoot: join(root, "output"),
  };
}

function candidate(overrides: Partial<DraftCandidate> = {}): DraftCandidate {
  return {
    channelHandle: "@creator",
    commentId: "comment-1",
    text: "How much does the course cost?",
    videoId: "video-1",
    videoTitle: "Growing tomatoes",
    postedAt: now.toISOString(),
    videoPostedAt: "2026-03-10T12:00:00.000Z",
    link: "https://www.youtube.com/watch?v=video-1&lc=comment-1",
    creatorReplied: false,
    qualifies: true,
    reason: "Asks about course pricing.",
    ...overrides,
  };
}

function checkWith(
  candidates: EvaluatedBuyerAlertCandidate[],
): NonNullable<Parameters<typeof createAlertDraft>[0]["check"]> {
  return async () => ({ skipped: false, comments: [], candidates });
}

function mockReply(
  reply = "Please see the course details.",
): NonNullable<Parameters<typeof createAlertDraft>[0]["makeReply"]> {
  return vi.fn(async () => reply);
}

describe("manual alert drafts", () => {
  it("writes no file or state when nothing qualifies", async () => {
    const paths = await setup();
    const store = new AlertStateStore(paths.dbPath);
    store.setWatermark("@creator", now);
    store.close();
    const before = await stat(paths.dbPath);
    const reply = mockReply();

    const result = await createAlertDraft({
      channel,
      config,
      now,
      ...paths,
      check: checkWith([candidate({ qualifies: false })]),
      makeReply: reply,
    });

    expect(result).toEqual({ status: "nothing" });
    expect(reply).not.toHaveBeenCalled();
    await expect(readdir(join(paths.outputRoot, "alerts"))).rejects.toThrow();
    const after = await stat(paths.dbPath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    const readOnly = new AlertStateStore(paths.dbPath, { readOnly: true });
    expect(readOnly.getWatermark("@creator")).toEqual(now);
    readOnly.close();
  });

  it("writes a plain-text new item draft without changing the database", async () => {
    const paths = await setup();
    const reply = mockReply(
      "You can find more information in the course details.",
    );
    const result = await createAlertDraft({
      channel,
      config,
      now,
      ...paths,
      check: checkWith([candidate()]),
      makeReply: reply,
    });

    expect(result.status).toBe("drafted");
    if (result.status !== "drafted") throw new Error("Expected a draft.");
    const text = await readFile(result.textPath, "utf8");
    expect(text).toContain("Subject: 1 buyer comment waiting - Creator");
    expect(text).toContain("VIDEO:");
    expect(text).toContain("How much does the course cost?");
    expect(text).toContain("VIDEO: Growing tomatoes");
    expect(text).toContain(candidate().link);
    expect(text).toContain(
      "Suggested reply: You can find more information in the course details.",
    );
    await expect(stat(paths.dbPath)).rejects.toThrow();
    const pending = JSON.parse(await readFile(result.pendingPath, "utf8")) as {
      newCommentIds: string[];
      remindedCommentIds: string[];
    };
    expect(pending).toMatchObject({
      newCommentIds: ["comment-1"],
      remindedCommentIds: [],
    });
  });

  it("groups matching questions by video, preserves exact words and links, and sorts videos by comment count", async () => {
    const paths = await setup();
    const reply = vi.fn(
      async (selected: EvaluatedBuyerAlertCandidate) =>
        `Reply for ${selected.commentId}`,
    );
    const result = await createAlertDraft({
      channel,
      config,
      now,
      ...paths,
      check: checkWith([
        candidate({ commentId: "heavy-1", text: "What is price?" }),
        candidate({
          commentId: "heavy-2",
          text: "What is the price",
          link: "https://youtube.test/heavy-2",
        }),
        candidate({
          commentId: "heavy-3",
          text: "How do I enroll?",
        }),
        candidate({
          commentId: "light-1",
          videoId: "video-2",
          videoTitle: "Growing peppers",
          text: "What's the price?",
        }),
      ]),
      makeReply: reply,
    });

    expect(result.status).toBe("drafted");
    if (result.status !== "drafted") throw new Error("Expected a draft.");
    expect(reply).toHaveBeenCalledTimes(3);
    expect(
      result.items.map(({ videoId, comments }) => [videoId, comments.length]),
    ).toEqual([
      ["video-1", 2],
      ["video-1", 1],
      ["video-2", 1],
    ]);
    expect(result.items[0]).toMatchObject({
      comments: [
        { text: "What is price?", link: candidate().link },
        { text: "What is the price", link: "https://youtube.test/heavy-2" },
      ],
      suggestedReply: "Reply for heavy-1",
    });
    const text = await readFile(result.textPath, "utf8");
    expect(text.indexOf("VIDEO: Growing tomatoes")).toBeLessThan(
      text.indexOf("VIDEO: Growing peppers"),
    );
    expect(text).toContain("VIDEO: Growing tomatoes (3 buyer comments)");
    expect(text).toContain("Question group (2 viewers):");
    expect(text).toContain("Viewer 1 exact words: What is price?");
    expect(text).toContain("Viewer 2 exact words: What is the price");
    expect(text).toContain("Link: https://youtube.test/heavy-2");
    expect(text).toContain("Suggested reply: Reply for heavy-1");
    expect(text).not.toContain("Suggested reply: Reply for heavy-2");
  });

  it("retries reply 429 and 503 responses using Retry-After and backoff", async () => {
    const waits: number[] = [];
    const responses = [
      new Response("{}", { status: 429, headers: { "Retry-After": "3" } }),
      new Response("{}", { status: 503 }),
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Thanks for your question." } }],
        }),
        { status: 200 },
      ),
    ];
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      return responses.shift()!;
    };

    await expect(
      generateSuggestedReply(
        {
          commentText: "Where can I learn more?",
          videoTitle: "Video",
          channel: { offerDescription: "A gardening course." },
        },
        {
          provider: "openai",
          model: "test-model",
          apiKey: "test-key",
          fetcher,
          wait: async (milliseconds) => {
            waits.push(milliseconds);
          },
        },
      ),
    ).resolves.toBe("Thanks for your question.");
    expect(calls).toBe(3);
    expect(waits).toEqual([3_000, 5_000]);
  });

  it("keeps qualified comments in the draft when reply generation exhausts retries", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    const paths = await setup();
    const waits: number[] = [];
    const warnings: string[] = [];
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      return new Response("{}", { status: 503 });
    };
    const result = await createAlertDraft({
      channel,
      config,
      now,
      ...paths,
      fetcher,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
      warn: (message) => warnings.push(message),
      check: checkWith([candidate()]),
    });

    expect(result.status).toBe("drafted");
    if (result.status !== "drafted") throw new Error("Expected a draft.");
    expect(result.items).toMatchObject([
      {
        comments: [{ text: candidate().text }],
        suggestedReply: "Thanks for asking! [Add your reply]",
      },
    ]);
    expect(await readFile(result.textPath, "utf8")).toContain(
      "Suggested reply: Thanks for asking! [Add your reply]",
    );
    expect(calls).toBe(4);
    expect(waits).toEqual([2_000, 5_000, 15_000]);
    expect(warnings).toEqual([
      "Suggested reply failed for comment-1; using fallback: Suggested reply generation failed (503).",
    ]);
  });

  it("keeps new and 72-hour reminder comments together with each reminder date", async () => {
    const paths = await setup();
    const store = new AlertStateStore(paths.dbPath);
    const remindedAt = new Date(now.getTime() - 72 * 60 * 60 * 1_000);
    store.markNotified(
      "@creator",
      [
        candidate({
          commentId: "reminder-1",
          text: "Can you ship this to Canada?",
          postedAt: remindedAt.toISOString(),
        }),
      ],
      remindedAt,
    );
    store.close();
    const result = await createAlertDraft({
      channel,
      config,
      now,
      ...paths,
      check: checkWith([
        candidate(),
        candidate({
          commentId: "reminder-1",
          text: "Can you ship this to Canada?",
          postedAt: remindedAt.toISOString(),
        }),
      ]),
      makeReply: mockReply(),
    });

    expect(result.status).toBe("drafted");
    if (result.status !== "drafted") throw new Error("Expected a draft.");
    const text = await readFile(result.textPath, "utf8");
    expect(text).toContain("VIDEO: Growing tomatoes (2 buyer comments)");
    expect(text).toContain("First sent 2026-03-12, still no reply from you.");
    expect(result.newCount).toBe(1);
    expect(result.reminderCount).toBe(1);
  });

  it("marks the pending draft sent once and makes a same-day rerun empty", async () => {
    const paths = await setup();
    const oldSent = new Date(now.getTime() - 72 * 60 * 60 * 1_000);
    const store = new AlertStateStore(paths.dbPath);
    store.markNotified(
      "@creator",
      [
        candidate({
          commentId: "reminder-1",
          postedAt: oldSent.toISOString(),
        }),
      ],
      oldSent,
    );
    store.close();
    const values = [
      candidate(),
      candidate({ commentId: "reminder-1", postedAt: oldSent.toISOString() }),
    ];
    await createAlertDraft({
      channel,
      config,
      now,
      ...paths,
      check: checkWith(values),
      makeReply: mockReply(),
    });
    const confirmed = await confirmAlertDraftSent({
      channel,
      now,
      ...paths,
    });

    expect(confirmed.sentPath).toMatch(/\.sent\.json$/u);
    await expect(readdir(join(paths.outputRoot, "alerts"))).resolves.toEqual(
      expect.arrayContaining([
        "2026-03-15-creator.txt",
        "2026-03-15-creator.sent.json",
      ]),
    );
    const sentStore = new AlertStateStore(paths.dbPath, { readOnly: true });
    expect(sentStore.getWatermark("@creator")).toEqual(now);
    expect(sentStore.getComments("@creator")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ commentId: "comment-1", state: "notified" }),
        expect.objectContaining({ commentId: "reminder-1", state: "reminded" }),
      ]),
    );
    sentStore.close();

    const rerun = await createAlertDraft({
      channel,
      config,
      now,
      ...paths,
      check: checkWith(values),
      makeReply: mockReply(),
    });
    expect(rerun).toEqual({ status: "nothing" });
  });

  it("rejects a second confirmation without changing the database", async () => {
    const paths = await setup();
    await createAlertDraft({
      channel,
      config,
      now,
      ...paths,
      check: checkWith([candidate()]),
      makeReply: mockReply(),
    });
    await confirmAlertDraftSent({ channel, now, ...paths });
    const before = await readFile(paths.dbPath);

    await expect(
      confirmAlertDraftSent({ channel, now, ...paths }),
    ).rejects.toThrow("No pending alert draft");
    expect(await readFile(paths.dbPath)).toEqual(before);
  });

  it("fails confirmation with no pending draft without creating a database", async () => {
    const paths = await setup();

    await expect(
      confirmAlertDraftSent({ channel, now, ...paths }),
    ).rejects.toThrow("No pending alert draft");
    await expect(stat(paths.dbPath)).rejects.toThrow();
  });

  it("replaces the same-day draft and sidecar on redraft", async () => {
    const paths = await setup();
    const first = await createAlertDraft({
      channel,
      config,
      now,
      ...paths,
      check: checkWith([candidate()]),
      makeReply: mockReply("First suggested reply."),
    });
    const second = await createAlertDraft({
      channel,
      config,
      now,
      ...paths,
      check: checkWith([candidate({ commentId: "comment-2" })]),
      makeReply: mockReply("Replacement suggested reply."),
    });

    expect(first.status).toBe("drafted");
    expect(second.status).toBe("drafted");
    if (second.status !== "drafted") throw new Error("Expected a draft.");
    expect(await readdir(join(paths.outputRoot, "alerts"))).toHaveLength(2);
    expect(await readFile(second.textPath, "utf8")).toContain(
      "Replacement suggested reply.",
    );
    const pending = JSON.parse(await readFile(second.pendingPath, "utf8")) as {
      newCommentIds: string[];
    };
    expect(pending.newCommentIds).toEqual(["comment-2"]);
  });

  it("keeps replies URL-free without a purchase link and replaces invented prices", async () => {
    const responses = [
      "Please use this link to visit our website: https://example.invalid",
      "It costs $49.99 and includes lifetime access.",
    ];
    const fetcher: Fetcher = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: responses.shift() } }],
        }),
        { status: 200 },
      );
    const noLinkReply = await generateSuggestedReply(
      {
        commentText: "Where can I learn more?",
        videoTitle: "Video",
        channel: { offerDescription: "A gardening course." },
      },
      { provider: "openai", model: "test-model", apiKey: "test-key", fetcher },
    );
    const inventedPriceReply = await generateSuggestedReply(
      {
        commentText: "How much does it cost?",
        videoTitle: "Video",
        channel: { offerDescription: "A gardening course." },
      },
      { provider: "openai", model: "test-model", apiKey: "test-key", fetcher },
    );

    expect(noLinkReply).not.toMatch(/https?:\/\//u);
    expect(noLinkReply).not.toMatch(/\b(?:link|website)\b/iu);
    expect(inventedPriceReply).toBe(
      "Thanks for asking! [Confirm the current price.]",
    );
  });

  it("provides offer details and only permits the configured purchase URL", async () => {
    let prompt = "";
    const fetcher: Fetcher = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        messages?: { content?: string }[];
      };
      prompt = request.messages?.[0]?.content ?? "";
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "You can find details here: https://example.com/buy",
              },
            },
          ],
        }),
        { status: 200 },
      );
    };
    const reply = await generateSuggestedReply(
      {
        commentText: "Where can I buy it?",
        videoTitle: "Video",
        channel: {
          offerDescription: "A gardening course with weekly lessons.",
          purchaseLink: "https://example.com/buy",
        },
      },
      { provider: "openai", model: "test-model", apiKey: "test-key", fetcher },
    );

    expect(prompt).toContain("A gardening course with weekly lessons.");
    expect(prompt).toContain("https://example.com/buy");
    expect(reply).toContain("https://example.com/buy");
  });

  it.each([
    { response: "We do not carry candy corn from PW.", name: "stock denial" },
    { response: "Yes, we sell tomatoes.", name: "affirmative sale" },
    { response: "$12 each.", name: "currency price" },
  ])(
    "replaces an unqualified $name claim with a safe fallback",
    async ({ response }) => {
      const fetcher: Fetcher = async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: response } }],
          }),
          { status: 200 },
        );
      const reply = await generateSuggestedReply(
        {
          commentText: "Do you have the candy corn from PW?",
          videoTitle: "Video",
          channel: { offerDescription: "A gardening course." },
        },
        {
          provider: "openai",
          model: "test-model",
          apiKey: "test-key",
          fetcher,
        },
      );

      expect(reply).toBe(
        "Thanks for asking! [Confirm whether the item is in stock.]",
      );
    },
  );

  it.each([
    {
      commentText: "Is the course currently available?",
      expected: "Thanks for asking! [Confirm whether the item is in stock.]",
    },
    {
      commentText: "How much does the course cost?",
      expected: "Thanks for asking! [Confirm the current price.]",
    },
    {
      commentText: "Is the course available, and what is the price?",
      expected:
        "Thanks for asking! [Confirm whether the item is in stock and the price.]",
    },
  ])(
    "formats an availability or price question as one creator note",
    async ({ commentText, expected }) => {
      const fetcher: Fetcher = async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "Please check our website for details.",
                },
              },
            ],
          }),
          { status: 200 },
        );
      const reply = await generateSuggestedReply(
        {
          commentText,
          videoTitle: "Video",
          channel: { offerDescription: "A gardening course." },
        },
        {
          provider: "openai",
          model: "test-model",
          apiKey: "test-key",
          fetcher,
        },
      );

      expect(reply).toBe(expected);
      expect(reply.match(/\[[^\]]+\]/gu)).toHaveLength(1);
    },
  );

  it("uses the availability note instead of passing through a placeholder", async () => {
    const placeholder = "[confirm in stock]";
    const fetcher: Fetcher = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: placeholder } }],
        }),
        { status: 200 },
      );
    const reply = await generateSuggestedReply(
      {
        commentText: "Do you have the candy corn from PW?",
        videoTitle: "Video",
        channel: { offerDescription: "A gardening course." },
      },
      { provider: "openai", model: "test-model", apiKey: "test-key", fetcher },
    );

    expect(reply).toBe(
      "Thanks for asking! [Confirm whether the item is in stock.]",
    );
  });

  it("passes a configured purchase link with a placeholder unchanged", async () => {
    const response =
      "You can see details here: https://example.com/buy [confirm availability].";
    const fetcher: Fetcher = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: response } }],
        }),
        { status: 200 },
      );
    const reply = await generateSuggestedReply(
      {
        commentText: "Could you share more details?",
        videoTitle: "Video",
        channel: {
          offerDescription: "A gardening course.",
          purchaseLink: "https://example.com/buy",
        },
      },
      { provider: "openai", model: "test-model", apiKey: "test-key", fetcher },
    );

    expect(reply).toBe(response);
  });

  it("keeps the draft module independent of the email and report pipeline modules", async () => {
    const { readFile: readSource } = await import("node:fs/promises");
    const draftSource = await readSource(
      new URL("../src/alert-drafts.ts", import.meta.url),
      "utf8",
    );
    const cliSource = await readSource(
      new URL("../src/cli.ts", import.meta.url),
      "utf8",
    );

    expect(draftSource).not.toMatch(/from ["']\.\/(?:email|pipeline)\.js/u);
    expect(cliSource).not.toMatch(
      /^import .* from ["']\.\/(?:email|pipeline)\.js["'];?$/mu,
    );
    expect(cliSource).toContain('await import("./pipeline.js")');
    expect(cliSource).toContain('await import("./email.js")');
  });
});
