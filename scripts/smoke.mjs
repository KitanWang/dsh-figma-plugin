/**
 * Loader smoke test: mount the plugin in a real Cordis context alongside the
 * harness's own tool, skill, and system-prompt services, then assert that the
 * tools and skills actually landed in those registries.
 *
 * This is the check that a stub context cannot make — it proves the plugin
 * works against the real service contracts, not a hand-written imitation.
 *
 * Usage: node scripts/smoke.mjs [path-to-plugin-entry]
 */

import { Context } from '@deepseek-ai/cordis';
import * as skillService from '@deepseek-ai/dsh-skill';
import * as systemPromptService from '@deepseek-ai/dsh-system-prompt';
import * as toolsService from '@deepseek-ai/dsh-tools';

const entry = process.argv[2] ?? new URL('../lib/index.js', import.meta.url).pathname;
const figma = await import(entry);

const ctx = new Context();
// The harness service packages export their Cordis Service class as `default`.
ctx.plugin(systemPromptService.default);
ctx.plugin(toolsService.default);
ctx.plugin(skillService.default);
ctx.plugin(figma, { accessToken: 'smoke-token' });

await new Promise((resolve) => setTimeout(resolve, 500));

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const tools = ctx.get('tools');
check(tools !== undefined, 'ctx.tools was not mounted');

const expected = [
  'figma_get_comments',
  'figma_get_components',
  'figma_get_design_context',
  'figma_get_dev_resources',
  'figma_get_file',
  'figma_get_screenshot',
  'figma_get_styles',
  'figma_get_variables',
  'figma_login',
  'figma_post_comment',
  'figma_whoami',
];
for (const name of expected) {
  check(tools?.get(name) !== undefined, `tool ${name} is not registered`);
}

const skills = ctx.get('skills');
check(skills !== undefined, 'ctx.skills was not mounted');
const catalog = skills === undefined ? [] : await skills.list({});
const skillNames = catalog.map((entry) => entry.name);
for (const name of ['figma-design-to-code', 'figma-design-system', 'figma-code-connect', 'figma-design-review']) {
  check(skillNames.includes(name), `skill ${name} is not in the catalog`);
}

const systemPrompt = ctx.get('systemPrompt');
check(systemPrompt !== undefined, 'ctx.systemPrompt was not mounted');
const assembled = systemPrompt === undefined ? undefined : await systemPrompt.assemble({ variables: {} });
const promptText = JSON.stringify(assembled ?? {});
check(promptText.includes('figma_get_design_context'), 'the figma prompt section did not reach assembly');

if (failures.length > 0) {
  console.error('smoke test FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`smoke test passed: ${expected.length} tools registered, ${skillNames.length} skill(s) in the catalog`);
console.log(`  skills: ${skillNames.join(', ')}`);
console.log(`  figma prompt section reached system-prompt assembly: yes`);
