import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { printError, printInfo, printSuccess } from '../prompt.js';

/** Written next to SKILL.md so we only ever update or remove a skill we installed. */
const MARKER = '.mailts-skill.json';
const SKILL_NAME = 'mailts';

export interface SkillTargetOptions {
  /** Install for every project (`~/.claude/skills`) instead of the current one (`./.claude/skills`). */
  global?: boolean;
  /** Custom skills directory (the skill goes into `<dir>/mailts`) — for other agents or layouts. */
  dir?: string;
  /** Base for relative paths and the project default. @default process.cwd() */
  cwd?: string;
  /** Home directory for `global`. @default os.homedir() */
  home?: string;
}

export interface SkillInstallOptions extends SkillTargetOptions {
  /** Overwrite a folder that was not created by `mailts skill install`. */
  force?: boolean;
  /** Skill source folder. @default the copy bundled with @mailts/cli */
  source?: string;
  /** Version recorded in the marker file. */
  version?: string;
}

export type SkillInstallResult =
  | { ok: true; path: string; action: 'installed' | 'updated'; previous?: string; files: number }
  | { ok: false; path: string; reason: 'foreign' | 'missing-source' };

/** Folder the skill is installed into for the given options. */
export function skillTarget(opts: SkillTargetOptions = {}): string {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.dir) return join(resolve(cwd, opts.dir), SKILL_NAME);
  const base = opts.global ? join(opts.home ?? homedir(), '.claude') : join(cwd, '.claude');
  return join(base, 'skills', SKILL_NAME);
}

/** The skill bundled with the CLI (works from `dist/` and from `src/` under tsx). */
export function bundledSkillDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../skill/mailts', '../../skill/mailts']) {
    const dir = resolve(here, rel);
    if (existsSync(join(dir, 'SKILL.md'))) return dir;
  }
  return undefined;
}

function readMarker(path: string): { version?: string } | undefined {
  try {
    return JSON.parse(readFileSync(join(path, MARKER), 'utf8')) as { version?: string };
  } catch {
    return undefined;
  }
}

function countFiles(dir: string): number {
  return readdirSync(dir, { withFileTypes: true, recursive: true }).filter(e => e.isFile()).length;
}

/** Copy the skill into place. Never touches a folder it did not create unless `force`. */
export function installSkill(opts: SkillInstallOptions = {}): SkillInstallResult {
  const path = skillTarget(opts);
  const source = opts.source ?? bundledSkillDir();
  if (!source || !existsSync(join(source, 'SKILL.md'))) return { ok: false, path, reason: 'missing-source' };

  const exists = existsSync(path);
  const marker = exists ? readMarker(path) : undefined;
  if (exists && !marker && !opts.force) return { ok: false, path, reason: 'foreign' };

  // Replace rather than merge, so files removed from the skill don't linger.
  if (exists) rmSync(path, { recursive: true, force: true });
  mkdirSync(dirname(path), { recursive: true });
  cpSync(source, path, { recursive: true });
  writeFileSync(join(path, MARKER), JSON.stringify({ version: opts.version ?? 'unknown', installedAt: new Date().toISOString() }, null, 2) + '\n');

  return {
    ok: true,
    path,
    action: exists ? 'updated' : 'installed',
    ...(marker?.version ? { previous: marker.version } : {}),
    files: countFiles(path) - 1,
  };
}

export type SkillUninstallResult =
  | { ok: true; path: string }
  | { ok: false; path: string; reason: 'not-installed' | 'foreign' };

/** Remove a skill installed by `installSkill`. Refuses other folders unless `force`. */
export function uninstallSkill(opts: SkillTargetOptions & { force?: boolean } = {}): SkillUninstallResult {
  const path = skillTarget(opts);
  if (!existsSync(path)) return { ok: false, path, reason: 'not-installed' };
  if (!readMarker(path) && !opts.force) return { ok: false, path, reason: 'foreign' };
  rmSync(path, { recursive: true, force: true });
  return { ok: true, path };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

interface SkillArgs extends SkillTargetOptions {
  subcommand?: string;
  force?: boolean;
  version: string;
}

const display = (p: string) => {
  const rel = relative(process.cwd(), p);
  return rel && !rel.startsWith('..') ? `./${rel}` : p.replace(homedir(), '~');
};

export function skillCommand(args: SkillArgs): void {
  const { subcommand = 'install' } = args;

  switch (subcommand) {
    case 'install': {
      const r = installSkill({ ...args, version: args.version });
      if (!r.ok) {
        if (r.reason === 'missing-source') printError('The bundled skill is missing — reinstall @mailts/cli.');
        else printError(`${display(r.path)} exists and was not installed by mailts. Use --force to replace it.`);
        process.exitCode = 1;
        return;
      }
      const verb = r.action === 'updated' ? 'Updated' : 'Installed';
      const was = r.previous && r.previous !== args.version ? `, was v${r.previous}` : '';
      printSuccess(`${verb} the mailts skill → ${display(r.path)} (${r.files} files${was})`);
      if (!args.dir) {
        printInfo(args.global
          ? 'Claude Code loads it in every project. Restart open sessions to pick it up.'
          : 'Claude Code loads it in this project. Commit .claude/skills/mailts to share it with your team.');
      } else {
        printInfo('Point your agent at this folder (Agent Skills format: SKILL.md + references/).');
      }
      return;
    }

    case 'uninstall':
    case 'remove': {
      const r = uninstallSkill(args);
      if (r.ok) { printSuccess(`Removed ${display(r.path)}`); return; }
      if (r.reason === 'not-installed') printInfo(`Nothing to remove — ${display(r.path)} does not exist.`);
      else { printError(`${display(r.path)} was not installed by mailts. Use --force to remove it.`); process.exitCode = 1; }
      return;
    }

    case 'show': {
      const src = bundledSkillDir();
      if (!src) { printError('The bundled skill is missing — reinstall @mailts/cli.'); process.exitCode = 1; return; }
      process.stdout.write(readFileSync(join(src, 'SKILL.md'), 'utf8'));
      return;
    }

    case 'path':
      process.stdout.write(skillTarget(args) + '\n');
      return;

    default:
      printError(`Unknown skill subcommand: ${subcommand}`);
      printInfo('Available: install | uninstall | show | path   (options: --global, --dir <path>, --force)');
      process.exitCode = 1;
  }
}
