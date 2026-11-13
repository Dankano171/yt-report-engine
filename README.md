# yt-report-engine

A read-only YouTube audience intelligence CLI. It reads public comments on recent channel videos and creates an AI-assisted weekly email/report. It never posts, replies, likes, or deletes anything on YouTube.

## Setup (phone-friendly)

1. Install Node.js 22.9 or newer and pnpm on the computer that will run this tool. Copy this repository to that computer and open a terminal in its folder.
2. Copy `config.example.json` to `config.json` and change the creator name, channel handle (or channel ID), recipient email, goal, optional product keywords, model, optional fallback model, and `emailFrom`. The sender address must be verified for your Resend account. Keep `config.json` private; it is git-ignored.
3. In Google Cloud, enable YouTube Data API v3 and create an API key. Create an API key with your chosen LLM provider (Gemini, Anthropic, or OpenAI) and a Resend API key if you plan to send email. Restrict keys to the relevant APIs/services wherever supported. Do not paste keys into config or chat.
4. Install and build:

   ```sh
   pnpm install
   pnpm build
   ```

5. Set keys safely in a terminal session. The shell's hidden input avoids echoing the secret on screen:

   ```sh
   read -s YOUTUBE_API_KEY && export YOUTUBE_API_KEY
   read -s LLM_API_KEY && export LLM_API_KEY
   read -s RESEND_API_KEY && export RESEND_API_KEY
   ```

   Alternatively, put values in a local `.env` file (never commit or share it). `pnpm start` loads `.env` using Node's built-in `--env-file-if-exists`. `.env.example` contains placeholders only.

## Run a dry report

```sh
pnpm start -- run --channel @examplecreator --days 30
```

The default is always a dry run: it writes `output/<channel>/<date>/report.html`, `report.md`, and `stats.json` and does not send email. The run prints progress and a summary of fetched/analyzed data, classifications, report items, and quote verification. Use `--debug` to log batch outcomes without printing comment text. Open the HTML on a phone or read the Markdown. The report includes linked viewer quotes; inspect the draft replies and AI findings before using them.

To explicitly run and send the report to the configured opt-in recipients:

```sh
pnpm start -- run --channel @examplecreator --days 30 --send
```

Or send a previously generated report:

```sh
pnpm start -- send output/@examplecreator/2026-02-25
```

Use your own address as the only recipient for a test email. Sending requires both `--send`, at least one configured recipient, `emailFrom`, `RESEND_API_KEY`, and a Resend-verified sender. A dry run never sends. `--dry-run` and `--send` cannot be combined.

## Other commands

```sh
pnpm start -- purge   # Permanently remove cached comment text older than 30 days
pnpm start -- cost    # Show today's recorded quota/token/cost estimates
pnpm check:secrets    # Scan tracked working files for common API-key shapes
```

The scanner is a best-effort guard, not a substitute for keeping secrets out of source control. Usage records contain counts and estimates only, never keys or comment text.

## Configuration and costs

`provider` may be `gemini`, `anthropic`, `openai`, or `mock` (the mock provider is for tests and local development only). Set `model` to a model available for the selected provider; `fallbackModel` is optional and is used after four 429/503 retries on the primary model. Each channel needs exactly one of `handle` or `channelId`, a `creatorName`, `creatorGoal` (`sell_course`, `sell_tool`, `sponsorships`, or `grow_audience`), and a non-empty `recipients` list. Optional `productKeywords` help classify relevant inquiries. `limits` controls videos (default 8), comment threads per video (default 300), and estimated LLM spend per run/day (defaults $0.50/$2.00). Adjust these caps to suit the account and provider. YouTube quota units and model token/cost figures are estimates; provider pricing and quota rules can change. Run `cost` to see locally recorded usage for the current UTC day.

The program batches comments and checks the estimate against the configured spend caps before each LLM call. It retries transient network/server failures with backoff and stops without retrying quota exhaustion. Invalid JSON or schema output is retried once with a stricter reminder; a failed batch is recorded in `stats.json`, and runs with more than 30% failed batches stop without creating a report. Comment text is cached only as needed and cache files older than 30 days can be removed with `purge`; the retention rule applies to cached raw comment text, not reports you choose to keep.

## How to read the report

- **Money on the table:** unanswered purchase/sponsor inquiries and high-like questions, with each quote, its public comment link, and a clearly marked editable draft reply.
- **Next video ideas:** 2–3 proposals based on repeated questions and topic requests, grounded in viewer wording and linked examples.
- **Fix list:** confusion, apparent broken/missing links, and recurring complaints, with a video and any available timestamp.
- **Proof pack:** selected viewer testimonials/results. Ordering is tailored to the creator goal.

“How to read this” notes that the analysis is AI-generated. Counts and links come from fetched data; quotes are kept only when they match the fetched source comment after Unicode, whitespace, and HTML-entity normalization.

## Troubleshooting

- **No channel found:** use a public channel handle such as `@name` or a channel ID (`UC...`) that the YouTube Data API can resolve. The pipeline uses channels/playlist/videos endpoints and does not use YouTube search.
- **API key/quota errors:** confirm YouTube Data API v3 is enabled and the key is valid; quota exhaustion stops cleanly. Try fewer days/videos/threads later.
- **No recent data or comments disabled:** a short “not enough data” report is expected; it is not an error.
- **LLM errors or spend cap:** confirm `provider` and `LLM_API_KEY` match, or raise the caps intentionally. Keys are redacted from error output.
- **Email not delivered:** check the configured recipient, `emailFrom`, Resend API key, verified sender/domain, and Resend dashboard. Email is never sent unless explicitly requested.
- **Secret scan failures:** remove actual keys from files and rotate any key that was committed or shared. The scanner ignores placeholders in example files.

## Assumptions

- A YouTube handle or channel ID identifies one configured channel. Channel handles are resolved through the YouTube `channels.list` forHandle endpoint; no search endpoint is used.
- Runs are on demand; schedule the CLI weekly with your device's scheduler if you want a recurring report.
- `emailFrom` is global configuration because Resend requires a sender identity. Configure a verified sender before using `--send`.
- “High-like” means at least 5 likes, a fixed implementation threshold rather than a model-generated score. It is not a health rating.
- Provider prices are rough estimates, not billing guarantees. The tool uses recent public data only and cannot see private, held-for-review, or deleted comments.
- Reports are left on disk until you remove them; `purge` deletes only the raw-comment cache, not reports or usage records.

## LIMITATIONS

- Only public comments visible through the YouTube Data API are available.
- The tool does not fetch or analyze video transcripts.
- Draft replies must be reviewed and edited by the creator; the tool never replies on YouTube.
- Results are AI-generated and can contain mistakes. Verify insights, links, draft wording, and context before acting.
