import type {
  Category,
  ChannelConfig,
  Classification,
  CommentRecord,
  VideoRecord,
} from "./types.js";
import { isLowInformationComment } from "./classification.js";
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
    answered: number;
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
      "language_or_subtitles_request",
      "alternative_or_tool_request",
      "format_request",
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
      "language_or_subtitles_request",
      "alternative_or_tool_request",
      "format_request",
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
      "language_or_subtitles_request",
      "alternative_or_tool_request",
      "format_request",
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
      "language_or_subtitles_request",
      "alternative_or_tool_request",
      "format_request",
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
      .normalize("NFKC")
      .match(/[a-z0-9]{2,}/g)
      ?.map((word) => (word.length > 4 ? word.replace(/s$/, "") : word))
      .filter((word) => !questionStopWords.has(word)) ?? [],
  );
}

interface FindingGroup {
  findings: Finding[];
  viewers: number;
}

function similarWording(left: Finding, right: Finding): boolean {
  const leftWords = topicWords(left.comment.text);
  const rightWords = topicWords(right.comment.text);
  const commonWords = [...leftWords].filter((word) => rightWords.has(word));
  return commonWords.length >= Math.min(2, leftWords.size, rightWords.size);
}

function groupFindings(findings: Finding[]): FindingGroup[] {
  const groups: Finding[][] = [];
  for (const finding of findings) {
    const matches = groups.filter((group) =>
      group.some((member) => similarWording(member, finding)),
    );
    if (matches.length === 0) {
      groups.push([finding]);
      continue;
    }
    const primary = matches[0]!;
    primary.push(finding);
    for (const duplicate of matches.slice(1)) {
      primary.push(...duplicate);
      groups.splice(groups.indexOf(duplicate), 1);
    }
  }
  return groups
    .map((group) => ({
      findings: group,
      viewers: new Set(
        group.map(
          (finding) =>
            finding.comment.authorChannelId ?? finding.comment.commentId,
        ),
      ).size,
    }))
    .sort((left, right) => right.viewers - left.viewers);
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
    if (isLowInformationComment(comment.text)) continue;
    const video = videos.get(comment.videoId);
    if (!video) {
      droppedQuotes.missingVideo += 1;
      console.warn(
        `Dropping comment ${classification.commentId} because its video is unavailable.`,
      );
      continue;
    }
    findings.push({
      classification: {
        ...classification,
        quote: comment.text.trim().slice(0, 300),
      },
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
  const requestCategories = new Set<Category>([
    "how_to_question",
    "topic_request",
    "language_or_subtitles_request",
    "alternative_or_tool_request",
    "format_request",
  ]);
  const requests = groupFindings(
    ordered.filter((finding) =>
      requestCategories.has(finding.classification.category),
    ),
  );
  const fixes = groupFindings(
    ordered.filter((finding) => {
      const { classification, comment } = finding;
      const mentionsProblem = /\b(link|broken|doesn.t work|can.t find)\b/i.test(
        comment.text,
      );
      return (
        classification.category === "confusion_or_error" ||
        classification.category === "complaint_or_objection" ||
        mentionsProblem
      );
    }),
  );
  const proofs = orderProof(
    findings.filter(
      ({ classification }) =>
        classification.category === "testimonial_or_result",
    ),
    input,
  ).slice(0, 5);
  const answeredQuestions = groupFindings(
    ordered.filter(
      ({ classification }) =>
        classification.category === "how_to_question" ||
        classification.category === "buying_or_sponsor_inquiry",
    ),
  )
    .map((group) => ({
      ...group,
      answeredFindings: group.findings.filter(
        (finding) => finding.comment.creatorReplied,
      ),
    }))
    .filter(
      (group) =>
        group.answeredFindings.length > 0 &&
        (group.findings.length >= 2 ||
          group.answeredFindings.some(
            (finding) => finding.comment.likeCount >= 5,
          )),
    );
  const quickPulseCounts = {
    questions: 0,
    praise: 0,
    requests: 0,
    objections: 0,
    noise: 0,
  };
  const categoriesByComment = new Map(
    input.classifications.map((classification) => [
      classification.commentId,
      classification.category,
    ]),
  );
  for (const comment of input.comments) {
    const category = isLowInformationComment(comment.text)
      ? "spam_or_noise"
      : categoriesByComment.get(comment.commentId);
    if (
      category === "how_to_question" ||
      category === "buying_or_sponsor_inquiry"
    )
      quickPulseCounts.questions += 1;
    if (category === "praise") quickPulseCounts.praise += 1;
    if (
      category === "topic_request" ||
      category === "language_or_subtitles_request" ||
      category === "alternative_or_tool_request" ||
      category === "format_request"
    )
      quickPulseCounts.requests += 1;
    if (category === "complaint_or_objection") quickPulseCounts.objections += 1;
    if (category === "spam_or_noise") quickPulseCounts.noise += 1;
  }
  const share = (count: number) =>
    `${count} (${input.comments.length ? Math.round((count / input.comments.length) * 100) : 0}%)`;
  const viewerLabel = (viewers: number) =>
    `${viewers} viewer${viewers === 1 ? "" : "s"}`;
  const requestTitles: Record<Category, string> = {
    buying_or_sponsor_inquiry: "Purchase or sponsorship question",
    how_to_question: "Question that could inspire an idea",
    confusion_or_error: "Confusion or error",
    complaint_or_objection: "Objection or limitation",
    testimonial_or_result: "Viewer result",
    topic_request: "Topic request",
    language_or_subtitles_request: "Language or subtitle request",
    alternative_or_tool_request: "Tool or alternative request",
    format_request: "Format request",
    praise: "Praise",
    spam_or_noise: "Noise",
  };
  const requestItems = requests.map((group) => {
    const first = group.findings[0]!;
    const title =
      first.classification.category === "topic_request" &&
      first.classification.idea
        ? safeGeneratedText(first.classification.idea)
        : requestTitles[first.classification.category];
    const countLabel = `${viewerLabel(group.viewers)}${group.viewers === 1 ? " (single mention)" : ""}`;
    const examples = group.findings.slice(0, 2);
    return `- **${escapeMarkdown(title)}** — ${countLabel}\n\n${examples
      .map(
        (finding) =>
          `[Open comment](${finding.link}) on **${escapeMarkdown(finding.video.title)}**\n\n${quoteBlock(finding.classification.quote)}`,
      )
      .join("\n\n")}`;
  });
  const fixItems = fixes.map((group) => {
    const title = group.findings.some(
      (finding) => finding.classification.category === "complaint_or_objection",
    )
      ? "Objection or limitation"
      : "Issue to address";
    const countLabel = `${viewerLabel(group.viewers)}${group.viewers === 1 ? " (single mention)" : ""}`;
    const examples = group.findings.slice(0, 2);
    return `- **${title}** — ${countLabel}\n\n${examples
      .map((finding) => {
        const claimedTimestamp = finding.classification.timestamp;
        const timestamp =
          (claimedTimestamp &&
          /^\d{1,2}:\d{2}(?::\d{2})?$/.test(claimedTimestamp) &&
          finding.comment.text.includes(claimedTimestamp)
            ? claimedTimestamp
            : undefined) ?? timestampFrom(finding.comment.text);
        return `[Open comment](${finding.link}) on **${escapeMarkdown(finding.video.title)}${timestamp ? ` at ${timestamp}` : ""}**\n\n${quoteBlock(finding.classification.quote)}`;
      })
      .join("\n\n")}`;
  });
  const answeredItems = answeredQuestions.map((group) => {
    const countLabel = viewerLabel(group.viewers);
    const examples = group.answeredFindings.slice(0, 2);
    return `- **Repeated or high-like question** — ${countLabel}\n\n${examples
      .map((finding) => {
        const replyLink = finding.comment.creatorReplyId
          ? buildDeepLink(
              finding.comment.videoId,
              finding.comment.commentId,
              finding.comment.creatorReplyId,
            )
          : undefined;
        return [
          `[Open question](${finding.link}) on **${escapeMarkdown(finding.video.title)}**`,
          quoteBlock(finding.classification.quote),
          replyLink ? `[Open creator reply](${replyLink})` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
      })
      .join(
        "\n\n",
      )}\n\n  **Suggestion:** Pin an answer comment or add it to the video description FAQ.`;
  });
  const sectionItemCounts = {
    money: money.length,
    ideas: requests.length,
    fixes: fixes.length,
    proofs: proofs.length,
    answered: answeredItems.length,
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
    "## Quick pulse",
    `- Comments analyzed: ${input.comments.length}`,
    `- Questions: ${share(quickPulseCounts.questions)}`,
    `- Praise: ${share(quickPulseCounts.praise)}`,
    `- Requests: ${share(quickPulseCounts.requests)}`,
    `- Objections: ${share(quickPulseCounts.objections)}`,
    `- Noise: ${share(quickPulseCounts.noise)}`,
    `- Creator replied: ${share(input.comments.filter((comment) => comment.creatorReplied).length)}`,
    input.classificationSucceeded === false
      ? "_Classification incomplete; category shares may be partial._"
      : "",
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
    "## B. Requests and ideas",
    requestItems.length
      ? requestItems.join("\n\n")
      : input.classificationSucceeded === false
        ? incompleteMessage
        : "_No questions or viewer requests found._",
    "",
    "## C. Fix list",
    fixItems.length
      ? fixItems.join("\n\n")
      : input.classificationSucceeded === false
        ? incompleteMessage
        : "_No confusion, issue, or objection identified._",
    "",
    "## D. Proof pack",
    proofs.length
      ? proofs.map(markdownFinding).join("\n\n")
      : input.classificationSucceeded === false
        ? incompleteMessage
        : "_No testimonial or result comment identified._",
    "",
    "## E. Already answered: pin these",
    answeredItems.length
      ? answeredItems.join("\n\n")
      : input.classificationSucceeded === false
        ? incompleteMessage
        : "_No repeated or high-like answered question found._",
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
