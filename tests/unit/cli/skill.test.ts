import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { installSkill, uninstallSkill, skillTarget, bundledSkillDir } from '../../../packages/cli/src/commands/skill.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'mailts-skill-'));

describe('mailts skill', () => {
  it('resolves the target for project, global and custom directories', () => {
    expect(skillTarget({ cwd: '/work/app' })).toBe('/work/app/.claude/skills/mailts');
    expect(skillTarget({ global: true, home: '/home/me' })).toBe('/home/me/.claude/skills/mailts');
    expect(skillTarget({ dir: 'agents/skills', cwd: '/work/app' })).toBe('/work/app/agents/skills/mailts');
    expect(skillTarget({ dir: '/abs/skills', global: true })).toBe('/abs/skills/mailts');
  });

  it('ships a valid skill: frontmatter name/description and every referenced file exists', () => {
    const dir = bundledSkillDir()!;
    expect(dir).toBeTruthy();
    const md = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    const fm = /^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/.exec(md);
    expect(fm, 'YAML frontmatter with name and description').not.toBeNull();
    expect(fm![1]).toBe('mailts');
    expect(fm![2]!.length).toBeLessThanOrEqual(1024);
    for (const [, ref] of md.matchAll(/\]\((references\/[a-z-]+\.md)\)/g)) {
      expect(existsSync(join(dir, ref!)), ref).toBe(true);
    }
  });

  it('installs, updates in place and removes files dropped from the skill', () => {
    const cwd = tmp();
    const src = join(tmp(), 'mailts');
    mkdirSync(join(src, 'references'), { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), '---\nname: mailts\ndescription: x\n---\n');
    writeFileSync(join(src, 'references', 'old.md'), 'old');

    const first = installSkill({ cwd, source: src, version: '0.2.0' });
    expect(first).toMatchObject({ ok: true, action: 'installed', files: 2 });
    const path = skillTarget({ cwd });
    expect(JSON.parse(readFileSync(join(path, '.mailts-skill.json'), 'utf8')).version).toBe('0.2.0');

    rmSync(join(src, 'references', 'old.md'));
    writeFileSync(join(src, 'references', 'new.md'), 'new');
    const second = installSkill({ cwd, source: src, version: '0.3.0' });
    expect(second).toMatchObject({ ok: true, action: 'updated', previous: '0.2.0' });
    expect(readdirSync(join(path, 'references'))).toEqual(['new.md']);
  });

  it('never replaces or removes a folder it did not create unless forced', () => {
    const cwd = tmp();
    const path = skillTarget({ cwd });
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'SKILL.md'), 'my own skill');

    expect(installSkill({ cwd })).toMatchObject({ ok: false, reason: 'foreign' });
    expect(uninstallSkill({ cwd })).toMatchObject({ ok: false, reason: 'foreign' });
    expect(readFileSync(join(path, 'SKILL.md'), 'utf8')).toBe('my own skill');

    expect(installSkill({ cwd, force: true })).toMatchObject({ ok: true, action: 'updated' });
    expect(readFileSync(join(path, 'SKILL.md'), 'utf8')).toMatch(/^---\nname: mailts/);
    expect(uninstallSkill({ cwd })).toMatchObject({ ok: true });
    expect(existsSync(path)).toBe(false);
    expect(uninstallSkill({ cwd })).toMatchObject({ ok: false, reason: 'not-installed' });
  });

  it('reports a missing source instead of creating an empty skill', () => {
    const cwd = tmp();
    expect(installSkill({ cwd, source: join(cwd, 'nope') })).toMatchObject({ ok: false, reason: 'missing-source' });
    expect(existsSync(skillTarget({ cwd }))).toBe(false);
  });
});
