const CLOSING_TRAILING_CHARS = new Set([
  '"',
  "'",
  ')',
  ']',
  '}',
  '」',
  '』',
  '”',
  '’',
  '）',
  '】',
  '〉',
  '》',
]);

export function stripGeneratedSubtitlePeriods(text: string): string {
  return text
    .split(/\r?\n/u)
    .map(stripGeneratedSubtitleLinePeriods)
    .join('\n');
}

function stripGeneratedSubtitleLinePeriods(line: string): string {
  const trailingWhitespace = line.match(/\s+$/u)?.[0] ?? '';
  const body = trailingWhitespace ? line.slice(0, -trailingWhitespace.length) : line;
  let closingStart = body.length;

  while (closingStart > 0 && CLOSING_TRAILING_CHARS.has(body.charAt(closingStart - 1))) {
    closingStart -= 1;
  }

  const beforeClosing = body.slice(0, closingStart).replace(/[。.]+$/u, '');
  return `${beforeClosing}${body.slice(closingStart)}`;
}
