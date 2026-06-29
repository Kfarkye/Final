import fs from 'fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync('/Users/k.far.88/Developer/reverie/thedrip/live-game.html', 'utf8');

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

try {
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  dom.window.renderPayload(good);
  console.log("Success! No exception thrown during renderPayload.");
} catch(e) {
  console.error("Exception thrown:", e);
}
