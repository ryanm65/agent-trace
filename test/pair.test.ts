import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pairToolEvents } from '../src/pair.ts';
import type { ToolCallEvent, ToolResultEvent, TraceEvent } from '../src/types.ts';

function call(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return { type: 'tool_call', ts: null, id: null, name: 'read_file', args: null, ...overrides };
}

function result(overrides: Partial<ToolResultEvent> = {}): ToolResultEvent {
  return { type: 'tool_result', ts: null, id: null, ok: true, durationMs: null, output: '', error: null, ...overrides };
}

test('matches call and result by id', () => {
  const events: TraceEvent[] = [call({ id: 'a' }), call({ id: 'b' }), result({ id: 'b' }), result({ id: 'a' })];
  const { spans, orphans } = pairToolEvents(events);
  assert.equal(orphans.length, 0);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].id, 'b');
  assert.equal(spans[1].id, 'a');
});

test('id-less result matches the oldest still-open call', () => {
  const events: TraceEvent[] = [
    call({ name: 'first' }),
    call({ name: 'second' }),
    result({ output: 'one' }),
    result({ output: 'two' }),
  ];
  const { spans } = pairToolEvents(events);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].name, 'first');
  assert.equal(spans[0].result.output, 'one');
  assert.equal(spans[1].name, 'second');
  assert.equal(spans[1].result.output, 'two');
});

test('result with an id that matches no open call is an orphan', () => {
  const events: TraceEvent[] = [call({ id: 'a' }), result({ id: 'z' })];
  const { spans, orphans } = pairToolEvents(events);
  assert.equal(spans.length, 0);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].id, 'z');
});

test('an id-less result is not stolen by an unrelated id when nothing is open', () => {
  const events: TraceEvent[] = [result({ id: null })];
  const { spans, orphans } = pairToolEvents(events);
  assert.equal(spans.length, 0);
  assert.equal(orphans.length, 1);
});

test('a call left without a result stays pending and is not a span or orphan', () => {
  const events: TraceEvent[] = [call({ id: 'a' })];
  const { spans, orphans } = pairToolEvents(events);
  assert.equal(spans.length, 0);
  assert.equal(orphans.length, 0);
});

test('durationMs on the result wins over the timestamp delta', () => {
  const events: TraceEvent[] = [call({ id: 'a', ts: 1000 }), result({ id: 'a', ts: 1100, durationMs: 42 })];
  const { spans } = pairToolEvents(events);
  assert.equal(spans[0].durationMs, 42);
});

test('duration falls back to the timestamp delta when durationMs is absent', () => {
  const events: TraceEvent[] = [call({ id: 'a', ts: 1000 }), result({ id: 'a', ts: 1075 })];
  const { spans } = pairToolEvents(events);
  assert.equal(spans[0].durationMs, 75);
});

test('duration is null when timestamps are missing or out of order', () => {
  const events: TraceEvent[] = [call({ id: 'a', ts: null }), result({ id: 'a', ts: 1000 })];
  const events2: TraceEvent[] = [call({ id: 'b', ts: 2000 }), result({ id: 'b', ts: 1000 })];
  assert.equal(pairToolEvents(events).spans[0].durationMs, null);
  assert.equal(pairToolEvents(events2).spans[0].durationMs, null);
});

test('ok is carried over from the result', () => {
  const events: TraceEvent[] = [call({ id: 'a' }), result({ id: 'a', ok: false, error: 'boom' })];
  const { spans } = pairToolEvents(events);
  assert.equal(spans[0].ok, false);
});

test('non tool events are ignored', () => {
  const events: TraceEvent[] = [
    { type: 'user', ts: null, text: 'hi' },
    { type: 'assistant', ts: null, text: 'hello', usage: null },
    call({ id: 'a' }),
    result({ id: 'a' }),
  ];
  const { spans, orphans } = pairToolEvents(events);
  assert.equal(spans.length, 1);
  assert.equal(orphans.length, 0);
});
