// World Cup 2026 — JSON Validator (verified against Spanner sports-worldcup-db)
// Zero deps. Node or browser. Returns { valid, errors[], warnings[], counts }.

const GROUP_LETTERS = new Set(["A","B","C","D","E","F","G","H","I","J","K","L"]);
const TEAM_CODE_RE = /^[A-Z0-9]{2,10}$/;       // STRING(10), uppercase codes
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/;
// Soft enum hints (warnings only — DB columns are free text)
const STAGE_HINTS = new Set(["group","round-of-32","round-of-16","quarter-final","semi-final","third-place","final"]);
const STATUS_HINTS = new Set(["scheduled","in_progress","halftime","completed","postponed","cancelled","final"]);

function validate(data) {
  const errors = [];
  const warnings = [];
  const counts = { groups: 0, teams: 0, matches: 0, venues: 0 };
  const err = (path, message, rule = "type") => errors.push({ path, message, rule });
  const warn = (m) => warnings.push(m);
  const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const isStr = v => typeof v === "string";
  const isInt = v => Number.isInteger(v);
  const isNum = v => typeof v === "number" && !isNaN(v);
  const isBool = v => typeof v === "boolean";
  const nullableStr = v => v === null || isStr(v);
  const nullableInt = v => v === null || isInt(v);
  const nullableNum = v => v === null || isNum(v);
  const nullableBool = v => v === null || isBool(v);

  if (!isObj(data)) { err("$", "Root must be an object.", "type"); return { valid: false, errors, warnings, counts }; }

  for (const k of ["tournament","groups","meta"]) if (!(k in data)) err("$", `Missing required: "${k}".`, "required");
  const extraRoot = Object.keys(data).filter(k => !["tournament","groups","meta"].includes(k));
  if (extraRoot.length) err("$", `Unexpected: ${extraRoot.join(", ")}.`, "additionalProperties");

  // ── Tournament ──
  if (isObj(data.tournament)) {
    const t = data.tournament, p = "$.tournament";
    const req = ["tournamentId","displayName","season","totalTeams","totalGroups","totalGroupMatches","hostNations","totalVenues","startDate","endDate"];
    for (const k of req) if (!(k in t)) err(p, `Missing required: "${k}".`, "required");
    if ("tournamentId" in t && !isStr(t.tournamentId)) err(p+".tournamentId", "Must be string.");
    if ("displayName" in t && !isStr(t.displayName)) err(p+".displayName", "Must be string.");
    if ("season" in t && !isStr(t.season)) err(p+".season", "Must be string.");
    if ("totalTeams" in t && t.totalTeams !== 48) err(p+".totalTeams", "Must be 48.", "const");
    if ("totalGroups" in t && t.totalGroups !== 12) err(p+".totalGroups", "Must be 12.", "const");
    if ("totalGroupMatches" in t && t.totalGroupMatches !== 72) err(p+".totalGroupMatches", "Must be 72.", "const");
    if ("hostNations" in t) {
      if (!Array.isArray(t.hostNations) || t.hostNations.length < 1) err(p+".hostNations", "Must be non-empty array.", "minItems");
      else t.hostNations.forEach((v,i)=>{ if(!isStr(v)) err(`${p}.hostNations[${i}]`,"Must be string."); });
    }
    if ("totalVenues" in t && (!isInt(t.totalVenues) || t.totalVenues < 1)) err(p+".totalVenues", "Must be integer ≥ 1.", "minimum");
    if ("startDate" in t && !(isStr(t.startDate) && DATE_RE.test(t.startDate))) err(p+".startDate", "Must be ISO date.", "format");
    if ("endDate" in t && !(isStr(t.endDate) && DATE_RE.test(t.endDate))) err(p+".endDate", "Must be ISO date.", "format");
    const extra = Object.keys(t).filter(k => !req.includes(k));
    if (extra.length) err(p, `Unexpected: ${extra.join(", ")}.`, "additionalProperties");
  } else if ("tournament" in data) err("$.tournament", "Must be object.");

  // ── Groups ──
  if (Array.isArray(data.groups)) {
    if (data.groups.length !== 12) err("$.groups", `Expected 12 groups, got ${data.groups.length}.`, "minItems/maxItems");
    counts.groups = data.groups.length;
    const seen = new Set();

    data.groups.forEach((group, gi) => {
      const gp = `$.groups[${gi}]`;
      if (!isObj(group)) { err(gp, "Must be object."); return; }
      const gReq = ["letter","hostLabel","standings","matches","matchesPlayed","totalMatches","dateRange"];
      for (const k of gReq) if (!(k in group)) err(gp, `Missing required: "${k}".`, "required");

      if ("letter" in group) {
        if (!GROUP_LETTERS.has(group.letter)) err(gp+".letter", `Invalid letter "${group.letter}" (A–L).`, "enum");
        if (seen.has(group.letter)) err(gp+".letter", `Duplicate group "${group.letter}".`, "uniqueItems");
        seen.add(group.letter);
      }
      if ("hostLabel" in group && !isStr(group.hostLabel)) err(gp+".hostLabel", "Must be string.");
      if ("matchesPlayed" in group && (!isInt(group.matchesPlayed) || group.matchesPlayed < 0 || group.matchesPlayed > 6)) err(gp+".matchesPlayed", "0–6.", "range");
      if ("totalMatches" in group && group.totalMatches !== 6) err(gp+".totalMatches", "Must be 6.", "const");

      if ("dateRange" in group) {
        const dr = group.dateRange;
        if (!isObj(dr)) err(gp+".dateRange", "Must be object.");
        else {
          if (!(isStr(dr.start) && DATE_RE.test(dr.start))) err(gp+".dateRange.start", "Must be ISO date.", "format");
          if (!(isStr(dr.end) && DATE_RE.test(dr.end))) err(gp+".dateRange.end", "Must be ISO date.", "format");
        }
      }

      // standings
      if (Array.isArray(group.standings)) {
        if (group.standings.length !== 4) err(gp+".standings", `Expected 4, got ${group.standings.length}.`, "minItems/maxItems");
        counts.teams += group.standings.length;
        let prev = null;
        group.standings.forEach((tm, ti) => {
          const tp = `${gp}.standings[${ti}]`;
          if (!isObj(tm)) { err(tp, "Must be object."); return; }
          const tReq = ["teamCode","name","played","won","drawn","lost","goalsFor","goalsAgainst","goalDifference","points","qualificationZone"];
          for (const k of tReq) if (!(k in tm)) err(tp, `Missing required: "${k}".`, "required");

          if ("teamCode" in tm && !(isStr(tm.teamCode) && TEAM_CODE_RE.test(tm.teamCode))) err(tp+".teamCode", "Must match /^[A-Z0-9]{2,10}$/.", "pattern");
          if ("name" in tm && !isStr(tm.name)) err(tp+".name", "Must be string.");
          if ("groupLetter" in tm && !GROUP_LETTERS.has(tm.groupLetter)) err(tp+".groupLetter", "Invalid letter.", "enum");
          if ("fifaRanking" in tm && !(tm.fifaRanking === null || (isInt(tm.fifaRanking) && tm.fifaRanking >= 1 && tm.fifaRanking <= 250))) err(tp+".fifaRanking", "Integer 1–250 or null.", "range");
          if ("confederation" in tm && !nullableStr(tm.confederation)) err(tp+".confederation", "String or null.");
          if ("flagEmoji" in tm && !nullableStr(tm.flagEmoji)) err(tp+".flagEmoji", "String or null.");
          if ("flagUrl" in tm && !nullableStr(tm.flagUrl)) err(tp+".flagUrl", "String(URI) or null.");
          if ("nickname" in tm && !nullableStr(tm.nickname)) err(tp+".nickname", "String or null.");
          if ("isPlaceholder" in tm && !nullableBool(tm.isPlaceholder)) err(tp+".isPlaceholder", "Boolean or null.");
          for (const f of ["played","won","drawn","lost"]) if (f in tm && (!isInt(tm[f]) || tm[f] < 0 || tm[f] > 3)) err(`${tp}.${f}`, "0–3.", "range");
          for (const f of ["goalsFor","goalsAgainst"]) if (f in tm && (!isInt(tm[f]) || tm[f] < 0)) err(`${tp}.${f}`, "Integer ≥ 0.", "minimum");
          if ("goalDifference" in tm && !isInt(tm.goalDifference)) err(tp+".goalDifference", "Must be integer.");
          if ("points" in tm && (!isInt(tm.points) || tm.points < 0 || tm.points > 9)) err(tp+".points", "0–9.", "range");
          if ("qualificationZone" in tm && !isBool(tm.qualificationZone)) err(tp+".qualificationZone", "Must be boolean.");

          // Semantic integrity (warnings)
          if (["won","drawn","lost","played"].every(f => isInt(tm[f])) && tm.won+tm.drawn+tm.lost !== tm.played)
            warn(`${tp}: W+D+L (${tm.won+tm.drawn+tm.lost}) ≠ played (${tm.played}).`);
          if (["won","drawn","points"].every(f => isInt(tm[f])) && tm.points !== tm.won*3+tm.drawn)
            warn(`${tp}: points (${tm.points}) ≠ W×3+D (${tm.won*3+tm.drawn}).`);
          if (["goalsFor","goalsAgainst","goalDifference"].every(f => isInt(tm[f])) && tm.goalDifference !== tm.goalsFor-tm.goalsAgainst)
            warn(`${tp}: GD (${tm.goalDifference}) ≠ GF−GA (${tm.goalsFor-tm.goalsAgainst}).`);
          // Sort-order sanity (warning)
          if (prev && isInt(tm.points) && isInt(prev.points)) {
            if (tm.points > prev.points) warn(`${tp}: points out of order (above team has fewer points).`);
          }
          prev = tm;
          const extra = Object.keys(tm).filter(k => !["teamCode","name","groupLetter","fifaRanking","confederation","flagEmoji","flagUrl","nickname","isPlaceholder","played","won","drawn","lost","goalsFor","goalsAgainst","goalDifference","points","qualificationZone"].includes(k));
          if (extra.length) err(tp, `Unexpected: ${extra.join(", ")}.`, "additionalProperties");
        });
      } else if ("standings" in group) err(gp+".standings", "Must be array.");

      // matches
      if (Array.isArray(group.matches)) {
        if (group.matches.length < 1 || group.matches.length > 6) err(gp+".matches", `Expected 1–6, got ${group.matches.length}.`, "range");
        counts.matches += group.matches.length;
        group.matches.forEach((m, mi) => {
          const mp = `${gp}.matches[${mi}]`;
          if (!isObj(m)) { err(mp, "Must be object."); return; }
          const mReq = ["matchId","homeTeamCode","awayTeamCode","kickoff"];
          for (const k of mReq) if (!(k in m)) err(mp, `Missing required: "${k}".`, "required");

          if ("matchId" in m && !(isStr(m.matchId) && m.matchId.length >= 1 && m.matchId.length <= 36)) err(mp+".matchId", "String 1–36 chars.", "maxLength");
          if ("groupLetter" in m && !GROUP_LETTERS.has(m.groupLetter)) err(mp+".groupLetter", "Invalid letter.", "enum");
          if ("matchNumber" in m && !(m.matchNumber === null || (isInt(m.matchNumber) && m.matchNumber >= 1 && m.matchNumber <= 104))) err(mp+".matchNumber", "1–104 or null.", "range");
          if ("homeTeamCode" in m && !(isStr(m.homeTeamCode) && TEAM_CODE_RE.test(m.homeTeamCode))) err(mp+".homeTeamCode", "Must match /^[A-Z0-9]{2,10}$/.", "pattern");
          if ("awayTeamCode" in m && !(isStr(m.awayTeamCode) && TEAM_CODE_RE.test(m.awayTeamCode))) err(mp+".awayTeamCode", "Must match /^[A-Z0-9]{2,10}$/.", "pattern");
          if ("kickoff" in m && !(isStr(m.kickoff) && DATETIME_RE.test(m.kickoff))) err(mp+".kickoff", "Must be ISO date-time.", "format");
          if ("stage" in m && !nullableStr(m.stage)) err(mp+".stage", "String or null.");
          else if (isStr(m.stage) && !STAGE_HINTS.has(m.stage)) warn(`${mp}: unrecognized stage "${m.stage}".`);
          if ("status" in m && !nullableStr(m.status)) err(mp+".status", "String or null.");
          else if (isStr(m.status) && !STATUS_HINTS.has(m.status)) warn(`${mp}: unrecognized status "${m.status}".`);
          for (const f of ["homeScore","awayScore"]) if (f in m && !(m[f] === null || (isInt(m[f]) && m[f] >= 0))) err(`${mp}.${f}`, "Integer ≥ 0 or null.", "minimum");
          if ("venueId" in m && !nullableStr(m.venueId)) err(mp+".venueId", "String or null.");
          if ("espnEventId" in m && !nullableStr(m.espnEventId)) err(mp+".espnEventId", "String or null.");
          if ("liveMinute" in m && !(m.liveMinute === null || (isInt(m.liveMinute) && m.liveMinute >= 0 && m.liveMinute <= 130))) err(mp+".liveMinute", "0–130 or null.", "range");
          if ("livePeriod" in m && !(m.livePeriod === null || (isStr(m.livePeriod) && m.livePeriod.length <= 8))) err(mp+".livePeriod", "String(≤8) or null.");
          if ("liveStoppage" in m && !(m.liveStoppage === null || (isInt(m.liveStoppage) && m.liveStoppage >= 0))) err(mp+".liveStoppage", "Integer ≥ 0 or null.");

          // Score/status consistency (warning)
          if (m.status === "completed" && (m.homeScore === null || m.awayScore === null))
            warn(`${mp}: status=completed but score is null.`);
          if (m.status === "scheduled" && (isInt(m.homeScore) || isInt(m.awayScore)))
            warn(`${mp}: status=scheduled but score present.`);

          // venue
          if ("venue" in m && m.venue !== null) {
            const v = m.venue, vp = mp+".venue";
            if (!isObj(v)) err(vp, "Must be object or null.");
            else {
              counts.venues++;
              for (const k of ["venueId","name","city","country"]) if (!(k in v)) err(vp, `Missing required: "${k}".`, "required");
              if ("venueId" in v && !isStr(v.venueId)) err(vp+".venueId", "Must be string.");
              if ("name" in v && !isStr(v.name)) err(vp+".name", "Must be string.");
              if ("city" in v && !isStr(v.city)) err(vp+".city", "Must be string.");
              if ("country" in v && !isStr(v.country)) err(vp+".country", "Must be string.");
              if ("state" in v && !nullableStr(v.state)) err(vp+".state", "String or null.");
              if ("capacity" in v && !(v.capacity === null || (isInt(v.capacity) && v.capacity >= 0))) err(vp+".capacity", "Integer ≥ 0 or null.");
              if ("elevationMeters" in v && !(v.elevationMeters === null || (isInt(v.elevationMeters) && v.elevationMeters >= 0))) err(vp+".elevationMeters", "Integer ≥ 0 or null.");
              if ("roofType" in v && !nullableStr(v.roofType)) err(vp+".roofType", "String or null.");
              if ("surfaceType" in v && !nullableStr(v.surfaceType)) err(vp+".surfaceType", "String or null.");
              if ("timezone" in v && !nullableStr(v.timezone)) err(vp+".timezone", "String or null.");
              if ("latitude" in v && !nullableNum(v.latitude)) err(vp+".latitude", "Number or null.");
              if ("longitude" in v && !nullableNum(v.longitude)) err(vp+".longitude", "Number or null.");
            }
          }
          const extra = Object.keys(m).filter(k => !["matchId","groupLetter","matchNumber","homeTeamCode","awayTeamCode","kickoff","stage","status","homeScore","awayScore","venueId","venue","espnEventId","liveMinute","livePeriod","liveStoppage"].includes(k));
          if (extra.length) err(mp, `Unexpected: ${extra.join(", ")}.`, "additionalProperties");
        });
      } else if ("matches" in group) err(gp+".matches", "Must be array.");

      const extra = Object.keys(group).filter(k => !gReq.includes(k));
      if (extra.length) err(gp, `Unexpected: ${extra.join(", ")}.`, "additionalProperties");
    });
  } else if ("groups" in data) err("$.groups", "Must be array.");

  // ── Meta ──
  if (isObj(data.meta)) {
    const m = data.meta, p = "$.meta";
    const mReq = ["dataSource","fetchedAt","matchdayLabel","groupMatchesPlayed","groupMatchesTotal"];
    for (const k of mReq) if (!(k in m)) err(p, `Missing required: "${k}".`, "required");
    if ("dataSource" in m && !isStr(m.dataSource)) err(p+".dataSource", "Must be string.");
    if ("fetchedAt" in m && !(isStr(m.fetchedAt) && DATETIME_RE.test(m.fetchedAt))) err(p+".fetchedAt", "Must be ISO date/date-time.", "format");
    if ("matchdayLabel" in m && !isStr(m.matchdayLabel)) err(p+".matchdayLabel", "Must be string.");
    if ("groupMatchesPlayed" in m && (!isInt(m.groupMatchesPlayed) || m.groupMatchesPlayed < 0 || m.groupMatchesPlayed > 72)) err(p+".groupMatchesPlayed", "0–72.", "range");
    if ("groupMatchesTotal" in m && m.groupMatchesTotal !== 72) err(p+".groupMatchesTotal", "Must be 72.", "const");
    const extra = Object.keys(m).filter(k => !mReq.includes(k));
    if (extra.length) err(p, `Unexpected: ${extra.join(", ")}.`, "additionalProperties");
  } else if ("meta" in data) err("$.meta", "Must be object.");

  return { valid: errors.length === 0, errors, warnings, counts };
}

if (typeof module !== "undefined") module.exports = { validate };
if (typeof window !== "undefined") window.WorldCupValidator = { validate };
