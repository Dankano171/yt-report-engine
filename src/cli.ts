#!/usr/bin/env node
import { Command } from "commander";
import { runAlertsCheck } from "./alerts.js";
import { loadConfig, matchChannel } from "./config.js";
import { sendExistingReport } from "./email.js";
import { QuotaError, redactSecrets } from "./errors.js";
import { runChannel } from "./pipeline.js";
import { purgeOldCache, purgeOldDebugDumps, readUsage } from "./storage.js";

const program = new Command();
program
  .name("yt-report-engine")
  .description(
    "Create read-only, AI-assisted audience intelligence reports from public YouTube comments.",
  )
  .version("1.0.0");

program
  .command("run")
  .description("Fetch recent public comments and create an audience report")
  .requiredOption(
    "--channel <handle>",
    "Configured YouTube channel handle or channel ID",
  )
  .option("--days <days>", "Lookback period in days", "30")
  .option("--dry-run", "Write report only (default; no email is sent)")
  .option("--send", "Send the report to configured recipients")
  .option("--debug", "Log sanitized LLM batch outcomes")
  .option("--dump-prompt", "Save LLM prompts and raw responses under output/")
  .option(
    "--dump-youtube",
    "Save the first three raw comment threads from the first video",
  )
  .option(
    "--classify-only",
    "Classify the first batch only; do not write a report",
  )
  .action(
    async (options: {
      channel: string;
      days: string;
      dryRun?: boolean;
      send?: boolean;
      debug?: boolean;
      classifyOnly?: boolean;
      dumpPrompt?: boolean;
      dumpYoutube?: boolean;
    }) => {
      if (options.send && options.dryRun)
        throw new Error("Choose either --send or --dry-run, not both.");
      if (options.send && options.classifyOnly)
        throw new Error("--classify-only cannot be combined with --send.");
      const config = await loadConfig();
      const channel = matchChannel(config.channels, options.channel);
      const result = await runChannel({
        channel,
        config,
        days: Number(options.days),
        send: options.send === true,
        debug:
          options.debug === true ||
          options.classifyOnly === true ||
          options.dumpPrompt === true,
        classifyOnly: options.classifyOnly === true,
        dumpPrompt: options.dumpPrompt === true,
        dumpYoutube: options.dumpYoutube === true,
      });
      if (result.classifyOnly) {
        console.log(
          `Classification-only stats saved to ${result.reportFolder}/stats.json.`,
        );
        return;
      }
      console.log(
        `Report saved to ${result.reportFolder} (${result.videosAnalyzed} videos, ${result.commentsFetched} comments).`,
      );
      console.log(
        result.sent
          ? "Email sent to configured recipients."
          : "Dry run: no email was sent.",
      );
    },
  );

program
  .command("alerts-check")
  .description("Check buyer comments without sending email or writing state")
  .requiredOption(
    "--channel <handle>",
    "Configured YouTube channel handle or channel ID",
  )
  .requiredOption("--dry-run", "Print qualifying buyer comments as JSON only")
  .action(async (options: { channel: string; dryRun: boolean }) => {
    if (!options.dryRun) throw new Error("alerts-check requires --dry-run.");
    const config = await loadConfig();
    const channel = matchChannel(config.channels, options.channel);
    const result = await runAlertsCheck({ channel, config });
    console.log(
      JSON.stringify(result.skipped ? result : result.comments, null, 2),
    );
  });

program
  .command("send")
  .description("Send an existing report to the configured opt-in recipients")
  .argument(
    "<reportFolder>",
    "Path to an existing output/<channel>/<date> report folder",
  )
  .action(async (reportFolder: string) => {
    const config = await loadConfig();
    await sendExistingReport(reportFolder, config);
    console.log("Report email sent to configured recipients.");
  });

program
  .command("purge")
  .description("Delete cached comments and debug dumps older than 30 days")
  .action(async () => {
    const deleted = (await purgeOldCache()) + (await purgeOldDebugDumps());
    console.log(`Purged ${deleted} expired file${deleted === 1 ? "" : "s"}.`);
  });

program
  .command("cost")
  .description("Show today's recorded YouTube quota and LLM usage estimates")
  .action(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const records = (await readUsage()).filter(
      (record) => record.date === today,
    );
    const totals = records.reduce(
      (sum, record) => ({
        quota: sum.quota + record.youtubeQuotaUnits,
        input: sum.input + record.llmInputTokens,
        output: sum.output + record.llmOutputTokens,
        usd: sum.usd + record.estimatedUsd,
      }),
      { quota: 0, input: 0, output: 0, usd: 0 },
    );
    console.log(`Usage for ${today} (UTC)`);
    console.log(`Estimated YouTube quota units: ${totals.quota}`);
    console.log(`LLM tokens: ${totals.input} input, ${totals.output} output`);
    console.log(`Estimated LLM cost: $${totals.usd.toFixed(4)}`);
  });

try {
  const args =
    process.argv[2] === "--"
      ? [...process.argv.slice(0, 2), ...process.argv.slice(3)]
      : process.argv;
  await program.parseAsync(args);
} catch (error) {
  const message = redactSecrets(
    error instanceof Error ? error.message : String(error),
  );
  if (error instanceof QuotaError) {
    console.error(`Stopped cleanly: ${message}`);
  } else {
    console.error(message);
  }
  process.exitCode = 1;
}
