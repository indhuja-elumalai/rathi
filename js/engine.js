// Rathi engine: intent router -> verified queries -> evidence pack -> narration.
// Facts come from deterministic analytics. The narration layer only phrases them.
// Powertrain-agnostic: units, signals and wording come from the vehicle profile.

import { DAYS } from './sim.js';

const SIGNALS = {
  // EV
  batteryTemp: { label: 'Battery temperature', unit: '°C', vss: 'Vehicle.Powertrain.TractionBattery.Temperature.Average' },
  batteryTemp2: { label: 'Battery temperature (2nd sensor)', unit: '°C', vss: 'Vehicle.Powertrain.TractionBattery.Temperature.Max (2nd sensor)', redundant: true },
  pumpDuty: { label: 'Battery coolant pump duty', unit: '%', vss: 'Vehicle.Powertrain.TractionBattery.CoolantPump.Duty (extension)' },
  chargePower: { label: 'Charging power', unit: 'kW', vss: 'Vehicle.Powertrain.TractionBattery.Charging (derived power)' },
  cellDelta: { label: 'Cell voltage spread', unit: 'mV', vss: 'Vehicle.Powertrain.TractionBattery.CellVoltage (derived)' },
  // Petrol / diesel
  coolantTemp: { label: 'Engine coolant temperature', unit: '°C', vss: 'Vehicle.OBD.CoolantTemperature' },
  fanDuty: { label: 'Radiator fan duty', unit: '%', vss: 'Vehicle.Powertrain.CombustionEngine.Fan.Duty (extension)' },
  engineLoad: { label: 'Engine load', unit: '%', vss: 'Vehicle.OBD.EngineLoad' },
  oilTemp: { label: 'Engine oil temperature', unit: '°C', vss: 'Vehicle.Powertrain.CombustionEngine.EOT' },
  // Common
  amb: { label: 'Outside temperature', unit: '°C', vss: 'Vehicle.Exterior.AirTemperature' },
  tireAmb: { label: 'Outside temperature', unit: '°C', vss: 'Vehicle.Exterior.AirTemperature' },
  tireFL: { label: 'Front-left tyre pressure', unit: 'bar', vss: 'Vehicle.Chassis.Axle.Row1.Wheel.Left.Tire.Pressure' },
  tireFR: { label: 'Front-right tyre pressure', unit: 'bar', vss: 'Vehicle.Chassis.Axle.Row1.Wheel.Right.Tire.Pressure' },
  tireRL: { label: 'Rear-left tyre pressure', unit: 'bar', vss: 'Vehicle.Chassis.Axle.Row2.Wheel.Left.Tire.Pressure' },
  tireRR: { label: 'Rear-right tyre pressure', unit: 'bar', vss: 'Vehicle.Chassis.Axle.Row2.Wheel.Right.Tire.Pressure' },
};

// Minimum spread per signal (sensor resolution), so tiny noise is never reported as a large deviation
const MIN_SD = { batteryTemp: 1, batteryTemp2: 1, pumpDuty: 5, chargePower: 2, cellDelta: 2, coolantTemp: 1, fanDuty: 5, engineLoad: 4, oilTemp: 1.5,
  amb: 1, tireAmb: 1, tireFL: 0.03, tireFR: 0.03, tireRL: 0.03, tireRR: 0.03 };

const fmtDay = (t) => new Date(t).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = (t) => new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))) || 1e-9; };
const r1 = (x) => Math.round(x * 10) / 10;
const inR = (label) => (label === 'yesterday' || label === 'today' ? label : `in the ${label}`);

// ---------- Router: intent + time slots, no LLM ----------
const LEADING = /(prove|confirm that|show that|it was the|was caused by the|blame)/;
const RULES = [
  { id: 'what_if', test: (q) => /(what if|what would|would (it|the warning)|suppose|if i had|if charging|if engine)/.test(q) },
  { id: 'before_warning', test: (q) => LEADING.test(q) && /(caus|overheat|warning|fault)/.test(q) },
  { id: 'before_warning', test: (q) => /(before|pehle|पहले|cause|why|kyun|क्यों|explain|what happened)/.test(q) && /(warning|overheat|over-temp|temperature|coolant|engine|tpms|tyre|tire|pressure|chetavani|चेतावनी|बैटरी|इंजन|गरम|battery)/.test(q) },
  { id: 'eff_drop', test: (q) => /(efficien|consumption|economy|mileage|wh\/km|l\/100)/.test(q) && /(drop|largest|worst|lowest|biggest|fell)/.test(q) },
  { id: 'range_trend', test: (q) => /(range|रेंज)/.test(q) },
  { id: 'compare', test: (q) => /(city|shahar|शहर)/.test(q) && /(highway|हाईवे)/.test(q) },
  { id: 'adas', test: (q) => /(adas|disengag|lane assist|autopilot|lane keep)/.test(q) },
  { id: 'warnings', test: (q) => /(warning|dtc|fault|error|alert|chetavani|चेतावनी)/.test(q) },
  { id: 'last_trip', test: (q) => /(last trip|latest trip|recent trip|previous trip)/.test(q) },
];

export function parseRange(q) {
  if (/(yesterday|कल)/.test(q)) return { from: DAYS - 2, to: DAYS - 2, label: 'yesterday' };
  if (/(today|aaj|आज)/.test(q)) return { from: DAYS - 1, to: DAYS - 1, label: 'today' };
  const n = q.match(/last (\d+) days/);
  if (n) return { from: DAYS - +n[1], to: DAYS - 1, label: `last ${n[1]} days` };
  if (/(last|past) (two|2) weeks|fortnight/.test(q)) return { from: DAYS - 14, to: DAYS - 1, label: 'last two weeks' };
  if (/(last|past|this) week/.test(q)) return { from: DAYS - 7, to: DAYS - 1, label: 'last 7 days' };
  return { from: 0, to: DAYS - 1, label: 'last 28 days' };
}

export function route(question) {
  const q = question.toLowerCase();
  const rule = RULES.find((x) => x.test(q));
  return { intent: rule ? rule.id : 'unknown', range: parseRange(q), q };
}

// ---------- Analytics helpers ----------
function solve(A, b) { // Gaussian elimination with partial pivoting
  const n = b.length; const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let i = c + 1; i < n; i++) if (Math.abs(M[i][c]) > Math.abs(M[p][c])) p = i;
    [M[c], M[p]] = [M[p], M[c]];
    for (let i = c + 1; i < n; i++) { const f = M[i][c] / M[c][c]; for (let j = c; j <= n; j++) M[i][j] -= f * M[c][j]; }
  }
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i]; }
  return x;
}

const FEATURES = [
  { key: 'cold', label: 'colder weather', f: (t) => Math.max(0, 20 - t.amb) },
  { key: 'hvac', label: 'cabin heating/cooling', f: (t) => (t.hvacKw * 1000) / t.speed },
  { key: 'highway', label: 'more highway driving', f: (t) => (t.type === 'highway' ? 1 : 0) },
  { key: 'rain', label: 'rain', f: (t) => (t.rain ? 1 : 0) },
];

function fitEfficiencyModel(trips) {
  const X = trips.map((t) => [1, ...FEATURES.map((F) => F.f(t))]);
  const y = trips.map((t) => t.eff);
  const k = X[0].length;
  const XtX = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => X.reduce((s, row) => s + row[i] * row[j], 0)));
  for (let i = 1; i < k; i++) XtX[i][i] += 1e-6; // tiny ridge for stability
  const Xty = Array.from({ length: k }, (_, i) => X.reduce((s, row, n) => s + row[i] * y[n], 0));
  return solve(XtX, Xty);
}

const wMean = (trips, fn) => { const km = trips.reduce((s, t) => s + t.km, 0); return trips.reduce((s, t) => s + fn(t) * t.km, 0) / (km || 1); };

export function buildEngine(data) {
  const { profile: P, trips, warnings, adas, baseline, dayStart, similar = [] } = data;
  const U = P.unit;
  const rp = (x) => +x.toFixed(P.dp);
  const effOf = (ts) => { const km = ts.reduce((s, t) => s + t.km, 0); return km ? (ts.reduce((s, t) => s + t.energy, 0) / km) * P.perKm : NaN; };
  const energyVss = P.id === 'ev' ? ['Vehicle.Powertrain.TractionBattery (energy used)', 'Energy used'] : ['Vehicle.Powertrain.FuelSystem (fuel used)', 'Fuel used'];

  const coef = fitEfficiencyModel(trips);
  const daily = Array.from({ length: DAYS }, (_, d) => trips.filter((t) => t.day === d));
  const rangeAt = (d) => (P.capacity * P.perKm) / effOf(trips.filter((t) => t.day > d - 7 && t.day <= d));

  function attribution(a, b) {
    return FEATURES.map((F, i) => ({ key: F.key, label: F.label, wh: coef[i + 1] * (wMean(b, F.f) - wMean(a, F.f)) }))
      .sort((x, y) => y.wh - x.wh);
  }

  const answers = {
    range_trend() {
      const prev = rangeAt(DAYS - 15), now = rangeAt(DAYS - 1);
      const A = trips.filter((t) => t.day < DAYS - 14), B = trips.filter((t) => t.day >= DAYS - 14);
      const e1 = rp(effOf(A)), e2 = rp(effOf(B)), pct = r1(((now - prev) / prev) * 100);
      const parts = attribution(A, B).filter((p) => p.wh > P.minEffect);
      const a1 = r1(wMean(A, (t) => t.amb)), a2 = r1(wMean(B, (t) => t.amb));
      const why = parts.map((p) => `${p.key === 'hvac' && a2 > a1 ? 'more air-conditioning' : p.key === 'hvac' ? 'more cabin heating' : p.label}${(p.key === 'cold' || (p.key === 'hvac' && !parts.some((x) => x.key === 'cold'))) ? ` (outside ${a1} → ${a2} °C)` : ''} ≈ +${rp(p.wh)} ${U}`).join('; ');
      return {
        route: 'narrate', confidence: 'High',
        text: `Your estimated range ${now < prev ? 'fell' : 'rose'} from ${Math.round(prev)} km to ${Math.round(now)} km (${pct > 0 ? '+' : ''}${pct}%) over the last two weeks. ${P.useWord} went from ${e1} to ${e2} ${U}. Main reasons: ${why || 'no single dominant factor'}.`,
        chart: { type: 'line', unitL: 'km', unitR: '°C', series: [
          { name: 'Estimated range (7-day)', color: '#0b5cad', points: Array.from({ length: DAYS - 6 }, (_, i) => [dayStart(i + 6).getTime(), r1(rangeAt(i + 6))]) },
          { name: 'Avg outside temp', color: '#f2b705', axis: 'R', points: daily.map((ts, d) => [dayStart(d).getTime(), r1(mean(ts.map((t) => t.amb)))]).filter((p) => !isNaN(p[1])) },
        ] },
        evidence: [['Vehicle.Powertrain.Range', 'Estimated range'], energyVss, ['Vehicle.Exterior.AirTemperature', 'Outside temperature'], ['Vehicle.Cabin.HVAC (power)', 'Cabin climate power'], ['Vehicle.Speed', 'Speed'], [`${trips.length} trips`, `${trips.length} trips analysed`]],
        facts: { direction: now < prev ? 'down' : 'up', topCause: parts[0]?.key, causes: parts.map((p) => (p.key === 'hvac' ? (a2 > a1 ? 'air-conditioning' : 'cabin heating') : p.label)), prev, now },
      };
    },

    eff_drop() {
      // Mix-adjusted: compare each day with the previous 7 days of the SAME kind of driving,
      // so a city-only day is not flagged just for being city-only.
      let best = null;
      for (let d = 7; d < DAYS; d++) {
        if (!daily[d].length) continue;
        const prior = trips.filter((t) => t.day >= d - 7 && t.day < d);
        const types = [...new Set(daily[d].map((t) => t.type))];
        const base = prior.filter((t) => types.includes(t.type));
        if (!base.length) continue;
        const km = daily[d].reduce((s, t) => s + t.km, 0);
        const expected = types.reduce((s, ty) => s + effOf(base.filter((t) => t.type === ty)) * daily[d].filter((t) => t.type === ty).reduce((k, t) => k + t.km, 0), 0) / km;
        const delta = (effOf(daily[d]) - expected) / expected;
        if (!best || delta > best.delta) best = { d, delta, base, expected };
      }
      const day = daily[best.d], e = rp(effOf(day)), b = rp(best.expected);
      const parts = attribution(best.base, day).filter((p) => p.wh > P.minEffect).slice(0, 3);
      const hw = day.find((t) => t.type === 'highway');
      const why = parts.map((p) => `${p.key === 'rain' && hw ? `rain on a ${Math.round(hw.km)} km highway trip` : p.label} (+${rp(p.wh)} ${U})`).join(', ');
      return {
        route: 'narrate', confidence: 'High',
        text: `The largest drop was on ${fmtDay(dayStart(best.d))}: ${e} ${U}, ${rp(e - b)} ${U} (${r1(((e - b) / b) * 100)}%) worse than your previous 7-day average of ${b} ${U} for the same kind of driving. Likely causes: ${why || 'no single dominant factor'}.`,
        chart: { type: 'line', unitL: U, marker: dayStart(best.d).getTime(), markerLabel: 'largest drop', series: [
          { name: `Daily ${P.useWord.toLowerCase()}`, color: '#0b5cad', points: daily.map((ts, d) => [dayStart(d).getTime(), rp(effOf(ts))]).filter((p) => !isNaN(p[1])) },
        ] },
        evidence: [energyVss, ['Vehicle.TraveledDistance', 'Distance'], ['Vehicle.Exterior.AirTemperature', 'Outside temperature'], ['Vehicle.Body.Raindetection.Intensity', 'Rain']],
        facts: { day: best.d },
      };
    },

    compare(range) {
      const T = trips.filter((t) => t.day >= range.from && t.day <= range.to);
      const c = T.filter((t) => t.type === 'city'), h = T.filter((t) => t.type === 'highway');
      const ce = rp(effOf(c)), he = rp(effOf(h));
      const ck = Math.round(c.reduce((s, t) => s + t.km, 0)), hk = Math.round(h.reduce((s, t) => s + t.km, 0));
      if (!c.length || !h.length) return { route: 'query', confidence: 'High', text: `Not enough ${!c.length ? 'city' : 'highway'} driving ${inR(range.label)} to compare.`, facts: { cityKm: ck, highwayKm: hk } };
      return {
        route: 'query', confidence: 'High',
        text: `Over the ${range.label}: city driving used ${ce} ${U} across ${ck} km (avg ${Math.round(wMean(c, (t) => t.speed))} km/h); highway used ${he} ${U} across ${hk} km (avg ${Math.round(wMean(h, (t) => t.speed))} km/h). ${ce > he ? `City costs ${rp(ce - he)} ${U} more: low speeds, stop-start traffic and climate control running longer per km.` : `Highway costs ${rp(he - ce)} ${U} more, mainly from aerodynamic drag at speed.`}`,
        chart: { type: 'bar', unit: U, bars: [{ label: 'City', value: ce, color: '#0b5cad' }, { label: 'Highway', value: he, color: '#f2b705' }] },
        evidence: [['Vehicle.Speed', 'Speed'], ['Vehicle.TraveledDistance', 'Distance'], energyVss, [`${T.length} trips`, `${T.length} trips`]],
        facts: { cityEff: ce, highwayEff: he, cityKm: ck, highwayKm: hk },
      };
    },

    adas(range) {
      const E = adas.filter((a) => a.day >= range.from && a.day <= range.to);
      return {
        route: 'query', confidence: 'High',
        text: E.length ? `${E.length} ADAS disengagement${E.length > 1 ? 's' : ''} ${inR(range.label)}.${E.length > 1 ? ` Most common reason: ${mode(E.map((e) => e.reason))}.` : ''}` : `No ADAS disengagements ${inR(range.label)}.`,
        table: { cols: ['When', 'Speed', 'Road', 'Reason'], rows: E.map((e) => [`${fmtDay(e.t)} ${fmtTime(e.t)}`, `${e.speed} km/h`, e.road, e.reason]) },
        evidence: [['Vehicle.ADAS.LaneDepartureDetection.IsEngaged', 'Lane assist state'], ['ADAS event log', 'Disengagement reasons'], ['Vehicle.Speed', 'Speed']],
        facts: { count: E.length },
      };
    },

    warnings(range) {
      const W = warnings.filter((w) => w.day >= range.from && w.day <= range.to);
      return {
        route: 'query', confidence: 'High',
        text: W.length ? `${W.length} warning${W.length > 1 ? 's' : ''} ${inR(range.label)}. Select one to see what happened before it.` : `No warnings or fault codes ${inR(range.label)}.`,
        table: { cols: ['When', 'Warning', 'Severity', ''], rows: W.map((w) => [`${fmtDay(w.t)} ${fmtTime(w.t)}`, w.label, w.severity, { explain: w.id }]) },
        evidence: [['UDS DTC memory', 'Diagnostic trouble codes'], ['Warning log', 'Instrument cluster warnings']],
        facts: { count: W.length },
      };
    },

    last_trip() {
      const t = trips[trips.length - 1];
      return {
        route: 'query', confidence: 'High',
        text: `Your last trip (${fmtDay(t.start)}, ${fmtTime(t.start)}) was ${t.km} km of ${t.type} driving at an average ${Math.round(t.speed)} km/h, using ${t.energy} ${P.energyUnit} (${rp(t.eff)} ${U}) with ${t.amb} °C outside.`,
        evidence: [['Vehicle.TraveledDistance', 'Distance'], ['Vehicle.Speed', 'Speed'], energyVss],
        facts: { tripId: t.id },
      };
    },

    unknown() {
      return {
        route: 'abstain', confidence: '-',
        text: "I can't answer that from this vehicle's data, so I won't guess. I can explain range and efficiency changes, compare city and highway driving, list warnings and ADAS disengagements, show what happened before any warning, and replay an incident with one factor changed (what-if).",
        facts: { abstained: true },
      };
    },
  };

  function beforeWarning(w) {
    if (!w.snapshot) {
      return {
        route: 'abstain', confidence: 'Low',
        text: `${w.label} on ${fmtDay(w.t)} at ${fmtTime(w.t)}. Only the warning record was kept for this event, with no signal snapshot, so I won't guess the cause. Suggested check: 12 V battery health test at the next service.`,
        evidence: [['Warning log', w.code]], facts: { warningCode: w.code, abstained: true },
      };
    }
    const ranked = Object.entries(w.snapshot).filter(([key]) => !SIGNALS[key].redundant).map(([key, pts]) => {
      const base = baseline[key] || [];
      const m = mean(base), s = Math.max(sd(base), MIN_SD[key] || 0);
      const peak = pts.reduce((p, c) => (Math.abs(c[1] - m) > Math.abs(p[1] - m) ? c : p));
      return { key, pts, m, s, z: (peak[1] - m) / s, peak, start: pts[0][1] };
    }).sort((a, b) => Math.abs(b.z) - Math.abs(a.z));

    const top = ranked[0];
    const onset = top.pts.find((p) => Math.abs(p[1] - top.m) > 2 * top.s);
    const lead = onset ? (w.t - onset[0]) / 60000 : 0;
    const leadTxt = lead >= 1440 ? `${Math.round(lead / 1440)} days` : `${Math.round(lead)} min`;
    const line = (x) => `${SIGNALS[x.key].label} ${x.start} → ${x.peak[1]} ${SIGNALS[x.key].unit} (${Math.abs(x.z) > 10 ? '>10' : Math.abs(x.z).toFixed(1)}σ ${x.z > 0 ? 'above' : 'below'} this car's normal)`;
    const notable = ranked.filter((x) => Math.abs(x.z) >= 2).slice(0, 3);
    const normal = ranked.filter((x) => Math.abs(x.z) < 2).map((x) => SIGNALS[x.key].label.toLowerCase());
    return {
      route: 'narrate', confidence: notable.length ? 'High' : 'Medium',
      text: `${w.label} on ${fmtDay(w.t)} at ${fmtTime(w.t)} (${w.context}). It started building ${leadTxt} before the warning. Ranked by deviation from this car's own history: ${notable.map(line).join('; ')}.${normal.length ? ` Normal: ${[...new Set(normal)].join(', ')}.` : ''}`,
      chart: { type: 'line', unitL: SIGNALS[top.key].unit, unitR: ranked[1] ? SIGNALS[ranked[1].key].unit : '', marker: w.t, markerLabel: 'warning', series: [
        { name: SIGNALS[top.key].label, color: '#0b5cad', points: top.pts },
        ...(ranked[1] ? [{ name: SIGNALS[ranked[1].key].label, color: '#f2b705', axis: 'R', points: ranked[1].pts }] : []),
      ] },
      evidence: ranked.slice(0, 4).map((x) => [SIGNALS[x.key].vss, SIGNALS[x.key].label]),
      facts: { warningCode: w.code, topSignal: top.key },
    };
  }

  // ---------- Evidence Lab: competing explanations with supporting and contradicting evidence ----------
  const OH = P.overheat || {};
  const fl = (v) => (OH.loadUnit === '%' ? `${v}%` : `${v} ${OH.loadUnit}`);
  const zOf = (key, v) => { const base = baseline[key] || []; return base.length ? (v - mean(base)) / Math.max(sd(base), MIN_SD[key] || 0) : NaN; };
  const peakOf = (pts) => pts.reduce((m, p) => (p[1] > m[1] ? p : m));

  function investigate(w, opts = {}) {
    const K = OH.keys, snap = { ...w.snapshot };
    for (const k of opts.drop || []) delete snap[k];
    if (opts.conflict && snap[K.temp2]) snap[K.temp2] = snap[K.temp2].map(([t]) => [t, snap[K.temp2][0][1]]);
    const T = snap[K.temp], T2 = snap[K.temp2], U = snap[K.cool], L = snap[K.load], A = snap.amb;
    const rise = T.at(-1)[1] - T[0][1];
    const H = {
      load: { label: `High ${OH.loadName}`, sup: [], con: [] },
      ambient: { label: 'Hot weather', sup: [], con: [] },
      coolingLimit: { label: 'Cooling at its limit', sup: [], con: [] },
      coolingFault: { label: `${OH.coolName[0].toUpperCase() + OH.coolName.slice(1)} hardware fault`, sup: [], con: [], missing: [] },
      sensor: { label: 'Temperature sensor fault', sup: [], con: [], missing: [] },
    };
    if (L) {
      const lp = peakOf(L)[1], z = zOf(K.load, lp);
      (z >= 2 ? H.load.sup : z < 1 ? H.load.con : []).push(`${OH.loadName} ${fl(lp)} (${z.toFixed(1)}σ vs this car's normal)`);
    } else H.load.missing = [`${OH.loadName} not recorded`];
    if (A) {
      const a = mean(A.map((p) => p[1])), z = zOf('amb', a);
      (z >= 1.5 ? H.ambient.sup : z < 0.5 ? H.ambient.con : []).push(`outside ${r1(a)} °C (${z.toFixed(1)}σ)`);
    } else H.ambient.missing = ['outside temperature not recorded'];
    if (U) {
      const sat = U.find((p) => p[1] >= 98);
      if (sat) {
        const mins = Math.round((w.t - sat[0]) / 60000), after = T.find((p) => p[0] >= sat[0]);
        H.coolingLimit.sup.push(`${OH.coolName} at 100% from ${mins} min before the warning, temperature still rose ${r1(T.at(-1)[1] - after[1])} °C`);
      } else H.coolingLimit.con.push(`${OH.coolName} never exceeded ${Math.max(...U.map((p) => p[1]))}%: cooling had headroom`);
      H.coolingFault.con.push(`${OH.coolName} responded to temperature as commanded`);
      H.coolingFault.missing.push('coolant flow is not recorded');
    } else {
      H.coolingLimit.missing = [`${OH.coolName} duty not recorded`];
      H.coolingFault.missing.push(`${OH.coolName} duty and coolant flow not recorded`);
    }
    if (T2) {
      const rise2 = T2.at(-1)[1] - T2[0][1];
      if (rise2 >= 0.6 * rise) H.sensor.con.push(`an independent sensor rose with it, +${r1(rise2)} vs +${r1(rise)} °C`);
      else H.sensor.sup.push(`the independent sensor stayed flat, +${r1(rise2)} vs +${r1(rise)} °C`);
    } else H.sensor.missing.push('no second temperature sensor recorded');

    for (const h of Object.values(H)) {
      const s = h.sup.length, c = h.con.length, m = (h.missing || []).length;
      h.verdict = s && !c ? 'supported' : c && !s ? (m && h === H.coolingFault ? 'cannot verify' : 'ruled out') : s && c ? 'mixed' : 'cannot verify';
    }
    if (H.coolingFault.missing.length) H.coolingFault.verdict = 'cannot verify';
    const order = ['load', 'coolingLimit', 'ambient', 'sensor', 'coolingFault'];
    const supported = order.filter((k) => H[k].verdict === 'supported');
    const confidence = H.sensor.verdict === 'supported' ? 'Low' : supported.length && H.sensor.verdict === 'ruled out' ? 'High' : 'Medium';
    const top = supported[0] || null;
    return { H, order, supported, top, confidence, rise };
  }

  // ---------- What-if Lab: replay the recorded incident through a heat model fitted to it ----------
  function fitThermal(w) {
    const K = OH.keys, s = w.snapshot, T = s[K.temp], U = s[K.cool], L = s[K.load], A = s.amb, n = T.length - 1;
    let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const dt = (T[i + 1][0] - T[i][0]) / 1000, y = (T[i + 1][1] - T[i][1]) / dt;
      const x1 = L[i][1], x2 = -(U[i][1] / 100) * (T[i][1] - A[i][1]);
      a11 += x1 * x1; a12 += x1 * x2; a22 += x2 * x2; b1 += x1 * y; b2 += x2 * y;
    }
    const det = a11 * a22 - a12 * a12, a = (b1 * a22 - b2 * a12) / det, b = (a11 * b2 - a12 * b1) / det;
    // cooling controller: linear fit of duty vs temperature on unsaturated samples
    const pts = U.map((u, i) => [T[i][1], u[1]]).filter(([, u]) => u < 98 && u > Math.min(...U.map((x) => x[1])) + 0.5);
    const mt = mean(pts.map((p) => p[0])), mu = mean(pts.map((p) => p[1]));
    const k = pts.reduce((acc, p) => acc + (p[0] - mt) * (p[1] - mu), 0) / (pts.reduce((acc, p) => acc + (p[0] - mt) ** 2, 0) || 1);
    return { a, b, k, mt, mu, umin: Math.min(...U.map((x) => x[1])) };
  }
  function replay(w, m, change = {}) {
    const K = OH.keys, s = w.snapshot, T = s[K.temp];
    let temp = T[0][1]; const out = [];
    for (let i = 0; i < T.length; i++) {
      const t = T[i][0], recL = s[K.load][i][1];
      const L = change.load != null ? Math.min(recL, change.load) : recL;
      const amb = change.amb != null ? change.amb : s.amb[i][1];
      const u = change.fullCooling ? 100 : Math.min(100, Math.max(m.umin, m.mu + m.k * (temp - m.mt)));
      out.push([t, r1(temp)]);
      if (i < T.length - 1) temp += ((T[i + 1][0] - t) / 1000) * (m.a * L - m.b * (u / 100) * (temp - amb));
    }
    return out;
  }
  function whatIf(w, change, labelText) {
    const t0 = performance.now();
    const K = OH.keys, T = w.snapshot[K.temp], m = fitThermal(w);
    const base = replay(w, m), cf = replay(w, m, change);
    const rmse = Math.sqrt(mean(base.map((p, i) => (p[1] - T[i][1]) ** 2)));
    const recPeak = peakOf(T)[1], cfPeak = peakOf(cf)[1], cross = cf.find((p) => p[1] >= w.threshold);
    const verdict = cross ? `the warning would still trigger, ${Math.round((w.t - cross[0]) / 60000)} min earlier than recorded` .replace(/, 0 min earlier than recorded/, ' at about the same time') : `the warning would not trigger (peak stays ${r1(w.threshold - cfPeak)} °C below the ${w.threshold} °C threshold)`;
    return {
      route: 'model', confidence: rmse < 1 ? 'High' : 'Medium', intent: 'what_if', question: labelText, range: null,
      text: `What-if: ${labelText.replace(/^What if /i, '').replace(/\?$/, '')}. Replaying the recorded ${w.label.toLowerCase()} incident through a heat model fitted to it (fit error ${rmse.toFixed(2)} °C): recorded peak ${recPeak} °C → simulated peak ${cfPeak} °C, so ${verdict}. This is a model estimate, not proof of the physical cause.`,
      chart: { type: 'line', unitL: '°C', marker: w.t, markerLabel: 'warning', series: [
        { name: 'Recorded', color: '#0b5cad', points: T },
        { name: 'What-if (model)', color: '#f2b705', points: cf },
        { name: 'Warning threshold', color: '#c0392b', points: [[T[0][0], w.threshold], [T.at(-1)[0], w.threshold]] },
      ] },
      evidence: [[SIGNALS[K.temp].vss, SIGNALS[K.temp].label], [SIGNALS[K.load].vss, SIGNALS[K.load].label], [SIGNALS[K.cool].vss, SIGNALS[K.cool].label], ['Vehicle.Exterior.AirTemperature', 'Outside temperature']],
      facts: { recordedPeak: recPeak, cfPeak, cfWarn: !!cross, fitRmse: rmse },
      ms: performance.now() - t0,
    };
  }
  const SCENARIOS = () => [
    { id: 'load', label: `What if ${OH.loadName} had been capped at ${fl(OH.cfLoad)}?`, change: { load: OH.cfLoad } },
    { id: 'amb', label: 'What if it had been 28 °C outside?', change: { amb: 28 } },
    { id: 'cool', label: `What if the ${OH.coolName} had run at 100% from the start?`, change: { fullCooling: true } },
  ];

  function investigateAnswer(w, opts = {}, leadingClaim = null) {
    const r = investigate(w, opts), K = OH.keys, H = r.H;
    const base = beforeWarning(w);
    const near = similar.map((x) => `${fmtDay(x.t)}: ${x.peak} °C at ${fl(x.load)}, ${x.amb} °C outside, no warning`);
    const cf = whatIf(w, { load: OH.cfLoad }, `What if ${OH.loadName} had been capped at ${fl(OH.cfLoad)}?`);
    const sup = r.supported.map((k) => H[k].label.toLowerCase());
    const ruled = r.order.filter((k) => H[k].verdict === 'ruled out').map((k) => `${H[k].label.toLowerCase()}, because ${H[k].con[0]}`);
    const cant = r.order.filter((k) => H[k].verdict === 'cannot verify').map((k) => `${H[k].label.toLowerCase()}, because ${(H[k].missing || [])[0] || 'there is no evidence either way'}`);
    let lead = '';
    if (leadingClaim) {
      const h = H[leadingClaim];
      lead = h.verdict === 'supported' ? `The data supports this: ${h.sup[0]}. ` : h.verdict === 'ruled out' ? `The data contradicts that: ${h.con[0]}. ` : `I can't confirm that from the data: a ${h.label.toLowerCase()} cannot be verified because ${(h.missing || [])[0] || 'there is no evidence either way'}. `;
    }
    return {
      ...base, route: 'investigate', confidence: r.confidence,
      text: `${lead}${w.label} on ${fmtDay(w.t)} at ${fmtTime(w.t)} (${w.context}). Most supported: ${sup.join(', ') || 'none of the explanations'}.${ruled.length ? ` Ruled out: ${ruled.join('; ')}.` : ''}${cant.length ? ` Cannot verify: ${cant.join('; ')}.` : ''}${near.length ? ` Seen before: ${near.length} similar episodes stayed below the threshold.` : ''} What-if: at ${fl(OH.cfLoad)} the model peak is ${cf.facts.cfPeak} °C, so ${cf.facts.cfWarn ? 'the warning would still trigger' : 'the warning would not trigger'}.`,
      hypotheses: r.order.map((k) => ({ key: k, label: H[k].label, verdict: H[k].verdict, sup: H[k].sup, con: H[k].con, missing: H[k].missing || [] })),
      similar: near,
      whatif: { warning: w.id, scenarios: SCENARIOS().map(({ id, label }) => ({ id, label })) },
      facts: { ...base.facts, topHypothesis: r.top, verdicts: Object.fromEntries(r.order.map((k) => [k, H[k].verdict])), similarCount: similar.length,
        leadingRejected: leadingClaim ? H[leadingClaim].verdict !== 'supported' : undefined, cfPeak: cf.facts.cfPeak, cfWarn: cf.facts.cfWarn },
    };
  }

  function whatIfFromQuestion(q) {
    const w = warnings.find((x) => x.kind === 'overheat');
    const num = q.match(/(\d+(?:\.\d+)?)\s*(kw|%|percent)/);
    const temp = q.match(/(\d+(?:\.\d+)?)\s*°?\s*c\b/);
    if (/(full|100%) (cooling|pump|fan)|(pump|fan|cooling).{0,20}(full|100%)/.test(q)) return whatIf(w, { fullCooling: true }, `What if the ${OH.coolName} had run at 100% from the start?`);
    if (temp && !num) return whatIf(w, { amb: +temp[1] }, `What if it had been ${temp[1]} °C outside?`);
    if (num) return whatIf(w, { load: +num[1] }, `What if ${OH.loadName} had been capped at ${fl(num[1])}?`);
    return whatIf(w, { load: OH.cfLoad }, `What if ${OH.loadName} had been capped at ${fl(OH.cfLoad)}?`);
  }

  function findWarning(q) {
    if (/(tyre|tire|tpms|pressure)/.test(q)) return warnings.find((w) => w.kind === 'tpms');
    if (/(12 ?v|low voltage)/.test(q)) return warnings.find((w) => w.kind === 'lv');
    if (/(overheat|over-temp|temperature|coolant|engine|battery|बैटरी|इंजन|गरम)/.test(q)) return warnings.find((w) => w.kind === 'overheat');
    return warnings[warnings.length - 1];
  }

  function ask(question) {
    const t0 = performance.now();
    const r = route(question);
    let a;
    if (r.intent === 'what_if') a = whatIfFromQuestion(r.q);
    else if (r.intent === 'before_warning') {
      const w = findWarning(r.q);
      const claim = LEADING.test(r.q) ? (/(sensor)/.test(r.q) ? 'sensor' : /(pump|fan|cooling|radiator)/.test(r.q) ? 'coolingFault' : /(charg|load)/.test(r.q) ? 'load' : /(weather|heat|hot)/.test(r.q) ? 'ambient' : null) : null;
      a = w.kind === 'overheat' ? investigateAnswer(w, {}, claim) : beforeWarning(w);
    } else a = answers[r.intent](r.range);
    return { ...a, intent: r.intent, range: ['before_warning', 'unknown', 'what_if'].includes(r.intent) ? null : r.range, question, ms: performance.now() - t0 };
  }

  function explain(id) {
    const t0 = performance.now();
    const w = warnings.find((x) => x.id === id);
    const a = w.kind === 'overheat' ? investigateAnswer(w) : beforeWarning(w);
    return { ...a, intent: 'before_warning', question: `Explain: ${w.label}`, ms: performance.now() - t0 };
  }

  function insights() {
    const rt = answers.range_trend();
    const last = warnings[warnings.length - 1];
    const y = adas.filter((a) => a.day === DAYS - 2).length;
    return [
      { title: `Range ${rt.facts.direction === 'down' ? 'down' : 'up'} ${Math.abs(r1(((rt.facts.now - rt.facts.prev) / rt.facts.prev) * 100))}% in two weeks`, body: rt.facts.causes.length ? `Mainly ${rt.facts.causes.slice(0, 2).join(' and ')}, not ${P.healthWord}.` : 'No single dominant factor.', q: 'Why has my driving range reduced over the last two weeks?' },
      { title: `Latest warning: ${last.label}`, body: `${fmtDay(last.t)}. See what led up to it.`, explain: last.id },
      { title: `${y} ADAS disengagement${y === 1 ? '' : 's'} yesterday`, body: 'Lane markings, glare and one driver override.', q: 'Show all ADAS disengagement events from yesterday' },
    ];
  }

  const status = () => ({
    range: Math.round(rangeAt(DAYS - 1)),
    eff: rp(effOf(trips.filter((t) => t.day >= DAYS - 7))), unit: U,
    trips: trips.length, warnings: warnings.length,
  });

  const runWhatIf = (id, scen) => { const w = warnings.find((x) => x.id === id); const sc = SCENARIOS().find((x) => x.id === scen); return whatIf(w, sc.change, sc.label); };
  const investigateWith = (opts) => investigateAnswer(warnings.find((x) => x.kind === 'overheat'), opts);
  return { ask, explain, insights, status, warnings, profile: P, runWhatIf, investigateWith };
}

function mode(arr) {
  const c = {}; arr.forEach((x) => (c[x] = (c[x] || 0) + 1));
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
}

// ---------- Benchmark: questions with answers checked against injected ground truth ----------
export function benchmarkCases(GT) {
  return [
    { q: 'Why has my driving range reduced over the last two weeks?', intent: 'range_trend', check: (a) => a.facts.direction === 'down' && GT.rangeCauses.includes(a.facts.topCause) },
    { q: 'When did fuel efficiency show the largest drop?', intent: 'eff_drop', check: (a) => a.facts.day === GT.effDropDay },
    { q: 'Which day had the worst energy efficiency drop?', intent: 'eff_drop', check: (a) => a.facts.day === GT.effDropDay },
    { q: 'Show all ADAS disengagement events from yesterday.', intent: 'adas', check: (a) => a.facts.count === GT.adasYesterday },
    { q: 'ADAS disengagements in the last week', intent: 'adas', check: (a) => a.facts.count === GT.adasLast7 },
    { q: GT.overheatQ, intent: 'before_warning', check: (a) => a.facts.warningCode === GT.overheatCode && a.facts.topSignal === GT.overheatTop },
    // Evidence Lab: competing explanations checked against the injected cause
    { q: `${GT.overheatQ} (most supported cause)`, ask: GT.overheatQ, intent: 'before_warning', check: (a) => a.facts.topHypothesis === GT.overheatCause },
    { q: 'Evidence Lab rules out a sensor fault when an independent sensor agrees', fn: (e) => e.investigateWith({}), check: (a) => a.facts.verdicts.sensor === 'ruled out' },
    { q: GT.leadingQ, intent: 'before_warning', check: (a) => a.facts.leadingRejected === true },
    { q: 'Missing data: cooling actuator removed, so the cooling claim cannot be verified', fn: (e, d) => e.investigateWith({ drop: [d.profile.overheat.keys.cool] }), check: (a) => a.facts.verdicts.coolingLimit === 'cannot verify' },
    { q: 'Conflicting sensors: confidence drops and a sensor fault becomes possible', fn: (e) => e.investigateWith({ conflict: true }), check: (a) => a.confidence === 'Low' && a.facts.verdicts.sensor === 'supported' },
    { q: 'Vehicle memory: similar past episodes are found', ask: GT.overheatQ, intent: 'before_warning', check: (a) => a.facts.similarCount === GT.similarCount },
    // What-if Lab: replay through a heat model fitted to the recorded incident
    { q: GT.cfQuestion, intent: 'what_if', check: (a) => a.facts.cfWarn === false && a.facts.cfPeak < a.facts.recordedPeak },
    { q: 'What-if model reproduces the recorded incident (fit error under 1 °C)', ask: GT.cfQuestion, intent: 'what_if', check: (a) => a.facts.fitRmse < 1 },
    { q: 'What-if replay is deterministic (same inputs, same result)', fn: (e, d) => { const x = e.ask(GT.cfQuestion), y = e.ask(GT.cfQuestion); return { facts: { same: x.facts.cfPeak === y.facts.cfPeak } }; }, check: (a) => a.facts.same },
    { q: 'Why did the tyre pressure warning come on?', intent: 'before_warning', check: (a) => a.facts.warningCode === GT.tpmsCode && a.facts.topSignal === GT.tpmsTop },
    { q: 'Explain the 12V low voltage warning', intent: 'before_warning', check: (a) => a.facts.abstained === true },
    { q: 'Compare energy consumption between city and highway driving.', intent: 'compare', check: (a) => a.facts.cityKm > 0 && a.facts.highwayKm > 0 },
    { q: 'List all warnings this month', intent: 'warnings', check: (a) => a.facts.count === GT.warningCount },
    { q: 'Any faults or warnings yesterday?', intent: 'warnings', check: (a) => a.facts.count === GT.warningsYesterday },
    { q: 'How was my last trip?', intent: 'last_trip', check: (a) => !!a.facts.tripId },
    { q: 'range kyun kam ho gayi?', intent: 'range_trend', check: (a) => a.facts.direction === 'down' },
    { q: GT.overheatHindi, intent: 'before_warning', check: (a) => a.facts.warningCode === GT.overheatCode },
    { q: "What's the weather on Mars?", intent: 'unknown', check: (a) => a.facts.abstained === true },
    { q: 'Tell me a joke about my car', intent: 'unknown', check: (a) => a.facts.abstained === true },
  ];
}
