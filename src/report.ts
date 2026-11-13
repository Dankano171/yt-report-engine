import type {
  Category,
  ChannelConfig,
  Classification,
  CommentRecord,
  VideoRecord,
} from "./types.js";
import { buildDeepLink } from "./youtube.js";

interface ReportInput {
  channel: ChannelConfig;
  videos: VideoRecord[];
  comments: CommentRecord[];
  classifications: Classification[];
  dateRange: { from: string; to: string };
  classificationSucceeded?: boolean;
  stoppedReason?: string;
}

interface Finding {
  classification: Classification;
  comment: CommentRecord;
  video: VideoRecord;
  link: string;
}

export interface RenderedReport {
  markdown: string;
  html: string;
  verifiedClassifications: Classification[];
  sectionItemCounts: {
    money: number;
    ideas: number;
    fixes: number;
    proofs: number;
  };
  droppedQuotes: {
    emptyQuote: number;
    quoteNotFound: number;
    unknownComment: number;
    missingVideo: number;
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeMarkdown(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replace(/([`*_{}()#+.!|>])/g, "\\$1")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("\n", " ");
}

function safeGeneratedText(value: string): string {
  return value
    .replace(/\[[^\]]+\]\(https?:\/\/[^)]+\)/gi, (match) =>
      match.slice(1, match.indexOf("](")),
    )
    .replace(/https?:\/\/\S+/gi, "[link omitted]");
}

function quoteBlock(quote: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...[...quote.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}text\n${quote}\n${fence}`;
}

function timestampFrom(text: string): string | undefined {
  return text.match(/\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b/)?.[0];
}

function goalOrder(channel: ChannelConfig): Category[] {
  const orders: Record<ChannelConfig["creatorGoal"], Category[]> = {
    sell_course: [
      "buying_or_sponsor_inquiry",
      "testimonial_or_result",
      "how_to_question",
      "confusion_or_error",
      "complaint_or_objection",
      "topic_request",
      "praise",
      "spam_or_noise",
    ],
    sell_tool: [
      "buying_or_sponsor_inquiry",
      "confusion_or_error",
      "how_to_question",
      "testimonial_or_result",
      "complaint_or_objection",
      "topic_request",
      "praise",
      "spam_or_noise",
    ],
    sponsorships: [
      "buying_or_sponsor_inquiry",
      "testimonial_or_result",
      "praise",
      "how_to_question",
      "complaint_or_objection",
      "confusion_or_error",
      "topic_request",
      "spam_or_noise",
    ],
    grow_audience: [
      "topic_request",
      "how_to_question",
      "testimonial_or_result",
      "praise",
      "confusion_or_error",
      "complaint_or_objection",
      "buying_or_sponsor_inquiry",
      "spam_or_noise",
    ],
  };
  return orders[channel.creatorGoal];
}

function orderedFindings(
  findings: Finding[],
  channel: ChannelConfig,
): Finding[] {
  const priorities = goalOrder(channel);
  return [...findings].sort(
    (left, right) =>
      priorities.indexOf(left.classification.category) -
        priorities.indexOf(right.classification.category) ||
      right.comment.likeCount - left.comment.likeCount,
  );
}

const questionStopWords = new Set([
  "about",
  "and",
  "can",
  "could",
  "does",
  "how",
  "i",
  "is",
  "it",
  "me",
  "my",
  "please",
  "the",
  "this",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "would",
  "you",
]);

function topicWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .match(/[a-z0-9]{4,}/g)
      ?.filter((word) => !questionStopWords.has(word)) ?? [],
  );
}

function isRecurringQuestion(finding: Finding, questions: Finding[]): boolean {
  const words = topicWords(finding.comment.text);
  return questions.some(
    (other) =>
      other !== finding &&
      [...words].some((word) => topicWords(other.comment.text).has(word)),
  );
}

function isRecurringComplaint(finding: Finding, findings: Finding[]): boolean {
  const words = topicWords(finding.comment.text);
  return findings.some(
    (other) =>
      other !== finding &&
      other.classification.category === "complaint_or_objection" &&
      [...words].some((word) => topicWords(other.comment.text).has(word)),
  );
}

function normalizeForQuoteMatch(text: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    bull: "•",
    copy: "©",
    eacute: "é",
    Eacute: "É",
    egrave: "è",
    Egrave: "È",
    gt: ">",
    hellip: "…",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    mdash: "—",
    ndash: "–",
    nbsp: " ",
    quot: '"',
    rdquo: "”",
    reg: "®",
    rsquo: "’",
    trade: "™",
  };
  return text
    .replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/gi, (entity, value: string) => {
      if (value.startsWith("#")) {
        const hex = value[1]?.toLowerCase() === "x";
        const codePoint = Number.parseInt(
          value.slice(hex ? 2 : 1),
          hex ? 16 : 10,
        );
        return Number.isFinite(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      return (
        namedEntities[value] ?? namedEntities[value.toLowerCase()] ?? entity
      );
    })
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

function findingList(input: ReportInput): {
  findings: Finding[];
  droppedQuotes: RenderedReport["droppedQuotes"];
} {
  const comments = new Map(
    input.comments.map((comment) => [comment.commentId, comment]),
  );
  const videos = new Map(input.videos.map((video) => [video.videoId, video]));
  const findings: Finding[] = [];
  const droppedQuotes = {
    emptyQuote: 0,
    quoteNotFound: 0,
    unknownComment: 0,
    missingVideo: 0,
  };
  for (const classification of input.classifications) {
    const comment = comments.get(classification.commentId);
    if (!comment) {
      droppedQuotes.unknownComment += 1;
      console.warn(
        `Dropping classification for unknown comment ${classification.commentId}.`,
      );
      continue;
    }
    const quote = normalizeForQuoteMatch(classification.quote);
    if (!quote) {
      droppedQuotes.emptyQuote += 1;
      console.warn(
        `Dropping empty quote for comment ${classification.commentId}.`,
      );
      continue;
    }
    if (!normalizeForQuoteMatch(comment.text).includes(quote)) {
      droppedQuotes.quoteNotFound += 1;
      console.warn(
        `Dropping non-verbatim quote for comment ${classification.commentId}.`,
      );
      continue;
    }
    const video = videos.get(comment.videoId);
    if (!video) {
      droppedQuotes.missingVideo += 1;
      console.warn(
        `Dropping comment ${classification.commentId} because its video is unavailable.`,
      );
      continue;
    }
    findings.push({
      classification,
      comment,
      video,
      link: buildDeepLink(comment.videoId, comment.commentId),
    });
  }
  return { findings, droppedQuotes };
}

function orderProof(findings: Finding[], input: ReportInput): Finding[] {
  const goal = input.channel.creatorGoal;
  const keywords = input.channel.productKeywords.map((keyword) =>
    keyword.toLowerCase(),
  );
  return findings.sort((left, right) => {
    const isRelevant = (finding: Finding) => {
      const text = finding.comment.text.toLowerCase();
      if (keywords.some((keyword) => text.includes(keyword))) return 1;
      if (
        goal === "sell_course" &&
        /\b(course|lesson|learn|student)\b/.test(text)
      )
        return 1;
      if (goal === "sell_tool" && /\b(tool|app|software|product)\b/.test(text))
        return 1;
      if (goal === "sponsorships" && /\b(sponsor|brand|partner)\b/.test(text))
        return 1;
      return 0;
    };
    return (
      isRelevant(right) - isRelevant(left) ||
      right.comment.likeCount - left.comment.likeCount
    );
  });
}

function markdownFinding(finding: Finding): string {
  return `- **${escapeMarkdown(finding.video.title)}** — ${finding.comment.likeCount} likes — [Open comment](${finding.link})\n\n${quoteBlock(finding.classification.quote)}`;
}

function renderMarkdown(
  input: ReportInput,
  findings: Finding[],
): {
  markdown: string;
  sectionItemCounts: RenderedReport["sectionItemCounts"];
} {
  const videoNames = input.videos.length
    ? input.videos.map((video) => `“${escapeMarkdown(video.title)}”`).join(", ")
    : "none";
  const ordered = orderedFindings(findings, input.channel);
  const money = ordered.filter(
    ({ classification, comment }) =>
      !comment.creatorReplied &&
      (classification.category === "buying_or_sponsor_inquiry" ||
        (classification.category === "how_to_question" &&
          comment.likeCount >= 5)),
  );
  const questions = ordered.filter(
    ({ classification }) =>
      classification.category === "how_to_question" ||
      classification.category === "topic_request",
  );
  const ideas: Finding[] = [];
  for (const finding of questions) {
    if (
      finding.classification.category === "how_to_question" &&
      !isRecurringQuestion(finding, questions)
    )
      continue;
    if (
      ideas.some(
        (idea) =>
          idea.comment.text.toLowerCase() ===
          finding.comment.text.toLowerCase(),
      )
    )
      continue;
    ideas.push(finding);
    if (ideas.length === 3) break;
  }
  const fixes = ordered.filter((finding) => {
    const { classification, comment } = finding;
    const mentionsProblem = /\b(link|broken|doesn.t work|can.t find)\b/i.test(
      comment.text,
    );
    return (
      classification.category === "confusion_or_error" ||
      (classification.category === "complaint_or_objection" &&
        isRecurringComplaint(finding, ordered)) ||
      mentionsProblem
    );
  });
  const proofs = orderProof(
    findings.filter(
      ({ classification }) =>
        classification.category === "testimonial_or_result",
    ),
    input,
  ).slice(0, 5);
  const sectionItemCounts = {
    money: money.length,
    ideas: ideas.length,
    fixes: fixes.length,
    proofs: proofs.length,
  };
  const incompleteMessage =
    "_Not reported because classification did not complete successfully._";
  const enough = input.videos.length > 0 || input.comments.length > 0;
  const sections = [
    `# ${escapeMarkdown(input.channel.creatorName)} — Audience intelligence`,
    "",
    "> **How to read this:** Viewer quotes and counts are from public comments. AI-generated findings and reply suggestions may be mistaken; review all drafts before use.",
    input.stoppedReason ? `\n> **Analysis note:** ${input.stoppedReason}` : "",
    "",
    "## A. Money on the table",
    money.length
      ? money
          .map(
            (finding) =>
              `${markdownFinding(finding)}\n\n  **DRAFT reply (edit before use):** ${escapeMarkdown(safeGeneratedText(finding.classification.draftReply ?? "Thanks for asking! I’ll share more details with you soon."))}`,
          )
          .join("\n\n")
      : input.classificationSucceeded === false
        ? incompleteMessage
        : "_No unanswered purchase/sponsor inquiry or high-like question found in the analyzed comments._",
    "",
    "## B. Next video ideas",
    ideas.length
      ? ideas
          .map(
            (finding, index) =>
              `${index + 1}. **${escapeMarkdown(safeGeneratedText(finding.classification.idea ?? "A video based on this viewer question"))}** — based on [this comment](${finding.link}) on “${escapeMarkdown(finding.video.title)}”:\n\n${quoteBlock(finding.classification.quote)}`,
          )
          .join("\n")
      : input.classificationSucceeded === false
        ? incompleteMessage
        : "_Not enough recurring questions or topic requests to suggest a video._",
    "",
    "## C. Fix list",
    fixes.length
      ? fixes
          .map((finding) => {
            const claimedTimestamp = finding.classification.timestamp;
            const timestamp =
              (claimedTimestamp &&
              /^\d{1,2}:\d{2}(?::\d{2})?$/.test(claimedTimestamp) &&
              finding.comment.text.includes(claimedTimestamp)
                ? claimedTimestamp
                : undefined) ?? timestampFrom(finding.comment.text);
            return `- **${escapeMarkdown(finding.video.title)}${timestamp ? ` at ${timestamp}` : ""}** — [Open comment](${finding.link})\n\n${quoteBlock(finding.classification.quote)}`;
          })
          .join("\n")
      : input.classificationSucceeded === false
        ? incompleteMessage
        : "_No clear confusion, link issue, or recurring complaint identified._",
    "",
    "## D. Proof pack",
    proofs.length
      ? proofs.map(markdownFinding).join("\n\n")
      : input.classificationSucceeded === false
        ? incompleteMessage
        : "_No testimonial or result comment identified._",
    "",
    !enough
      ? "_Not enough data: no recent public videos or public comments were available to analyze._"
      : input.comments.length === 0
        ? "_Not enough data: recent videos were found, but no public comments were available to analyze._"
        : "",
    "",
    `---\nDate range: ${input.dateRange.from} to ${input.dateRange.to} · Videos analyzed (${input.videos.length}): ${videoNames}\n\nYou received this because you opted in. To unsubscribe, reply to the email asking to be removed.`,
    "",
  ];
  return {
    markdown: sections.filter((section) => section !== "").join("\n"),
    sectionItemCounts,
  };
}

function markdownToHtml(markdown: string): string {
  const allowedLinks = new Set(
    [
      ...markdown.matchAll(
        /\]\((https:\/\/www\.youtube\.com\/watch\?v=[^ )]+)\)/g,
      ),
    ].map((match) => match[1]),
  );
  const inline = (value: string) => {
    let output = "";
    let start = 0;
    for (const match of value.matchAll(
      /\[([^\]]+)\]\((https:\/\/www\.youtube\.com\/watch\?v=[^ )]+)\)/g,
    )) {
      const index = match.index ?? 0;
      output += escapeHtml(value.slice(start, index));
      const [fullMatch, label = "", url = ""] = match;
      output += allowedLinks.has(url)
        ? `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`
        : escapeHtml(fullMatch);
      start = index + fullMatch.length;
    }
    output += escapeHtml(value.slice(start));
    return output
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/\\([\\`*_{}()#+.!|>])/g, "$1")
      .replaceAll("\\[", "[")
      .replaceAll("\\]", "]");
  };
  const lines = markdown.split("\n");
  const output: string[] = [];
  let inList = false;
  let inCodeBlock = false;
  let codeLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        output.push(
          `<pre class="quote">${escapeHtml(codeLines.join("\n"))}</pre>`,
        );
        codeLines = [];
        inCodeBlock = false;
      } else {
        if (inList) {
          output.push("</ul>");
          inList = false;
        }
        inCodeBlock = true;
      }
    } else if (inCodeBlock) {
      codeLines.push(line);
    } else if (line.startsWith("# "))
      output.push(`<h1>${inline(line.slice(2))}</h1>`);
    else if (line.startsWith("## "))
      output.push(`<h2>${inline(line.slice(3))}</h2>`);
    else if (line.startsWith("> "))
      output.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
    else if (line.startsWith("- ") || /^\d+\.\s/.test(line)) {
      if (!inList) {
        output.push("<ul>");
        inList = true;
      }
      output.push(`<li>${inline(line.replace(/^(?:- |\d+\.\s)/, ""))}</li>`);
    } else {
      if (inList) {
        output.push("</ul>");
        inList = false;
      }
      if (line.startsWith("---")) output.push("<hr>");
      else if (line.trim()) output.push(`<p>${inline(line.trim())}</p>`);
    }
  }
  if (inList) output.push("</ul>");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Audience intelligence</title><style>
body{margin:0;background:#f4f6f8;color:#20242a;font:16px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:720px;margin:24px auto;padding:24px;background:#fff;border-radius:12px}
h1{font-size:1.6rem;line-height:1.25}h2{font-size:1.2rem;margin-top:2rem;border-bottom:1px solid #e5e7eb;padding-bottom:.4rem}
blockquote{margin:1rem 0;padding:.75rem 1rem;border-left:4px solid #5677d1;background:#f7f8fb;overflow-wrap:anywhere}
.quote{margin:.5rem 0 1rem;padding:1rem;background:#f7f8fb;border-left:4px solid #5677d1;border-radius:4px;font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}
a{color:#2455be}li{margin:.65rem 0}footer{margin-top:2rem;color:#59616b;font-size:.9rem}
@media(max-width:600px){main{margin:0;padding:18px;border-radius:0}body{font-size:15px}}
</style></head><body><main>${output.join("\n")}<footer>AI-generated analysis. Review before acting.</footer></main></body></html>`;
}

export function renderReport(input: ReportInput): RenderedReport {
  const verification = findingList(input);
  const rendered = renderMarkdown(input, verification.findings);
  return {
    markdown: rendered.markdown,
    html: markdownToHtml(rendered.markdown),
    verifiedClassifications: verification.findings.map(
      (finding) => finding.classification,
    ),
    sectionItemCounts: rendered.sectionItemCounts,
    droppedQuotes: verification.droppedQuotes,
  };
}
