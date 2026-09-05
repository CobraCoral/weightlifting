#!/usr/bin/env node
/* Iron Log test runner — zero dependencies, run with `node tests/run.js`.
   1. Syntax-checks every <script> in index.html and bjj.html, plus sw.js.
   2. Extracts the pure-logic blocks between // @@TESTABLE-START / -END markers
      in index.html and unit-tests them (progression engine + day summary).
   Exit code is non-zero on any failure, so CI fails loudly. */
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
function ok(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.log('  ✗', msg); } }
function eq(a, b, msg){ ok(JSON.stringify(a)===JSON.stringify(b), `${msg}  →  ${JSON.stringify(a)}`); }

// ── 1. Syntax checks ─────────────────────────────────────────────────────────
console.log('\n[syntax]');
function scriptsOf(file){
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}
for (const file of ['index.html', 'bjj.html']) {
  scriptsOf(file).forEach((src, i) => {
    try { new vm.Script(src, { filename: `${file}#${i}` }); ok(true, `${file} script #${i} parses`); }
    catch (e) { ok(false, `${file} script #${i} parses — ${e.message}`); }
  });
}
try { execFileSync(process.execPath, ['--check', path.join(ROOT, 'sw.js')]); ok(true, 'sw.js parses'); }
catch (e) { ok(false, 'sw.js parses'); }

// ── 2. Extract testable blocks ───────────────────────────────────────────────
const main = scriptsOf('index.html').reduce((a, b) => (b.length > a.length ? b : a), '');
const blocks = [...main.matchAll(/\/\/ @@TESTABLE-START[^\n]*\n([\s\S]*?)\/\/ @@TESTABLE-END/g)].map(m => m[1]);
ok(blocks.length === 2, `found ${blocks.length} @@TESTABLE blocks (expected 2)`);

// Sandbox with the globals the pure functions reference.
const ctx = { PROGRAM: {}, draft: {}, suggestions: {}, makeDefaultDraft: (day) => ({}), console };
vm.createContext(ctx);
vm.runInContext(blocks.join('\n'), ctx);
const { computeSuggestions, parseRepRange, getRepRange, progStep, dayStats, fmtSecs } = ctx;

// ── 3. Rep-range parsing / structured targets ────────────────────────────────
console.log('\n[rep targets]');
eq(parseRepRange('8-12'),   { lo: 8, hi: 12 }, 'parse "8-12"');
eq(parseRepRange('15'),     { lo: 15, hi: 15 }, 'parse "15"');
eq(parseRepRange('3-5 min'), null,             'time target "3-5 min" is not reps');
eq(parseRepRange('30-45s'),  null,             'time target "30-45s" is not reps');
eq(parseRepRange('20 steps'), null,            'step target "20 steps" is not reps');
eq(getRepRange({ repMin: 6, repMax: 10, rt: '99-99' }), { lo: 6, hi: 10 }, 'structured DB range wins over text');
eq(getRepRange({ targetType: 'minutes', repMin: 3, repMax: 5 }), null,      'targetType=minutes -> no rep range');
eq(getRepRange({ rt: '10-12' }), { lo: 10, hi: 12 },                        'falls back to text when unstructured');

// ── 4. Progression step (DB value > id map > default; never by name) ────────
console.log('\n[step]');
eq(progStep({ id: 6, step: 1.5 }), 1.5, 'uses exercises.step from DB');
eq(progStep({ id: 6 }),            1.5, 'id-keyed fallback for cable pushdowns');
eq(progStep({ id: 2 }),            5,   'default step');
eq(progStep({ id: 2, name: 'Rope Triceps Pushdowns' }), 5, 'name alone does NOT change the step');

// ── 5. Progression engine ────────────────────────────────────────────────────
console.log('\n[engine]');
ctx.PROGRAM = { PUSH: { exercises: [
  { id: 1, name: 'Incline', repMin: 8, repMax: 12, u: 'lb/hand' },
  { id: 3, name: 'Laterals', repMin: 12, repMax: 15, u: 'lb/hand' },
  { id: 4, name: 'Pushdowns', repMin: 15, repMax: 15, u: 'lb', step: 1.5 },
  { id: 6, name: 'Stall', repMin: 8, repMax: 12, u: 'lb' },
  { id: 8, name: 'Vacuum', targetType: 'minutes', repMin: 3, repMax: 5, u: '' },
] } };
const row = (id, date, i, w, r) => ({ exercise_id: id, date, set_number: i + 1, weight: w, reps: r });
const rows = [
  ...[10,10,10,8].map((r,i) => row(1,'2026-07-11',i,45,r)),
  ...[15,15,15,15].map((r,i) => row(3,'2026-07-11',i,25,r)),
  ...[52.5,54,55.5].map((w,i) => row(4,'2026-07-11',i,w,15)),
  ...[10,9,8].map((r,i) => row(6,'2026-07-11',i,70,r)),
  ...[10,9,8].map((r,i) => row(6,'2026-07-04',i,70,r)),
  row(8,'2026-07-11',0,0,4),
];
const s = computeSuggestions(rows, 'PUSH');
eq(s[1].mode, 'progress', 'below ceiling -> progress (hold weight)');
eq(s[1].sets.map(x => x.r), [11,11,11,9], 'progress adds +1 rep/set, capped at ceiling');
eq(s[1].sets.every(x => x.w === 45), true, 'progress never changes weight');
eq(s[3].mode, 'increase', 'all sets at ceiling -> increase');
eq(s[3].sets.every(x => x.w === 30 && x.r === 12), true, 'increase adds default 5 and resets to floor');
eq(s[4].mode, 'increase', 'ascending cable scheme at ceiling -> increase');
eq(s[4].sets.map(x => x.w), [54, 55.5, 57], 'cable step 1.5 preserves ascending offsets');
eq(s[6].mode, 'stall', 'identical consecutive sessions -> stall');
eq(s[8], undefined, 'time-based exercise gets NO suggestion');
// numeric input (post-migration the API returns numbers, not strings)
const s2 = computeSuggestions([row(1,'2026-07-11',0,45,12), row(1,'2026-07-11',1,45,12)], 'PUSH');
eq(s2[1].mode, 'increase', 'numeric weight/reps from API handled');

// ── 6. Day summary ───────────────────────────────────────────────────────────
console.log('\n[day summary]');
const T = (m, sec) => new Date(Date.UTC(2026, 7, 29, 14, m, sec)).toISOString();
ctx.PROGRAM = { PUSH: { exercises: [
  { id: 2, name: 'Incline',   u: 'lb/hand' },
  { id: 6, name: 'Pushdowns', u: 'lb' },
  { id: 19, name: 'Pull-ups', u: 'lb assist' },
  { id: 40, name: 'BW',       u: 'BW' },
] } };
ctx.draft = {
  2:  [{ w:'45', r:'10', done:true, startedAt:T(0,0),  completedAt:T(0,40) },
       { w:'45', r:'10', done:true, startedAt:T(2,40), completedAt:T(3,20) }],
  6:  [{ w:'50', r:'12', done:true, startedAt:T(5,20), completedAt:T(5,50) },
       { w:'50', r:'12', done:false, startedAt:null,   completedAt:null }],   // untouched
  19: [{ w:'-40', r:'8', done:true, startedAt:T(7,50), completedAt:T(8,20) }], // assisted
  40: [{ w:'0',  r:'15', done:true, startedAt:T(9,20), completedAt:T(9,50) }], // bodyweight zero
};
const d = dayStats('PUSH');
eq(d.totalTime, 590, 'total = first start -> last finish');
eq(d.avgRest, 105,   'avg rest across whole day, chronological: (120+120+120+60)/4');
eq(d.avgSet, 34,     'avg set time');
eq(d.volume, 2400,   'volume: per-hand doubled, assisted + 0 lb excluded, untouched ignored');
eq(d.done, 5, 'done sets counted'); eq(d.total, 6, 'total sets counted');
eq(fmtSecs(590), '9:50', 'fmt m:ss'); eq(fmtSecs(3725), '1h02m', 'fmt hours'); eq(fmtSecs(null), '—', 'fmt null');

// ── Result ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
