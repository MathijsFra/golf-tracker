import {
  initDb, getMode, getRounds, addRound, updateRound, deleteRound,
  processImage, saveScreenshot, resolveScreenshot, parseScreenshots,
  getUser, signIn, signOut, onAuthChange, triggerWorkflow,
  loadUserSettings, saveGolfnlCredentials,
} from "./db.js?v=9";
import { computeStats } from "./stats.js?v=9";
import { renderHcpChart, renderStbChart, renderTrendChart } from "./charts.js?v=9";

const MONTHS = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

let rounds = [];      // geannoteerde rondes (oplopend op datum)
let stats = null;
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
async function refresh() {
  rounds = await getRounds();
  stats = computeStats(rounds);
  rounds = stats.rounds;
  renderDashboard();
  renderRoundList();
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
  return `
  <div class="round-card" data-id="${r.id}">
    <div class="round-head">
      <div class="round-date"><span class="d">${parseInt(d, 10)}</span><span class="m">${MONTHS[parseInt(m, 10) - 1]}</span></div>
      <div class="round-info">
        <div class="round-course">${esc(r.course)} ${r._exs ? '<span class="badge-exs">EXS</span>' : ""}</div>
        <div class="round-tags">${r.holes}h · ${esc(r.tee || "—")} · SD ${r.sd != null ? Number(r.sd).toFixed(1) : "—"}${r.score != null ? ` · ${r.score} slagen` : ""}</div>
      </div>
      <div class="round-metrics">
        <span class="round-stb">${r.stb != null ? r.stb : "—"}</span>
        <span class="round-hcp">hcp ${r.hcp != null ? Number(r.hcp).toFixed(1) : "—"}</span>
      </div>
      <span class="chev">›</span>
    </div>
    <div class="round-detail">
      ${garmin ? `<div class="garmin-grid">
        ${gcell(r.putts, "Putts")}
        ${gcell(r.penalties, "Penalties")}
        ${gcell(r.bunkers, "Bunkers")}
        ${gcell(r.bunker_saves, "Saves")}
      </div>` : ""}
      ${hd.length ? holesTable(hd) : ""}
      ${shots.length ? `<div class="shot-thumbs">${shots.map((u) => `<a class="shot-link" data-shot="${esc(u)}" target="_blank" rel="noopener"><img alt="screenshot" loading="lazy"></a>`).join("")}</div>` : ""}
      ${r.notes ? `<div class="round-notes">${esc(r.notes)}</div>` : ""}
      ${!garmin && !hd.length && !shots.length && !r.notes ? `<div class="empty-garmin">Geen extra details voor deze ronde.</div>` : ""}
      ${withActions ? `<div class="detail-actions">
        <button class="btn btn-ghost btn-sm" data-edit="${r.id}">Bewerken</button>
        <button class="btn btn-danger btn-sm" data-del="${r.id}">Verwijderen</button>
      </div>` : ""}
    </div>
  </div>`;
}

function holesTable(hd) {
  const cell = (v) => (v === null || v === undefined || v === "" ? "—" : v);
  const fwSym = { hit: "✓", miss: "✗", left: "←", right: "→" };
  const rows = hd.map((h) => `<tr>
    <td>${cell(h.hole)}</td>
    <td>${cell(h.par)}</td>
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
  if ([r.putts, r.penalties, r.bunkers, r.bunker_saves].some((v) => v != null)) return true;
  const hd = Array.isArray(r.holes_data) ? r.holes_data : [];
  return hd.some((h) => h.putts != null || h.penalties != null || h.fairway != null);
}

function bindRoundCards(scope) {
  scope.querySelectorAll(".round-head").forEach((head) => {
    head.addEventListener("click", () => head.closest(".round-card").classList.toggle("open"));
  });
  scope.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); startEdit(b.dataset.edit); }));
  scope.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (confirm("Deze ronde verwijderen?")) { await deleteRound(b.dataset.del); await refresh(); }
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
  if (view !== "add" && editingId) resetForm();
}

// ---------- auth ----------
function showApp(show) {
  $("#main").style.display = show ? "" : "none";
  document.querySelector(".tabbar").style.display = show ? "" : "none";
  $("#loginScreen").hidden = show;
  const syncSection = $("#syncSection");
  if (syncSection) {
    syncSection.hidden = !(show && getMode() === "supabase");
    if (show) refreshSyncTokenUI();
  }
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

// ---------- sync ----------
async function onSync(workflowFile, btn, statusEl) {
  btn.disabled = true;
  statusEl.textContent = "Gestart…";
  statusEl.className = "sync-status";
  try {
    await triggerWorkflow(workflowFile);
    statusEl.textContent = "✓ Sync afgetrapt — klaar over ~1 minuut.";
    statusEl.className = "sync-status ok";
  } catch (err) {
    statusEl.textContent = "Mislukt: " + (err.message || err);
    statusEl.className = "sync-status err";
  } finally {
    btn.disabled = false;
    setTimeout(() => { statusEl.textContent = ""; }, 8000);
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
  $("#f_shots").addEventListener("change", onShotsSelected);
  $("#parseBtn").addEventListener("click", onParse);
  $("#f_holes").addEventListener("change", () => buildHolesGrid(collectHolesGrid()));
  $("#clearHolesBtn").addEventListener("click", () => buildHolesGrid([]));
  $("#loginForm").addEventListener("submit", onLogin);
  $("#logoutBtn").addEventListener("click", () => signOut());

  const syncStatus = $("#syncStatus");
  $("#syncGolfnlBtn")?.addEventListener("click", () =>
    onSync("sync-golfnl.yml", $("#syncGolfnlBtn"), syncStatus));
  $("#syncGarminBtn")?.addEventListener("click", () =>
    onSync("sync-garmin.yml", $("#syncGarminBtn"), syncStatus));
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

  resetForm();

  if (mode !== "supabase") {       // lokale modus: geen login
    showApp(true);
    await refresh();
    return;
  }

  // Cloud-modus: login vereist. Reageer op login/logout/sessieherstel.
  let loaded = false;
  onAuthChange(async (user) => {
    $("#logoutBtn").hidden = !user;
    if (user && !loaded) {
      loaded = true;
      showApp(true);
      $("#loginMsg").textContent = "";
      await refresh();
      loadUserSettings().then((s) => {
        if (s.golfnl_username) $("#golfnlUsername").value = s.golfnl_username;
      });
    } else if (!user) {
      loaded = false;
      showApp(false);
    }
  });

  // Eerste check (bestaande sessie?).
  const user = await getUser();
  $("#logoutBtn").hidden = !user;
  if (user) {
    loaded = true; showApp(true); await refresh();
    loadUserSettings().then((s) => {
      if (s.golfnl_username) $("#golfnlUsername").value = s.golfnl_username;
    });
  } else { showApp(false); }
}

main().catch((e) => {
  console.error(e);
  document.getElementById("main").insertAdjacentHTML("afterbegin",
    `<p class="empty-note">Er ging iets mis bij het laden: ${esc(e.message || e)}</p>`);
});
