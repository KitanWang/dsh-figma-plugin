/**
 * Bundled-skill loading and registration.
 *
 * The plugin ships its Figma workflows as ordinary `SKILL.md` directories —
 * the same shape the filesystem skill provider reads — but registers them
 * through `ctx.skills.register()` so they land in the harness-global layer.
 * That is what makes them visible to every agent and preset, including
 * presets that never mount a filesystem skill provider.
 *
 * @module dsh-figma/skills
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the package's `skills/` directory. */
export const SKILLS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills');

/** Provider label attached to every skill this plugin registers. */
export const SKILL_PROVIDER = 'dsh-figma';

/** Strip one layer of matching quotes from a scalar. */
function unquote(value) {
  const text = value.trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Parse the YAML frontmatter subset that skill files use: single-line scalars
 * plus `|` literal and `>` folded blocks. Anything more elaborate belongs in
 * the body, not the header, so a full YAML parser would be dead weight.
 *
 * @param text - the raw SKILL.md contents.
 * @returns the parsed metadata and the remaining body.
 */
export function parseFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---')) return { data: {}, body: normalized.trim() };

  const lines = normalized.split('\n');
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      end = index;
      break;
    }
  }
  if (end === -1) return { data: {}, body: normalized.trim() };

  const data = {};
  const header = lines.slice(1, end);
  for (let index = 0; index < header.length; index += 1) {
    const line = header[index];
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1];
    const rawValue = match[2];

    if (rawValue === '|' || rawValue === '>' || rawValue === '|-' || rawValue === '>-') {
      const block = [];
      while (index + 1 < header.length && (header[index + 1].trim().length === 0 || /^\s+/.test(header[index + 1]))) {
        index += 1;
        block.push(header[index].replace(/^\s{1,4}/, ''));
      }
      const joined = rawValue.startsWith('|') ? block.join('\n') : block.join(' ').replace(/\s+/g, ' ');
      data[key] = joined.trim();
      continue;
    }
    data[key] = unquote(rawValue);
  }

  return { data, body: lines.slice(end + 1).join('\n').trim() };
}

/**
 * Load every skill directory under a root.
 *
 * @param root - directory containing one subdirectory per skill.
 * @returns loaded skill records; malformed directories are reported, not thrown.
 */
export function loadSkills(root = SKILLS_ROOT) {
  if (!existsSync(root)) return { skills: [], problems: [`skill root not found: ${root}`] };
  const skills = [];
  const problems = [];
  const entries = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const entry of entries) {
    const directory = join(root, entry.name);
    const skillFile = join(directory, 'SKILL.md');
    if (!existsSync(skillFile)) {
      problems.push(`${entry.name}: no SKILL.md`);
      continue;
    }
    let parsed;
    try {
      parsed = parseFrontmatter(readFileSync(skillFile, 'utf8'));
    } catch (error) {
      problems.push(`${entry.name}: ${error?.message ?? String(error)}`);
      continue;
    }
    const name = typeof parsed.data.name === 'string' && parsed.data.name.length > 0 ? parsed.data.name : entry.name;
    const description =
      typeof parsed.data.description === 'string' && parsed.data.description.length > 0
        ? parsed.data.description
        : `Figma workflow: ${name}`;
    if (parsed.body.length === 0) {
      problems.push(`${entry.name}: empty body`);
      continue;
    }
    skills.push({
      name,
      description,
      whenToUse: typeof parsed.data.whenToUse === 'string' && parsed.data.whenToUse.length > 0 ? parsed.data.whenToUse : undefined,
      content: parsed.body,
      directory,
      path: skillFile,
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, problems };
}

/**
 * Register every bundled skill into the calling context's skill layer.
 *
 * A missing skill service is not an error: the plugin stays useful as a pure
 * tool provider in a deployment that does not mount `ctx.skills`.
 *
 * @param ctx - the plugin context.
 * @param options - root override and provider label.
 * @returns the registered skill names and any problems encountered.
 */
export function registerSkills(ctx, options = {}) {
  const skills = ctx.get?.('skills');
  const { skills: loaded, problems } = loadSkills(options.root ?? SKILLS_ROOT);
  if (skills === undefined) {
    return { registered: [], problems: [...problems, 'no skill registry is mounted; skills were not registered'] };
  }
  const registered = [];
  for (const skill of loaded) {
    try {
      skills.register({
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        content: skill.content,
        source: 'bundled',
        provider: options.provider ?? SKILL_PROVIDER,
        resourceBase: { kind: 'directory', path: skill.directory },
      });
      registered.push(skill.name);
    } catch (error) {
      problems.push(`${skill.name}: ${error?.message ?? String(error)}`);
    }
  }
  return { registered, problems };
}
