const lowInformationPhrases = new Set(["thanks", "thx", "ty"]);

export function normalizeKeywordResponse(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncateQuote(text: string, maximum = 300): string {
  const trimmed = text.trim();
  if (trimmed.length <= maximum) return trimmed;
  const boundary = trimmed.lastIndexOf(" ", maximum - 1);
  const end = boundary > 0 ? boundary : maximum - 1;
  return `${trimmed.slice(0, end).trimEnd()}…`;
}

export function detectKeywordResponses(
  comments: { commentId: string; videoId: string; text: string }[],
): Map<string, string> {
  const grouped = new Map<string, string[]>();
  const normalizedById = new Map<string, string>();
  for (const comment of comments) {
    const phrase = normalizeKeywordResponse(comment.text);
    if (!phrase || phrase.split(" ").length >= 6) continue;
    const key = `${comment.videoId}\u0000${phrase}`;
    const ids = grouped.get(key) ?? [];
    ids.push(comment.commentId);
    grouped.set(key, ids);
    normalizedById.set(comment.commentId, phrase);
  }
  const result = new Map<string, string>();
  for (const ids of grouped.values()) {
    if (ids.length < 5) continue;
    for (const id of ids) {
      const phrase = normalizedById.get(id);
      if (phrase) result.set(id, phrase);
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
