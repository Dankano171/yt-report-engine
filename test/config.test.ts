import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("model configuration", () => {
  it("defaults classification and writing models to model and their fallbacks", async () => {
    root = await mkdtemp(join(tmpdir(), "yt-report-config-"));
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        provider: "gemini",
        model: "primary",
        fallbackModel: "fallback",
        channels: [
          {
            handle: "@creator",
            creatorName: "Creator",
            creatorGoal: "grow_audience",
            recipients: ["creator@example.com"],
          },
        ],
      }),
    );
    const config = await loadConfig(path);
    expect(config).toMatchObject({
      model: "primary",
      fallbackModel: "fallback",
      classificationModel: "primary",
      classificationFallbackModel: "fallback",
      writingModel: "primary",
      writingFallbackModel: "fallback",
    });
  });

  it("keeps explicitly configured classification and writing models separate", async () => {
    root = await mkdtemp(join(tmpdir(), "yt-report-config-"));
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        provider: "gemini",
        model: "primary",
        classificationModel: "classifier",
        classificationFallbackModel: "classifier-fallback",
        writingModel: "writer",
        writingFallbackModel: "writer-fallback",
        channels: [
          {
            handle: "@creator",
            creatorName: "Creator",
            creatorGoal: "grow_audience",
            recipients: ["creator@example.com"],
          },
        ],
      }),
    );
    const config = await loadConfig(path);
    expect(config).toMatchObject({
      classificationModel: "classifier",
      classificationFallbackModel: "classifier-fallback",
      writingModel: "writer",
      writingFallbackModel: "writer-fallback",
    });
  });
});
