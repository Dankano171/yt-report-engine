#!/usr/bin/env node
import { Command } from "commander";
import { runAlertsCheck } from "./alerts.js";
import {
  runDailyAlerts,
  runWeeklyAlerts,
  skipTodayAlert,
} from "./alert-batch.js";
import { confirmAlertDraftSent, createAlertDraft } from "./alert-drafts.js";
import {
  AlertStateStore,
  DEFAULT_ALERT_DB_PATH,
  classifyCandidates,
  readAlertStateIfExists,
} from "./alert-state.js";
import { loadConfig, matchChannel } from "./config.js";
import { QuotaError, redactSecrets } from "./errors.js";
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
      const { runChannel } = await import("./pipeline.js");
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
  .description("Check buyer comments without sending email")
  .requiredOption(
    "--channel <handle>",
    "Configured YouTube channel handle or channel ID",
  )
  .option("--dry-run", "Read state and print proposed changes without writing")
  .option("--draft", "Write a plain-text draft for manual review and sending")
  .option("--mark-sent", "Confirm that the latest pending draft was sent")
  .option(
    "--simulate-send",
    "Record a simulated successful send; never sends email",
  )
  .option("--db <path>", "SQLite alert-state database path")
  .action(
    async (options: {
      channel: string;
      dryRun?: boolean;
      draft?: boolean;
      markSent?: boolean;
      simulateSend?: boolean;
      db?: string;
    }) => {
      const selectedModes = [
        options.dryRun,
        options.draft,
        options.markSent,
        options.simulateSend,
      ].filter(Boolean).length;
      if (selectedModes !== 1)
        throw new Error(
          "Choose exactly one of --dry-run, --draft, --mark-sent, or --simulate-send.",
        );
      if (options.simulateSend && !options.db)
        throw new Error("--simulate-send requires an explicit --db path.");

      const config = await loadConfig();
      const channel = matchChannel(config.channels, options.channel);
      if (options.markSent) {
        const result = await confirmAlertDraftSent({
          channel,
          ...(options.db ? { dbPath: options.db } : {}),
        });
        console.log(`Marked sent: ${result.sentPath}`);
        return;
      }
      if (options.draft) {
        const result = await createAlertDraft({
          channel,
          config,
          ...(options.db ? { dbPath: options.db } : {}),
        });
        if (result.status === "nothing")
          console.log(
            `Nothing to send for ${channel.handle ?? options.channel}`,
          );
        else console.log(`Draft written to ${result.textPath}`);
        return;
      }

      const channelHandle =
        channel.handle ?? channel.channelId ?? options.channel;
      const dbPath = options.db ?? DEFAULT_ALERT_DB_PATH;
      const store = options.simulateSend
        ? new AlertStateStore(dbPath)
        : readAlertStateIfExists(dbPath);
      const now = new Date();
      try {
        const state = store?.getComments(channelHandle) ?? [];
        const lastSuccessfulPass = state.some(
          (record) => record.state === "notified",
        )
          ? undefined
          : store?.getWatermark(channelHandle);
        const result = await runAlertsCheck({
          channel,
          config,
          now,
          ...(lastSuccessfulPass ? { lastSuccessfulPass } : {}),
          includeAllCandidates: true,
        });
        const candidates =
          !result.skipped && result.candidates
            ? result.candidates.map((candidate) => ({
                ...candidate,
                channelHandle,
              }))
            : [];
        const classification = result.skipped
          ? { newItems: [], reminders: [], toClose: [] }
          : classifyCandidates(candidates, state, now);
        if (options.simulateSend && !result.skipped) {
          if (!store)
            throw new Error(
              "Alert state store is unavailable for simulated send.",
            );
          store.applySuccessfulPass(channelHandle, classification, now);
        }
        console.log(JSON.stringify(classification, null, 2));
      } finally {
        store?.close();
      }
    },
  );

program
  .command("alerts-daily")
  .description(
    "Create buyer-alert drafts for all channels in data/channels.txt",
  )
  .option(
    "--db <path>",
    "SQLite alert-state database path",
    DEFAULT_ALERT_DB_PATH,
  )
  .option("--channels <path>", "Channel list file", "data/channels.txt")
  .option("--out <path>", "Output root directory", "output")
  .option("--skip <path>", "Skip list path", "data/skip.txt")
  .action(
    async (options: {
      db: string;
      channels: string;
      out: string;
      skip: string;
    }) => {
      const config = await loadConfig();
      const result = await runDailyAlerts({
        config,
        dbPath: options.db,
        channelsPath: options.channels,
        outputRoot: options.out,
        skipPath: options.skip,
        log: console.log,
        warn: console.error,
      });
      if (result.allFailed) process.exitCode = 1;
    },
  );

program
  .command("alerts-weekly")
  .description("Find one repeated viewer request for each channel")
  .option(
    "--db <path>",
    "SQLite alert-state database path",
    DEFAULT_ALERT_DB_PATH,
  )
  .option("--channels <path>", "Channel list file", "data/channels.txt")
  .option("--out <path>", "Output root directory", "output")
  .action(async (options: { db: string; channels: string; out: string }) => {
    const config = await loadConfig();
    const result = await runWeeklyAlerts({
      config,
      dbPath: options.db,
      channelsPath: options.channels,
      outputRoot: options.out,
      warn: console.error,
    });
    console.log(`Weekly dashboard: ${options.out}/${result.date}/weekly.html`);
    console.log(
      `Repeated requests: ${result.findings.length} channel${result.findings.length === 1 ? "" : "s"}.`,
    );
  });

program
  .command("alerts-skip")
  .description("Keep today's pending buyer-alert draft unconfirmed")
  .argument("[handle]", "Channel handle (for example @examplecreator)")
  .option("--channel <handle>", "Channel handle")
  .option("--out <path>", "Output root directory", "output")
  .action(
    async (
      argument: string | undefined,
      options: { channel?: string; out: string },
    ) => {
      const handle = options.channel ?? argument;
      if (!handle || (options.channel && argument))
        throw new Error(
          "Provide exactly one channel using --channel or <handle>.",
        );
      const removed = await skipTodayAlert({
        channel: handle,
        outputRoot: options.out,
      });
      console.log(
        removed
          ? `Removed today's pending draft for ${handle}.`
          : `No pending draft for ${handle} today.`,
      );
    },
  );

program
  .command("send")
  .description("Send an existing report to the configured opt-in recipients")
  .argument(
    "<reportFolder>",
    "Path to an existing output/<channel>/<date> report folder",
  )
  .action(async (reportFolder: string) => {
    const config = await loadConfig();
    const { sendExistingReport } = await import("./email.js");
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
