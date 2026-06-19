const fs = require('fs');
const readline = require('readline');

async function main() {
  const fileStream = fs.createReadStream('/Users/k.far.88/.gemini/antigravity-ide/brain/ab0f30af-e710-4d44-b328-6eb3d8dec799/.system_generated/logs/transcript.jsonl');
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let inputs = [];
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    const obj = JSON.parse(line);
    if (obj.type === 'USER_INPUT') {
      inputs.push(obj.content);
    }
  }

  // second to last user input
  if (inputs.length >= 2) {
    fs.writeFileSync('last_user_input.txt', inputs[inputs.length - 2]);
    console.log('Saved to last_user_input.txt');
  }
}
main();
