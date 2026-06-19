// Minimal contract validator for the drip-live-game schema.
// Not a full JSON-Schema engine — checks the invariants that matter:
// types, enums, maxLength, required, the 3-cells rule, prose caps.
// Run BEFORE handing a Gemini payload to the page renderer.

import fs from 'fs';
const schema = JSON.parse(fs.readFileSync('drip-live-schema.json','utf8')).responseSchema;
const defs = JSON.parse(fs.readFileSync('drip-live-schema.json','utf8'))['$defs'];

function resolve(node){
  if(node && node['$ref']){ const k=node['$ref'].split('/').pop(); return defs[k]; }
  return node;
}
function check(node, val, path, errs){
  node = resolve(node);
  if(val===null || val===undefined){
    if(node.nullable) return;
    return; // requiredness handled by parent
  }
  const T = node.type;
  if(T==='OBJECT'){
    if(typeof val!=='object'||Array.isArray(val)){ errs.push(`${path}: expected object`); return; }
    (node.required||[]).forEach(r=>{ if(val[r]===undefined||val[r]===null){ if(!(resolve(node.properties[r])||{}).nullable) errs.push(`${path}.${r}: required, missing`); }});
    for(const k in (node.properties||{})) if(k in val) check(node.properties[k], val[k], `${path}.${k}`, errs);
  } else if(T==='ARRAY'){
    if(!Array.isArray(val)){ errs.push(`${path}: expected array`); return; }
    if(node.minItems!=null && val.length<node.minItems) errs.push(`${path}: <${node.minItems} items (got ${val.length})`);
    if(node.maxItems!=null && val.length>node.maxItems) errs.push(`${path}: >${node.maxItems} items (got ${val.length})`);
    val.forEach((v,i)=>check(node.items, v, `${path}[${i}]`, errs));
  } else if(T==='STRING'){
    if(typeof val!=='string'){ errs.push(`${path}: expected string`); return; }
    if(node.enum && !node.enum.includes(val)) errs.push(`${path}: "${val}" not in [${node.enum.join(', ')}]`);
    if(node.maxLength!=null && val.length>node.maxLength) errs.push(`${path}: ${val.length} chars > maxLength ${node.maxLength}`);
  } else if(T==='INTEGER'||T==='NUMBER'){
    if(typeof val!=='number'){ errs.push(`${path}: expected number`); return; }
    if(T==='INTEGER' && !Number.isInteger(val)) errs.push(`${path}: not integer`);
    if(node.minimum!=null && val<node.minimum) errs.push(`${path}: ${val} < min ${node.minimum}`);
    if(node.maximum!=null && val>node.maximum) errs.push(`${path}: ${val} > max ${node.maximum}`);
  } else if(T==='BOOLEAN'){
    if(typeof val!=='boolean') errs.push(`${path}: expected boolean`);
  }
}
function validate(payload){ const e=[]; check(schema,payload,'',e); return e; }

// ---- GOOD payload (mirrors the page's current state) ----
const good = {
  gameState:{inning:5,inningHalf:'top',leader:'NYY',margin:2,runsScored:4},
  teams:{away:{abbr:'NYY',name:'Yankees',record:'50–22',score:3,teamId:'147'},
         home:{abbr:'BOS',name:'Red Sox',record:'35–35',score:1,teamId:'111'}},
  situation:{bases:{first:false,second:true,third:false},outs:2,balls:2,strikes:1,
             line:'Top 5th · Two Outs',sub:'Yankees batting · 2–1 on Judge'},
  atBat:{name:'Aaron Judge',playerId:'592450',monogram:'AJ',statLine:'2–2, RBI single in 3rd',
         count:'2–1',onDeck:'Alex Verdugo',dueUp:'Giancarlo Stanton'},
  pitcher:{name:'Kutter Crawford',playerId:'676092',monogram:'KC',teamAbbr:'BOS',teamId:'111',
           statLine:'4.1 IP · 5 H · 3 ER · 78 P · 3.47 ERA'},
  markets:{
    total:{name:'Total',cells:[{num:'8.5',cap:'Open'},{num:'7.5',cap:'Live',arrow:'down'},{num:'4',cap:'Runs · 4½'}],
           read:'Four in through four and a half. Live total sits a run under the open.',movement:1.0,openLine:8.5,liveLine:7.5},
    moneyline:{name:'Moneyline',cells:[{num:'−135',cap:'NYY Open'},{num:'−180',cap:'NYY Live',arrow:'down'},{num:'+150',cap:'BOS Live'}],
           read:'New York opened a slim favorite. Two runs up in the fifth, the price has hardened toward them.',movement:0.45,openLine:-135,liveLine:-180},
    runline:{name:'Run Line',cells:[{num:'−1.5',cap:'NYY Line'},{num:'+118',cap:'NYY Price',arrow:'down'},{num:'−142',cap:'BOS +1.5'}],
           read:'New York laying a run and a half. The price has come in as the lead held.',movement:0.30,openLine:118,liveLine:104}
  },
  plays:[{inning:'T5',desc:'<strong>A. Judge</strong> takes ball two outside.'}],
  booth:null
};

// ---- BROKEN payload (the failures that actually happen) ----
const bad = JSON.parse(JSON.stringify(good));
bad.markets.moneyline.name = 'ML';                                  // enum violation
bad.markets.total.cells.push({num:'x',cap:'extra'});                // 4 cells, not 3
bad.markets.total.read = 'This is a lock, huge edge, hammer the under — '.repeat(6); // way over 160 + banned words (length catches it)
bad.situation.outs = 5;                                             // > max 3
bad.gameState.inning = 'five';                                      // wrong type
delete bad.teams.away.score;                                        // required missing
bad.booth = {lead:'ok', paragraphs:['only one']};                   // < minItems 2

console.log('GOOD payload →', validate(good).length===0 ? 'PASS ✓' : 'FAIL:\n  '+validate(good).join('\n  '));
console.log();
const e = validate(bad);
console.log('BROKEN payload → caught '+e.length+' violations:');
e.forEach(x=>console.log('  ✗ '+x));
