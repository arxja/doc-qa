// Dedupe two candidate lists into one set, preserving each chunk once.

export function unionIds(
  a: Array<{ id: string }>,
  b: Array<{ id: string }>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...a, ...b]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item.id);
  }
  return out;
}
