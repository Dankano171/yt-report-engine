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

The default is always a dry run: it writes `output/<channel>/<date>/report.html`, `report.md`, and `stats.json` and does not send email. The run prints progress and a summary of fetched/analyzed data, classifications, report items, and quote verification. Use `--debug` to log sanitized per-response counts, short returned indexes, text-length metrics, Gemini finish/token metadata, rejected optional fields, and provider error details without printing comment text. `--dump-prompt` writes the exact prompt and raw provider response body for each batch under `output/<channel>/<date>/debug/`; `--dump-youtube` writes the first three raw public comment-thread items from the first video to `youtube-sample.json` in that debug folder. These files are created with private permissions, contain no request URLs or API keys, and are removed by `purge` after 30 days. `--classify-only` classifies only the first batch, prints the same diagnostics, saves `stats.json`, and skips the report.

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
pnpm start -- purge   # Permanently remove cached comments and debug dumps older than 30 days
pnpm start -- cost    # Show today's recorded quota/token/cost estimates
pnpm check:secrets    # Scan tracked working files for common API-key shapes
```

The scanner is a best-effort guard, not a substitute for keeping secrets out of source control. Usage records contain counts and estimates only, never keys or comment text.

## Configuration and costs

`provider` may be `gemini`, `anthropic`, `openai`, or `mock` (the mock provider is for tests and local development only). Set `model` to a model available for the selected provider; `fallbackModel` is optional and is used after four 429/503 retries on the primary model. Optional Gemini request settings can be set per model under `modelOptions`, for example `"modelOptions": {"gemini-2.5-flash": {"thinkingBudget": 0, "maxOutputTokens": 1024}}`. Supported settings are `responseMimeType`, `responseSchema`, `thinkingBudget` (sent as `thinkingConfig.thinkingBudget`), and `maxOutputTokens`. By default the request uses JSON MIME output and a conservative output-token budget, without a response schema or thinking config. If a model rejects `thinkingConfig` or `responseSchema` as an unsupported field, that field is dropped for subsequent requests to that model during the run. Each channel needs exactly one of `handle` or `channelId`, a `creatorName`, `creatorGoal` (`sell_course`, `sell_tool`, `sponsorships`, or `grow_audience`), and a non-empty `recipients` list. Optional `productKeywords` help classify relevant inquiries. `limits` controls videos (default 8), comment threads per video (default 300), estimated LLM spend per run/day (defaults $0.50/$2.00), and output budget (default 60 tokens per comment plus 256 tokens overhead; configurable with `maxOutputTokensPerComment` and `outputTokenOverhead`). Adjust these caps to suit the account and provider. YouTube quota units and model token/cost figures are estimates; provider pricing and quota rules can change. Run `cost` to see locally recorded usage for the current UTC day.

The program excludes the creator's own top-level comments from analysis and reports. Comment threads are parsed from `item.snippet.topLevelComment.snippet`; if more than 20% of viewer comments have empty text, the run saves stats and aborts before any LLM call. `stats.json` records creator comments, empty text, exclusions, comments not analyzed, sent, classified, and unclassified so fetched-comment totals reconcile. Repeated short phrases (under six words, at least five comments in one video) are classified as keyword responses rather than noise or requests; the report shows response and creator-reply counts, and lists only unanswered calls to action in section A. The program batches remaining comments and checks the estimate against configured spend caps before each LLM call. It retries transient network/server failures with backoff and stops without retrying quota exhaustion. The model receives sequential integer indexes instead of YouTube comment IDs, and returns category/timestamp only. Categories are normalized and known synonyms are mapped; unknown categories are retried once with the allowed list. Quotes always come from fetched comment text in code, trimmed at a word boundary with an ellipsis when over 300 characters, never from model output. Any response guidance is labeled as suggestions, not a draft to post, and avoids promises. Output is validated in code; valid items are kept, missing, invalid, or unmapped items are retried once using new short indexes, and Gemini output truncated at `MAX_TOKENS` is retried in smaller batches. Any remaining comments are counted as unclassified in `stats.json` and excluded from findings; a run stops without a report only when more than 30% of analyzed comments are unclassified. Comment text is cached in full `CommentRecord` form; the cache currently archives fetched records and is not read as a cache hit. `purge` removes cache files and debug dumps older than 30 days, but leaves reports and usage records untouched.

## How to read the report

- **Quick pulse:** direct counts and shares for analyzed comments, questions, praise, requests, objections, noise, and creator replies. It contains no scores or ratings.
- **Money on the table:** unanswered purchase/sponsor inquiries, high-like questions, and grouped unanswered keyword responses, with public comment links. Response guidance is suggestions only, not a draft reply.
- **Requests and ideas:** topic, language/subtitle, alternative-tool, and format requests, plus questions that could inspire ideas. Similar comments have short comment-derived titles, up to three quotes, a total count, and an “and N more” note when needed.
- **Fix list:** confusion, broken/missing links, objections, and stated limitations. Similar comments are grouped with short comment-derived titles, up to three quotes, a total count, and an “and N more” note when needed.
- **Proof pack:** selected viewer testimonials/results. Ordering is tailored to the creator goal.
- **Already answered: pin these:** repeated or high-like questions that have a creator reply, with the fetched reply link when available and a short comment-derived title.

Repeated short calls to action (five or more matching phrases in a video) are counted in Quick pulse with the number of viewers and creator replies. Section A links only responses that have not received a creator reply.

Emoji-only, one-word, and content-free comments are classified as noise and counted, but never shown as findings. “How to read this” notes that the analysis is AI-generated. Counts and links come from fetched data; quotes are kept only when they match the fetched source comment after Unicode, whitespace, and HTML-entity normalization.

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
- Reports are left on disk until you remove them; `purge` removes old raw-comment cache and debug dumps, not reports or usage records.

## LIMITATIONS

- Only public comments visible through the YouTube Data API are available.
- The tool does not fetch or analyze video transcripts.
- Draft replies must be reviewed and edited by the creator; the tool never replies on YouTube.
- Results are AI-generated and can contain mistakes. Verify insights, links, draft wording, and context before acting.
