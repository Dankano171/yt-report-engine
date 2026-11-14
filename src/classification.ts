const lowInformationPhrases = new Set(["thanks", "thx", "ty"]);

export function normalizeKeywordResponse(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function keywordResponseGroupKey(text: string): string {
  const words = normalizeKeywordResponse(text).split(" ").filter(Boolean);
  if (words.length < 2) return words[0] ?? "";
  return `${words[0]} ${words[1]![0]}`;
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
): Map<string, string> {
  const grouped = new Map<string, { id: string; phrase: string }[]>();
  for (const comment of comments) {
    const phrase = normalizeKeywordResponse(comment.text);
    if (!phrase || phrase.split(" ").length >= 6) continue;
    const key = `${comment.videoId}\u0000${keywordResponseGroupKey(phrase)}`;
    const entries = grouped.get(key) ?? [];
    entries.push({ id: comment.commentId, phrase });
    grouped.set(key, entries);
  }
  const result = new Map<string, string>();
  for (const entries of grouped.values()) {
    if (entries.length < 5) continue;
    const counts = new Map<string, number>();
    for (const entry of entries)
      counts.set(entry.phrase, (counts.get(entry.phrase) ?? 0) + 1);
    const canonical = [...counts].sort(
      ([left, leftCount], [right, rightCount]) =>
        rightCount - leftCount || right.length - left.length,
    )[0]?.[0];
    if (!canonical) continue;
    for (const { id } of entries) {
      result.set(id, canonical);
    }
  }
  return result;
}

export function isLowInformationComment(text: string): boolean {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
  if (lowInformationPhrases.has(normalized)) return true;
  return /^[\p{Extended_Pictographic}\p{Emoji_Component}\p{White_Space}\p{Punctuation}\p{Symbol}]+$/u.test(
    text,
  );
}
