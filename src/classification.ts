const lowInformationPhrases = new Set([
  "thanks",
  "thank you",
  "thx",
  "ty",
  "full course",
  "fullcourse",
]);

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
