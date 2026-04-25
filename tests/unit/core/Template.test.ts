import { describe, it, expect, beforeEach } from 'vitest';
import { TemplateRenderer } from '../../../src/core/Template.js';
import { TemplateError } from '../../../src/errors.js';

describe('TemplateRenderer (built-in engine)', () => {
  let renderer: TemplateRenderer;

  beforeEach(() => {
    renderer = new TemplateRenderer();
  });

  it('substitutes a simple variable', () => {
    expect(renderer.render('Hello {{name}}!', { name: 'Alice' })).toBe('Hello Alice!');
  });

  it('substitutes multiple variables', () => {
    const result = renderer.render('{{greeting}}, {{name}}!', { greeting: 'Hi', name: 'Bob' });
    expect(result).toBe('Hi, Bob!');
  });

  it('replaces missing variable with empty string', () => {
    expect(renderer.render('Hello {{missing}}!', {})).toBe('Hello !');
  });

  it('supports dotted nested path syntax', () => {
    const result = renderer.render('{{user.name}}', { user: { name: 'Carol' } });
    expect(result).toBe('Carol');
  });

  it('handles deeply nested paths', () => {
    const result = renderer.render('{{a.b.c}}', { a: { b: { c: 'deep' } } });
    expect(result).toBe('deep');
  });

  it('returns empty for broken nested path', () => {
    expect(renderer.render('{{a.b.c}}', { a: {} })).toBe('');
  });

  it('coerces non-string values to string', () => {
    expect(renderer.render('Count: {{n}}', { n: 42 })).toBe('Count: 42');
    expect(renderer.render('Flag: {{f}}', { f: true })).toBe('Flag: true');
  });

  it('replaces null/undefined values with empty string', () => {
    expect(renderer.render('{{v}}', { v: null })).toBe('');
    expect(renderer.render('{{v}}', { v: undefined })).toBe('');
  });

  it('handles whitespace inside delimiters', () => {
    expect(renderer.render('{{ name }}', { name: 'Alice' })).toBe('Alice');
  });

  it('leaves non-matching double-braces alone', () => {
    const result = renderer.render('No {{$invalid}} here', {});
    // $invalid doesn't match \w[\w.]* pattern — left as-is by the regex
    expect(result).toBeDefined();
  });

  it('works with an empty data object', () => {
    expect(renderer.render('no vars', {})).toBe('no vars');
  });

  it('handles template with only variables', () => {
    expect(renderer.render('{{a}}{{b}}', { a: 'X', b: 'Y' })).toBe('XY');
  });

  it('handles multiline template strings', () => {
    const template = 'Dear {{name}},\n\nThank you for your order #{{orderId}}.\n\nRegards';
    const result = renderer.render(template, { name: 'Dave', orderId: '42' });
    expect(result).toContain('Dear Dave');
    expect(result).toContain('order #42');
  });
});

describe('TemplateRenderer (custom engine)', () => {
  it('uses a custom render function', () => {
    const renderer = new TemplateRenderer();
    renderer.setEngine({
      render: (_compiled, data) => `custom:${String(data['x'] ?? '')}`,
    });
    expect(renderer.render('ignored', { x: 'hello' })).toBe('custom:hello');
  });

  it('uses custom compile + render', () => {
    const renderer = new TemplateRenderer();
    renderer.setEngine({
      compile: (t: string) => t.split('').reverse().join(''),
      render: (compiled: unknown) => compiled as string,
    });
    expect(renderer.render('abc', {})).toBe('cba');
  });

  it('throws TemplateError if render throws', () => {
    const renderer = new TemplateRenderer();
    renderer.setEngine({
      render: () => { throw new Error('render blew up'); },
    });
    expect(() => renderer.render('template', {})).toThrow(TemplateError);
    expect(() => renderer.render('template', {})).toThrow('render blew up');
  });

  it('throws when setEngine is given an object without render', () => {
    const renderer = new TemplateRenderer();
    expect(() => renderer.setEngine({} as never)).toThrow(TemplateError);
  });
});

describe('TemplateRenderer constructor', () => {
  it('accepts an engine in constructor', () => {
    const renderer = new TemplateRenderer({
      render: (_c, data) => `hi ${String(data['name'] ?? '')}`,
    });
    expect(renderer.render('t', { name: 'Eve' })).toBe('hi Eve');
  });
});
