import { generate, PROFILES } from './sim.js';
import { buildEngine, benchmarkCases } from './engine.js';

// Powertrain profile: ?v=ev or ?v=ice (remembered per viewer)
let profileId = new URLSearchParams(location.search).get('v');
if (!PROFILES[profileId]) { try { profileId = localStorage.getItem('rathi-v'); } catch { profileId = null; } }
if (!PROFILES[profileId]) profileId = 'ev';
let data, engine;
function load(id) { profileId = id; data = generate(42, id); engine = buildEngine(data); }
load(profileId);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const suggestions = () => [
  'Why has my driving range reduced over the last two weeks?',
  'When did efficiency show the largest drop?',
  'Show all ADAS disengagement events from yesterday',
  data.GT.overheatQ,
  data.GT.cfQuestion,
  data.GT.leadingQ,
  'Compare energy consumption between city and highway driving',
  'range kyun kam ho gayi?',
];

// ---------- Charts (plain SVG, no libraries) ----------
function niceTicks(min, max, n = 4) {
  if (min === max) { min -= 1; max += 1; }
  const step = (max - min) / (n - 1);
  return Array.from({ length: n }, (_, i) => min + step * i);
}
const fmtX = (t, span) => span > 2 * 864e5
  ? new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  : new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });

function lineChart(c) {
  const W = 600, H = 210, L = 46, R = c.series.some((s) => s.axis === 'R') ? 46 : 14, T = 14, B = 28;
  const all = c.series.flatMap((s) => s.points.map((p) => p[0]));
  const x0 = Math.min(...all), x1 = Math.max(...all), span = x1 - x0 || 1;
  const X = (t) => L + ((t - x0) / span) * (W - L - R);
  const scale = (axis) => {
    const ys = c.series.filter((s) => (s.axis || 'L') === axis).flatMap((s) => s.points.map((p) => p[1]));
    if (!ys.length) return null;
    let lo = Math.min(...ys), hi = Math.max(...ys); const pad = (hi - lo) * 0.12 || 1; lo -= pad; hi += pad;
    return { lo, hi, Y: (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B) };
  };
  const SL = scale('L'), SR = scale('R');
  let g = '';
  niceTicks(SL.lo, SL.hi).forEach((v) => {
    const y = SL.Y(v);
    g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" class="gl"/><text x="${L - 6}" y="${y + 4}" text-anchor="end" class="ax">${Math.round(v * 10) / 10}</text>`;
  });
  if (SR) niceTicks(SR.lo, SR.hi).forEach((v) => { g += `<text x="${W - R + 6}" y="${SR.Y(v) + 4}" class="ax">${Math.round(v * 10) / 10}</text>`; });
  for (let i = 0; i < 5; i++) { const t = x0 + (span * i) / 4; g += `<text x="${X(t)}" y="${H - 8}" text-anchor="middle" class="ax">${fmtX(t, span)}</text>`; }
  if (c.marker) { const mx = X(c.marker); g += `<line x1="${mx}" x2="${mx}" y1="${T}" y2="${H - B}" class="marker"/><text x="${mx - 4}" y="${T + 10}" text-anchor="end" class="mk">${c.markerLabel || ''}</text>`; }
  c.series.forEach((s) => {
    const S = s.axis === 'R' ? SR : SL;
    g += `<polyline fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linejoin="round" points="${s.points.map((p) => `${X(p[0]).toFixed(1)},${S.Y(p[1]).toFixed(1)}`).join(' ')}"/>`;
  });
  const legend = c.series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)} (${s.axis === 'R' ? c.unitR : c.unitL})</span>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="chart">${g}</svg><div class="legend">${legend}</div>`;
}

function barChart(c) {
  const W = 600, H = 150, L = 90, R = 60, max = Math.max(...c.bars.map((b) => b.value)) * 1.1;
  const bh = 34, gap = 22;
  const g = c.bars.map((b, i) => {
    const y = 18 + i * (bh + gap), w = ((W - L - R) * b.value) / max;
    return `<text x="${L - 10}" y="${y + bh / 2 + 5}" text-anchor="end" class="bl">${esc(b.label)}</text><rect x="${L}" y="${y}" width="${w}" height="${bh}" rx="6" fill="${b.color}"/><text x="${L + w + 8}" y="${y + bh / 2 + 5}" class="bv">${b.value} ${c.unit}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart">${g}</svg>`;
}

// ---------- Answer cards ----------
const ROUTE = {
  query: ['Verified query · no LLM', 'r-query'],
  narrate: ['Evidence pack → narrated', 'r-narrate'],
  abstain: ['Not enough data · no guess', 'r-abstain'],
  investigate: ['Evidence Lab · competing explanations', 'r-narrate'],
  model: ['What-if Lab · model estimate, not proof', 'r-model'],
};
const VERDICT = { supported: 'v-sup', 'ruled out': 'v-out', 'cannot verify': 'v-cant', mixed: 'v-mix' };

function card(a) {
  const [rl, rc] = ROUTE[a.route];
  let html = `<div class="answer"><div class="meta"><span class="route ${rc}">${rl}</span><span class="lat">${a.ms.toFixed(1)} ms</span>${a.confidence !== '-' ? `<span class="conf">Confidence: ${a.confidence}</span>` : ''}</div><p>${esc(a.text)}</p>`;
  if (a.chart) html += a.chart.type === 'bar' ? barChart(a.chart) : lineChart(a.chart);
  if (a.table && a.table.rows.length) {
    html += `<table><thead><tr>${a.table.cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${a.table.rows.map((r) => `<tr>${r.map((v) => `<td>${typeof v === 'object' ? `<button class="mini" data-explain="${v.explain}">Explain</button>` : esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
  if (a.hypotheses) {
    html += `<h4 class="sub">Evidence Lab: competing explanations</h4><table class="hyp"><thead><tr><th>Explanation</th><th>Verdict</th><th>Supporting</th><th>Contradicting / missing</th></tr></thead><tbody>${a.hypotheses.map((h) => `<tr><td><b>${esc(h.label)}</b></td><td><span class="verdict ${VERDICT[h.verdict]}">${esc(h.verdict)}</span></td><td>${h.sup.map(esc).join('<br>') || '–'}</td><td>${[...h.con, ...h.missing].map(esc).join('<br>') || '–'}</td></tr>`).join('')}</tbody></table>`;
  }
  if (a.similar && a.similar.length) html += `<h4 class="sub">Vehicle memory: seen before</h4><ul class="mem">${a.similar.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  if (a.whatif) html += `<h4 class="sub">What-if Lab: replay this incident with one factor changed</h4><div class="wi">${a.whatif.scenarios.map((sc) => `<button class="chip" data-whatif="${a.whatif.warning}|${sc.id}">${esc(sc.label)}</button>`).join('')}</div>`;
  if (a.evidence) html += `<div class="chips">${a.evidence.map(([v, l]) => `<span class="ev" title="${esc(v)}">${esc(l)}</span>`).join('')}${a.range ? `<span class="ev">${esc(a.range.label)}</span>` : ''}</div>`;
  return html + '</div>';
}

function post(a) {
  const log = $('#log');
  log.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(a.question)}</div><div class="msg bot">${card(a)}</div>`);
  log.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function ask(q) { if (q.trim()) post(engine.ask(q)); }

// ---------- Sidebar ----------
function renderSidebar() {
  const s = engine.status();
  $('#status').innerHTML = `<div><b>${s.range} km</b><span>Estimated range</span></div><div><b>${s.eff}</b><span>${s.unit} (7 days)</span></div><div><b>${s.trips}</b><span>Trips in history</span></div><div><b>${s.warnings}</b><span>Warnings logged</span></div>`;
  $('#insights').innerHTML = engine.insights().map((i) => `<button class="insight" ${i.q ? `data-q="${esc(i.q)}"` : `data-explain="${i.explain}"`}><b>${esc(i.title)}</b><span>${esc(i.body)}</span></button>`).join('');
  $('#warnings').innerHTML = [...engine.warnings].reverse().map((w) => `<div class="warn"><div><b>${esc(w.label)}</b><span>${new Date(w.t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} · ${w.severity}</span></div><button class="mini" data-explain="${w.id}">Explain</button></div>`).join('');
}

// ---------- Benchmark ----------
function runBenchmark() {
  const cases = benchmarkCases(data.GT);
  const rows = cases.map((c) => {
    const t0 = performance.now();
    let a = null; try { a = c.fn ? c.fn(engine, data) : engine.ask(c.ask || c.q); } catch { a = null; }
    const ms = (a && a.ms) || performance.now() - t0;
    const okIntent = !!a && (c.fn ? true : a.intent === c.intent);
    let okAns = false; try { okAns = okIntent && c.check(a); } catch { okAns = false; }
    return { ...c, intent: c.intent || 'check', got: c.fn ? 'check' : a ? a.intent : 'error', okIntent, okAns, ms };
  });
  const ms = rows.map((r) => r.ms).sort((x, y) => x - y);
  const pct = (p) => ms[Math.min(ms.length - 1, Math.ceil((p / 100) * ms.length) - 1)];
  const routing = rows.filter((r) => r.okIntent).length, correct = rows.filter((r) => r.okAns).length;
  $('#bench-summary').innerHTML = `<div><b>${correct}/${rows.length}</b><span>Answers correct vs injected ground truth</span></div><div><b>${routing}/${rows.length}</b><span>Questions routed correctly</span></div><div><b>${pct(50).toFixed(1)} ms</b><span>p50 latency (this browser)</span></div><div><b>${pct(95).toFixed(1)} ms</b><span>p95 latency (this browser)</span></div>`;
  $('#bench-table').innerHTML = `<table><thead><tr><th>Question</th><th>Expected</th><th>Routed to</th><th>Answer</th><th>ms</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.q)}</td><td>${r.intent}</td><td class="${r.okIntent ? 'ok' : 'bad'}">${r.got}</td><td class="${r.okAns ? 'ok' : 'bad'}">${r.okAns ? 'Correct' : 'Wrong'}</td><td>${r.ms.toFixed(1)}</td></tr>`).join('')}</tbody></table>`;
  return { correct, routing, total: rows.length };
}

// ---------- Wiring ----------
function init() {
  renderAll();
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.q) { switchTab('assistant'); ask(b.dataset.q); }
    else if (b.dataset.explain) { switchTab('assistant'); post(engine.explain(b.dataset.explain)); }
    else if (b.dataset.whatif) { const [w, sc] = b.dataset.whatif.split('|'); post(engine.runWhatIf(w, sc)); }
    else if (b.dataset.tab) switchTab(b.dataset.tab);
    else if (b.id === 'run-bench') runBenchmark();
  });
  document.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => {
    load(b.dataset.v);
    try { localStorage.setItem('rathi-v', b.dataset.v); } catch { /* storage unavailable */ }
    history.replaceState(null, '', `?v=${b.dataset.v}`);
    $('#log').innerHTML = ''; $('#bench-summary').innerHTML = ''; $('#bench-table').innerHTML = '';
    renderAll();
    post(engine.ask('Why has my driving range reduced over the last two weeks?'));
  }));
  $('#ask').addEventListener('submit', (e) => { e.preventDefault(); const i = $('#q'); ask(i.value); i.value = ''; });
  post(engine.ask('Why has my driving range reduced over the last two weeks?'));
  window.__rathi = { runBenchmark, engine };
}

function renderAll() {
  document.querySelectorAll('[data-v]').forEach((b) => b.classList.toggle('active', b.dataset.v === profileId));
  $('#chips').innerHTML = suggestions().map((s) => `<button class="chip" data-q="${esc(s)}">${esc(s)}</button>`).join('');
  $('#vehicle-name').textContent = `${data.profile.name} profile`;
  renderSidebar();
}

function switchTab(id) {
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== `tab-${id}`));
}

init();
