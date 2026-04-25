import { describe, it, expect } from 'vitest';
import { htmlToText } from '../../../src/core/HtmlToText.js';

describe('htmlToText', () => {
  it('strips plain tags', () => {
    expect(htmlToText('<p>Hello world</p>')).toBe('Hello world');
  });

  it('converts <br> to newline', () => {
    const result = htmlToText('Line 1<br>Line 2<br/>Line 3');
    expect(result).toContain('Line 1');
    expect(result).toContain('Line 2');
    expect(result).toContain('Line 3');
    const lines = result.split('\n').map(l => l.trim()).filter(Boolean);
    expect(lines).toHaveLength(3);
  });

  it('converts block-level closing tags to newlines', () => {
    const result = htmlToText('<p>First</p><p>Second</p>');
    expect(result).toContain('First');
    expect(result).toContain('Second');
    expect(result.indexOf('First')).toBeLessThan(result.indexOf('Second'));
  });

  it('drops the <head> block entirely', () => {
    const result = htmlToText('<head><title>Title</title><style>body{}</style></head><body>Content</body>');
    expect(result).not.toContain('Title');
    expect(result).not.toContain('body{}');
    expect(result).toContain('Content');
  });

  it('converts anchors to text (url) format', () => {
    const result = htmlToText('<a href="https://example.com">Visit us</a>');
    expect(result).toContain('Visit us');
    expect(result).toContain('https://example.com');
    expect(result).toMatch(/Visit us \(https:\/\/example\.com\)/);
  });

  it('does not duplicate URL when link text equals href', () => {
    const result = htmlToText('<a href="https://example.com">https://example.com</a>');
    // Should appear only once
    expect(result.split('https://example.com')).toHaveLength(2);
  });

  it('returns plain text for mailto links without adding URL', () => {
    const result = htmlToText('<a href="mailto:info@example.com">Contact</a>');
    expect(result).toContain('Contact');
    expect(result).not.toContain('mailto:');
  });

  it('converts <li> to bullet points', () => {
    const result = htmlToText('<ul><li>Apple</li><li>Banana</li></ul>');
    expect(result).toContain('•');
    expect(result).toContain('Apple');
    expect(result).toContain('Banana');
  });

  it('uses alt text for images', () => {
    const result = htmlToText('<img src="logo.png" alt="Company Logo">');
    expect(result).toContain('Company Logo');
    expect(result).not.toContain('logo.png');
  });

  it('decodes named HTML entities', () => {
    expect(htmlToText('&amp; &lt; &gt; &quot; &nbsp;')).toContain('&');
    expect(htmlToText('Hello&nbsp;World')).toContain('Hello');
    expect(htmlToText('&copy;')).toContain('©');
    expect(htmlToText('&mdash;')).toContain('—');
    expect(htmlToText('&euro;')).toContain('€');
  });

  it('decodes numeric decimal entities', () => {
    expect(htmlToText('&#65;')).toContain('A');
    expect(htmlToText('&#9829;')).toContain('♥');
  });

  it('decodes hex entities', () => {
    expect(htmlToText('&#x41;')).toContain('A');
    expect(htmlToText('&#x2665;')).toContain('♥');
  });

  it('collapses more than two consecutive blank lines', () => {
    const result = htmlToText('<p>A</p><p></p><p></p><p></p><p>B</p>');
    const blanks = result.match(/\n{3,}/);
    expect(blanks).toBeNull();
  });

  it('handles deeply nested HTML', () => {
    const html = '<div><div><p><strong>Deep <em>content</em></strong></p></div></div>';
    expect(htmlToText(html)).toContain('Deep content');
  });

  it('trims leading and trailing whitespace from result', () => {
    const result = htmlToText('   <p>  content  </p>   ');
    expect(result[0]).not.toBe(' ');
    expect(result[result.length - 1]).not.toBe(' ');
  });

  it('returns empty string for empty or whitespace-only input', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText('   ')).toBe('');
  });

  it('returns empty string for HTML with no visible content', () => {
    expect(htmlToText('<div></div><span></span>')).toBe('');
  });

  it('handles headings', () => {
    const result = htmlToText('<h1>Title</h1><h2>Subtitle</h2>');
    expect(result).toContain('Title');
    expect(result).toContain('Subtitle');
  });

  it('handles complete HTML email structure', () => {
    const html = `
      <html>
        <head><title>Email</title></head>
        <body>
          <h1>Hello Alice</h1>
          <p>Thanks for signing up. <a href="https://example.com/verify">Verify your email</a>.</p>
          <ul><li>Feature A</li><li>Feature B</li></ul>
          <p>Best regards,<br>The Team</p>
        </body>
      </html>
    `;
    const result = htmlToText(html);
    expect(result).toContain('Hello Alice');
    expect(result).toContain('Thanks for signing up');
    expect(result).toContain('Verify your email');
    expect(result).toContain('https://example.com/verify');
    expect(result).toContain('Feature A');
    expect(result).toContain('Feature B');
    expect(result).toContain('The Team');
    expect(result).not.toContain('<');
  });
});
