import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { isBuyerAlertChannelEnabled } from "../src/alerts.js";
import type { ChannelConfig } from "../src/types.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function loadChannel(channel: Record<string, unknown>) {
  root = await mkdtemp(join(tmpdir(), "yt-report-alert-config-"));
  const path = join(root, "config.json");
  await writeFile(
    path,
    JSON.stringify({
      provider: "openai",
      model: "test-model",
      channels: [
        {
          handle: "@creator",
          creatorName: "Creator",
          creatorGoal: "sell_course",
          recipients: ["creator@example.com"],
          ...channel,
        },
      ],
    }),
  );
  return loadConfig(path);
}

describe("buyer alert channel configuration", () => {
  it("loads a valid enabled channel with the alert settings", async () => {
    const config = await loadChannel({
      enabled: true,
      offerDescription: "A gardening course and nursery.",
      purchaseLink: "https://example.com/buy",
      runTime: "08:30",
      timezone: "America/Los_Angeles",
    });

    expect(config.channels[0]).toMatchObject({
      enabled: true,
      offerDescription: "A gardening course and nursery.",
      purchaseLink: "https://example.com/buy",
      runTime: "08:30",
      timezone: "America/Los_Angeles",
    });
    expect(isBuyerAlertChannelEnabled(config.channels[0]!)).toBe(true);
  });

  it("skips an enabled channel with no offer description", async () => {
    const config = await loadChannel({ enabled: true });

    expect(isBuyerAlertChannelEnabled(config.channels[0]!)).toBe(false);
  });

  it("skips a channel with alerts disabled", async () => {
    const config = await loadChannel({
      enabled: false,
      offerDescription: "A gardening course.",
    });

    expect(isBuyerAlertChannelEnabled(config.channels[0]!)).toBe(false);
  });

  it("rejects a timezone that is not recognized by Intl", async () => {
    await expect(
      loadChannel({
        enabled: true,
        offerDescription: "A gardening course.",
        runTime: "08:30",
        timezone: "Mars/Olympus_Mons",
      }),
    ).rejects.toThrow("timezone must be a valid IANA timezone");
  });

  it("continues to load an old channel without alert settings", async () => {
    const config = await loadChannel({});
    const channel: ChannelConfig = config.channels[0]!;

    expect(channel.enabled).toBeUndefined();
    expect(channel.offerDescription).toBeUndefined();
    expect(channel.purchaseLink).toBeUndefined();
    expect(channel.runTime).toBeUndefined();
    expect(channel.timezone).toBeUndefined();
    expect(isBuyerAlertChannelEnabled(channel)).toBe(false);
  });

  it("requires a time and timezone for a configured enabled offer", async () => {
    await expect(
      loadChannel({
        enabled: true,
        offerDescription: "A gardening course.",
      }),
    ).rejects.toThrow(
      "runTime is required for an enabled alert channel; timezone is required for an enabled alert channel",
    );
  });
});
