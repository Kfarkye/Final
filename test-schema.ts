import { z } from 'zod';
import { SchemaStream } from 'schema-stream';

const zGeminiStructuredSchema = z.object({
  thought_process: z.string().optional(),
  user_message: z.string().optional()
});

async function main() {
  const parser = new SchemaStream(zGeminiStructuredSchema);
  const streamParser = parser.parse();
  const writer = streamParser.writable.getWriter();
  const reader = streamParser.readable.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const pump = async () => {
    await writer.write(encoder.encode('{"thought_process": "thinking", '));
    await writer.write(encoder.encode('"user_message": "hello"}'));
    await writer.close();
  };

  const consume = async () => {
    let done = false;
    while (!done) {
      const { value, done: doneReading } = await reader.read();
      done = doneReading;
      if (value) {
        console.log("Value type:", typeof value, value instanceof Uint8Array);
        if (typeof value === 'string') {
          console.log("Value string:", value);
        } else {
          console.log("Decoded:", decoder.decode(value, { stream: true }));
        }
      }
    }
  };

  await Promise.all([pump(), consume()]);
}
main().catch(console.error);
