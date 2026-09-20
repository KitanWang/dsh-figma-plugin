import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SKILLS_ROOT, loadSkills, parseFrontmatter, registerSkills } from '../lib/skills.js';

test('parses single-line frontmatter and the body', () => {
  const { data, body } = parseFrontmatter('---\nname: demo\ndescription: "A demo"\n---\n\nBody text\n');
  assert.equal(data.name, 'demo');
  assert.equal(data.description, 'A demo');
  assert.equal(body, 'Body text');
});

test('parses folded and literal block scalars', () => {
  const folded = parseFrontmatter('---\ndescription: >\n  one\n  two\n---\nbody');
  assert.equal(folded.data.description, 'one two');
  const literal = parseFrontmatter('---\ndescription: |\n  one\n  two\n---\nbody');
  assert.equal(literal.data.description, 'one\ntwo');
});

test('tolerates a document without frontmatter', () => {
  const { data, body } = parseFrontmatter('# Just a title\n');
  assert.deepEqual(data, {});
  assert.equal(body, '# Just a title');
});

test('loads every bundled skill with a usable name and description', () => {
  const { skills, problems } = loadSkills(SKILLS_ROOT);
  assert.deepEqual(problems, []);
  const names = skills.map((skill) => skill.name);
  assert.deepEqual(names, ['figma-code-connect', 'figma-design-review', 'figma-design-system', 'figma-design-to-code']);
  for (const skill of skills) {
    assert.ok(skill.description.length > 20, `${skill.name} has a short description`);
    assert.ok(skill.content.length > 200, `${skill.name} has a short body`);
    assert.equal(skill.path.endsWith('SKILL.md'), true);
  }
});

test('reports a missing skill root instead of throwing', () => {
  const { skills, problems } = loadSkills('/nonexistent/skills');
  assert.deepEqual(skills, []);
  assert.equal(problems.length, 1);
});

test('registerSkills publishes to the skill service with a directory resource base', () => {
  const registered = [];
  const ctx = {
    get: (name) => (name === 'skills' ? { register: (skill) => (registered.push(skill), () => {}) } : undefined),
  };
  const { registered: names, problems } = registerSkills(ctx);
  assert.deepEqual(problems, []);
  assert.equal(names.length, 4);
  assert.equal(registered[0].source, 'bundled');
  assert.equal(registered[0].provider, 'dsh-figma');
  assert.equal(registered[0].resourceBase.kind, 'directory');
});

test('registerSkills degrades when no skill service is mounted', () => {
  const { registered, problems } = registerSkills({ get: () => undefined });
  assert.deepEqual(registered, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no skill registry/);
});
