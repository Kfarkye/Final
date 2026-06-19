// Generate provider adapters from the canonical Gemini schema.
// Single source of truth -> mechanical transforms. Adapters can't drift.
import fs from 'fs';
const canonical = JSON.parse(fs.readFileSync('drip-live-schema.json','utf8'));
const root = canonical.responseSchema;
const defs = canonical['$defs'];

// ---------- OpenAI strict transform ----------
// Rules: lowercase types; EVERY property in `required`; optionals expressed as
// ["type","null"] unions; additionalProperties:false on every object;
// drop maxLength/min/max/minItems/maxItems (strict mode rejects them).
function oaType(t){ return {OBJECT:'object',ARRAY:'array',STRING:'string',INTEGER:'integer',NUMBER:'number',BOOLEAN:'boolean'}[t]; }
function oaResolve(node){ if(node && node['$ref']) return structuredClone(defs[node['$ref'].split('/').pop()]); return structuredClone(node); }

function toOpenAI(node){
  node = oaResolve(node);
  const T = node.type;
  const nullable = !!node.nullable;
  const out = {};
  if(node.description) out.description = node.description;

  if(T==='OBJECT'){
    out.type = nullable ? ['object','null'] : 'object';
    out.properties = {};
    const keys = node.propertyOrdering || Object.keys(node.properties||{});
    for(const k of keys) out.properties[k] = toOpenAI(node.properties[k]);
    out.required = keys;                 // strict: ALL keys required
    out.additionalProperties = false;
  } else if(T==='ARRAY'){
    out.type = nullable ? ['array','null'] : 'array';
    out.items = toOpenAI(node.items);
  } else {
    const base = oaType(T);
    out.type = nullable ? [base,'null'] : base;
    if(node.enum) out.enum = nullable ? node.enum.concat([null]) : node.enum;
  }
  // strict drops: maxLength, minLength, minimum, maximum, minItems, maxItems
  return out;
}

const openaiSchema = toOpenAI(root);
const openaiPayload = {
  model: "gpt-5.1",
  response_format: {
    type: "json_schema",
    json_schema: { name: "drip_live_game", strict: true, schema: openaiSchema }
  },
  _note: "strict:true enforces SHAPE at decode (types, enums, required, no extra keys). It does NOT enforce maxLength / minItems / numeric ranges — those were stripped and are now enforced ONLY by validate.mjs. Prose guardrail (system_instruction) must be sent as a system message."
};
fs.writeFileSync('drip-live-schema.openai.json', JSON.stringify(openaiPayload, null, 2));

// ---------- Anthropic tool transform ----------
// Rules: lowercase types; keep `required` as authored (true optionals allowed);
// nullable -> ["type","null"] union (Claude reads these); KEEP length/range as
// guidance (tolerated, not decode-enforced); additionalProperties:false.
function anType(t){ return oaType(t); }
function anResolve(node){ if(node && node['$ref']) return structuredClone(defs[node['$ref'].split('/').pop()]); return structuredClone(node); }

function toAnthropic(node){
  node = anResolve(node);
  const T = node.type;
  const nullable = !!node.nullable;
  const out = {};
  if(node.description) out.description = node.description;

  if(T==='OBJECT'){
    out.type = 'object';
    out.properties = {};
    const keys = node.propertyOrdering || Object.keys(node.properties||{});
    for(const k of keys) out.properties[k] = toAnthropic(node.properties[k]);
    if(node.required) out.required = node.required;   // keep real requiredness
    out.additionalProperties = false;
  } else if(T==='ARRAY'){
    out.type = 'array';
    out.items = toAnthropic(node.items);
    if(node.minItems!=null) out.minItems = node.minItems;   // kept as guidance
    if(node.maxItems!=null) out.maxItems = node.maxItems;
  } else {
    const base = anType(T);
    out.type = nullable ? [base,'null'] : base;
    if(node.enum) out.enum = node.enum;
    if(node.maxLength!=null) out.maxLength = node.maxLength; // guidance
    if(node.minimum!=null) out.minimum = node.minimum;
    if(node.maximum!=null) out.maximum = node.maximum;
  }
  return out;
}

const anthropicTool = {
  model: "claude-opus-4-8",
  tools: [{
    name: "render_live_game",
    description: "Emit the complete structured payload for one live game render. All fields per the drip-live-game contract.",
    input_schema: toAnthropic(root)
  }],
  tool_choice: { type: "tool", name: "render_live_game" },
  _note: "Forcing the tool guarantees Claude returns a tool_use block whose `input` conforms to input_schema (strong shape adherence, not token-level like OpenAI strict). maxLength/minItems kept as guidance — still validate.mjs after. Read payload from response.content[].input where type==='tool_use'. system_instruction goes in the top-level `system` param."
};
fs.writeFileSync('drip-live-schema.anthropic.json', JSON.stringify(anthropicTool, null, 2));

console.log('Built both adapters.');
console.log('  OpenAI:   required-count per object =', 'all keys (strict)');
console.log('  Anthropic: required preserved as authored');
