import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as agentTrace from '../src/index.ts';

/**
 * Pulls the function names documented under "### API" in the README, e.g.
 * `- \`parseTrace(text): { events, issues }\` -- ...` yields `parseTrace`.
 */
function documentedApiNames(): string[] {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.split(/^### API$/m)[1]?.split(/^##/m)[0];
  assert.ok(section, 'README has no "### API" section');
  const names: string[] = [];
  for (const line of section.split('\n')) {
    const match = line.match(/^- `(\w+)\(/);
    if (match) names.push(match[1]);
  }
  return names;
}

function exportedFunctionNames(): string[] {
  return Object.keys(agentTrace)
    .filter((key) => typeof (agentTrace as Record<string, unknown>)[key] === 'function')
    .sort();
}

test('every function exported from src/index.ts is documented in the README API list', () => {
  const documented = new Set(documentedApiNames());
  for (const name of exportedFunctionNames()) {
    assert.ok(documented.has(name), `${name} is exported but missing from the README API list`);
  }
});

test('every function documented in the README API list is actually exported', () => {
  const exported = new Set(exportedFunctionNames());
  for (const name of documentedApiNames()) {
    assert.ok(exported.has(name), `README documents ${name}, but src/index.ts does not export it`);
  }
});
