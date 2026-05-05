function findOutermostBraces(text: string): { start: number; end: number } | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return { start, end: i };
  }
  return null;
}

/**
 * Extracts the first complete JSON object from text that may contain leading
 * prose, trailing prose, or markdown code fences.
 */
export function extractJsonObject(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const bounds = findOutermostBraces(text);
  return bounds ? text.slice(bounds.start, bounds.end + 1) : text.trim();
}

export function slugify(text: string, maxLen = 20): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/, '');
}

export function formatTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function timestamp(): string {
  return formatTimestamp(new Date());
}
