// Keeps a recorded run's reading and drops its writing, for the emission bench. Tool calls
// that recorded claims or ended the run go, with their results; an assistant turn left with
// nothing in it goes too, because an empty assistant message is not a turn any provider
// accepts. The prose of a turn that wrote is dropped with its calls: it narrates the writing
// ("I have recorded the claims, let me end the investigation"), and left in, it made 6 of 40
// samples on 2026-09-23 end at once with no claim. Prose in turns that only read is kept.
const WRITING = new Set(['record_claim', 'end_investigation']);

export function readingOnly(transcript) {
  const dropped = new Set();
  const kept = [];
  for (const entry of transcript) {
    if (entry.role === 'assistant' && Array.isArray(entry.tool_calls)) {
      const calls = entry.tool_calls.filter(call => {
        if (WRITING.has(call.function?.name)) { dropped.add(call.id); return false; }
        return true;
      });
      const wrote = calls.length < entry.tool_calls.length;
      if (wrote && !calls.length) continue;
      if (!calls.length && !entry.content) continue;
      const { tool_calls: _, ...rest } = entry;
      const message = wrote ? { ...rest, content: '', ...('reasoning' in rest ? { reasoning: null } : {}) } : rest;
      kept.push(calls.length ? { ...message, tool_calls: calls } : message);
    } else if (entry.role === 'tool' && dropped.has(entry.tool_call_id)) {
      continue;
    } else kept.push(entry);
  }
  return kept;
}
