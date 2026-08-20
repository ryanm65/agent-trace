import assert from 'node:assert/strict';
import { test } from 'node:test';
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

test('counts events by type', () => {
  const events: TraceEvent[] = [user(), assistant(), assistant(), call({ id: 'a' }), result({ id: 'a' })];
  const stats = computeStats(events);
  assert.deepEqual(stats.eventCounts, { user: 1, assistant: 2, tool_call: 1, tool_result: 1 });
  assert.equal(stats.totalEvents, 5);
});

test('wall clock spans the earliest to the latest timestamp', () => {
  const events: TraceEvent[] = [user({ ts: 1000 }), assistant({ ts: 4500 }), call({ ts: 2000 })];
  assert.equal(computeStats(events).wallClockMs, 3500);
});

test('wall clock is null with fewer than two timestamps', () => {
  assert.equal(computeStats([user({ ts: 1000 })]).wallClockMs, null);
  assert.equal(computeStats([user()]).wallClockMs, null);
});

test('tool time is the sum of span durations', () => {
  const events: TraceEvent[] = [
    call({ id: 'a', ts: 0 }),
    result({ id: 'a', ts: 100 }),
    call({ id: 'b', ts: 0 }),
    result({ id: 'b', durationMs: 250 }),
  ];
  assert.equal(computeStats(events).toolTimeMs, 350);
});

test('pending calls are counted but excluded from tool time', () => {
  const events: TraceEvent[] = [call({ id: 'a' }), call({ id: 'b' }), result({ id: 'a', durationMs: 10 })];
  const stats = computeStats(events);
  assert.equal(stats.toolCalls.total, 2);
  assert.equal(stats.toolCalls.completed, 1);
  assert.equal(stats.toolCalls.pending, 1);
});

test('failure rate is failed over total calls issued', () => {
  const events: TraceEvent[] = [
    call({ id: 'a' }),
    result({ id: 'a', ok: false, error: 'boom' }),
    call({ id: 'b' }),
    result({ id: 'b', ok: true }),
  ];
  const stats = computeStats(events);
  assert.equal(stats.toolCalls.failed, 1);
  assert.equal(stats.toolCalls.failureRate, 0.5);
});

test('failure rate is zero with no calls at all', () => {
  assert.equal(computeStats([]).toolCalls.failureRate, 0);
});

test('tokens are summed across assistant events, null when none had usage', () => {
  const withUsage: TraceEvent[] = [
    assistant({ usage: { input: 100, output: 20 } }),
    assistant({ usage: { input: 50, output: 5 } }),
  ];
  assert.deepEqual(computeStats(withUsage).tokens, { input: 150, output: 25, total: 175 });
  assert.equal(computeStats([assistant(), user()]).tokens, null);
});

test('per-tool stats aggregate calls, failures, timing and share', () => {
  const events: TraceEvent[] = [
    call({ id: 'a', name: 'run_tests', ts: 0 }),
    result({ id: 'a', ts: 1000, ok: false, error: 'fail' }),
    call({ id: 'b', name: 'run_tests', ts: 0 }),
    result({ id: 'b', ts: 3000, ok: true }),
    call({ id: 'c', name: 'read_file', ts: 0 }),
    result({ id: 'c', ts: 40, ok: true }),
  ];
  const stats = computeStats(events);
  assert.equal(stats.tools.length, 2);

  const runTests = stats.tools.find((t) => t.name === 'run_tests');
  assert.ok(runTests);
  assert.equal(runTests.calls, 2);
  assert.equal(runTests.failures, 1);
  assert.equal(runTests.totalMs, 4000);
  assert.equal(runTests.avgMs, 2000);
  assert.equal(runTests.maxMs, 3000);

  // run_tests is listed first because it has the larger share of tool time.
  assert.equal(stats.tools[0].name, 'run_tests');
  assert.ok(stats.tools[0].timeShare > stats.tools[1].timeShare);
});

test('a span with no derivable duration does not skew avg or max for its tool', () => {
  const events: TraceEvent[] = [
    call({ id: 'a', name: 'read_file', ts: null }),
    result({ id: 'a', ts: 1000 }),
    call({ id: 'b', name: 'read_file', ts: 0 }),
    result({ id: 'b', ts: 100 }),
  ];
  const stats = computeStats(events);
  const readFile = stats.tools[0];
  assert.equal(readFile.calls, 2);
  assert.equal(readFile.totalMs, 100);
  assert.equal(readFile.avgMs, 100);
  assert.equal(readFile.maxMs, 100);
});

test('orphan results are counted separately from calls', () => {
  const events: TraceEvent[] = [result({ id: 'nothing-open' })];
  const stats = computeStats(events);
  assert.equal(stats.orphanResults, 1);
  assert.equal(stats.toolCalls.total, 0);
});
