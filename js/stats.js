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
