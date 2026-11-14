import type {
  Category,
  ChannelConfig,
  Classification,
  CommentRecord,
  VideoRecord,
} from "./types.js";
import {
  isLowInformationComment,
  keywordResponseGroupKey,
  normalizeKeywordResponse,
  truncateQuote,
} from "./classification.js";
import { clusterComments, type WritingCluster } from "./llm.js";
import { buildDeepLink } from "./youtube.js";
import type { AppConfig, Fetcher, UsageRecord } from "./types.js";

export interface ReportInput {
  channel: ChannelConfig;
  videos: VideoRecord[];
  comments: CommentRecord[];
  classifications: Classification[];
  dateRange: { from: string; to: string };
  classificationSucceeded?: boolean;
  stoppedReason?: string;
}

export type ReportSection = "money" | "ideas" | "fixes" | "proofs" | "answered";
export type ReportClusters = Partial<
  Record<ReportSection, { clusters: WritingCluster[]; commentIds: string[] }>
>;

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
    .replaceAll("'", "&#39;")
    .replace(/&amp;(#(?:\d+|x[\da-f]+)|[a-z]+);/gi, "&$1;");
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/[\s\S]/g, (character) =>
      character === "\\" || "`*_{}()#+.!|>[][".includes(character)
        ? `&#${character.codePointAt(0)};`
        : character,
    )
    .replaceAll("\n", " ");
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

function inlineHtml(value: string): string {
  return escapeHtml(value).replace(/&#(\d+);/g, (entity, number: string) => {
    const code = Number(number);
    return [34, 38, 39, 60, 62].includes(code)
      ? entity
      : String.fromCodePoint(code);
  });
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
      "keyword_response",
      "suspected_bot_or_promo",
      "purchase_intent",
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
      "keyword_response",
      "suspected_bot_or_promo",
      "purchase_intent",
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
      "keyword_response",
      "suspected_bot_or_promo",
      "purchase_intent",
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
      "keyword_response",
      "suspected_bot_or_promo",
      "purchase_intent",
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

interface FindingGroup {
  findings: Finding[];
  viewers: number;
  title?: string;
  paraphrase?: string;
}

const requestCategories = new Set<Category>([
  "how_to_question",
  "topic_request",
  "language_or_subtitles_request",
  "alternative_or_tool_request",
  "format_request",
]);

function isActionableMoney(finding: Finding): boolean {
  const { classification, comment } = finding;
  const topicNeedsCreatorAction =
    /\b(buy|purchase|access|price|pricing|cost|payment|paid|sponsor|partnership|refund|membership|password|login|account)\b/i.test(
      comment.text,
    );
  const reportsProblem =
    /\b(problem|issue|broken|can't|cannot|doesn't work|won't|asks? for|asked for|can't access|cannot access)\b/i.test(
      comment.text,
    );
  const asksQuestion =
    /[?]|\b(what|how|where|when|can|could|does|do|is|are|which|who)\b/i.test(
      comment.text,
    );
  return (
    !comment.creatorReplied &&
    (isCustomerProblem(finding) ||
      (classification.category === "buying_or_sponsor_inquiry" &&
        topicNeedsCreatorAction &&
        asksQuestion) ||
      (classification.category === "how_to_question" &&
        topicNeedsCreatorAction &&
        asksQuestion) ||
      ((classification.category === "confusion_or_error" ||
        classification.category === "complaint_or_objection") &&
        topicNeedsCreatorAction &&
        reportsProblem))
  );
}

function isCustomerProblem(finding: Finding): boolean {
  const text = finding.comment.text;
  const paidOrJoined =
    /\b(paid|payment|purchased|bought|joined|membership|member level|subscription)\b/i.test(
      text,
    );
  const deliveryOrAccessProblem =
    /\b(password|access|login|link|guide|download|delivery|asked for|asks for)\b/i.test(
      text,
    );
  const asksForHelp =
    /[?]|\b(how|where|can|could|please|help|can't|cannot|doesn't work|broken)\b/i.test(
      text,
    );
  return paidOrJoined && deliveryOrAccessProblem && asksForHelp;
}

function isFix(finding: Finding): boolean {
  const { classification, comment } = finding;
  return (
    !comment.creatorReplied &&
    !isCustomerProblem(finding) &&
    (classification.category === "confusion_or_error" ||
      classification.category === "complaint_or_objection" ||
      /\b(link|broken|doesn.t work|can.t find|password|access problem)\b/i.test(
        comment.text,
      ))
  );
}

function isAnsweredQuestion(finding: Finding): boolean {
  return (
    finding.comment.creatorReplied &&
    (finding.classification.category === "how_to_question" ||
      finding.classification.category === "buying_or_sponsor_inquiry")
  );
}

function isUnansweredRequest(finding: Finding): boolean {
  return (
    !finding.comment.creatorReplied &&
    requestCategories.has(finding.classification.category)
  );
}

export async function clusterReportSections(
  input: ReportInput,
  config: AppConfig,
  fetcher?: Fetcher,
  now?: Date,
  onUsage?: (record: UsageRecord) => Promise<void>,
  reserveUsd?: (estimate: number) => boolean,
): Promise<ReportClusters> {
  const findings = findingList(input).findings;
  const moneyIds = new Set(
    findings
      .filter(isActionableMoney)
      .map((finding) => finding.comment.commentId),
  );
  const sectionComments: Record<ReportSection, CommentRecord[]> = {
    money: findings.filter(isActionableMoney).map((finding) => finding.comment),
    ideas: findings
      .filter(
        (finding) =>
          isUnansweredRequest(finding) &&
          !moneyIds.has(finding.comment.commentId),
      )
      .map((finding) => finding.comment),
    fixes: findings
      .filter(isFix)
      .filter(
        (finding) =>
          !isUnansweredRequest(finding) &&
          !moneyIds.has(finding.comment.commentId),
      )
      .map((finding) => finding.comment),
    proofs: findings
      .filter(
        (finding) =>
          finding.classification.category === "testimonial_or_result",
      )
      .map((finding) => finding.comment),
    answered: findings
      .filter(isAnsweredQuestion)
      .map((finding) => finding.comment),
  };
  const clusters: ReportClusters = {};
  for (const section of Object.keys(sectionComments) as ReportSection[]) {
    const comments = sectionComments[section];
    if (comments.length === 0) continue;
    clusters[section] = {
      clusters: await clusterComments(comments, {
        provider: config.provider,
        ...((config.writingModel ?? config.model)
          ? { model: config.writingModel ?? config.model }
          : {}),
        ...((config.writingFallbackModel ??
        config.fallbackModel ??
        config.writingModel ??
        config.model)
          ? {
              fallbackModel:
                config.writingFallbackModel ??
                config.fallbackModel ??
                config.writingModel ??
                config.model,
            }
          : {}),
        ...(process.env.LLM_API_KEY ? { apiKey: process.env.LLM_API_KEY } : {}),
        ...(fetcher ? { fetcher } : {}),
        ...(config.modelOptions ? { modelOptions: config.modelOptions } : {}),
        section,
        ...(now ? { date: now.toISOString().slice(0, 10) } : {}),
        ...(onUsage ? { onUsage } : {}),
        ...(reserveUsd ? { reserveUsd } : {}),
      }),
      commentIds: comments.map((comment) => comment.commentId),
    };
  }
  return clusters;
}

function categoryTitle(category: Category): string {
  return category
    .split("_")
    .map((word) => word[0]!.toLocaleUpperCase() + word.slice(1))
    .join(" ");
}

function groupsForSection(
  findings: Finding[],
  section: ReportSection,
  clusters: ReportClusters,
): FindingGroup[] {
  const byCommentId = new Map(
    findings.map((finding) => [finding.comment.commentId, finding]),
  );
  const result: FindingGroup[] = [];
  const assigned = new Set<string>();
  const sectionData = clusters[section];
  for (const cluster of sectionData?.clusters ?? []) {
    const members = cluster.ids
      .map((id) => {
        const commentId = sectionData?.commentIds[id - 1];
        return commentId ? byCommentId.get(commentId) : undefined;
      })
      .filter((finding): finding is Finding => finding !== undefined);
    if (members.length === 0) continue;
    members.forEach((finding) => assigned.add(finding.comment.commentId));
    result.push({
      findings: members,
      viewers: new Set(
        members.map(
          (finding) =>
            finding.comment.authorChannelId ?? finding.comment.commentId,
        ),
      ).size,
      title: cluster.title,
      ...(cluster.paraphrase ? { paraphrase: cluster.paraphrase } : {}),
    });
  }
  for (const finding of findings) {
    if (assigned.has(finding.comment.commentId)) continue;
    result.push({
      findings: [finding],
      viewers: 1,
      title: categoryTitle(finding.classification.category),
    });
  }
  return result;
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
    if (
      classification.category === "suspected_bot_or_promo" ||
      classification.category === "purchase_intent"
    )
      continue;
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
        quote: truncateQuote(comment.text),
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

function cleanTitle(title: string): string {
  return title
    .replace(/[\\*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 8)
    .join(" ");
}

function paraphrase(group: FindingGroup): string {
  return group.paraphrase ?? "";
}

function hasAsk(text: string): boolean {
  return (
    text.includes("?") ||
    /\b(?:please|could you|can you|would you|request(?:ing)?|want(?:ing)?|need(?:ing)?|show me|add|make|cover|explain|share)\b/i.test(
      text,
    )
  );
}

function groundedParaphrase(group: FindingGroup): string | undefined {
  if (
    !group.paraphrase ||
    !group.findings.some(({ comment }) => hasAsk(comment.text))
  )
    return undefined;
  const sourceWords = new Set(
    group.findings.flatMap(
      ({ comment }) =>
        comment.text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [],
    ),
  );
  const paraphraseStopWords = new Set([
    "viewers",
    "viewer",
    "asks",
    "ask",
    "asking",
    "about",
    "whether",
    "could",
    "would",
    "should",
    "please",
  ]);
  const contentWords =
    group.paraphrase
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]{4,}/gu)
      ?.filter((word) => !paraphraseStopWords.has(word)) ?? [];
  return contentWords.every((word) => sourceWords.has(word))
    ? group.paraphrase
    : undefined;
}

function answerSource(finding: Finding): string | undefined {
  const words =
    finding.comment.text.toLocaleLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  const description = finding.video.description.toLocaleLowerCase();
  if (description.trim() && words.some((word) => description.includes(word)))
    return "video description";
  const reply = finding.comment.creatorReplyText?.toLocaleLowerCase() ?? "";
  if (reply && words.some((word) => reply.includes(word)))
    return "creator reply";
  return undefined;
}

function renderMarkdown(
  input: ReportInput,
  findings: Finding[],
  clusters: ReportClusters = {},
): {
  markdown: string;
  sectionItemCounts: RenderedReport["sectionItemCounts"];
} {
  const videoNames = input.videos.length
    ? input.videos.map((video) => `“${escapeMarkdown(video.title)}”`).join(", ")
    : "none";
  const ordered = orderedFindings(findings, input.channel);
  const money = ordered.filter(isActionableMoney);
  money.sort(
    (left, right) =>
      Number(isCustomerProblem(right)) - Number(isCustomerProblem(left)),
  );
  const customerProblemGroups = groupsForSection(
    money.filter(isCustomerProblem),
    "money",
    clusters,
  ).map((group) => ({ ...group, title: "Customer problem" }));
  const otherMoneyGroups = groupsForSection(
    money.filter((finding) => !isCustomerProblem(finding)),
    "money",
    clusters,
  );
  const moneyGroups = [...customerProblemGroups, ...otherMoneyGroups];
  const keywordResponses = new Map<string, Finding[]>();
  for (const finding of ordered.filter(
    ({ classification }) => classification.category === "keyword_response",
  )) {
    const phrase = normalizeKeywordResponse(finding.comment.text);
    const key = keywordResponseGroupKey(phrase);
    keywordResponses.set(key, [...(keywordResponses.get(key) ?? []), finding]);
  }
  const keywordResponseGroups = [...keywordResponses.values()].map(
    (groupFindings) => {
      const variantCounts = new Map<string, number>();
      for (const finding of groupFindings) {
        const variant = normalizeKeywordResponse(finding.comment.text);
        variantCounts.set(variant, (variantCounts.get(variant) ?? 0) + 1);
      }
      const phrase =
        [...variantCounts].sort(
          ([left, leftCount], [right, rightCount]) =>
            rightCount - leftCount || right.length - left.length,
        )[0]?.[0] ?? "";
      return {
        findings: groupFindings,
        viewers: new Set(
          groupFindings.map(
            (finding) =>
              finding.comment.authorChannelId ?? finding.comment.commentId,
          ),
        ).size,
        phrase: phrase.split(" ").slice(0, 2).join(" "),
      };
    },
  );
  const moneyIds = new Set(money.map(({ comment }) => comment.commentId));
  const requests = groupsForSection(
    ordered.filter(
      (finding) =>
        isUnansweredRequest(finding) &&
        !moneyIds.has(finding.comment.commentId),
    ),
    "ideas",
    clusters,
  );
  const requestIds = new Set(
    requests.flatMap((group) =>
      group.findings.map(({ comment }) => comment.commentId),
    ),
  );
  const fixes = groupsForSection(
    ordered.filter(
      (finding) =>
        isFix(finding) &&
        !moneyIds.has(finding.comment.commentId) &&
        !requestIds.has(finding.comment.commentId) &&
        !keywordResponseGroups.some((group) =>
          group.findings.some(
            ({ comment }) => comment.commentId === finding.comment.commentId,
          ),
        ),
    ),
    "fixes",
    clusters,
  );
  const proofs = groupsForSection(
    orderProof(
      findings.filter(
        ({ classification }) =>
          classification.category === "testimonial_or_result",
      ),
      input,
    ).slice(0, 5),
    "proofs",
    clusters,
  );
  const answeredQuestions = groupsForSection(
    ordered.filter(isAnsweredQuestion),
    "answered",
    clusters,
  );
  const quickPulseCounts = {
    questions: 0,
    praise: 0,
    requests: 0,
    objections: 0,
    noise: 0,
    botOrPromo: 0,
    purchaseIntent: 0,
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
    if (category === "suspected_bot_or_promo") quickPulseCounts.botOrPromo += 1;
    if (category === "purchase_intent") quickPulseCounts.purchaseIntent += 1;
  }
  const share = (count: number) =>
    `${count} (${input.comments.length ? Math.round((count / input.comments.length) * 100) : 0}%)`;
  const viewerLabel = (viewers: number) =>
    `${viewers} viewer${viewers === 1 ? "" : "s"}`;
  const requestItems = requests.map((group) => {
    const title = cleanTitle(group.title ?? "Viewer feedback");
    const countLabel = `${viewerLabel(group.viewers)}${group.viewers === 1 ? " (single mention)" : ""}`;
    const examples = group.findings.slice(0, 3);
    const more =
      group.findings.length > examples.length
        ? `\n\n  and ${group.findings.length - examples.length} more`
        : "";
    const viewerAsk = groundedParaphrase(group);
    return `- **${title}** — ${countLabel} · ${group.findings.length} comment${group.findings.length === 1 ? "" : "s"}${viewerAsk ? `\n\nViewer asks: ${paraphrase(group)}` : ""}\n\n${examples
      .map(
        (finding) =>
          `[Open comment](${finding.link}) on **${escapeMarkdown(finding.video.title)}**\n\n${quoteBlock(finding.classification.quote)}`,
      )
      .join("\n\n")}${more}`;
  });
  const fixItems = fixes.map((group) => {
    const title = cleanTitle(group.title ?? "Viewer feedback");
    const countLabel = `${viewerLabel(group.viewers)}${group.viewers === 1 ? " (single mention)" : ""}`;
    const examples = group.findings.slice(0, 3);
    const more =
      group.findings.length > examples.length
        ? `\n\n  and ${group.findings.length - examples.length} more`
        : "";
    const viewerAsk = groundedParaphrase(group);
    return `- **${title}** — ${countLabel} · ${group.findings.length} comment${group.findings.length === 1 ? "" : "s"}${viewerAsk ? `\n\nViewer asks: ${viewerAsk}` : ""}\n\n${examples
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
      .join("\n\n")}${more}`;
  });
  const answeredItems = answeredQuestions.map((group) => {
    const countLabel = viewerLabel(group.viewers);
    const examples = group.findings.slice(0, 3);
    const more =
      group.findings.length > examples.length
        ? `\n\n  and ${group.findings.length - examples.length} more`
        : "";
    const viewerAsk = groundedParaphrase(group);
    return `- **${cleanTitle(group.title ?? "Viewer feedback")}** — ${countLabel} · ${group.findings.length} answered comment${group.findings.length === 1 ? "" : "s"}${viewerAsk ? `\n\nViewer asks: ${viewerAsk}` : ""}\n\n${examples
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
      )}${more}\n\n        **Suggestion:** Consider pinning an answer or adding an FAQ entry.`;
  });
  const unansweredKeywordResponses = keywordResponseGroups.flatMap((group) =>
    group.findings.filter((finding) => !finding.comment.creatorReplied),
  );
  const keywordResponseItem =
    unansweredKeywordResponses.length > 0
      ? `- **Viewers who commented the keyword and got no reply** — ${unansweredKeywordResponses.length} comment${unansweredKeywordResponses.length === 1 ? "" : "s"}\n\n${unansweredKeywordResponses
          .slice(0, 3)
          .map(
            (finding) =>
              `[Open comment](${finding.link}) on **${escapeMarkdown(finding.video.title)}**`,
          )
          .join(
            "\n\n",
          )}${unansweredKeywordResponses.length > 3 ? `\n\nand ${unansweredKeywordResponses.length - 3} more` : ""}`
      : undefined;
  const moneyItems = [
    ...moneyGroups.map((group) => {
      const title = cleanTitle(group.title ?? "Viewer feedback");
      const examples = group.findings.slice(0, 3);
      const more =
        group.findings.length > examples.length
          ? `\n\n  and ${group.findings.length - examples.length} more`
          : "";
      const viewerAsk = groundedParaphrase(group);
      return `- **${title}** — ${group.viewers} viewer${group.viewers === 1 ? "" : "s"} · ${group.findings.length} comment${group.findings.length === 1 ? "" : "s"}${viewerAsk ? `\n\nViewer asks: ${viewerAsk}` : ""}\n\n${examples
        .map((finding) => {
          const answer = answerSource(finding);
          return [
            `[Open comment](${finding.link}) on **${escapeMarkdown(finding.video.title)}**`,
            answer ? `Answer found in: ${answer}.` : "",
            quoteBlock(finding.classification.quote),
          ]
            .filter(Boolean)
            .join("\n\n");
        })
        .join("\n\n")}${more}`;
    }),
    ...(keywordResponseItem ? [keywordResponseItem] : []),
  ];
  const sectionItemCounts = {
    money: moneyItems.length,
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
    "> **How to read this:** Viewer quotes and counts are from public comments. Suggestions are not replies to post; review details against source material.",
    input.stoppedReason ? `\n> **Analysis note:** ${input.stoppedReason}` : "",
    "",
    "## Quick pulse",
    `- Comments analyzed: ${input.comments.length}`,
    `- Questions: ${share(quickPulseCounts.questions)}`,
    `- Praise: ${share(quickPulseCounts.praise)}`,
    `- Requests: ${share(quickPulseCounts.requests)}`,
    `- Objections: ${share(quickPulseCounts.objections)}`,
    `- Noise: ${share(quickPulseCounts.noise)}`,
    `- Suspected bot/promo: ${share(quickPulseCounts.botOrPromo)}`,
    `- Purchase intent: ${share(quickPulseCounts.purchaseIntent)}`,
    ...keywordResponseGroups.map(
      (group) =>
        `- ${group.viewers} viewers commented a '${escapeMarkdown(group.phrase)}' variant; the creator replied to ${group.findings.filter((finding) => finding.comment.creatorReplied).length}`,
    ),
    `- Creator replied: ${share(input.comments.filter((comment) => comment.creatorReplied).length)}`,
    input.classificationSucceeded === false
      ? "_Classification incomplete; category shares may be partial._"
      : "",
    "",
    "## A. Money on the table",
    moneyItems.length
      ? moneyItems.join("\n\n")
      : input.classificationSucceeded === false
        ? incompleteMessage
        : "_No unanswered purchase/sponsor inquiry, high-like question, or keyword response found in the analyzed comments._",
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
      ? proofs
          .map(
            (group) =>
              `- **${cleanTitle(group.title ?? "Testimonial or result")}**\n\n${group.findings
                .slice(0, 3)
                .map(markdownFinding)
                .join("\n\n")}`,
          )
          .join("\n\n")
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
      output += inlineHtml(value.slice(start, index));
      const [fullMatch, label = "", url = ""] = match;
      output += allowedLinks.has(url)
        ? `<a href="${escapeHtml(url)}">${inlineHtml(label)}</a>`
        : inlineHtml(fullMatch);
      start = index + fullMatch.length;
    }
    output += inlineHtml(value.slice(start));
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

export function renderReport(
  input: ReportInput,
  clusters: ReportClusters = {},
): RenderedReport {
  const verification = findingList(input);
  const rendered = renderMarkdown(input, verification.findings, clusters);
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
