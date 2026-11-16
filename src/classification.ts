const lowInformationPhrases = new Set([
  "thanks",
  "thx",
  "ty",
  "i m tired boss",
  "im tired boss",
  "i am tired boss",
]);

export function normalizeKeywordResponse(text: string): string {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/gu, " ")
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\b\d+\b/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized;
}

export function keywordResponseGroupKey(text: string): string {
  const words = normalizeKeywordResponse(text).split(" ").filter(Boolean);
  if (words.length < 2) return words[0] ?? "";
  return `${words[0]} ${words[1]![0]}`;
}

function requestedKeyword(description: string): string | undefined {
  const patterns = [
    /\b(?:comment|type)\s+(?:the\s+)?(?:word|phrase)\s+["“']?([^"'“”.,!?;]{1,40}?)["”']?(?=\s+(?:below|in the comments|to get|to receive|for|and|if)\b|[,.;!?]|$)/iu,
    /\bcomment\s+["“']?([\p{L}\p{N}_-]{2,40})["”']?\s+(?:below|in the comments)\b/iu,
    /\btype\s+["“']?([\p{L}\p{N}_-]{2,40})["”']?(?=\s+(?:below|in the comments|to get|to receive|for)\b|[,.;!?]|$)/iu,
  ];
  for (const pattern of patterns) {
    const match = description.match(pattern);
    const keyword = match?.[1]?.trim();
    if (keyword) return normalizeKeywordResponse(keyword);
  }
  return undefined;
}

function containsKeyword(text: string, keyword: string): boolean {
  const normalized = normalizeKeywordResponse(text);
  return ` ${normalized} `.includes(` ${keyword} `);
}

export function truncateQuote(text: string, maximum = 500): string {
  const trimmed = text.trim();
  if (trimmed.length <= maximum) return trimmed;
  const sentences =
    trimmed
      .match(/[^.!?]+(?:[.!?]+["'”’)]*|$)/gu)
      ?.map((part) => part.trim()) ?? [];
  const requestVerbs =
    /\b(?:please|could you|can you|would you|request(?:ing)?|want(?:ing)?|need(?:ing)?|show me|add|make|cover|explain|share)\b/i;
  const relevant = sentences.filter(
    (sentence) => sentence.includes("?") || requestVerbs.test(sentence),
  );
  const source = relevant.length > 0 ? relevant.join(" ") : trimmed;
  if (source.length <= maximum)
    return source === trimmed ? source : `${source}…`;
  const clipped = source.slice(0, maximum - 1);
  const sentenceEnd = Math.max(
    clipped.lastIndexOf("."),
    clipped.lastIndexOf("?"),
    clipped.lastIndexOf("!"),
  );
  const wordEnd = clipped.lastIndexOf(" ");
  const boundary = sentenceEnd >= maximum * 0.6 ? sentenceEnd + 1 : wordEnd;
  const end = boundary > 0 ? boundary : maximum - 1;
  return `${source.slice(0, end).trimEnd()}…`;
}

export function detectKeywordResponses(
  comments: { commentId: string; videoId: string; text: string }[],
  videos: { videoId: string; description: string }[],
): Map<string, string> {
  const result = new Map<string, string>();
  const videoById = new Map(videos.map((video) => [video.videoId, video]));
  const grouped = new Map<string, typeof comments>();
  for (const comment of comments) {
    const video = videoById.get(comment.videoId);
    const keyword = video ? requestedKeyword(video.description) : undefined;
    if (!keyword || !containsKeyword(comment.text, keyword)) continue;
    const key = `${comment.videoId}\u0000${keyword}`;
    grouped.set(key, [...(grouped.get(key) ?? []), comment]);
  }
  for (const [key, entries] of grouped) {
    if (entries.length < 5) continue;
    const keyword = key.slice(key.indexOf("\u0000") + 1);
    for (const { commentId } of entries) result.set(commentId, keyword);
  }
  return result;
}

export function isLowInformationComment(text: string): boolean {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
  const mentionsVideoCreatorOrProduct =
    /\b(?:video|creator|channel|product|course|lesson|tutorial|app|tool|software)\b/u.test(
      normalized,
    );
  if (
    lowInformationPhrases.has(normalized) ||
    /\b(?:im|i m|i am) tired(?: boss)?\b/u.test(normalized)
  )
    return !mentionsVideoCreatorOrProduct;
  return /^[\p{Extended_Pictographic}\p{Emoji_Component}\p{White_Space}\p{Punctuation}\p{Symbol}]+$/u.test(
    text,
  );
}
