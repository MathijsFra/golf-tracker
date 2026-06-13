import {
  initDb, getMode, getRounds, addRound, updateRound, deleteRound, softDeleteRound,
  processImage, saveScreenshot, resolveScreenshot, parseScreenshots,
  getUser, signIn, signUp, signOut, onAuthChange, triggerWorkflow,
  loadUserSettings, saveGolfnlCredentials, saveGarminCredentials,
  triggerGarminAuth, getGarminAuthStatus, submitGarminOtp,
  resetGarminAuthStatus, clearGarminCredentials, clearGolfnlCredentials,
  getClubBag, getToptracerStatus, saveToptracerCredentials, clearToptracerCredentials,
  saveRoundInsights, patchRoundStats, getLoopsForRound, updateRoundLoop, saveGoal,
  callCoachAdvice,
} from "./db.js?v=33";
import { computeStats, computeWeakspots, computeCoachData, hcpLevel } from "./stats.js?v=16";
import { renderHcpChart, renderStbChart, renderTrendChart } from "./charts.js?v=12";

const MONTHS = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

let rounds = [];      // geannoteerde rondes (oplopend op datum)
let stats = null;
let userGoal = {};    // { target_hcp, target_date } uit user_settings
let editingId = null;
let chartsBuilt = false;
let pendingShots = []; // [{ processed, url }] — screenshots voor de huidige form

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function parseNum(v, { decimal = false } = {}) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(",", ".");
  if (s === "") return null;
  const n = decimal ? parseFloat(s) : parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}
function fmtDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${parseInt(d, 10)} ${MONTHS[parseInt(m, 10) - 1]} ${y}`;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- data flow ----------
function persistInsights(allRounds) {
  for (const r of allRounds) {
    if (r.insights !== null && r.insights !== undefined) continue;
    const insights = computeInsights(r, allRounds);
    if (insights.length) saveRoundInsights(r.id, insights);
  }
}

async function refresh() {
  rounds = await getRounds();
  stats = computeStats(rounds);
  rounds = stats.rounds;
  renderDashboard();
  renderLevelBadge();
  renderRoundList();
  persistInsights(rounds);
  if (isActive("chart")) buildCharts();
  else chartsBuilt = false;
}

// ---------- dashboard ----------
function renderDashboard() {
  $("#heroHcp").textContent = stats.currentHcp != null ? stats.currentHcp.toFixed(1) : "–";
  const prog = stats.progress;
  $("#heroProgress").innerHTML =
    prog != null && prog !== 0
      ? (prog > 0
          ? `<span class="up">▼ ${prog.toFixed(1)}</span> verbeterd sinds ${stats.startHcp.toFixed(1)}`
          : `▲ ${Math.abs(prog).toFixed(1)} sinds ${stats.startHcp.toFixed(1)}`)
      : `${stats.count} rondes geregistreerd`;

  const cards = [];
  if (stats.best) {
    cards.push(card("Beste ronde", `${stats.best.stb} STB`,
      `${esc(stats.best.course)} · ${stats.best.holes}h · ${fmtDate(stats.best.date)}`));
  }
  if (stats.lowestSd != null) cards.push(card("Laagste dagresultaat", stats.lowestSd.toFixed(1), "beste SD"));
  if (stats.avgScore20) cards.push(card("Gem. score", stats.avgScore20.value.toFixed(1), `laatste ${stats.avgScore20.count} → 18h`));
  if (stats.avgStb18 != null) cards.push(card("Gem. STB (18h)", stats.avgStb18.toFixed(1), `${stats.countStb18} rondes`));
  if (stats.avgStb9 != null) cards.push(card("Gem. STB (9h)", stats.avgStb9.toFixed(1), `${stats.countStb9} rondes`));
  cards.push(card("Totale vooruitgang",
    prog != null ? `${prog > 0 ? "−" : "+"}${Math.abs(prog).toFixed(1)}` : "–", "handicap punten"));
  cards.push(card("Aantal rondes", String(stats.count), `${stats.exsRounds.length} × EXS`));
  $("#statGrid").innerHTML = cards.join("");

  // Spel-statistieken
  const p = stats.play;
  const pc = [];
  if (p.girPct != null) pc.push(card("GIR", `${p.girPct}%`, "greens in regulation"));
  if (p.fairwayPct != null) pc.push(card("Fairways", `${p.fairwayPct}%`, "geraakt"));
  if (p.threePutts != null) pc.push(card("3-putts", p.threePutts.toFixed(1), "per 18 holes"));
  if (p.penalties != null) pc.push(card("Penalties", p.penalties.toFixed(1), "per 18 holes"));
  if (p.doubleBogeyRate != null) pc.push(card("Double bogey", `${p.doubleBogeyRate}%`, "van de holes"));
  $("#playGrid").innerHTML = pc.length ? pc.join("")
    : emptyNote("Nog geen detaildata. Upload een scorecard-screenshot of vul GIR/fairways in.");
  renderWeakspots(computeWeakspots(stats));

  // Par scoring
  const pa = stats.par;
  const ac = [];
  if (pa.par3 != null) ac.push(card("Par 3", pa.par3.toFixed(2), "gem. slagen"));
  if (pa.par4 != null) ac.push(card("Par 4", pa.par4.toFixed(2), "gem. slagen"));
  if (pa.par5 != null) ac.push(card("Par 5", pa.par5.toFixed(2), "gem. slagen"));
  $("#parGrid").innerHTML = ac.length ? ac.join("")
    : emptyNote("Par-scoring verschijnt zodra er per-hole data is (via een scorecard-screenshot).");

  // Garmin
  const g = stats.garmin;
  if (g.any) {
    const gc = [];
    if (g.avgPutts != null) gc.push(card("Gem. putts", g.avgPutts.toFixed(1), "per 18 holes"));
    if (g.saveRate != null) gc.push(card("Bunker saves", `${g.saveRate}%`, `${g.totalSaves}/${g.totalBunkers}`));
    else if (g.totalBunkers > 0) gc.push(card("Bunkers", String(g.totalBunkers), "totaal"));
    $("#garminGrid").innerHTML = gc.join("") || emptyNote("Nog geen Garmin-data.");
  } else {
    $("#garminGrid").innerHTML = emptyNote("Nog geen Garmin-data (putts, bunkers).");
  }

  // EXS
  if (stats.exsRounds.length) {
    $("#exsList").innerHTML = stats.exsRounds.slice().reverse().map((r) => `
      <div class="exs-item">
        <div>
          <div class="ex-main">${esc(r.course)} · ${r.holes}h</div>
          <div class="ex-sub">${fmtDate(r.date)} · SD ${Number(r.sd).toFixed(1)} → hcp ${Number(r.hcp).toFixed(1)}</div>
        </div>
        <div class="ex-drop">−${r._exsDiff.toFixed(1)}</div>
      </div>`).join("");
  } else {
    $("#exsList").innerHTML = emptyNote("Nog geen exceptionele scores (dagresultaat ≥ 7.0 onder je index).");
  }

  $("#recentList").innerHTML = rounds.slice(-3).reverse().map((r) => roundCard(r, false)).join("")
    || emptyNote("Nog geen rondes.");
  bindRoundCards($("#recentList"));
}

function card(label, value, meta) {
  return `<div class="stat-card">
    <div class="label">${esc(label)}</div>
    <div class="value">${esc(value)}</div>
    ${meta ? `<div class="meta">${esc(meta)}</div>` : ""}
  </div>`;
}
function emptyNote(t) { return `<p class="empty-note">${esc(t)}</p>`; }

function renderWeakspots(weakspots) {
  const el = $("#weakGrid");
  if (!el) return;
  const shown = weakspots.slice(0, 3);
  if (!shown.length) {
    el.innerHTML = emptyNote("Nog te weinig spel-data voor een analyse. Vul GIR, fairways en putts in via de scorekaarten.");
    return;
  }
  el.innerHTML = `<div class="weak-list">${shown.map((w) => {
    const level = w.score > 15 ? "high" : w.score > 5 ? "mid" : "low";
    return `<div class="weak-card ${level}">
      <div class="weak-area">${esc(w.area)}</div>
      <div class="weak-val">${esc(w.value)}</div>
      <div class="weak-bench">${esc(w.bench)}</div>
    </div>`;
  }).join("")}</div>`;
}

// ---------- club bag ----------
const CLUB_GROUPS = [
  { label: "Woods",   types: ["Driver","ThreeWood","FiveWood","SevenWood","NineWood"] },
  { label: "Hybrids", types: ["OneHybrid","TwoHybrid","ThreeHybrid","FourHybrid","FiveHybrid","Hybrid"] },
  { label: "Irons",   types: ["OneIron","TwoIron","ThreeIron","FourIron","FiveIron","SixIron","SevenIron","EightIron","NineIron"] },
  { label: "Wedges",  types: ["PitchingWedge","GapWedge","SandWedge","LobWedge"] },
  { label: "Putter",  types: ["Putter"] },
];
const CLUB_ORDER = CLUB_GROUPS.flatMap((g) => g.types);

const BAG_METRIC_FIELD = { median: "median_carry_m", avg: "avg_carry_m", max: "max_carry_m" };
const BAG_METRIC_LABEL = { median: "mediaan", avg: "gemiddeld", max: "max" };

let bagPeriod = "all";
let bagMetric = "median";

function initBagToggles() {
  $("#bagPeriodToggle")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-period]");
    if (!btn) return;
    bagPeriod = btn.dataset.period;
    $("#bagPeriodToggle").querySelectorAll(".toggle-btn").forEach((b) => b.classList.toggle("active", b === btn));
    renderBagView();
  });
  $("#bagMetricToggle")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-metric]");
    if (!btn) return;
    bagMetric = btn.dataset.metric;
    $("#bagMetricToggle").querySelectorAll(".toggle-btn").forEach((b) => b.classList.toggle("active", b === btn));
    renderBagGrid();
  });
}

let _bagClubs = [];

async function renderBagView() {
  const emptyEl = $("#bagEmpty");
  const grid    = $("#bagClubGrid");
  const sub     = $("#bagSub");
  if (!grid) return;

  grid.innerHTML = `<div class="bag-loading">Laden…</div>`;
  try {
    _bagClubs = await getClubBag(bagPeriod);
    if (!_bagClubs.length) {
      grid.innerHTML = "";
      if (emptyEl) emptyEl.hidden = false;
      if (sub) sub.textContent = "";
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    if (sub) sub.textContent = `${_bagClubs.length} clubs via Toptracer`;
    renderBagGrid();
  } catch {
    grid.innerHTML = "";
    if (emptyEl) emptyEl.hidden = false;
  }
}

function renderBagGrid() {
  const grid = $("#bagClubGrid");
  if (!grid || !_bagClubs.length) return;

  const field = BAG_METRIC_FIELD[bagMetric];
  const label = BAG_METRIC_LABEL[bagMetric];

  const sorted = _bagClubs.slice().sort((a, b) => {
    const ai = CLUB_ORDER.indexOf(a.club_type);
    const bi = CLUB_ORDER.indexOf(b.club_type);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  const knownTypes = new Set(CLUB_ORDER);
  const byType = Object.fromEntries(sorted.map((c) => [c.club_type, c]));
  let html = "";
  for (const group of CLUB_GROUPS) {
    const inGroup = group.types.map((t) => byType[t]).filter(Boolean);
    if (!inGroup.length) continue;
    html += `<div class="bag-group-label">${group.label}</div>`;
    html += `<div class="stat-grid bag-group-grid">`;
    html += inGroup.map((c) => {
      const val = c[field] != null ? `${Math.round(c[field])} m` : "—";
      const sub = c.shot_count ? `${label} · ${c.shot_count} slagen` : label;
      return card(esc(c.club_display_name || c.club_type), val, sub);
    }).join("");
    html += `</div>`;
  }
  const overig = sorted.filter((c) => !knownTypes.has(c.club_type));
  if (overig.length) {
    html += `<div class="bag-group-label">Overig</div>`;
    html += `<div class="stat-grid bag-group-grid">`;
    html += overig.map((c) => {
      const val = c[field] != null ? `${Math.round(c[field])} m` : "—";
      const sub = c.shot_count ? `${label} · ${c.shot_count} slagen` : label;
      return card(esc(c.club_display_name || c.club_type), val, sub);
    }).join("");
    html += `</div>`;
  }
  grid.innerHTML = html;
}

// ---------- per-ronde inzichten ----------
function computeInsights(round, allRounds) {
  const insights = [];
  const h = round.holes || 18;

  const peers = allRounds.filter(
    (r) => r.id !== round.id && r.holes === h && !r.non_qualifying && !r.deleted_at,
  );
  if (peers.length < 4) return insights;

  const avg = (arr, fn) => {
    const vals = arr.map(fn).filter((v) => v != null && !isNaN(v));
    return vals.length >= 3 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  // Putting
  if (round.putts != null) {
    const a = avg(peers, (r) => r.putts);
    if (a != null) {
      if (round.putts <= a - 2) insights.push({ sentiment: "positive", label: "Goed geput", detail: `${round.putts} putts, gem. ${Math.round(a)}` });
      else if (round.putts >= a + 3) insights.push({ sentiment: "negative", label: "Veel putts", detail: `${round.putts} putts, gem. ${Math.round(a)}` });
    }
  }

  // 3-putts
  if (round.three_putts != null) {
    const a = avg(peers, (r) => r.three_putts);
    if (a != null && round.three_putts >= a + 2)
      insights.push({ sentiment: "negative", label: "3-putts", detail: `${round.three_putts}×, gem. ${a.toFixed(1)}` });
  }

  // Fairways
  if (round.fairways_hit != null && round.fairways_total) {
    const rate = round.fairways_hit / round.fairways_total;
    const a = avg(peers.filter((r) => r.fairways_total), (r) => r.fairways_hit / r.fairways_total);
    if (a != null) {
      if (rate >= a + 0.15) insights.push({ sentiment: "positive", label: "Goede driving", detail: `${round.fairways_hit}/${round.fairways_total} fairways` });
      else if (rate <= a - 0.15) insights.push({ sentiment: "negative", label: "Weinig fairways", detail: `${round.fairways_hit}/${round.fairways_total}` });
    }
  }

  // GIR
  if (round.gir != null) {
    const a = avg(peers, (r) => r.gir);
    if (a != null) {
      if (round.gir >= a + 2) insights.push({ sentiment: "positive", label: "Scherpe ijzers", detail: `${round.gir} GIR, gem. ${a.toFixed(1)}` });
      else if (round.gir <= a - 2) insights.push({ sentiment: "negative", label: "GIR onder gem.", detail: `${round.gir} GIR, gem. ${a.toFixed(1)}` });
    }
  }

  // Penalties
  if (round.penalties != null) {
    const a = avg(peers, (r) => r.penalties);
    if (a != null && round.penalties >= a + 2)
      insights.push({ sentiment: "negative", label: "Veel penalties", detail: `${round.penalties}×, gem. ${a.toFixed(1)}` });
  }

  // Double bogeys
  if (round.double_bogeys != null) {
    const a = avg(peers, (r) => r.double_bogeys);
    if (a != null && round.double_bogeys >= a + 2)
      insights.push({ sentiment: "negative", label: "Dubbele bogeys", detail: `${round.double_bogeys}×, gem. ${a.toFixed(1)}` });
  }

  // Stableford vs break-even (36 op 18h, 18 op 9h)
  if (round.stb != null && !round.non_qualifying) {
    const expected = h === 9 ? 18 : 36;
    const diff = round.stb - expected;
    if (diff >= 4) insights.push({ sentiment: "positive", label: "Boven verwachting", detail: `${round.stb} stbl.` });
    else if (diff <= -6) insights.push({ sentiment: "negative", label: "Onder verwachting", detail: `${round.stb} stbl.` });
  }

  return insights;
}

function insightChips(insights) {
  if (!insights.length) return "";
  return `<div class="insight-chips">${
    insights.map((i) => `<span class="insight-chip ${i.sentiment}" title="${esc(i.detail)}">${esc(i.label)}</span>`).join("")
  }</div>`;
}

// ---------- round list ----------
function renderRoundList() {
  $("#roundCount").textContent = stats.count;
  const filter = $("#filterHoles").value;
  let list = rounds.slice().reverse();
  if (filter !== "all") list = list.filter((r) => String(r.holes) === filter);
  $("#roundList").innerHTML = list.map((r) => roundCard(r, true)).join("")
    || emptyNote("Geen rondes voor dit filter.");
  bindRoundCards($("#roundList"));

  const courses = [...new Set(rounds.map((r) => r.course).filter(Boolean))];
  $("#courseList").innerHTML = courses.map((c) => `<option value="${esc(c)}"></option>`).join("");
}

function roundCard(r, withActions) {
  const [, m, d] = r.date.split("-");
  const garmin = hasGarmin(r);
  const shots = Array.isArray(r.screenshots) ? r.screenshots : [];
  const hd = Array.isArray(r.holes_data) ? r.holes_data : [];
  const ct = r.course_tees;
  const hasCr = ct && (ct.course_rating != null || ct.slope_rating != null);
  const insights = computeInsights(r, rounds);
  const chips = insightChips(insights);
  const hasContent = hasCr || garmin || hd.length || shots.length || r.notes || chips || withActions || r.course;
  return `
  <div class="round-card" data-id="${r.id}">
    <div class="round-head">
      <div class="round-date"><span class="d">${parseInt(d, 10)}</span><span class="m">${MONTHS[parseInt(m, 10) - 1]}</span></div>
      <div class="round-info">
        <div class="round-course">${esc(r.course)} ${r._exs ? '<span class="badge-exs">EXS</span>' : ""}${r.non_qualifying ? '<span class="badge-nq">NQ</span>' : ""}</div>
        <div class="round-tags">${r.holes}h · ${esc(r.tee || "—")} · SD ${r.sd != null ? Number(r.sd).toFixed(1) : "—"}${r.score != null ? ` · ${r.score} slagen` : ""}</div>
      </div>
      <div class="round-metrics">
        <span class="round-stb">${r.stb != null ? r.stb : "—"}</span>
        <span class="round-hcp">hcp ${r.hcp != null ? Number(r.hcp).toFixed(1) : "—"}</span>
      </div>
      <span class="chev">›</span>
    </div>
    <div class="round-detail">
      ${chips}
      ${hasCr ? `<div class="round-cr-row">
        <span class="round-cr-item"><span class="cr-label">CR</span> ${ct.course_rating != null ? Number(ct.course_rating).toFixed(1) : "—"}</span>
        <span class="round-cr-item"><span class="cr-label">Slope</span> ${ct.slope_rating ?? "—"}</span>
        ${ct.par != null ? `<span class="round-cr-item"><span class="cr-label">Par</span> ${ct.par}</span>` : ""}
      </div>` : ""}
      ${r.course ? `<div class="loop-row">
        <span class="cr-label">Lus</span>
        <select class="loop-select"
          data-round-id="${r.id}"
          data-club="${esc(r.course)}"
          data-holes="${r.holes || 18}"
          data-tee="${esc(r.tee || '')}"
          data-current="${r.course_tee_id || ''}">
          ${ct?.courses?.loop_name
            ? `<option value="${r.course_tee_id}">${esc(ct.courses.loop_name)}</option>`
            : `<option value="${r.course_tee_id || ''}">Kies lus…</option>`}
        </select>
      </div>` : ""}
      ${garmin ? `<div class="garmin-grid">
        ${gcell(r.putts, "Putts")}
        ${gcell(r.penalties, "Penalties")}
        ${gcell(r.gir != null ? Math.round(r.gir / (r.holes || 18) * 100) + "%" : null, "GIR%")}
        ${gcell(r.fairways_hit != null && r.fairways_total ? Math.round(r.fairways_hit / r.fairways_total * 100) + "%" : null, "FW%")}
      </div>` : ""}
      ${hd.length ? (withActions ? holesEditGrid(r) : holesTable(hd)) : ""}
      ${shots.length ? `<div class="shot-thumbs">${shots.map((u) => `<a class="shot-link" data-shot="${esc(u)}" target="_blank" rel="noopener"><img alt="screenshot" loading="lazy"></a>`).join("")}</div>` : ""}
      ${r.notes ? `<div class="round-notes">${esc(r.notes)}</div>` : ""}
      ${!hasContent ? `<div class="empty-garmin">Geen extra details voor deze ronde.</div>` : ""}
      ${withActions ? `
        <div class="detail-actions">
          ${(!r.non_qualifying && !r.golfnl_scorecard_id) ? `<button class="btn btn-ghost btn-sm" data-edit="${r.id}">Bewerken</button>` : ""}
          <button class="btn btn-danger btn-sm" data-del="${r.id}" ${r.non_qualifying ? 'data-nq="true"' : ""}>Verwijderen</button>
        </div>` : ""}
    </div>
  </div>`;
}

function holesTable(hd) {
  const cell = (v) => (v === null || v === undefined || v === "" ? "—" : v);
  const parCell = (h) => h.par != null ? (h.extra_strokes ? `${h.par}<span class="extra-strokes">+${h.extra_strokes}</span>` : h.par) : "—";
  const fwSym = { hit: "✓", miss: "✗", left: "←", right: "→" };
  const rows = hd.map((h) => `<tr>
    <td>${cell(h.hole)}</td>
    <td>${parCell(h)}</td>
    <td class="${num(h.score) != null && num(h.par) != null && num(h.score) >= num(h.par) + 2 ? "db" : ""}">${cell(h.score)}</td>
    <td>${h.gir === true ? "✓" : h.gir === false ? "✗" : "—"}</td>
    <td>${h.fairway ? (fwSym[h.fairway] || h.fairway) : "—"}</td>
    <td class="${num(h.putts) >= 3 ? "db" : ""}">${cell(h.putts)}</td>
    <td>${cell(h.penalties)}</td>
  </tr>`).join("");
  return `<table class="holes-table">
    <thead><tr><th>Hole</th><th>Par</th><th>Score</th><th>GIR</th><th>FW</th><th>Putts</th><th>Pen</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
function num(v) { return v === null || v === undefined || v === "" ? null : Number(v); }

// ---------- inline per-hole editgrid (rondes-tab) ----------
function holesEditGrid(r) {
  const n = r.holes || 18;
  const hd = Array.isArray(r.holes_data) ? r.holes_data : [];
  const byHole = Object.fromEntries(hd.map((h) => [h.hole, h]));
  const opt = (val, cur, lbl) => `<option value="${val}"${val === cur ? " selected" : ""}>${lbl}</option>`;
  const girSel = (hole, v) => {
    const c = v === true ? "yes" : v === false ? "no" : "";
    return `<select data-hf="gir" data-hole="${hole}" class="he-sel">${opt("", c, "—")}${opt("yes", c, "✓")}${opt("no", c, "✗")}</select>`;
  };
  const fwSel = (hole, v) => {
    const c = v ?? "";
    return `<select data-hf="fairway" data-hole="${hole}" class="he-sel">${opt("", c, "—")}${opt("hit", c, "✓")}${opt("left", c, "←")}${opt("right", c, "→")}${opt("miss", c, "✗")}</select>`;
  };
  const numIn = (field, hole, val, mx) => `<input type="number" inputmode="numeric" min="0" max="${mx}" data-hf="${field}" data-hole="${hole}" class="he-num" value="${val ?? ""}">`;
  const rows = Array.from({ length: n }, (_, i) => {
    const hole = i + 1;
    const h = byHole[hole] || {};
    const parStr = h.par != null ? (h.extra_strokes ? `${h.par}<span class="extra-strokes">+${h.extra_strokes}</span>` : h.par) : "—";
    return `<tr><td class="hcol">${hole}</td><td>${parStr}</td><td>${h.score ?? "—"}</td><td>${girSel(hole, h.gir)}</td><td>${fwSel(hole, h.fairway)}</td><td>${numIn("putts", hole, h.putts, 9)}</td><td>${numIn("penalties", hole, h.penalties, 9)}</td></tr>`;
  }).join("");
  return `<div class="holes-edit-wrap">
    <table class="holes-table">
      <thead><tr><th>Hole</th><th>Par</th><th>Score</th><th>GIR</th><th>FW</th><th>Putts</th><th>Pen</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <button class="btn btn-primary btn-sm holes-save-btn" data-holessave="${r.id}">Opslaan</button>
  </div>`;
}

// ---------- per-hole invoerraster ----------
function buildHolesGrid(holesData = []) {
  const n = parseInt($("#f_holes").value, 10) || 18;
  const byHole = {};
  (holesData || []).forEach((h) => { if (h && h.hole != null) byHole[h.hole] = h; });

  const opt = (val, cur, label) => `<option value="${val}"${val === cur ? " selected" : ""}>${label}</option>`;
  const fwSel = (v) => `<select data-h-field="fairway">
    ${opt("", v == null ? "" : v, "—")}${opt("hit", v ?? "", "✓")}${opt("left", v ?? "", "←")}${opt("right", v ?? "", "→")}${opt("miss", v ?? "", "✗")}</select>`;
  const girCur = (v) => (v === true ? "yes" : v === false ? "no" : "");
  const girSel = (v) => { const c = girCur(v); return `<select data-h-field="gir">${opt("", c, "—")}${opt("yes", c, "✓")}${opt("no", c, "✗")}</select>`; };
  const numIn = (field, v) => `<input type="number" inputmode="numeric" data-h-field="${field}" value="${v == null ? "" : v}">`;

  let rows = "";
  for (let i = 1; i <= n; i++) {
    const h = byHole[i] || {};
    rows += `<tr data-hole="${i}">
      <td class="hcol">${i}</td>
      <td>${numIn("par", h.par)}</td>
      <td>${numIn("score", h.score)}</td>
      <td>${fwSel(h.fairway)}</td>
      <td>${girSel(h.gir)}</td>
      <td>${numIn("putts", h.putts)}</td>
      <td>${numIn("penalties", h.penalties)}</td>
    </tr>`;
  }
  $("#holesGrid").innerHTML =
    `<thead><tr><th>H</th><th>Par</th><th>Score</th><th>FW</th><th>GIR</th><th>Putts</th><th>Pen</th></tr></thead><tbody>${rows}</tbody>`;
}

function collectHolesGrid() {
  const out = [];
  $("#holesGrid").querySelectorAll("tbody tr").forEach((tr) => {
    const get = (f) => tr.querySelector(`[data-h-field="${f}"]`);
    const par = parseNum(get("par").value);
    const score = parseNum(get("score").value);
    const putts = parseNum(get("putts").value);
    const penalties = parseNum(get("penalties").value);
    const fairway = get("fairway").value || null;
    const girRaw = get("gir").value;
    const gir = girRaw === "yes" ? true : girRaw === "no" ? false : null;
    if (par == null && score == null && putts == null && penalties == null && fairway == null && gir == null) return;
    out.push({ hole: Number(tr.dataset.hole), par, score, fairway, gir, putts, penalties });
  });
  return out;
}

function gcell(v, label) {
  return `<div class="g"><div class="gv">${v != null ? v : "—"}</div><div class="gl">${label}</div></div>`;
}
function hasGarmin(r) {
  if ([r.putts, r.penalties, r.gir, r.fairways_hit].some((v) => v != null)) return true;
  const hd = Array.isArray(r.holes_data) ? r.holes_data : [];
  return hd.some((h) => h.putts != null || h.penalties != null || h.fairway != null || h.gir != null);
}

async function loadLoopSelect(sel) {
  sel.dataset.loaded = "1";
  const clubName = sel.dataset.club;
  const teeColor = sel.dataset.tee;
  const holes    = parseInt(sel.dataset.holes, 10) || 18;
  const currentId = sel.dataset.current || "";
  const roundId  = sel.dataset.roundId;

  if (!clubName || !teeColor) return;

  try {
    const loops = await getLoopsForRound(clubName, teeColor, holes);
    if (!loops.length) return; // Keep whatever is shown

    // Detect if the same loop_name appears in multiple genders
    const countByLoop = {};
    for (const t of loops) countByLoop[t.loop_name] = (countByLoop[t.loop_name] || 0) + 1;
    const showGender = (ln) => countByLoop[ln] > 1;
    const genderLabel = (t) => showGender(t.loop_name) ? ` (${t.tee_gender === "male" ? "H" : "D"})` : "";

    const opts = loops.map((t) =>
      `<option value="${t.id}"${t.id === currentId ? " selected" : ""}>${esc(t.loop_name)}${genderLabel(t)}</option>`
    ).join("");

    // Prepend a placeholder if nothing matches the current tee
    const hasMatch = loops.some((t) => t.id === currentId);
    sel.innerHTML = (hasMatch ? "" : `<option value="${currentId}">${sel.options[0]?.text || "—"}</option>`) + opts;

    sel.addEventListener("change", async () => {
      const newId = sel.value;
      if (!newId || newId === sel.dataset.current) return;
      try {
        await updateRoundLoop(roundId, newId);
        sel.dataset.current = newId;
        const r = rounds.find((x) => x.id === roundId);
        if (r) r.course_tee_id = newId;
        await refresh();
      } catch {
        alert("Opslaan mislukt.");
        sel.value = sel.dataset.current;
      }
    });
  } catch {
    // Silently leave the placeholder as-is
  }
}

function bindRoundCards(scope) {
  scope.querySelectorAll(".round-head").forEach((head) => {
    head.addEventListener("click", () => {
      const card = head.closest(".round-card");
      const wasOpen = card.classList.contains("open");
      card.classList.toggle("open");
      if (!wasOpen) {
        const sel = card.querySelector(".loop-select:not([data-loaded])");
        if (sel) loadLoopSelect(sel);
      }
    });
  });
  scope.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); startEdit(b.dataset.edit); }));
  scope.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (confirm("Deze ronde verwijderen?")) {
        if (b.dataset.nq) await softDeleteRound(b.dataset.del);
        else await deleteRound(b.dataset.del);
        await refresh();
      }
    }));
  scope.querySelectorAll("[data-holessave]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = b.dataset.holessave;
      const card = b.closest(".round-card");
      const round = rounds.find((r) => r.id === id);
      if (!round) return;

      const n = round.holes || 18;
      const existing = Array.isArray(round.holes_data) ? round.holes_data : [];
      const byHole = Object.fromEntries(existing.map((h) => [h.hole, h]));

      let girCount = 0, fwHit = 0, fwTotal = 0, puttsSum = 0, penSum = 0;
      const holesData = [];

      for (let hole = 1; hole <= n; hole++) {
        const prev = byHole[hole] || { hole };
        const getHf = (field) => card.querySelector(`[data-hf="${field}"][data-hole="${hole}"]`);
        const gir = (() => { const v = getHf("gir")?.value; return v === "yes" ? true : v === "no" ? false : null; })();
        const fairway = getHf("fairway")?.value || null;
        const putts = num(getHf("putts")?.value);
        const penalties = num(getHf("penalties")?.value);

        holesData.push({ ...prev, hole, gir, fairway, putts, penalties });

        if (gir === true) girCount++;
        if (fairway != null) { fwTotal++; if (fairway === "hit") fwHit++; }
        if (putts != null) puttsSum += putts;
        if (penalties != null) penSum += penalties;
      }

      const patch = {
        holes_data:     holesData,
        gir:            girCount   || null,
        fairways_hit:   fwHit      || null,
        fairways_total: fwTotal    || null,
        putts:          puttsSum   || null,
        penalties:      penSum     || null,
      };

      const orig = b.textContent;
      b.textContent = "…";
      b.disabled = true;
      try {
        await patchRoundStats(id, patch);
        const idx = rounds.findIndex((r) => r.id === id);
        if (idx !== -1) Object.assign(rounds[idx], patch);
        b.textContent = "Opgeslagen ✓";
        setTimeout(() => { b.textContent = orig; b.disabled = false; }, 1500);
      } catch {
        b.textContent = "Fout!";
        b.disabled = false;
      }
    }));
  hydrateShots(scope);
}

// Zet de juiste (signed) URL op screenshot-thumbnails.
async function hydrateShots(scope) {
  for (const a of scope.querySelectorAll(".shot-link[data-shot]")) {
    try {
      const url = await resolveScreenshot(a.dataset.shot);
      if (!url) continue;
      a.href = url;
      const img = a.querySelector("img");
      if (img) img.src = url;
    } catch (err) { console.warn("screenshot laden mislukt", err); }
  }
}

// ---------- niveau-badge ----------
function renderLevelBadge() {
  const el = $("#levelBadge");
  if (!el || !stats) return;
  const current = hcpLevel(stats.currentHcp);
  if (!current) { el.hidden = true; return; }

  const target = userGoal.target_hcp != null ? hcpLevel(Number(userGoal.target_hcp)) : null;
  const sameLevel = target && target.level === current.level;

  let html = `<span class="level-current">Niveau ${current.level} — ${current.name}</span>`;
  if (target && !sameLevel) {
    const arrow = target.level > current.level ? "↑" : "↓";
    const dateStr = userGoal.target_date
      ? ` voor ${new Date(userGoal.target_date).toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" })}`
      : "";
    html += `<span class="level-target">${arrow} doel: ${target.name} (HCP ${userGoal.target_hcp})${dateStr}</span>`;
  } else if (target && sameLevel) {
    html += `<span class="level-target">✓ Al op doelniveau</span>`;
  }

  el.innerHTML = html;
  el.hidden = false;
}

function applyUserGoal(s) {
  userGoal = { target_hcp: s.target_hcp ?? null, target_date: s.target_date ?? null };
  if ($("#goalHcp") && s.target_hcp != null) $("#goalHcp").value = s.target_hcp;
  if ($("#goalDate") && s.target_date) $("#goalDate").value = s.target_date;
  renderLevelBadge();
}

// ---------- charts ----------
function buildCharts() {
  renderHcpChart(rounds);
  renderStbChart(rounds);
  renderTrendChart(stats.trend);
  chartsBuilt = true;
}

// ---------- screenshots ----------
async function renderShotPreview() {
  const wrap = $("#shotPreview");
  const srcs = await Promise.all(pendingShots.map((s) =>
    s.processed ? Promise.resolve(s.processed.dataUrl) : resolveScreenshot(s.url)));
  wrap.innerHTML = pendingShots.map((s, i) => `
    <div class="shot-item">
      <img src="${esc(srcs[i] || "")}" alt="screenshot">
      <button type="button" class="shot-del" data-shot="${i}" aria-label="verwijderen">×</button>
    </div>`).join("");
  wrap.querySelectorAll("[data-shot]").forEach((b) =>
    b.addEventListener("click", () => { pendingShots.splice(Number(b.dataset.shot), 1); renderShotPreview(); updateParseBtn(); }));
}

function updateParseBtn() {
  const hasNew = pendingShots.some((s) => s.processed);
  const btn = $("#parseBtn");
  btn.hidden = !(getMode() === "supabase" && hasNew);
}

async function onShotsSelected(e) {
  const files = Array.from(e.target.files || []);
  $("#parseMsg").textContent = "";
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    try {
      const processed = await processImage(file);
      pendingShots.push({ processed, url: null });
    } catch (err) {
      console.error("Afbeelding verwerken mislukt", err);
    }
  }
  e.target.value = "";
  renderShotPreview();
  updateParseBtn();
  if (getMode() !== "supabase" && pendingShots.some((s) => s.processed)) {
    $("#parseMsg").textContent = "AI-inlezen vereist een gekoppelde Supabase. Screenshots worden lokaal als bijlage bewaard.";
    $("#parseMsg").className = "form-msg";
  }
}

async function onParse() {
  const toParse = pendingShots.filter((s) => s.processed).map((s) => s.processed);
  if (!toParse.length) return;
  const msg = $("#parseMsg");
  const btn = $("#parseBtn");
  btn.disabled = true;
  msg.textContent = "AI leest je screenshots…";
  msg.className = "form-msg";
  try {
    const data = await parseScreenshots(toParse);
    applyParsedRound(data);
    msg.textContent = "Ingevuld ✓ — controleer en sla op.";
    msg.className = "form-msg ok";
  } catch (err) {
    console.error(err);
    msg.textContent = "Inlezen mislukt: " + (err.message || err);
    msg.className = "form-msg err";
  } finally {
    btn.disabled = false;
  }
}

function applyParsedRound(d) {
  const set = (id, v) => { if (v !== null && v !== undefined && v !== "") $(id).value = v; };
  set("#f_date", normDate(d.date));
  set("#f_course", d.course);
  if (d.holes) $("#f_holes").value = d.holes;
  set("#f_tee", d.tee);
  set("#f_stb", d.stb);
  set("#f_sd", d.sd);
  set("#f_hcp", d.hcp);
  set("#f_score", d.score);
  set("#f_course_handicap", d.course_handicap);
  set("#f_putts", d.putts);
  set("#f_penalties", d.penalties);
  set("#f_gir", d.gir);
  set("#f_fairways_hit", d.fairways_hit);
  set("#f_fairways_total", d.fairways_total);
  set("#f_three_putts", d.three_putts);
  set("#f_double_bogeys", d.double_bogeys);
  if (Array.isArray(d.holes_data) && d.holes_data.length) {
    buildHolesGrid(d.holes_data);
    $("#holesDetails").open = true;
  }
}

function normDate(s) {
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? "" : dt.toISOString().slice(0, 10);
}

// ---------- form ----------
function fillForm(r) {
  $("#f_id").value = r?.id || "";
  $("#f_date").value = r?.date || new Date().toISOString().slice(0, 10);
  $("#f_course").value = r?.course || "";
  $("#f_holes").value = r?.holes || 18;
  $("#f_tee").value = r?.tee || "";
  $("#f_stb").value = r?.stb ?? "";
  $("#f_sd").value = r?.sd ?? "";
  $("#f_hcp").value = r?.hcp ?? "";
  $("#f_score").value = r?.score ?? "";
  $("#f_course_handicap").value = r?.course_handicap ?? "";
  $("#f_putts").value = r?.putts ?? "";
  $("#f_penalties").value = r?.penalties ?? "";
  $("#f_bunkers").value = r?.bunkers ?? "";
  $("#f_bunker_saves").value = r?.bunker_saves ?? "";
  $("#f_gir").value = r?.gir ?? "";
  $("#f_fairways_hit").value = r?.fairways_hit ?? "";
  $("#f_fairways_total").value = r?.fairways_total ?? "";
  $("#f_three_putts").value = r?.three_putts ?? "";
  $("#f_double_bogeys").value = r?.double_bogeys ?? "";
  $("#f_notes").value = r?.notes ?? "";
  buildHolesGrid(Array.isArray(r?.holes_data) ? r.holes_data : []);
  pendingShots = (Array.isArray(r?.screenshots) ? r.screenshots : []).map((u) => ({ processed: null, url: u }));
  renderShotPreview();
  updateParseBtn();
  $("#parseMsg").textContent = "";
}

function startEdit(id) {
  const r = rounds.find((x) => x.id === id);
  if (!r) return;
  editingId = id;
  fillForm(r);
  $("#formTitle").textContent = "Ronde bewerken";
  $("#saveBtn").textContent = "Wijzigingen opslaan";
  $("#cancelBtn").hidden = false;
  switchView("add");
}

function resetForm() {
  editingId = null;
  pendingShots = [];
  fillForm(null);
  $("#formTitle").textContent = "Ronde toevoegen";
  $("#saveBtn").textContent = "Opslaan";
  $("#cancelBtn").hidden = true;
  $("#formMsg").textContent = "";
  $("#formMsg").className = "form-msg";
}

function collectForm() {
  return {
    date: $("#f_date").value,
    course: $("#f_course").value.trim(),
    holes: parseInt($("#f_holes").value, 10),
    tee: $("#f_tee").value.trim() || null,
    stb: parseNum($("#f_stb").value),
    sd: parseNum($("#f_sd").value, { decimal: true }),
    hcp: parseNum($("#f_hcp").value, { decimal: true }),
    score: parseNum($("#f_score").value),
    course_handicap: parseNum($("#f_course_handicap").value),
    putts: parseNum($("#f_putts").value),
    penalties: parseNum($("#f_penalties").value),
    bunkers: parseNum($("#f_bunkers").value),
    bunker_saves: parseNum($("#f_bunker_saves").value),
    gir: parseNum($("#f_gir").value),
    fairways_hit: parseNum($("#f_fairways_hit").value),
    fairways_total: parseNum($("#f_fairways_total").value),
    three_putts: parseNum($("#f_three_putts").value),
    double_bogeys: parseNum($("#f_double_bogeys").value),
    holes_data: collectHolesGrid(),
    notes: $("#f_notes").value.trim() || null,
  };
}

async function onSubmit(e) {
  e.preventDefault();
  const data = collectForm();
  const msg = $("#formMsg");
  if (!data.date || !data.course) {
    msg.textContent = "Datum en baan zijn verplicht.";
    msg.className = "form-msg err";
    return;
  }
  $("#saveBtn").disabled = true;
  try {
    // Screenshots opslaan (uploaden voor nieuwe, bestaande URLs behouden).
    const urls = [];
    for (const s of pendingShots) {
      urls.push(s.url || await saveScreenshot(s.processed));
    }
    data.screenshots = urls;

    if (editingId) await updateRound(editingId, data);
    else await addRound(data);
    await refresh();
    resetForm();
    msg.textContent = "Opgeslagen ✓";
    msg.className = "form-msg ok";
    switchView("rounds");
    setTimeout(() => { msg.textContent = ""; }, 2500);
  } catch (err) {
    console.error(err);
    msg.textContent = "Opslaan mislukt: " + (err.message || err);
    msg.className = "form-msg err";
  } finally {
    $("#saveBtn").disabled = false;
  }
}

// ---------- navigation ----------
function isActive(view) { return $(`#view-${view}`).classList.contains("active"); }

function switchView(view) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  window.scrollTo({ top: 0 });
  if (view === "chart" && !chartsBuilt) buildCharts();
  if (view === "bag") renderBagView();
  if (view !== "add" && editingId) resetForm();
}

// ---------- dark mode ----------
const THEME_KEY = "golf_theme";
function applyTheme(dark) {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  const toggle = $("#darkModeToggle");
  if (toggle) toggle.checked = dark;
}
(function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved === "dark" || (!saved && prefersDark));
})();

// ---------- auth ----------
function showApp(show) {
  $("#main").style.display = show ? "" : "none";
  document.querySelector(".tabbar").style.display = show ? "" : "none";
  document.querySelector(".app-header").hidden = !show;
  $("#loginScreen").hidden = show;
}

async function onLogin(e) {
  e.preventDefault();
  const msg = $("#loginMsg");
  msg.textContent = "Inloggen…";
  msg.className = "form-msg";
  $("#loginBtn").disabled = true;
  try {
    await signIn($("#loginEmail").value.trim(), $("#loginPassword").value);
    // onAuthChange handelt de rest af (app tonen + data laden).
  } catch (err) {
    msg.textContent = "Inloggen mislukt: " + (err.message || err);
    msg.className = "form-msg err";
  } finally {
    $("#loginBtn").disabled = false;
  }
}

async function onSignUp(e) {
  e.preventDefault();
  const msg = $("#signupMsg");
  msg.textContent = "Account aanmaken…";
  msg.className = "form-msg";
  $("#signupBtn").disabled = true;
  try {
    const data = await signUp($("#signupEmail").value.trim(), $("#signupPassword").value);
    if (data?.user && !data?.session) {
      msg.textContent = "✓ Controleer je e-mail voor de bevestigingslink.";
      msg.className = "form-msg ok";
    }
    // Als session aanwezig is, handelt onAuthChange alles af.
  } catch (err) {
    msg.textContent = "Registreren mislukt: " + (err.message || err);
    msg.className = "form-msg err";
  } finally {
    $("#signupBtn").disabled = false;
  }
}

// ---------- sync ----------
async function onSync(workflowFile, btn, statusEl) {
  btn.disabled = true;
  statusEl.textContent = "Gestart…";
  statusEl.className = "sync-status";
  try {
    const user = await getUser();
    const inputs = user?.id ? { user_id: user.id } : null;
    await triggerWorkflow(workflowFile, inputs);
    statusEl.textContent = "✓ Sync gestart — klaar over ~1 minuut.";
    statusEl.className = "sync-status ok";
  } catch (err) {
    statusEl.textContent = "Mislukt: " + (err.message || err);
    statusEl.className = "sync-status err";
  } finally {
    btn.disabled = false;
    setTimeout(() => { statusEl.textContent = ""; }, 8000);
  }
}

// ---------- golf.nl koppeling ----------
function showGolfnlLinked(username) {
  const linked = !!username;
  const linkedState = $("#golfnlLinkedState");
  const unlinkedState = $("#golfnlUnlinkedState");
  if (!linkedState || !unlinkedState) return;
  linkedState.hidden = !linked;
  unlinkedState.hidden = linked;
  if (username) $("#golfnlLinkedUser").textContent = username;
  const summary = document.querySelector("#golfnlDetails summary");
  if (summary) summary.textContent = linked ? "GOLF.NL ✓ gekoppeld" : "GOLF.NL inloggegevens";
}

// ---------- toptracer koppelen ----------
function showToptracerLinked(username) {
  const linked = !!username;
  const linkedState = $("#toptracerLinkedState");
  const unlinkedState = $("#toptracerUnlinkedState");
  if (!linkedState || !unlinkedState) return;
  linkedState.hidden = !linked;
  unlinkedState.hidden = linked;
  if (username) $("#toptracerLinkedUser").textContent = username;
  const summary = document.querySelector("#toptracerDetails summary");
  if (summary) summary.textContent = linked ? "Toptracer ✓ gekoppeld" : "Toptracer koppelen";
}

// ---------- garmin koppelen ----------
function showGarminLinked(username) {
  const linked = !!username;
  const linkedState = $("#garminLinkedState");
  const unlinkedState = $("#garminUnlinkedState");
  if (!linkedState || !unlinkedState) return;
  linkedState.hidden = !linked;
  unlinkedState.hidden = linked;
  if (username) $("#garminLinkedUser").textContent = username;
  const summary = document.querySelector("#garminDetails summary");
  if (summary) summary.textContent = linked ? "Garmin Connect ✓ gekoppeld" : "Garmin Connect koppelen";
}

let garminPollTimer = null;

function stopGarminPoll() {
  if (garminPollTimer) { clearInterval(garminPollTimer); garminPollTimer = null; }
}

function updateGarminUI(status, error) {
  const msg = $("#garminMsg");
  const step1 = $("#garminStep1");
  const step2 = $("#garminStep2");
  if (!msg || !step1 || !step2) return;
  if (status === "otp_needed") {
    step1.hidden = true;
    step2.hidden = false;
    msg.textContent = "";
    msg.className = "sync-status";
  } else if (status === "completed") {
    stopGarminPoll();
    msg.textContent = "✓ Garmin gekoppeld!";
    msg.className = "sync-status ok";
    loadUserSettings().then((s) => {
      showGarminLinked(s.garmin_username || "–");
      if (s.golfnl_username) $("#golfnlUsername").value = s.golfnl_username;
    }).catch(() => showGarminLinked("–"));
    setTimeout(() => { msg.textContent = ""; }, 5000);
  } else if (status === "failed") {
    stopGarminPoll();
    step1.hidden = false;
    step2.hidden = true;
    msg.textContent = "Mislukt: " + (error || "onbekende fout");
    msg.className = "sync-status err";
  } else if (status === "pending") {
    step1.hidden = true;
    step2.hidden = true;
    msg.textContent = "⏳ Verbinden met Garmin (~30 sec)…";
    msg.className = "sync-status";
  }
}

function startGarminPoll() {
  stopGarminPoll();
  garminPollTimer = setInterval(async () => {
    try {
      const { status, error } = await getGarminAuthStatus();
      updateGarminUI(status, error);
      if (status === "completed" || status === "failed") stopGarminPoll();
    } catch { /* transient */ }
  }, 3000);
}

// ---------- coach ----------
const COACH_CACHE_KEY = "coach_advice_v1";

function saveCoachCache(advice) {
  try {
    localStorage.setItem(COACH_CACHE_KEY, JSON.stringify({
      advice,
      generatedAt: Date.now(),
      roundCount: rounds.length,
    }));
  } catch { /* quota full — ignore */ }
}

function loadCoachCache() {
  try {
    const raw = localStorage.getItem(COACH_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function isCoachStale(cached) {
  return rounds.length > (cached?.roundCount ?? 0);
}

function showCoachView() {
  const cached = loadCoachCache();
  if (!cached) return; // geen cache → intro blijft zichtbaar

  renderCoachResult(cached.advice);
  $("#coachIntro").hidden  = true;
  $("#coachLoading").hidden = true;
  $("#coachResult").hidden  = false;

  const staleBanner = $("#coachStaleBanner");
  if (isCoachStale(cached)) {
    const newRounds = rounds.length - cached.roundCount;
    staleBanner.querySelector(".stale-text").textContent =
      `Je hebt ${newRounds} nieuwe ronde${newRounds > 1 ? "s" : ""} gespeeld sinds dit advies.`;
    staleBanner.hidden = false;
  } else {
    staleBanner.hidden = true;
  }
}

async function runCoachAnalysis() {
  const intro   = $("#coachIntro");
  const loading = $("#coachLoading");
  const result  = $("#coachResult");
  const hint    = $("#coachModeHint");
  const stale   = $("#coachStaleBanner");

  if (getMode() !== "supabase") {
    hint.hidden = false;
    return;
  }

  intro.hidden   = true;
  result.hidden  = true;
  stale.hidden   = true;
  loading.hidden = false;

  try {
    const coachData = computeCoachData(rounds, userGoal);
    const advice    = await callCoachAdvice(coachData);
    saveCoachCache(advice);
    renderCoachResult(advice);
    loading.hidden = true;
    result.hidden  = false;
  } catch (err) {
    loading.hidden = true;
    // herstel vorige staat: toon cached als die er is, anders intro
    const cached = loadCoachCache();
    if (cached) {
      result.hidden = false;
      stale.hidden  = true;
    } else {
      intro.hidden = false;
    }
    hint.textContent = "Analyse mislukt: " + (err.message || err);
    hint.hidden = false;
    setTimeout(() => { hint.textContent = ""; hint.hidden = true; }, 6000);
  }
}

function renderCoachResult(advice) {
  const summaryCard = $("#coachSummaryCard");
  const adviezen    = $("#coachAdviezen");
  const goalCard    = $("#coachGoalCard");

  summaryCard.innerHTML = `<p class="coach-summary-text">${esc(advice.samenvatting ?? "")}</p>`;

  if (advice.minimalData) {
    adviezen.innerHTML = "";
    goalCard.hidden = true;
    return;
  }

  const trendLabel = { verbeterend: "↑ verbeterend", stabiel: "→ stabiel", verslechterend: "↓ verslechterend" };
  const trendClass = { verbeterend: "trend-up", stabiel: "trend-stable", verslechterend: "trend-down" };

  adviezen.innerHTML = (advice.adviezen ?? []).map((a) => `
    <div class="advies-card">
      <div class="advies-header">
        <span class="advies-prio">${a.prioriteit}</span>
        <span class="advies-gebied">${esc(a.gebied)}</span>
        <span class="trend-badge ${trendClass[a.trend] ?? "trend-stable"}">${trendLabel[a.trend] ?? esc(a.trend)}</span>
      </div>
      <div class="advies-vals">
        <span class="advies-val-label">Jij</span><span class="advies-val">${esc(a.jouw_waarde)}</span>
        <span class="advies-val-sep">→</span>
        <span class="advies-val-label">Doel</span><span class="advies-val doel">${esc(a.doel_waarde)}</span>
      </div>
      <p class="advies-text">${esc(a.advies)}</p>
    </div>
  `).join("");

  if (advice.doelVoortgang) {
    goalCard.innerHTML = `
      <div class="coach-goal-header">🎯 Voortgang naar doel</div>
      <p class="coach-goal-text">${esc(advice.doelVoortgang)}</p>
    `;
    goalCard.hidden = false;
  } else {
    goalCard.hidden = true;
  }
}

// ---------- init ----------
async function main() {
  const mode = await initDb();
  const badge = $("#dbBadge");
  if (mode === "supabase") { badge.textContent = "☁ Cloud"; badge.className = "db-badge cloud"; }
  else { badge.textContent = "● Lokaal"; badge.className = "db-badge local"; }

  $$(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));
  $("#roundForm").addEventListener("submit", onSubmit);
  $("#cancelBtn").addEventListener("click", () => { resetForm(); switchView("rounds"); });
  $("#filterHoles").addEventListener("change", renderRoundList);
  $("#bagGoSettings")?.addEventListener("click", () => switchView("settings"));
  $("#coachAnalyseBtn")?.addEventListener("click", runCoachAnalysis);
  $("#coachStaleRefreshBtn")?.addEventListener("click", runCoachAnalysis);
  $("#coachRefreshBtn")?.addEventListener("click", runCoachAnalysis);
  $$(".tab").forEach((t) => {
    if (t.dataset.view === "coach") {
      t.addEventListener("click", showCoachView);
    }
  });
  initBagToggles();
  $("#f_shots").addEventListener("change", onShotsSelected);
  $("#parseBtn").addEventListener("click", onParse);
  $("#f_holes").addEventListener("change", () => buildHolesGrid(collectHolesGrid()));
  $("#clearHolesBtn").addEventListener("click", () => buildHolesGrid([]));
  $("#loginForm").addEventListener("submit", onLogin);
  $("#signupForm")?.addEventListener("submit", onSignUp);
  $("#showSignupBtn")?.addEventListener("click", () => {
    $("#loginForm").hidden = true;
    $("#signupForm").hidden = false;
    $("#signupMsg").textContent = "";
  });
  $("#showLoginBtn")?.addEventListener("click", () => {
    $("#signupForm").hidden = true;
    $("#loginForm").hidden = false;
    $("#loginMsg").textContent = "";
  });
  $("#logoutBtn").addEventListener("click", () => signOut());

  const syncStatus = $("#syncStatus");
  $("#syncGolfnlBtn")?.addEventListener("click", () =>
    onSync("sync-golfnl.yml", $("#syncGolfnlBtn"), syncStatus));
  $("#syncGarminBtn")?.addEventListener("click", () =>
    onSync("sync-garmin.yml", $("#syncGarminBtn"), syncStatus));
  $("#syncToptracerBtn")?.addEventListener("click", () =>
    onSync("sync-toptracer.yml", $("#syncToptracerBtn"), syncStatus));

  $("#golfnlSaveBtn")?.addEventListener("click", async () => {
    const username = $("#golfnlUsername").value.trim();
    const password = $("#golfnlPassword").value;
    const msg = $("#golfnlMsg");
    if (!username || !password) {
      msg.textContent = "Vul e-mailadres en wachtwoord in.";
      msg.className = "sync-status err";
      return;
    }
    try {
      await saveGolfnlCredentials(username, password);
      msg.textContent = "✓ Opgeslagen.";
      msg.className = "sync-status ok";
      $("#golfnlPassword").value = "";
      $("#golfnlDetails").open = false;
    } catch (err) {
      msg.textContent = "Opslaan mislukt: " + (err.message || err);
      msg.className = "sync-status err";
    }
    setTimeout(() => { msg.textContent = ""; }, 4000);
  });

  $("#golfnlUnlinkBtn")?.addEventListener("click", async () => {
    if (!confirm("GOLF.NL ontkoppelen? De opgeslagen inloggegevens worden gewist.")) return;
    const msg = $("#golfnlMsg");
    try {
      await clearGolfnlCredentials();
      showGolfnlLinked(null);
      $("#golfnlUsername").value = "";
      $("#golfnlPassword").value = "";
      msg.textContent = "";
      $("#golfnlDetails").open = false;
    } catch (err) {
      msg.textContent = "Ontkoppelen mislukt: " + (err.message || err);
      msg.className = "sync-status err";
    }
  });

  $("#garminConnectBtn")?.addEventListener("click", async () => {
    const username = $("#garminUsername").value.trim();
    const password = $("#garminPassword").value;
    const msg = $("#garminMsg");
    if (!username || !password) {
      msg.textContent = "Vul e-mailadres en wachtwoord in.";
      msg.className = "sync-status err";
      return;
    }
    try {
      msg.textContent = "Opslaan…";
      msg.className = "sync-status";
      await saveGarminCredentials(username, password);
      await resetGarminAuthStatus();
      await triggerGarminAuth();
      $("#garminPassword").value = "";
      updateGarminUI("pending", null);
      startGarminPoll();
    } catch (err) {
      msg.textContent = "Fout: " + (err.message || err);
      msg.className = "sync-status err";
    }
  });

  $("#garminOtpBtn")?.addEventListener("click", async () => {
    const otp = $("#garminOtp").value.trim();
    const msg = $("#garminMsg");
    if (!otp) {
      msg.textContent = "Voer de verificatiecode in.";
      msg.className = "sync-status err";
      return;
    }
    try {
      msg.textContent = "Code versturen…";
      msg.className = "sync-status";
      await submitGarminOtp(otp);
      $("#garminOtp").value = "";
      msg.textContent = "⏳ Verwerken…";
    } catch (err) {
      msg.textContent = "Fout: " + (err.message || err);
      msg.className = "sync-status err";
    }
  });

  // Toptracer
  $("#toptracerSaveBtn")?.addEventListener("click", async () => {
    const email = $("#toptracerEmail")?.value?.trim() || "";
    const password = $("#toptracerPassword")?.value || "";
    const msg = $("#toptracerMsg");
    if (!email || !password) {
      if (msg) { msg.textContent = "Vul e-mailadres en wachtwoord in."; msg.className = "sync-status err"; }
      return;
    }
    if (msg) { msg.textContent = "Opslaan…"; msg.className = "sync-status"; }
    try {
      await saveToptracerCredentials(email, password);
      $("#toptracerPassword").value = "";
      showToptracerLinked(email);
      if (msg) { msg.textContent = "✓ Opgeslagen! Club-afstanden worden gesynchroniseerd bij de volgende dagelijkse sync."; msg.className = "sync-status ok"; }
      setTimeout(() => { if (msg) msg.textContent = ""; }, 6000);
      $("#toptracerDetails").open = false;
    } catch (err) {
      if (msg) { msg.textContent = "Opslaan mislukt: " + (err.message || err); msg.className = "sync-status err"; }
    }
  });

  $("#toptracerUnlinkBtn")?.addEventListener("click", async () => {
    if (!confirm("Toptracer ontkoppelen? De opgeslagen inloggegevens worden gewist.")) return;
    const msg = $("#toptracerMsg");
    try {
      await clearToptracerCredentials();
      showToptracerLinked(null);
      if (msg) msg.textContent = "";
      $("#toptracerDetails").open = false;
    } catch (err) {
      if (msg) { msg.textContent = "Ontkoppelen mislukt: " + (err.message || err); msg.className = "sync-status err"; }
    }
  });

  $("#garminUnlinkBtn")?.addEventListener("click", async () => {
    if (!confirm("Garmin Connect ontkoppelen? De gekoppelde gegevens worden gewist.")) return;
    const msg = $("#garminMsg");
    try {
      await clearGarminCredentials();
      showGarminLinked(null);
      stopGarminPoll();
      msg.textContent = "";
      $("#garminDetails").open = false;
    } catch (err) {
      msg.textContent = "Ontkoppelen mislukt: " + (err.message || err);
      msg.className = "sync-status err";
    }
  });

  $("#darkModeToggle")?.addEventListener("change", (e) => {
    applyTheme(e.target.checked);
    localStorage.setItem(THEME_KEY, e.target.checked ? "dark" : "light");
  });

  $("#settingsLogoutBtn")?.addEventListener("click", () => signOut());

  $("#saveGoalBtn")?.addEventListener("click", async () => {
    const hcp  = $("#goalHcp")?.value.trim();
    const date = $("#goalDate")?.value;
    const btn  = $("#saveGoalBtn");
    const status = $("#goalStatus");
    btn.disabled = true;
    try {
      await saveGoal(hcp !== "" ? hcp : null, date || null);
      userGoal = { target_hcp: hcp !== "" ? Number(hcp) : null, target_date: date || null };
      renderLevelBadge();
      status.textContent = "✓ Doel opgeslagen";
      status.className = "sync-status ok";
    } catch {
      status.textContent = "Opslaan mislukt.";
      status.className = "sync-status err";
    } finally {
      btn.disabled = false;
      setTimeout(() => { status.textContent = ""; }, 3000);
    }
  });

  resetForm();

  if (mode !== "supabase") {       // lokale modus: geen login
    showApp(true);
    await refresh();
    return;
  }

  // Cloud-modus: login vereist. Reageer op login/logout/sessieherstel.
  let loaded = false;

  function onUserLoggedIn(user) {
    $("#logoutBtn").hidden = false;
    const emailEl = $("#settingsEmail");
    if (emailEl) emailEl.textContent = user.email || "–";
    showApp(true);
    $("#loginMsg").textContent = "";
  }

  onAuthChange(async (user) => {
    if (user && !loaded) {
      loaded = true;
      onUserLoggedIn(user);
      await refresh();
      loadUserSettings().then((s) => {
        if (s.golfnl_sync_status === "completed" && s.golfnl_username) {
          showGolfnlLinked(s.golfnl_username);
        } else {
          if (s.golfnl_username) $("#golfnlUsername").value = s.golfnl_username;
          showGolfnlLinked(null);
        }
        if (s.garmin_auth_status === "completed" && s.garmin_username) {
          showGarminLinked(s.garmin_username);
        } else {
          if (s.garmin_username) $("#garminUsername").value = s.garmin_username;
          showGarminLinked(null);
        }
        if ((s.toptracer_auth_status === "completed" || s.toptracer_auth_status === "credentials_saved") && s.toptracer_username) {
          showToptracerLinked(s.toptracer_username);
        } else {
          showToptracerLinked(null);
        }
        applyUserGoal(s);
      });
      // Herstel lopende Garmin-koppeling na pagina-refresh.
      getGarminAuthStatus().then(({ status, error }) => {
        if (status === "pending" || status === "otp_needed") {
          updateGarminUI(status, error);
          startGarminPoll();
        }
      }).catch(() => {});
    } else if (!user) {
      loaded = false;
      stopGarminPoll();
      $("#logoutBtn").hidden = true;
      showApp(false);
    }
  });

  // Eerste check (bestaande sessie?).
  const user = await getUser();
  if (user) {
    loaded = true;
    onUserLoggedIn(user);
    await refresh();
    loadUserSettings().then((s) => {
      if (s.golfnl_username) $("#golfnlUsername").value = s.golfnl_username;
      applyUserGoal(s);
    });
    getGarminAuthStatus().then(({ status, error }) => {
      if (status === "pending" || status === "otp_needed") {
        updateGarminUI(status, error);
        startGarminPoll();
      }
    }).catch(() => {});
  } else { showApp(false); }
}

main().catch((e) => {
  console.error(e);
  document.getElementById("main").insertAdjacentHTML("afterbegin",
    `<p class="empty-note">Er ging iets mis bij het laden: ${esc(e.message || e)}</p>`);
});
