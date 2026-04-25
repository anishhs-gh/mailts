/**
 * Converts an HTML string to a readable plain-text fallback.
 *
 * Strategy:
 *  - Block-level elements become newlines
 *  - Anchors become `text (url)` when the href differs from the text
 *  - All remaining tags are stripped
 *  - HTML entities are decoded
 *  - Runs of blank lines are collapsed to at most two
 */
export function htmlToText(html: string): string {
  let text = html;

  // Normalise line endings
  text = text.replace(/\r\n|\r/g, '\n');

  // Drop <head> block entirely
  text = text.replace(/<head[\s\S]*?<\/head>/gi, '');

  // <br> → newline
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Block-level elements → preceding newline
  text = text.replace(
    /<\/(p|div|h[1-6]|ul|ol|dl|table|blockquote|pre|tr|section|article|header|footer|li|dt|dd)>/gi,
    '\n',
  );

  // <li> → bullet
  text = text.replace(/<li[^>]*>/gi, '\n• ');

  // <a href="url">text</a> → "text (url)" when href != text
  text = text.replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const innerText = stripTags(inner).trim();
    const url = href.trim();
    if (!innerText) return url;
    if (innerText === url || url.startsWith('mailto:') || url.startsWith('#')) return innerText;
    return `${innerText} (${url})`;
  });

  // <img alt="..."> → alt text
  text = text.replace(/<img[^>]+alt=["']([^"']+)["'][^>]*\/?>/gi, '$1');

  // Strip all remaining tags
  text = stripTags(text);

  // Decode HTML entities
  text = decodeEntities(text);

  // Collapse runs of 3+ blank lines to 2
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', copy: '©', reg: '®', trade: '™',
  mdash: '—', ndash: '–', laquo: '«', raquo: '»',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  hellip: '…', bull: '•', middot: '·', euro: '€', pound: '£', yen: '¥',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&([a-zA-Z]+);/g, (_m, name: string) => ENTITIES[name.toLowerCase()] ?? _m)
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)));
}
