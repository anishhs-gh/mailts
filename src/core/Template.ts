import { readFileSync, existsSync } from 'fs';
import type { TemplateEngine } from '../types/core.js';
import { TemplateError } from '../errors.js';

/** Built-in Mustache-style template engine — {{variable}} substitution. */
const builtinEngine: TemplateEngine = {
  compile: (template: string) => template,
  render(compiled: unknown, data: Record<string, unknown>): string {
    if (typeof compiled !== 'string') {
      throw new TemplateError('Compiled template must be a string for the built-in engine');
    }
    return compiled.replace(/\{\{\s*(\w[\w.]*)\s*\}\}/g, (_match, key: string) => {
      const parts = key.split('.');
      let val: unknown = data;
      for (const part of parts) {
        if (val === null || val === undefined || typeof val !== 'object') return '';
        val = (val as Record<string, unknown>)[part];
      }
      return val === null || val === undefined ? '' : String(val);
    });
  },
};

export class TemplateRenderer {
  private engine: TemplateEngine;

  constructor(engine?: TemplateEngine) {
    this.engine = engine ?? builtinEngine;
  }

  setEngine(engine: TemplateEngine): void {
    if (typeof engine.render !== 'function') {
      throw new TemplateError('Template engine must implement a render(compiled, data) method');
    }
    this.engine = engine;
  }

  render(template: string, data: Record<string, unknown> = {}): string {
    let source = template;

    // Detect if template is a file path
    if (!template.includes('\n') && !template.includes('{{') && existsSync(template)) {
      source = readFileSync(template, 'utf8');
    }

    const compiled = this.engine.compile ? this.engine.compile(source) : source;
    try {
      return this.engine.render(compiled, data);
    } catch (err) {
      throw new TemplateError(`Template rendering failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
