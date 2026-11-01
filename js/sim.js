// Seeded simulation of 28 days of vehicle data with injected, known scenarios.
// Powertrain-agnostic: an EV and a petrol (ICE) car share one pipeline. Only the
// profile changes: signals, units, warnings and the energy model.
// The injected scenarios double as ground truth for the benchmark.

export const DAYS = 28;

export const PROFILES = {
  ev: {
    id: 'ev', name: 'Electric', unit: 'Wh/km', perKm: 1000, energyUnit: 'kWh', capacity: 55, dp: 1,
    useWord: 'Energy use', healthWord: 'battery health', minEffect: 2, weather: 'cold',
    cityBase: 128, hwBase: 158, coldK: 3.4, hvacK: 1, rainAdd: 90, noise: 4,
    overheat: {
      code: 'BMS_OVERTEMP', label: 'Battery over-temperature', context: 'DC fast charging at a public charger',
      top: 'batteryTemp', question: 'What happened before the battery overheating warning?',
      hindi: 'बैटरी गरम होने की चेतावनी से पहले क्या हुआ?',
    },
  },
  ice: {
    id: 'ice', name: 'Petrol', unit: 'L/100 km', perKm: 100, energyUnit: 'L', capacity: 40, dp: 2,
    useWord: 'Fuel use', healthWord: 'engine health', minEffect: 0.08, heatFromWaste: true, weather: 'hot',
    // AC load on an engine: kW / (25% efficiency × 8.9 kWh per litre) → L/h, then per 100 km
    cityBase: 6.9, hwBase: 5.5, coldK: 0.11, hvacK: 0.045, rainAdd: 3.6, noise: 0.12,
    overheat: {
      code: 'ENG_COOLANT_OVERTEMP', label: 'Engine coolant over-temperature', context: 'long uphill climb in 36 °C heat with AC on',
      top: 'coolantTemp', question: 'What happened before the engine overheating warning?',
      hindi: 'इंजन गरम होने की चेतावनी से पहले क्या हुआ?',
    },
  },
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r) {
  let u = 0, v = 0;
  while (!u) u = r();
  while (!v) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function generate(seed = 42, profileId = 'ev') {
  const P = PROFILES[profileId];
  const r = mulberry32(seed);
  const N = (m, s) => m + s * gauss(r);
  const round = (x, p = 1) => +x.toFixed(p);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayStart = (d) => new Date(today.getTime() - (DAYS - 1 - d) * 864e5);
  const at = (d, h, m) => { const t = dayStart(d); t.setHours(h, m, 0, 0); return t.getTime(); };

  // Injected scenario days
  const D_LVBATT = 5;    // 12 V battery low warning, no signal snapshot kept
  const D_HEAT = 10;     // overheating event (battery for EV, engine coolant for petrol)
  const D_RAIN = 12;     // rainy highway day: the largest efficiency drop
  const D_TPMS = 22;     // slow front-left leak days 18-22, warning on day 22
  const D_Y = DAYS - 2;  // yesterday

  const trips = [], tire = [], warnings = [], adas = [];
  const baseline = {}; // this vehicle's own normal-operation history, per signal
  const push = (k, v) => (baseline[k] = baseline[k] || []).push(v);

  for (let d = 0; d < DAYS; d++) {
    // Injected weather story over the last two weeks: a cold spell for the EV (heating costs range),
    // a hot spell for the petrol car (AC costs fuel; cabin heat is free engine waste heat)
    const ambBase = P.weather === 'hot' ? 24 + Math.max(0, d - 13) * 0.9 : 27 - Math.max(0, d - 13) * 1.15;
    const dow = dayStart(d).getDay();
    const weekend = dow === 0 || dow === 6;

    const plan = weekend || d === D_RAIN
      ? [{ h: 11, m: 5, type: 'highway', km: N(82, 8) }, { h: 18, m: 40, type: 'city', km: N(12, 2) }]
      : [
          { h: 8, m: 30, type: 'city', km: N(14, 1.5) },
          { h: 18, m: 35, type: 'city', km: N(16, 2) },
          ...(d % 3 === 0 ? [{ h: 13, m: 10, type: 'highway', km: N(38, 5) }] : []),
        ];

    for (const p of plan) {
      const rain = d === D_RAIN && p.type === 'highway';
      const amb = ambBase + (p.h < 12 ? -4.5 : 1.5) + N(0, 1.2);
      const speed = p.type === 'city' ? N(24, 3) : N(rain ? 70 : 82, 5);
      let hvacKw = amb < 20 ? 0.5 + (20 - amb) * 0.16 : amb > 26 ? 0.6 + (amb - 26) * 0.22 : 0.35;
      hvacKw = Math.max(0.2, hvacKw + N(0, 0.08));
      // A combustion engine heats the cabin with waste heat: only the blower and AC draw on the fuel
      if (P.heatFromWaste && amb < 20) hvacKw = 0.2 + N(0, 0.02);
      const hvacPerKm = ((hvacKw * 1000) / speed) * P.hvacK;
      const base = p.type === 'city' ? P.cityBase : P.hwBase;
      const eff = base + Math.max(0, 20 - amb) * P.coldK + hvacPerKm + (rain ? P.rainAdd : 0) + N(0, P.noise);
      const km = Math.max(3, p.km);
      trips.push({
        id: trips.length + 1, day: d, start: at(d, p.h, p.m), type: p.type,
        km: round(km), speed: round(speed), amb: round(amb), hvacKw: round(hvacKw, 2),
        rain, eff: round(eff, P.dp + 1), energy: round((eff * km) / P.perKm, 2),
      });
      if (profileId === 'ice' && d !== D_HEAT) {
        push('coolantTemp', round(N(92, 2))); push('fanDuty', Math.round(N(40, 10)));
        push('engineLoad', Math.round(N(p.type === 'city' ? 32 : 48, 8))); push('oilTemp', round(N(101, 3)));
        push('amb', round(amb));
      }
    }

    // Morning tyre pressures (bar)
    let fl = 2.4 + N(0, 0.01);
    if (d >= 18 && d <= D_TPMS) fl = 2.4 - (d - 17) * 0.105 + N(0, 0.005);
    tire.push({ day: d, t: at(d, 8, 25), fl: round(fl, 2), fr: round(2.4 + N(0, 0.01), 2),
      rl: round(2.38 + N(0, 0.01), 2), rr: round(2.38 + N(0, 0.01), 2), amb: round(ambBase - 4.5 + N(0, 1)) });

    // EV only: normal charging history is the baseline for battery signals
    if (profileId === 'ev' && d !== D_HEAT) {
      if (d % 2 === 1) { push('batteryTemp', round(N(30, 2))); push('pumpDuty', Math.round(N(38, 8))); push('chargePower', round(N(7, 0.2))); push('amb', round(ambBase - 3 + N(0, 1))); push('cellDelta', Math.round(N(11, 2))); }
      if (d % 5 === 2) { push('batteryTemp', round(N(37, 2.5))); push('pumpDuty', Math.round(N(70, 8))); push('chargePower', round(N(60, 8))); push('amb', round(ambBase + 2 + N(0, 1))); push('cellDelta', Math.round(N(14, 2))); }
    }
  }
  for (const x of tire) { if (x.day < 18) push('tireFL', x.fl); push('tireFR', x.fr); push('tireRL', x.rl); push('tireRR', x.rr); push('tireAmb', x.amb); }

  // Overheating event: 15-minute snapshot at 10 s steps
  const tHeat = at(D_HEAT, 15, 40);
  const heat = {};
  const add = (k, t, v) => (heat[k] = heat[k] || []).push([t, v]);
  for (let s = -900; s <= 0; s += 10) {
    const t = tHeat + s * 1000;
    const k = Math.max(0, (s + 720) / 720); // climb starts 12 min before
    const fanUp = Math.round(s < -480 ? 55 + ((s + 900) / 420) * 45 : 100);
    if (profileId === 'ev') {
      add('batteryTemp', t, round(33.5 + 18.5 * Math.pow(k, 1.4) + N(0, 0.15)));
      add('pumpDuty', t, fanUp);
      add('chargePower', t, round(s > -60 ? 40 : 92 + N(0, 1.2)));
      add('amb', t, round(36 + N(0, 0.1)));
      add('cellDelta', t, Math.round(13 + 6 * k + N(0, 0.4)));
    } else {
      add('coolantTemp', t, round(93 + 25 * Math.pow(k, 1.4) + N(0, 0.2)));
      add('fanDuty', t, fanUp);
      add('engineLoad', t, Math.round(s > -60 ? 40 : 82 + N(0, 2)));
      add('amb', t, round(36 + N(0, 0.1)));
      add('oilTemp', t, round(102 + 14 * k + N(0, 0.3)));
    }
  }
  warnings.push({ id: 'W2', kind: 'overheat', code: P.overheat.code, label: P.overheat.label, severity: 'High',
    t: tHeat, day: D_HEAT, context: P.overheat.context, snapshot: heat });

  // TPMS low pressure, front-left: 7-day lookback of morning readings
  const tpms = { tireFL: [], tireFR: [], tireRL: [], tireRR: [], tireAmb: [] };
  for (const x of tire.filter((x) => x.day >= D_TPMS - 6 && x.day <= D_TPMS)) {
    tpms.tireFL.push([x.t, x.fl]); tpms.tireFR.push([x.t, x.fr]); tpms.tireRL.push([x.t, x.rl]);
    tpms.tireRR.push([x.t, x.rr]); tpms.tireAmb.push([x.t, x.amb]);
  }
  warnings.push({ id: 'W3', kind: 'tpms', code: 'TPMS_LOW_FL', label: 'Low tyre pressure, front-left', severity: 'Medium',
    t: at(D_TPMS, 8, 40), day: D_TPMS, context: 'detected at the morning start', snapshot: tpms });
  for (const x of tire) if (x.day > D_TPMS) x.fl = +(2.4 + (x.fl - 2.4) * 0.1).toFixed(2); // repaired

  // 12 V battery low: record only, no snapshot retained
  warnings.push({ id: 'W1', kind: 'lv', code: 'LV_BATT_LOW', label: '12 V battery low voltage', severity: 'Low',
    t: at(D_LVBATT, 7, 55), day: D_LVBATT, context: 'at vehicle wake-up', snapshot: null });
  warnings.sort((a, b) => a.t - b.t);

  // ADAS disengagements
  const addAdas = (d, h, m, speed, road, reason) => adas.push({ day: d, t: at(d, h, m), speed, road, reason });
  addAdas(16, 8, 51, 38, 'City', 'Lane markings not detected');
  addAdas(D_RAIN, 11, 20, 66, 'Highway', 'Front camera visibility low (rain)');
  addAdas(D_RAIN, 11, 48, 61, 'Highway', 'Front camera visibility low (rain)');
  addAdas(24, 13, 30, 74, 'Highway', 'Driver steering override');
  addAdas(D_Y, 8, 47, 42, 'City', 'Lane markings not detected');
  addAdas(D_Y, 18, 52, 31, 'City', 'Driver steering override');
  addAdas(D_Y, 19, 6, 35, 'City', 'Front camera visibility low (glare)');

  // Ground truth from the injected scenarios, never from the analytics
  const GT = {
    effDropDay: D_RAIN,
    overheatCode: P.overheat.code, overheatTop: P.overheat.top,
    overheatQ: P.overheat.question, overheatHindi: P.overheat.hindi,
    tpmsCode: 'TPMS_LOW_FL', tpmsTop: 'tireFL',
    adasYesterday: adas.filter((a) => a.day === D_Y).length,
    adasLast7: adas.filter((a) => a.day >= DAYS - 7).length,
    warningCount: warnings.length,
    warningsYesterday: warnings.filter((w) => w.day === D_Y).length,
    rangeCauses: ['cold', 'hvac'],
  };

  return { profile: P, trips, tire, warnings, adas, baseline, GT, dayStart, today };
}
