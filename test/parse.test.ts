import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatIssue, parseTrace, parseTraceLine, parseTraceStrict } from '../src/parse.ts';

test('parses one event per non-blank line and skips blank lines', () => {
  const text = [
    '{"type":"user","text":"hi"}',
    '',
    '  ',
    '{"type":"assistant","text":"hello"}',
  ].join('\n');
  const { events, issues } = parseTrace(text);
  assert.equal(issues.length, 0);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'user');
  assert.equal(events[1].type, 'assistant');
});

test('bad json becomes an issue, not a thrown error', () => {
  const { events, issues } = parseTrace('{not json}');
  assert.equal(events.length, 0);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /not valid json/);
  assert.equal(issues[0].line, 1);
});

test('a json value that is not an object is an issue', () => {
  const { issues } = parseTrace('[1,2,3]');
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /expected a json object/);
});

test('missing type field is an issue', () => {
  const { issues } = parseTrace('{"text":"hi"}');
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /missing "type"/);
});

test('unknown type is an issue', () => {
  const { issues } = parseTrace('{"type":"mystery"}');
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /unknown event type/);
});

test('type aliases are matched case-insensitively', () => {
  const result = parseTraceLine('{"role":"HUMAN","text":"hi"}');
  assert.ok(result.ok);
  assert.equal(result.event.type, 'user');
});

test('role, event and kind are accepted in place of type', () => {
  assert.equal(parseTraceLine('{"role":"assistant"}').ok, true);
  assert.equal(parseTraceLine('{"event":"tool_use","name":"x"}').ok, true);
  assert.equal(parseTraceLine('{"kind":"tool_output"}').ok, true);
});

test('tool_call requires a non-blank name', () => {
  const missing = parseTraceLine('{"type":"tool_call"}');
  assert.equal(missing.ok, false);
  const blank = parseTraceLine('{"type":"tool_call","name":"  "}');
  assert.equal(blank.ok, false);
});

test('tool_call picks up id and args aliases', () => {
  const result = parseTraceLine(
    '{"type":"tool_call","tool_name":"read_file","call_id":"c1","arguments":{"path":"a.txt"}}',
  );
  assert.ok(result.ok && result.event.type === 'tool_call');
  assert.equal(result.event.name, 'read_file');
  assert.equal(result.event.id, 'c1');
  assert.deepEqual(result.event.args, { path: 'a.txt' });
});

test('tool_result defaults to ok when nothing says otherwise', () => {
  const result = parseTraceLine('{"type":"tool_result"}');
  assert.ok(result.ok && result.event.type === 'tool_result');
  assert.equal(result.event.ok, true);
  assert.equal(result.event.error, null);
});

test('tool_result is not ok when an error is present', () => {
  const result = parseTraceLine('{"type":"tool_result","error":"boom"}');
  assert.ok(result.ok && result.event.type === 'tool_result');
  assert.equal(result.event.ok, false);
  assert.equal(result.event.error, 'boom');
});

test('tool_result status strings drive ok', () => {
  const failed = parseTraceLine('{"type":"tool_result","status":"failed"}');
  assert.ok(failed.ok && failed.event.type === 'tool_result');
  assert.equal(failed.event.ok, false);

  const succeeded = parseTraceLine('{"type":"tool_result","status":"succeeded"}');
  assert.ok(succeeded.ok && succeeded.event.type === 'tool_result');
  assert.equal(succeeded.event.ok, true);
});

test('an object-shaped error is reduced to its message', () => {
  const result = parseTraceLine('{"type":"tool_result","error":{"message":"timed out","code":7}}');
  assert.ok(result.ok && result.event.type === 'tool_result');
  assert.equal(result.event.error, 'timed out');
});

test('epoch seconds are scaled up to milliseconds, epoch milliseconds are left alone', () => {
  const seconds = parseTraceLine('{"type":"user","ts":1700000000}');
  const millis = parseTraceLine('{"type":"user","ts":1700000000000}');
  assert.ok(seconds.ok && seconds.event.type === 'user');
  assert.ok(millis.ok && millis.event.type === 'user');
  assert.equal(seconds.event.ts, 1700000000000);
  assert.equal(millis.event.ts, 1700000000000);
});

test('an iso timestamp string is parsed, an unparseable one is null', () => {
  const iso = parseTraceLine('{"type":"user","ts":"2024-01-01T00:00:00.000Z"}');
  const bad = parseTraceLine('{"type":"user","ts":"not a date"}');
  assert.ok(iso.ok && iso.event.type === 'user');
  assert.ok(bad.ok && bad.event.type === 'user');
  assert.equal(iso.event.ts, Date.parse('2024-01-01T00:00:00.000Z'));
  assert.equal(bad.event.ts, null);
});

test('assistant text arrays are flattened, joining text parts', () => {
  const result = parseTraceLine(
    '{"type":"assistant","text":[{"text":"part one"},"part two",{"other":1}]}',
  );
  assert.ok(result.ok && result.event.type === 'assistant');
  assert.equal(result.event.text, 'part one\npart two\n{"other":1}');
});

test('assistant usage is picked up from token key aliases', () => {
  const result = parseTraceLine('{"type":"assistant","tokens":{"prompt_tokens":10,"completion_tokens":4}}');
  assert.ok(result.ok && result.event.type === 'assistant');
  assert.deepEqual(result.event.usage, { input: 10, output: 4 });
});

test('assistant usage is null when there is nothing usable to report', () => {
  const result = parseTraceLine('{"type":"assistant","usage":{}}');
  assert.ok(result.ok && result.event.type === 'assistant');
  assert.equal(result.event.usage, null);
});

test('formatIssue renders line, message and the raw text', () => {
  const rendered = formatIssue({ line: 3, message: 'boom', raw: '{"x":1}' });
  assert.equal(rendered, 'line 3: boom -- {"x":1}');
});

test('parseTraceStrict returns events when the trace is clean', () => {
  const events = parseTraceStrict('{"type":"user","text":"hi"}');
  assert.equal(events.length, 1);
});

test('parseTraceStrict throws with a summary of the issues found', () => {
  const text = ['{"type":"user"}', 'not json', '{"type":"mystery"}'].join('\n');
  assert.throws(() => parseTraceStrict(text), /invalid trace: 2 unusable line\(s\): line 2:.*line 3:/);
});

test('parseTraceStrict truncates the issue summary past three entries', () => {
  const text = ['bad1', 'bad2', 'bad3', 'bad4'].join('\n');
  assert.throws(() => parseTraceStrict(text), /and 1 more/);
});
