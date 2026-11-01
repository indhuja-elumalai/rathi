// Runs the self-scoring benchmark across many simulation seeds.
import { generate, PROFILES } from '../js/sim.js';
import { buildEngine, benchmarkCases } from '../js/engine.js';

const seeds = Number(process.argv[2] || 30);
let total = 0, correct = 0;
const misses = {};
for (const profile of Object.keys(PROFILES)) for (let seed = 1; seed <= seeds; seed++) {
  const data = generate(seed, profile);
  const engine = buildEngine(data);
  for (const c of benchmarkCases(data.GT)) {
    let ok = false;
    try {
      const a = c.fn ? c.fn(engine, data) : engine.ask(c.ask || c.q);
      ok = (c.fn || a.intent === c.intent) && c.check(a);
    } catch { ok = false; }
    total++; if (ok) correct++; else misses[`[${profile}] ${c.q}`] = (misses[`[${profile}] ${c.q}`] || 0) + 1;
  }
}
console.log(`Correct: ${correct}/${total} (${((100 * correct) / total).toFixed(1)}%) across ${seeds} seeds × ${Object.keys(PROFILES).length} powertrains`);
for (const [q, n] of Object.entries(misses)) console.log(`  missed ${n}x: ${q}`);
// Random data occasionally produces a genuinely ambiguous day, so require 99% rather than 100%
process.exit(correct / total >= 0.99 ? 0 : 1);
