import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderStats, renderTimeline } from '../src/render.ts';
import { computeStats } from '../src/stats.ts';
import type { AssistantEvent, ToolCallEvent, ToolResultEvent, TraceEvent, UserEvent } from '../src/types.ts';

function user(overrides: Partial<UserEvent> = {}): UserEvent {
  return { type: 'user', ts: null, text: '', ...overrides };
}

function assistant(overrides: Partial<AssistantEvent> = {}): AssistantEvent {
  return { type: 'assistant', ts: null, text: '', usage: null, ...overrides };
}

function call(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return { type: 'tool_call', ts: null, id: null, name: 'read_file', args: null, ...overrides };
}

function result(overrides: Partial<ToolResultEvent> = {}): ToolResultEvent {
  return { type: 'tool_result', ts: null, id: null, ok: true, durationMs: null, output: '', error: null, ...overrides };
}

test('renders a completed tool call with its result on the following line', () => {
  const events: TraceEvent[] = [
    call({ id: 'a', ts: 1000, name: 'read_file', args: { path: 'x' } }),
    result({ id: 'a', ts: 1050, output: 'done' }),
  ];
  const lines = renderTimeline(events).split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('tool_call'));
  assert.ok(lines[0].includes('read_file({"path":"x"})'));
  assert.equal(lines[1].trim(), '-> ok in 50ms  done');
});

test('a call left without a result is marked pending', () => {
  const events: TraceEvent[] = [call({ id: 'a', name: 'read_file' })];
  const output = renderTimeline(events);
  assert.ok(output.includes('[pending]'));
  assert.ok(output.includes('read_file'));
});

test('a failed call reports its error as the detail, not its output', () => {
  const events: TraceEvent[] = [
    call({ id: 'a', ts: 0, name: 'run_tests' }),
    result({ id: 'a', ts: 10, ok: false, output: 'ignored', error: 'boom' }),
  ];
  const output = renderTimeline(events);
  assert.ok(output.includes('-> failed in 10ms  boom'));
  assert.ok(!output.includes('ignored'));
});

test('an orphan result is rendered on its own line', () => {
  const events: TraceEvent[] = [result({ id: 'z', output: 'stray' })];
  const output = renderTimeline(events);
  assert.equal(output.split('\n').length, 1);
  assert.ok(output.includes('orphan (ok)'));
  assert.ok(output.includes('stray'));
});

test('user and assistant text appear in chronological order alongside tool activity', () => {
  const events: TraceEvent[] = [
    user({ text: 'hi' }),
    assistant({ text: 'sure' }),
    call({ id: 'a', name: 'read_file' }),
    result({ id: 'a' }),
  ];
  const lines = renderTimeline(events).split('\n');
  assert.ok(lines[0].includes('user') && lines[0].includes('hi'));
  assert.ok(lines[1].includes('assistant') && lines[1].includes('sure'));
});

test('an assistant line reports its token usage', () => {
  const events: TraceEvent[] = [assistant({ text: 'sure', usage: { input: 12, output: 3 } })];
  assert.ok(renderTimeline(events).includes('(12 in / 3 out)'));
});

test('includeText: false hides user and assistant events but keeps tool activity', () => {
  const events: TraceEvent[] = [user({ text: 'hi' }), call({ id: 'a', name: 'read_file' }), result({ id: 'a' })];
  const output = renderTimeline(events, { includeText: false });
  assert.ok(!output.includes('hi'));
  assert.ok(output.includes('read_file'));
});

test('filtering by tool hides text, other tools, and orphans', () => {
  const events: TraceEvent[] = [
    user({ text: 'hi' }),
    call({ id: 'a', name: 'run_tests' }),
    result({ id: 'a', output: 'passed' }),
    call({ id: 'b', name: 'read_file' }),
    result({ id: 'b' }),
    result({ id: 'nothing-open' }),
  ];
  const output = renderTimeline(events, { tool: 'run_tests' });
  assert.ok(output.includes('run_tests'));
  assert.ok(!output.includes('read_file'));
  assert.ok(!output.includes('hi'));
  assert.ok(!output.includes('orphan'));
});

test('args and output are truncated to maxArgLength', () => {
  const events: TraceEvent[] = [
    call({ id: 'a', name: 'read_file', args: { path: 'a'.repeat(100) } }),
    result({ id: 'a', output: 'b'.repeat(100) }),
  ];
  const output = renderTimeline(events, { maxArgLength: 10 });
  assert.ok(output.includes('...'));
  assert.ok(!output.includes('a'.repeat(100)));
  assert.ok(!output.includes('b'.repeat(100)));
});

test('summary reports totals and tool time as a share of wall clock', () => {
  const events: TraceEvent[] = [
    user({ ts: 0 }),
    call({ id: 'a', ts: 0, name: 'run_tests' }),
    result({ id: 'a', ts: 900, ok: true }),
  ];
  const stats = computeStats(events);
  const lines = renderStats(stats).split('\n');
  assert.ok(lines[0].startsWith('events'));
  assert.ok(lines[0].includes(String(stats.totalEvents)));
  assert.ok(lines.some((l) => l.startsWith('wall clock') && l.includes('900ms')));
  assert.ok(lines.some((l) => l.includes('of wall clock')));
});

test('wall clock is n/a and no share is shown without timestamp data', () => {
  const stats = computeStats([user(), assistant()]);
  const output = renderStats(stats);
  assert.ok(output.includes('wall clock    n/a'));
  assert.ok(!output.includes('of wall clock'));
});

test('tokens line reports none recorded when no assistant usage was seen', () => {
  const stats = computeStats([user()]);
  assert.ok(renderStats(stats).includes('tokens        none recorded'));
});

test('tokens line reports totals when usage was seen', () => {
  const stats = computeStats([assistant({ usage: { input: 100, output: 20 } })]);
  assert.ok(renderStats(stats).includes('tokens        100 in / 20 out = 120 total'));
});

test('no tool table is printed when there were no tool calls', () => {
  const stats = computeStats([user(), assistant()]);
  assert.equal(renderStats(stats).split('\n').length, 5);
});

test('tool table sorts by total time descending and formats sub-second durations in ms', () => {
  const events: TraceEvent[] = [
    call({ id: 'a', name: 'run_tests', ts: 0 }),
    result({ id: 'a', ts: 3515, ok: false, error: 'fail' }),
    call({ id: 'b', name: 'run_tests', ts: 0 }),
    result({ id: 'b', ts: 1758, ok: true }),
    call({ id: 'c', name: 'read_file', ts: 0 }),
    result({ id: 'c', ts: 48, ok: true }),
  ];
  const output = renderStats(computeStats(events));
  assert.ok(output.indexOf('run_tests') < output.indexOf('read_file'));
  assert.ok(output.includes('3.515s'));
  assert.ok(output.includes('48ms'));
});

test('tool table header lists every column', () => {
  const stats = computeStats([call({ id: 'a', name: 'x' }), result({ id: 'a', durationMs: 5 })]);
  const header = renderStats(stats)
    .split('\n')
    .find((l) => l.includes('share'));
  assert.ok(header);
  for (const column of ['calls', 'fail', 'total', 'avg', 'max', 'share']) {
    assert.ok(header?.includes(column), `expected header to include "${column}"`);
  }
});
