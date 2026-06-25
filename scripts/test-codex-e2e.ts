/**
 * E2E: Codex Governed Execution Loop — verify tool name fix on reverie-00268-xff
 */
const ENDPOINT = 'https://reverie-70323048967.us-central1.run.app/api/truth/codex/chat';

interface SSEEvent { event: string; data: Record<string, unknown>; }

async function run() {
  console.log('═══ Codex E2E — Revision 00268-xff ═══');
  console.log(`Endpoint: ${ENDPOINT}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify({
      prompt: 'What are the current pregame odds for today\'s MLB games? Use the get_pregame_odds tool.',
      history: [],
      connectionId: `e2e_retest_${Date.now()}`,
      userTimezone: 'America/New_York',
      modelVersion: 'gpt-5.5',
    }),
  });

  if (!res.ok) { console.error(`HTTP ${res.status}: ${await res.text()}`); process.exit(1); }
  console.log(`HTTP ${res.status} OK\n`);

  const events: SSEEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split(/\r?\n\r?\n/);
    buf = parts.pop() || '';
    for (const part of parts) {
      if (!part.trim()) continue;
      const lines = part.split(/\r?\n/);
      let ev = 'message', data = '';
      for (const l of lines) {
        if (l.startsWith('event: ')) ev = l.slice(7).trim();
        else if (l.startsWith('data: ')) data = l.slice(6);
      }
      if (data) {
        try {
          const parsed = JSON.parse(data);
          events.push({ event: ev, data: parsed });
          if (ev === 'tool_call_started') console.log(`  🔧 Tool started: ${parsed.tool}`);
          else if (ev === 'tool_call_completed') console.log(`  ✅ Tool completed: ${parsed.tool}`);
          else if (ev === 'codex_response_id') console.log(`  🆔 Response: ${parsed.responseId}`);
          else if (ev === 'error') console.log(`  ❌ Error: ${parsed.message}`);
          else if (ev === 'done') console.log(`  ✔ Done`);
          else if (ev === 'delta') process.stdout.write('');
        } catch {}
      }
    }
  }

  console.log('\n═══ Results ═══');
  const toolStarts = events.filter(e => e.event === 'tool_call_started');
  const toolCompletes = events.filter(e => e.event === 'tool_call_completed');
  const undefinedTools = toolStarts.filter(e => !e.data.tool || e.data.tool === 'undefined');
  const doneEvent = events.find(e => e.event === 'done');
  const errors = events.filter(e => e.event === 'error');

  console.log(`Total events: ${events.length}`);
  console.log(`Tool starts: ${toolStarts.length} (names: ${toolStarts.map(e => e.data.tool || 'UNDEFINED').join(', ')})`);
  console.log(`Tool completes: ${toolCompletes.length}`);
  console.log(`Undefined tool names: ${undefinedTools.length}`);
  console.log(`Done event: ${doneEvent ? 'YES' : 'NO'}`);
  console.log(`Errors: ${errors.length}`);

  const pass = undefinedTools.length === 0 && !!doneEvent && errors.length === 0;
  console.log(`\n${pass ? '✅ TOOL NAME FIX VERIFIED — no undefined names' : '❌ STILL HAS UNDEFINED TOOL NAMES'}`);
  process.exit(pass ? 0 : 1);
}

run().catch(e => { console.error(e); process.exit(1); });
