import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readingOnly } from '../benchmarks/reading-only.mjs';

const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } });

// The bench is only a test of emission if the model starts with the reading and none of the
// claims. A claim left in the prefix would be re-emitted from memory, not from the code; a
// tool result left without its call, or an empty assistant turn, is refused by the provider.
test('the reading is kept and every claim, with its result, is removed', () => {
  const transcript = [
    { role: 'assistant', content: 'reading and recording', reasoning: 'I will record it', tool_calls: [call('r1', 'read_file'), call('c1', 'record_claim')] },
    { role: 'tool', tool_call_id: 'r1', content: 'source' },
    { role: 'tool', tool_call_id: 'c1', content: '{"recorded":true}' },
    { role: 'assistant', content: '', tool_calls: [call('c2', 'record_claim')] },
    { role: 'tool', tool_call_id: 'c2', content: '{"recorded":true}' },
    { role: 'assistant', content: 'still reading' },
    { role: 'assistant', content: 'all recorded, ending', tool_calls: [call('e1', 'end_investigation')] },
    { role: 'tool', tool_call_id: 'e1', content: '{"recorded":true}' },
  ];
  // The prose of a turn that wrote narrates the writing, so it goes with it; a sample that
  // reads "I have recorded the claims" ends at once without writing any.
  assert.deepEqual(readingOnly(transcript), [
    { role: 'assistant', content: '', reasoning: null, tool_calls: [call('r1', 'read_file')] },
    { role: 'tool', tool_call_id: 'r1', content: 'source' },
    { role: 'assistant', content: 'still reading' },
  ]);
});
