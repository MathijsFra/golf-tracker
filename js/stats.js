// Statistiek- en EXS-berekeningen over een lijst rondes.
// Rondes worden verwacht oplopend op datum gesorteerd.

const EXS_THRESHOLD = 7.0; // WHS: SD >= 7.0 onder huidige index = exceptional score

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const round1 = (v) => Math.round(v * 10) / 10;
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

function holesData(r) {
  return Array.isArray(r.holes_data) ? r.holes_data : [];
}

const isNonQualifying = (r) => r.non_qualifying === true || r.notes === "Non-qualifying";

// Bepaalt per ronde of het een exceptionele score (EXS) is.
// EXS is een WHS-concept dat alleen geldt voor kwalificerende rondes;
// non-qualifying rondes worden overgeslagen voor EXS én handicap-tracking.
export function annotateExs(rounds) {
  let prevHcp = null;
  return rounds.map((r) => {
    const sd = num(r.sd);
    let exs = false;
    let diff = null;
    if (!isNonQualifying(r) && prevHcp !== null && sd !== null) {
      diff = round1(prevHcp - sd);
      exs = diff >= EXS_THRESHOLD;
    }
    const out = { ...r, _exs: exs, _exsDiff: diff };
    // Alleen qualifying rondes werken de handicap-voortgang bij.
    if (!isNonQualifying(r) && num(r.hcp) !== null) prevHcp = num(r.hcp);
    return out;
  });
}

// ---- afgeleide per-ronde waarden (per-hole heeft voorrang, anders totalen) ----
function girCount(r) {
  const hd = holesData(r);
  const fromHoles = hd.filter((h) => h.gir === true).length;
  if (hd.some((h) => h.gir === true || h.gir === false)) return fromHoles;
  return num(r.gir);
}
function fairwayStats(r) {
  const hd = holesData(r);
  const applicable = hd.filter((h) => h.fairway !== null && h.fairway !== undefined && h.fairway !== "");
  if (applicable.length) {
    const hit = applicable.filter((h) => h.fairway === "hit").length;
    return { hit, total: applicable.length };
  }
  if (num(r.fairways_hit) !== null && num(r.fairways_total) !== null) {
    return { hit: num(r.fairways_hit), total: num(r.fairways_total) };
  }
  return null;
}
function threePutts(r) {
  const hd = holesData(r);
  if (hd.some((h) => num(h.putts) !== null)) {
    return hd.filter((h) => num(h.putts) !== null && num(h.putts) >= 3).length;
  }
  return num(r.three_putts);
}
function doubleBogeys(r) {
  const hd = holesData(r);
  const withBoth = hd.filter((h) => num(h.score) !== null && num(h.par) !== null);
  if (withBoth.length) {
    return withBoth.filter((h) => num(h.score) >= num(h.par) + 2).length;
  }
  return num(r.double_bogeys);
}
// Gemiddelde score per par-categorie (3/4/5) binnen deze ronde.
function parAverages(r) {
  const hd = holesData(r);
  const out = {};
  for (const par of [3, 4, 5]) {
    const scores = hd
      .filter((h) => num(h.par) === par && num(h.score) !== null)
      .map((h) => num(h.score));
    out[par] = scores.length ? avg(scores) : null;
    out[`${par}_count`] = scores.length;
  }
  return out;
}

export function computeStats(rounds) {
  const annotated = annotateExs(rounds);
  const n = annotated.length;

  let currentHcp = null, startHcp = null;
  for (let i = n - 1; i >= 0; i--) {
    if (!isNonQualifying(annotated[i]) && num(annotated[i].hcp) !== null) { currentHcp = num(annotated[i].hcp); break; }
  }
  for (let i = 0; i < n; i++) {
    if (!isNonQualifying(annotated[i]) && num(annotated[i].hcp) !== null) { startHcp = num(annotated[i].hcp); break; }
  }
  const progress = (startHcp !== null && currentHcp !== null) ? round1(startHcp - currentHcp) : null;

  // Beste ronde = hoogste STB.
  let best = null;
  for (const r of annotated) {
    if (num(r.stb) === null) continue;
    if (!best || num(r.stb) > num(best.stb)) best = r;
  }

  const stb9 = annotated.filter((r) => r.holes === 9 && num(r.stb) !== null).map((r) => num(r.stb));
  const stb18 = annotated.filter((r) => r.holes === 18 && num(r.stb) !== null).map((r) => num(r.stb));

  let lowestSd = null;
  for (const r of annotated) {
    if (num(r.sd) === null) continue;
    if (lowestSd === null || num(r.sd) < lowestSd) lowestSd = num(r.sd);
  }

  const exsRounds = annotated.filter((r) => r._exs);

  return {
    rounds: annotated,
    count: n,
    currentHcp,
    startHcp,
    progress,
    best,
    avgStb9: stb9.length ? round1(avg(stb9)) : null,
    avgStb18: stb18.length ? round1(avg(stb18)) : null,
    countStb9: stb9.length,
    countStb18: stb18.length,
    lowestSd: lowestSd !== null ? round1(lowestSd) : null,
    exsRounds,
    avgScore20: avgScoreLast20(annotated),
    play: computePlay(annotated),
    par: computePar(annotated),
    garmin: computeGarmin(annotated),
    trend: rollingTrend(annotated, 10),
  };
}

// Gemiddelde score over de laatste 20 rondes, genormaliseerd naar 18 holes.
function avgScoreLast20(rounds) {
  const last = rounds.slice(-20);
  const norm = last
    .filter((r) => num(r.score) !== null)
    .map((r) => num(r.score) * (r.holes === 9 ? 2 : 1));
  if (!norm.length) return null;
  return { value: round1(avg(norm)), count: norm.length };
}

// Spel-statistieken: GIR%, fairway%, 3-putts, penalties, double bogey rate.
function computePlay(rounds) {
  let girHit = 0, girHoles = 0, anyGir = false;
  let fwHit = 0, fwTotal = 0, anyFw = false;
  const tp = [], pen = [];
  let dbCount = 0, dbHoles = 0, anyDb = false;

  for (const r of rounds) {
    const g = girCount(r);
    if (g !== null) { girHit += g; girHoles += r.holes; anyGir = true; }

    const fw = fairwayStats(r);
    if (fw) { fwHit += fw.hit; fwTotal += fw.total; anyFw = true; }

    const t = threePutts(r);
    if (t !== null) tp.push(t * (r.holes === 9 ? 2 : 1));

    const penVal = penaltiesTotal(r);
    if (penVal !== null) pen.push(penVal * (r.holes === 9 ? 2 : 1));

    const db = doubleBogeys(r);
    if (db !== null) { dbCount += db; dbHoles += r.holes; anyDb = true; }
  }

  return {
    any: anyGir || anyFw || tp.length || pen.length || anyDb,
    girPct: anyGir && girHoles ? Math.round((girHit / girHoles) * 100) : null,
    fairwayPct: anyFw && fwTotal ? Math.round((fwHit / fwTotal) * 100) : null,
    threePutts: tp.length ? round1(avg(tp)) : null,
    penalties: pen.length ? round1(avg(pen)) : null,
    doubleBogeyRate: anyDb && dbHoles ? Math.round((dbCount / dbHoles) * 100) : null,
  };
}

// Gemiddelde scoring per par-3/4/5 over alle rondes (gemiddelde van per-ronde-gemiddelden).
function computePar(rounds) {
  const buckets = { 3: [], 4: [], 5: [] };
  for (const r of rounds) {
    const pa = parAverages(r);
    for (const par of [3, 4, 5]) {
      if (pa[par] !== null) buckets[par].push(pa[par]);
    }
  }
  return {
    any: buckets[3].length || buckets[4].length || buckets[5].length,
    par3: buckets[3].length ? round1(avg(buckets[3])) : null,
    par4: buckets[4].length ? round1(avg(buckets[4])) : null,
    par5: buckets[5].length ? round1(avg(buckets[5])) : null,
  };
}

function puttsTotal(r) {
  if (num(r.putts) !== null) return num(r.putts);
  const hd = holesData(r);
  const vals = hd.map((h) => num(h.putts)).filter((v) => v !== null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}

function penaltiesTotal(r) {
  if (num(r.penalties) !== null) return num(r.penalties);
  const hd = holesData(r);
  const vals = hd.map((h) => num(h.penalties)).filter((v) => v !== null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}

function computeGarmin(rounds) {
  const putts = [];
  let bunkers = 0, saves = 0, anyGarmin = false;
  for (const r of rounds) {
    const factor = r.holes === 9 ? 2 : 1;
    const p = puttsTotal(r);
    if (p !== null) { putts.push(p * factor); anyGarmin = true; }
    if (num(r.bunkers) !== null) { bunkers += num(r.bunkers); anyGarmin = true; }
    if (num(r.bunker_saves) !== null) { saves += num(r.bunker_saves); anyGarmin = true; }
  }
  return {
    any: anyGarmin,
    avgPutts: putts.length ? round1(avg(putts)) : null,
    totalBunkers: bunkers,
    totalSaves: saves,
    saveRate: bunkers > 0 ? Math.round((saves / bunkers) * 100) : null,
  };
}

// Research-based benchmarkcurves [[hcp, waarde], ...] — lineair geïnterpoleerd.
// Bronnen: Shot Scope, Golf Insider UK, Break X Golf, MyGolfSpy (zie handicap-levels-framework).
const _GIR_C  = [[0,65],[5,50],[10,37],[15,26],[20,22],[25,19],[30,12],[36,6],[54,3]];
const _FW_C   = [[0,57],[5,51],[10,49],[15,48],[20,43],[25,43],[30,38],[36,30],[54,22]];
const _TP_C   = [[0,1.5],[5,2.0],[10,2.5],[15,3.5],[20,4.2],[25,5.8],[30,7.0],[36,8.5],[54,12.0]];
const _PEN_C  = [[0,0.5],[5,0.8],[10,1.5],[15,2.0],[20,2.8],[25,3.5],[30,5.0],[36,6.5],[54,10.0]];
const _DB_C   = [[0,1.5],[5,5],[10,14],[15,26],[20,37],[25,51],[30,60],[36,67],[54,75]];

function _interp(hcp, curve) {
  if (hcp <= curve[0][0]) return curve[0][1];
  const last = curve[curve.length - 1];
  if (hcp >= last[0]) return last[1];
  for (let i = 0; i < curve.length - 1; i++) {
    if (hcp <= curve[i + 1][0]) {
      const t = (hcp - curve[i][0]) / (curve[i + 1][0] - curve[i][0]);
      return curve[i][1] + t * (curve[i + 1][1] - curve[i][1]);
    }
  }
  return last[1];
}

// Zwaktepunt-analyse: welke onderdelen kosten de meeste slagen?
// Doelwaarden zijn gebaseerd op research-data per handicapniveau (niet-lineaire curves).
export function computeWeakspots(stats) {
  const items = [];
  const p = stats.play;
  const hcp = stats.currentHcp ?? 18;

  const girTarget = Math.round(_interp(hcp, _GIR_C));
  const fwTarget  = Math.round(_interp(hcp, _FW_C));
  const tpTarget  = Math.round(_interp(hcp, _TP_C) * 10) / 10;
  const penTarget = Math.round(_interp(hcp, _PEN_C) * 10) / 10;
  const dbTarget  = Math.round(_interp(hcp, _DB_C));

  if (p.girPct != null)
    items.push({ area: "GIR", value: `${p.girPct}%`, bench: `doel: ${girTarget}%+`, score: Math.max(0, girTarget - p.girPct) });
  if (p.fairwayPct != null)
    items.push({ area: "Fairways", value: `${p.fairwayPct}%`, bench: `doel: ${fwTarget}%+`, score: Math.max(0, fwTarget - p.fairwayPct) });
  if (p.threePutts != null)
    items.push({ area: "3-putts", value: `${p.threePutts.toFixed(1)}/18h`, bench: `doel: <${tpTarget}`, score: Math.max(0, (p.threePutts - tpTarget) * 20) });
  if (p.penalties != null)
    items.push({ area: "Penalties", value: `${p.penalties.toFixed(1)}/18h`, bench: `doel: <${penTarget}`, score: Math.max(0, (p.penalties - penTarget) * 20) });
  if (p.doubleBogeyRate != null)
    items.push({ area: "Double bogeys", value: `${p.doubleBogeyRate}%`, bench: `doel: <${dbTarget}%`, score: Math.max(0, p.doubleBogeyRate - dbTarget) });

  items.sort((a, b) => b.score - a.score);
  return items;
}

// ---------------------------------------------------------------------------
// Niveau-lookup op basis van handicap
// ---------------------------------------------------------------------------
const LEVELS = [
  { level: 10, name: "Scratch",             min: -99, max: 0   },
  { level:  9, name: "Expert",              min:   1, max: 4   },
  { level:  8, name: "Enkeling",            min:   5, max: 8   },
  { level:  7, name: "Gevorderd Speler",    min:   9, max: 12  },
  { level:  6, name: "Wedstrijdspeler",     min:  13, max: 17  },
  { level:  5, name: "Clubspeler",          min:  18, max: 22  },
  { level:  4, name: "Gevorderd Recreant",  min:  23, max: 28  },
  { level:  3, name: "Recreant",            min:  29, max: 36  },
  { level:  2, name: "Leerling",            min:  37, max: 45  },
  { level:  1, name: "Starter",             min:  46, max: 999 },
];

export function hcpLevel(hcp) {
  if (hcp == null) return null;
  return LEVELS.find((l) => hcp <= l.max) ?? LEVELS[LEVELS.length - 1];
}

// ---------------------------------------------------------------------------
// Coach-data: structuur voor de AI-coach Edge Function (K6/K8/K9)
// ---------------------------------------------------------------------------

function statTrend(qualifying, extractor) {
  const vals = qualifying.map(extractor).filter((v) => v !== null);
  if (vals.length < 4) return { recent: avg(vals) ?? null, prev: null, trend: null };
  const half = Math.floor(vals.length / 2);
  const prevAvg = avg(vals.slice(0, half));
  const recentAvg = avg(vals.slice(-half));
  return {
    recent: round1(recentAvg),
    prev:   round1(prevAvg),
    trend:  round1(recentAvg - prevAvg),  // negatief = verbetering voor putts/DB/etc.
  };
}

export function computeCoachData(rounds, userGoal = {}) {
  const qualifying = rounds.filter((r) => !isNonQualifying(r));
  const n = qualifying.length;

  const currentHcp = (() => {
    for (let i = n - 1; i >= 0; i--) {
      if (num(qualifying[i].hcp) !== null) return num(qualifying[i].hcp);
    }
    return null;
  })();

  const currentLevel = hcpLevel(currentHcp);
  const targetLevel  = userGoal.target_hcp != null ? hcpLevel(num(userGoal.target_hcp)) : null;

  // Per-stat trends (laatste helft vs vorige helft van kwalificerende rondes)
  const trends = {
    gir:        statTrend(qualifying, (r) => girCount(r) !== null ? Math.round((girCount(r) / (r.holes || 18)) * 100) : null),
    fairway:    statTrend(qualifying, (r) => { const fw = fairwayStats(r); return fw ? Math.round((fw.hit / fw.total) * 100) : null; }),
    threePutts: statTrend(qualifying, (r) => { const v = threePutts(r); return v !== null ? v * (r.holes === 9 ? 2 : 1) : null; }),
    penalties:  statTrend(qualifying, (r) => { const hd = holesData(r); const vals = hd.map((h) => num(h.penalties)).filter((v) => v !== null); const tot = vals.length ? vals.reduce((a,b)=>a+b,0) : num(r.penalties); return tot !== null ? tot * (r.holes === 9 ? 2 : 1) : null; }),
    doubleBogey:statTrend(qualifying, (r) => { const db = doubleBogeys(r); return db !== null ? Math.round((db / (r.holes || 18)) * 100) : null; }),
    sd:         statTrend(qualifying, (r) => num(r.sd)),
  };

  // Benchmarks op huidig niveau
  const hcp = currentHcp ?? 18;
  const benchmarks = {
    gir:        Math.round(_interp(hcp, _GIR_C)),
    fairway:    Math.round(_interp(hcp, _FW_C)),
    threePutts: Math.round(_interp(hcp, _TP_C) * 10) / 10,
    penalties:  Math.round(_interp(hcp, _PEN_C) * 10) / 10,
    doubleBogey:Math.round(_interp(hcp, _DB_C)),
  };

  // Positieve gap = speler zit ONDER de benchmark (verbetering nodig).
  // Negatieve of nul gap = benchmark al gehaald, geen advies nodig.
  // Richting is hier ondubbelzinnig bepaald zodat de AI dit niet zelf hoeft af te leiden.
  const t = trends;
  const b = benchmarks;
  const gaps = {
    gir:         t.gir.recent        !== null ? b.gir         - t.gir.recent        : null, // hoger=beter
    fairway:     t.fairway.recent    !== null ? b.fairway     - t.fairway.recent    : null, // hoger=beter
    threePutts:  t.threePutts.recent !== null ? t.threePutts.recent - b.threePutts  : null, // lager=beter
    penalties:   t.penalties.recent  !== null ? t.penalties.recent  - b.penalties   : null, // lager=beter
    doubleBogey: t.doubleBogey.recent!== null ? t.doubleBogey.recent- b.doubleBogey : null, // lager=beter
  };

  return {
    qualifying: n,
    hasHoleData: qualifying.filter((r) => holesData(r).length > 0).length,
    currentHcp,
    currentLevel,
    targetHcp:  userGoal.target_hcp != null ? num(userGoal.target_hcp) : null,
    targetDate:  userGoal.target_date || null,
    targetLevel,
    trends,
    benchmarks,
    gaps,
  };
}

// Voortschrijdend gemiddelde van het dagresultaat (SD) over een venster van `window` rondes.
export function rollingTrend(rounds, window = 10) {
  const points = [];
  const sds = [];
  for (const r of rounds) {
    const sd = num(r.sd);
    sds.push(sd);
    const slice = sds.slice(Math.max(0, sds.length - window)).filter((v) => v !== null);
    points.push({
      date: r.date,
      avg: slice.length ? round1(avg(slice)) : null,
    });
  }
  return points;
}
