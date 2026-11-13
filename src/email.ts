import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { redactSecrets } from "./errors.js";
import type { AppConfig, Fetcher } from "./types.js";

export async function sendEmail(
  recipients: string[],
  from: string,
  subject: string,
  html: string,
  apiKey: string,
  fetcher: Fetcher = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from, to: recipients, subject, html }),
    });
  } catch (error) {
    throw new Error(
      redactSecrets(error instanceof Error ? error.message : String(error)),
    );
  }
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === "string") detail = body.message;
    } catch {
      // The status code is enough when Resend does not return JSON.
    }
    throw new Error(
      `Resend request failed (${response.status}): ${redactSecrets(detail)}`,
    );
  }
}

export async function sendExistingReport(
  reportFolder: string,
  config: AppConfig,
  options: { outputRoot?: string; fetcher?: Fetcher } = {},
): Promise<void> {
  const outputRoot = resolve(options.outputRoot ?? "output");
  const folder = resolve(reportFolder);
  const relativePath = relative(outputRoot, folder);
  if (
    !relativePath ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      "Report folder must be a channel/date folder inside output/.",
    );
  }
  const folderParts = relativePath.split(sep);
  if (folderParts.length !== 2)
    throw new Error("Report folder must be output/<channel>/<date>.");
  const channelFolder = folderParts[0];
  if (!channelFolder)
    throw new Error("Report folder must be output/<channel>/<date>.");
  const channel = config.channels.find((item) => {
    const key = item.handle ?? item.channelId ?? "";
    return key.replace(/[^A-Za-z0-9@._-]/g, "_") === channelFolder;
  });
  if (!channel)
    throw new Error(
      `No configured channel matches report folder ${channelFolder}.`,
    );
  const html = await readFile(resolve(folder, "report.html"), "utf8");
  if (!html.trim()) throw new Error("The report.html file is empty.");
  const from = config.emailFrom;
  if (!from)
    throw new Error(
      "Set emailFrom in config.json to a verified Resend sender before sending.",
    );
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is required to send email.");
  const subject = `${channel.creatorName} — Audience intelligence (${basename(folder)})`;
  await sendEmail(
    channel.recipients,
    from,
    subject,
    html,
    apiKey,
    options.fetcher,
  );
}
