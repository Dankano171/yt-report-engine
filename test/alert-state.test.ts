import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AlertStateStore,
  classifyCandidates,
  readAlertStateIfExists,
  type AlertCandidate,
} from "../src/alert-state.js";

const start = new Date("2026-03-15T12:00:00.000Z");
let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function createStore() {
  root = await mkdtemp(join(tmpdir(), "yt-report-alert-state-"));
  const path = join(root, "alerts.db");
  return { path, store: new AlertStateStore(path) };
}

function candidate(overrides: Partial<AlertCandidate> = {}): AlertCandidate {
  return {
    channelHandle: "@creator",
    commentId: "comment-1",
    text: "Can I buy this?",
    videoId: "video-1",
    link: "https://youtube.com/watch?v=video-1&lc=comment-1",
    postedAt: start.toISOString(),
    creatorReplied: false,
    ...overrides,
  };
}

describe("durable alert state", () => {
  it("classifies a new comment and suppresses it after notification", async () => {
    const { store } = await createStore();
    const item = candidate();
    expect(classifyCandidates([item], [], start).newItems).toEqual([item]);

    store.markNotified("@creator", [item], start);
    const result = classifyCandidates(
      [item],
      store.getComments("@creator"),
      start,
    );
    expect(result).toEqual({ newItems: [], reminders: [], toClose: [] });
    store.close();
  });

  it("reminds at 72 hours once and never again, including after 30 days", async () => {
    const { store } = await createStore();
    const item = candidate();
    store.markNotified("@creator", [item], start);
    const state = store.getComments("@creator");

    expect(
      classifyCandidates(
        [item],
        state,
        new Date(start.getTime() + 71 * 60 * 60 * 1_000),
      ).reminders,
    ).toEqual([]);
    const reminderTime = new Date(start.getTime() + 72 * 60 * 60 * 1_000);
    expect(classifyCandidates([item], state, reminderTime).reminders).toEqual([
      item,
    ]);
    store.markReminded("@creator", [item.commentId], reminderTime);
    const later = new Date(start.getTime() + 30 * 86_400_000);
    expect(
      classifyCandidates([item], store.getComments("@creator"), later),
    ).toEqual({ newItems: [], reminders: [], toClose: [] });
    expect(
      classifyCandidates([], store.getComments("@creator"), later),
    ).toEqual({ newItems: [], reminders: [], toClose: [] });
    store.close();
  });

  it("closes a notified comment silently when the channel replies", async () => {
    const { store } = await createStore();
    const item = candidate();
    store.markNotified("@creator", [item], start);
    const replied = candidate({ creatorReplied: true });
    const result = classifyCandidates(
      [replied],
      store.getComments("@creator"),
      start,
    );

    expect(result).toEqual({
      newItems: [],
      reminders: [],
      toClose: [{ commentId: item.commentId, reason: "channel_replied" }],
    });
    store.closeComments("@creator", result.toClose, start);
    expect(store.getComments("@creator")[0]?.closedReason).toBe(
      "channel_replied",
    );
    expect(
      classifyCandidates(
        [replied],
        store.getComments("@creator"),
        new Date(start.getTime() + 30 * 86_400_000),
      ),
    ).toEqual({ newItems: [], reminders: [], toClose: [] });
    store.close();
  });

  it("closes a notified comment that no longer qualifies", async () => {
    const { store } = await createStore();
    const item = candidate();
    store.markNotified("@creator", [item], start);
    const result = classifyCandidates(
      [candidate({ qualifies: false })],
      store.getComments("@creator"),
      start,
    );

    expect(result.toClose).toEqual([
      { commentId: item.commentId, reason: "no_longer_qualifies" },
    ]);
    store.close();
  });

  it("closes a notified comment after seven days with no alert output", async () => {
    const { store } = await createStore();
    const item = candidate();
    store.markNotified("@creator", [item], start);
    const result = classifyCandidates(
      [item],
      store.getComments("@creator"),
      new Date(start.getTime() + 8 * 86_400_000),
    );

    expect(result).toEqual({
      newItems: [],
      reminders: [],
      toClose: [{ commentId: item.commentId, reason: "no_longer_qualifies" }],
    });
    store.close();
  });

  it("leaves a comment new when a send fails before marking it notified", async () => {
    const { store } = await createStore();
    const item = candidate();
    const failedSend = () => {
      throw new Error("send failed");
    };
    expect(failedSend).toThrow("send failed");

    expect(
      classifyCandidates([item], store.getComments("@creator"), start).newItems,
    ).toEqual([item]);
    store.close();
  });

  it("makes repeated notifications idempotent", async () => {
    const { store } = await createStore();
    const item = candidate();
    store.markNotified("@creator", [item], start);
    store.markNotified("@creator", [item], new Date(start.getTime() + 1_000));

    expect(store.getComments("@creator")).toHaveLength(1);
    expect(store.getComments("@creator")[0]?.firstNotifiedAt).toBe(
      start.toISOString(),
    );
    store.close();
  });

  it("advances a watermark only when a successful pass is recorded", async () => {
    const { store } = await createStore();
    expect(store.getWatermark("@creator")).toBeUndefined();
    const successfulTime = new Date(start.getTime() + 60_000);
    store.applySuccessfulPass(
      "@creator",
      { newItems: [], reminders: [], toClose: [] },
      successfulTime,
    );

    expect(store.getWatermark("@creator")).toEqual(successfulTime);
    store.close();
  });

  it("keeps identical comment ids separate across channels", async () => {
    const { store } = await createStore();
    const first = candidate({ channelHandle: "@first" });
    const second = candidate({ channelHandle: "@second" });
    store.markNotified("@first", [first], start);

    expect(
      classifyCandidates([second], store.getComments("@second"), start),
    ).toEqual({ newItems: [second], reminders: [], toClose: [] });
    store.markNotified("@second", [second], start);
    expect(store.getComments("@first")).toHaveLength(1);
    expect(store.getComments("@second")).toHaveLength(1);
    store.close();
  });

  it("combines a reminder and new item in one classification", async () => {
    const { store } = await createStore();
    const previous = candidate();
    store.markNotified("@creator", [previous], start);
    const next = candidate({ commentId: "comment-2" });
    const time = new Date(start.getTime() + 72 * 60 * 60 * 1_000);

    expect(
      classifyCandidates([previous, next], store.getComments("@creator"), time),
    ).toEqual({ newItems: [next], reminders: [previous], toClose: [] });
    store.close();
  });

  it("does not create or modify a database during read-only state access", async () => {
    root = await mkdtemp(join(tmpdir(), "yt-report-alert-state-"));
    const missingPath = join(root, "missing.db");
    expect(readAlertStateIfExists(missingPath)).toBeUndefined();
    await expect(stat(missingPath)).rejects.toThrow();

    const path = join(root, "existing.db");
    const store = new AlertStateStore(path);
    store.markNotified("@creator", [candidate()], start);
    store.close();
    const before = await stat(path);
    const readOnly = readAlertStateIfExists(path);
    expect(readOnly?.getComments("@creator")).toHaveLength(1);
    readOnly?.close();
    const after = await stat(path);

    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
