/**
 * Lightweight XML tag extractor for parsing LLM structured output.
 *
 * Does NOT require well-formed XML — extracts tagged content from free text
 * so the LLM can include reasoning outside of tags.
 */

/**
 * Extract the text content of the first occurrence of `<tag>...</tag>`.
 * Returns `undefined` if the tag is not found.
 */
export function extractTag(text: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open);
  if (start === -1) return undefined;
  const end = text.indexOf(close, start + open.length);
  if (end === -1) return undefined;
  return text.slice(start + open.length, end).trim();
}

/**
 * Extract ALL occurrences of `<tag>...</tag>` as an array of strings.
 */
export function extractAllTags(text: string, tag: string): string[] {
  const results: string[] = [];
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf(open, pos);
    if (start === -1) break;
    const end = text.indexOf(close, start + open.length);
    if (end === -1) break;
    results.push(text.slice(start + open.length, end).trim());
    pos = end + close.length;
  }
  return results;
}

/**
 * Parse a single `<tag>` block into an object by extracting its child tags.
 *
 * Example:
 * ```
 * parseTagObject("<anchor><question>Q</question><answer>A</answer></anchor>",
 *                "anchor", ["question", "answer"])
 * // => { question: "Q", answer: "A" }
 * ```
 */
export function parseTagChildren(
  block: string,
  childTags: string[],
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const tag of childTags) {
    result[tag] = extractTag(block, tag);
  }
  return result;
}

/**
 * Extract all occurrences of a parent tag and parse each into an object
 * of child tags.
 *
 * Example:
 * ```
 * parseAllTagObjects(text, "anchor", ["question", "answer"])
 * // => [{ question: "Q1", answer: "A1" }, { question: "Q2", answer: "A2" }]
 * ```
 */
export function parseAllTagObjects(
  text: string,
  parentTag: string,
  childTags: string[],
): Record<string, string | undefined>[] {
  return extractAllTags(text, parentTag).map((block) => parseTagChildren(block, childTags));
}
