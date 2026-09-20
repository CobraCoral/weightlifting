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
const ctx = { PROGRAM: {}, draft: {}, suggestions: {}, bodyCompHistory: [], makeDefaultDraft: (day) => ({}), console };
vm.createContext(ctx);
vm.runInContext(blocks.join('\n'), ctx);
const { computeSuggestions, parseRepRange, getRepRange, progStep, dayStats, fmtSecs, bodyWeightOn, isBodyweightEx, dayProjection } = ctx;

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

// set-count handling: extra stall set is kept on blue/amber, dropped on green
ctx.PROGRAM = { PUSH: { exercises: [
  { id: 11, name: 'RowWithExtraSet', repMin: 8, repMax: 10, ds: 4, u: 'lb' },
  { id: 12, name: 'RowStillBuilding', repMin: 8, repMax: 10, ds: 4, u: 'lb' },
  { id: 13, name: 'RowFewerThanDefault', repMin: 8, repMax: 10, ds: 4, u: 'lb' },
] } };
const s3 = computeSuggestions([
  ...[10,10,10,10,10].map((r,i) => row(11,'2026-09-06',i,80,r)),   // 5 sets, all at ceiling
  ...[9,9,8,8,8].map((r,i) => row(12,'2026-09-06',i,80,r)),        // 5 sets, below ceiling
  ...[10,10,10].map((r,i) => row(13,'2026-09-06',i,80,r)),         // 3 sets (< default 4), at ceiling
], 'PUSH');
eq(s3[11].mode, 'increase', 'green with an extra set');
eq(s3[11].sets.length, 4, 'green -> default set count (5 -> 4)');
eq(s3[11].text.includes('4 sets'), true, 'badge notes the count change');
eq(s3[12].mode, 'progress', 'blue keeps building');
eq(s3[12].sets.length, 4, 'blue -> default set count too (5 -> 4): program edits apply immediately');
eq(s3[13].sets.length, 4, 'green pads up to default if fewer sets were done (3 -> 4)');
eq(s3[13].sets.every(x => x.w === 85 && x.r === 8), true, 'padded sets use the new weight + floor reps');
// amber = default + 1 for this session only
const s4 = computeSuggestions([
  ...[9,9,8,8].map((r,i) => row(11,'2026-09-13',i,80,r)),
  ...[9,9,8,8].map((r,i) => row(11,'2026-09-06',i,80,r)),
], 'PUSH');
eq(s4[11].mode, 'stall', 'identical sessions -> amber');
eq(s4[11].sets.length, 5, 'amber -> default + 1 (4 -> 5)');
eq(s4[11].text.includes('+1 set'), true, 'amber badge announces the extra set');
// a program trim (ds lowered) takes effect on the very next blue session
ctx.PROGRAM.PUSH.exercises[1].ds = 3;
const s5 = computeSuggestions([...[9,9,8,8,8].map((r,i) => row(12,'2026-09-06',i,80,r))], 'PUSH');
eq(s5[12].sets.length, 3, 'ds trimmed 4->3 applies immediately on blue (5 -> 3)');


// ── 4b. RIR-aware suggestions ───────────────────────────────────────────────
console.log('\n[RIR]');
ctx.bodyCompHistory = [];
ctx.PROGRAM = { PUSH: { exercises: [
  { id: 30, name: 'Laterals', repMin: 12, repMax: 15, ds: 3, u: 'lb/hand' },
  { id: 31, name: 'Pushdowns', repMin: 10, repMax: 15, ds: 3, u: 'lb' },
  { id: 32, name: 'Row', repMin: 8, repMax: 10, ds: 3, u: 'lb' },
] } };
const rowR = (id, date, i, w, r, rir) => ({ exercise_id: id, date, set_number: i + 1, weight: w, reps: r, rir });
// ceiling reached at 4 RIR -> double step (5 -> +10 not +5)
const r1 = computeSuggestions([
  rowR(30,'2026-09-19',0,25,15,null), rowR(30,'2026-09-19',1,25,15,null), rowR(30,'2026-09-19',2,25,15,4),
], 'PUSH');
eq(r1[30].mode, 'increase', 'ceiling reached -> increase');
eq(r1[30].sets[0].w, 35, 'high RIR at ceiling -> DOUBLE step (25 + 2x5)');
eq(r1[30].text.includes('double step'), true, 'badge explains the bigger jump');
// ceiling reached at 1 RIR -> normal step
const r2 = computeSuggestions([
  rowR(30,'2026-09-19',0,25,15,null), rowR(30,'2026-09-19',1,25,15,null), rowR(30,'2026-09-19',2,25,15,1),
], 'PUSH');
eq(r2[30].sets[0].w, 30, 'low RIR at ceiling -> normal step');
eq(r2[30].text.includes('1 RIR'), true, 'badge shows the logged RIR');
// below ceiling but 4 RIR -> advisory + amber colour
const r3 = computeSuggestions([
  rowR(31,'2026-09-19',0,50,12,null), rowR(31,'2026-09-19',1,50,12,null), rowR(31,'2026-09-19',2,50,12,4),
], 'PUSH');
eq(r3[31].mode, 'progress', 'below ceiling stays progress');
eq(r3[31].text.includes('go heavier'), true, 'advisory when reps added at 4+ RIR');
eq(r3[31].color, '#fbbf24', 'too-easy sets turn the badge amber');
// no RIR logged -> unchanged behaviour, no note
const r4 = computeSuggestions([
  rowR(32,'2026-09-19',0,80,10,null), rowR(32,'2026-09-19',1,80,10,null), rowR(32,'2026-09-19',2,80,10,null),
], 'PUSH');
eq(r4[32].sets[0].w, 85, 'no RIR -> normal step (back-compatible)');
eq(/RIR/.test(r4[32].text), false, 'no RIR logged -> no RIR text in badge');

// ── 4c. Rest targets ────────────────────────────────────────────────────────
console.log('\n[rest targets]');
{
  // The rest indicator is pure arithmetic: elapsed vs target decides the colour.
  const restState = (prevCompletedAt, nowTs, target) => {
    const el = Math.max(0, Math.round((nowTs - new Date(prevCompletedAt).getTime()) / 1000));
    const ok = target == null || el >= target;
    return { el, ok };
  };
  const t0 = new Date(Date.UTC(2026, 8, 20, 10, 0, 0));
  const at = (sec) => t0.getTime() + sec * 1000;
  eq(restState(t0, at(60), 105).ok, false, '60s into a 105s target -> not met (amber)');
  eq(restState(t0, at(105), 105).ok, true, 'exactly at target -> met (green)');
  eq(restState(t0, at(200), 150).ok, true, 'past a 150s compound target -> met');
  eq(restState(t0, at(45), null).ok, true, 'no target set -> always met (never nags)');
  eq(restState(t0, at(90), 105).el, 90, 'elapsed seconds computed from previous set end');
  eq(fmtSecs(105), '1:45', 'target renders as m:ss');
  eq(fmtSecs(150), '2:30', 'compound target renders as m:ss');
}

// ── 4d. Session-time projection ─────────────────────────────────────────────
console.log('\n[projection]');
{
  ctx.bodyCompHistory = [];
  ctx.PROGRAM = { PUSH: { exercises: [
    { id: 60, name: 'Press', u: 'lb', rest: 150 },
    { id: 61, name: 'Fly',   u: 'lb', rest: 105 },
  ] } };
  const T3 = (m,sec) => new Date(Date.UTC(2026, 8, 20, 14, m, sec)).toISOString();
  // nothing logged yet: 3 + 2 sets, all remaining
  ctx.draft = {
    60: [ {w:'50',r:'8',done:false}, {w:'50',r:'8',done:false}, {w:'50',r:'8',done:false} ],
    61: [ {w:'30',r:'12',done:false}, {w:'30',r:'12',done:false} ],
  };
  let p = dayProjection('PUSH', '2026-09-20');
  eq(p.remainingSets, 5, 'counts every unfinished set');
  eq(p.avgSet, 40, 'falls back to 40s per set with no history');
  // press: 3x40 + 2 rests x150 = 420 ; fly: 2x40 + 1 rest x105 = 185
  eq(p.remainingSecs, 420 + 185, 'last set of each exercise carries no rest');
  eq(p.totalSecs, 605, 'total = elapsed (0) + remaining');

  // partially done, with real set times: two 30s sets completed
  ctx.draft = {
    60: [ {w:'50',r:'8',done:true,startedAt:T3(0,0),completedAt:T3(0,30)},
          {w:'50',r:'8',done:true,startedAt:T3(3,0),completedAt:T3(3,30)},
          {w:'50',r:'8',done:true,startedAt:T3(6,0),completedAt:T3(6,30)},
          {w:'50',r:'8',done:false} ],
    61: [ {w:'30',r:'12',done:false} ],
  };
  p = dayProjection('PUSH', '2026-09-20');
  eq(p.remainingSets, 2, 'only unfinished sets remain');
  eq(p.avgSet, 30, 'uses this session actual average once 3+ sets are done');
  // press set 4 is last -> no rest ; fly single set -> no rest
  eq(p.remainingSecs, 30 + 30, 'remaining = set time only when each is the last of its exercise');
  eq(p.totalSecs, 390 + 60, 'total = elapsed 6:30 + remaining 1:00');
  eq(typeof p.finishAt?.getTime === 'function', true, 'finish time is a Date while sets remain');

  // fully done
  ctx.draft = { 60: [ {w:'50',r:'8',done:true,startedAt:T3(0,0),completedAt:T3(0,30)} ], 61: [] };
  eq(dayProjection('PUSH','2026-09-20').finishAt, null, 'no finish estimate once everything is done');
}

// ── 5a. Bodyweight awareness ────────────────────────────────────────────────
console.log('\n[bodyweight]');
const bcHist = [ // newest first, like the API
  { measure_date: '2026-09-13', weight_lb: 160, body_fat_pct: 14, fat_free_mass_lb: 137.6 },
  { measure_date: '2026-09-01', weight_lb: 158, body_fat_pct: 15, fat_free_mass_lb: 134.3 },
  { measure_date: '2026-08-01', weight_lb: 165, body_fat_pct: 19, fat_free_mass_lb: 133.6 },
];
eq(bodyWeightOn('2026-09-13', bcHist), 160, 'exact date match');
eq(bodyWeightOn('2026-09-05', bcHist), 158, 'between readings -> latest prior');
eq(bodyWeightOn('2026-07-01', bcHist), null, 'before any reading -> null');
eq(isBodyweightEx({ u: 'lb assist' }), true,  '"lb assist" is bodyweight');
eq(isBodyweightEx({ u: 'lb/hand' }),   false, '"lb/hand" is not');
eq(isBodyweightEx({ u: 'lb' }),        false, '"lb" is not');

// stall suppression: identical pull-up sets but bodyweight rose -> NOT a stall
ctx.bodyCompHistory = bcHist;
ctx.PROGRAM = { PULL: { exercises: [
  { id: 19, name: 'Pull-Ups', repMin: 8, repMax: 12, ds: 4, u: 'lb assist' },
  { id: 20, name: 'Row',      repMin: 8, repMax: 12, ds: 4, u: 'lb' },
] } };
const pu = [
  ...[10,9,8,8].map((r,i) => row(19,'2026-09-13',i,0,r)),   // BW 160 on this date
  ...[10,9,8,8].map((r,i) => row(19,'2026-09-06',i,0,r)),   // BW 158 on this date
  ...[10,9,8,8].map((r,i) => row(20,'2026-09-13',i,80,r)),  // control: loaded row, same reps
  ...[10,9,8,8].map((r,i) => row(20,'2026-09-06',i,80,r)),
];
const sp = computeSuggestions(pu, 'PULL');
eq(sp[19].mode, 'progress', 'pull-ups: same reps at +2 lb bodyweight -> progress, NOT stall');
eq(sp[19].text.includes('BW 160'), true, 'badge shows current bodyweight');
eq(sp[20].mode, 'stall', 'control: loaded row with identical sessions still stalls');
// same pull-up numbers with NO bodyweight change -> stall as normal
ctx.bodyCompHistory = [{ measure_date: '2026-09-13', weight_lb: 160 }, { measure_date: '2026-09-01', weight_lb: 160 }];
eq(computeSuggestions(pu, 'PULL')[19].mode, 'stall', 'pull-ups: same reps, same bodyweight -> stall');

// volume: bodyweight movement counts BW + load (assist is negative)
ctx.bodyCompHistory = bcHist;
ctx.PROGRAM = { PULL: { exercises: [{ id: 19, name: 'Pull-Ups', u: 'lb assist' }, { id: 21, name: 'Abs', u: 'lb' }] } };
const T2 = (m) => new Date(Date.UTC(2026, 8, 13, 14, m, 0)).toISOString();
ctx.draft = {
  19: [{ w:'0',   r:'10', done:true, startedAt:T2(0), completedAt:T2(1) },   // 160 x 10
       { w:'-20', r:'10', done:true, startedAt:T2(3), completedAt:T2(4) }],  // (160-20) x 10
  21: [{ w:'0',   r:'15', done:true, startedAt:T2(6), completedAt:T2(7) }],  // non-BW ex at 0 -> excluded
};
eq(dayStats('PULL', '2026-09-13').volume, 1600 + 1400, 'volume = (BW+load)*reps for bodyweight exercises; 0-lb non-BW excluded');
ctx.bodyCompHistory = [];
eq(dayStats('PULL', '2026-09-13').volume, 0, 'no bodyweight data -> bodyweight sets contribute 0 (no guess)');

// ── 5b. Cross-day history merge (fetchSuggestionRows) ───────────────────────
console.log('\n[cross-day history]');
function crossDayTests(){
  // Simulate: exercise 99 sits on PULL but all its history was logged on EXTRA.
  const store = {
    PULL:  [ { exercise_id: 1, date: '2026-09-06', set_number: 1, weight: 80, reps: 10 } ],
    EXTRA: [ { exercise_id: 99, date: '2026-09-07', set_number: 1, weight: 85, reps: 12 },
             { exercise_id: 77, date: '2026-09-07', set_number: 1, weight: 20, reps: 10 } ],
    PUSH:  [], LEGS: [],
  };
  let calls = 0;
  const PROG = { PULL: { exercises: [{ id: 1 }, { id: 99 }] }, EXTRA:{exercises:[]}, PUSH:{exercises:[]}, LEGS:{exercises:[]} };
  const apiGet = async ({ day }) => { calls++; return store[day] || []; };
  // inline copy of fetchSuggestionRows against these stubs
  const fetchSuggestionRows = async (day) => {
    const rows = (await apiGet({ day })) || [];
    const seen = new Set(rows.map(r => r.exercise_id));
    const missing = ((PROG[day] && PROG[day].exercises) || []).filter(ex => !seen.has(ex.id));
    if (!missing.length) return rows;
    const ids = new Set(missing.map(ex => ex.id));
    const others = Object.keys(PROG).filter(d => d !== day);
    const extra = await Promise.all(others.map(d => apiGet({ day: d }).catch(() => [])));
    return rows.concat(extra.flat().filter(r => r && ids.has(r.exercise_id)));
  };
  return fetchSuggestionRows('PULL').then(merged=>{
  eq(merged.length, 2, 'merges the moved exercise history into this day');
  eq(merged.some(r => r.exercise_id === 99), true, 'moved exercise (99) history found on another day');
  eq(merged.some(r => r.exercise_id === 77), false, 'unrelated exercise (77) is NOT merged in');
  eq(calls, 4, 'one call for the day + others only because a gap existed');

  calls = 0;
  PROG.PULL.exercises = [{ id: 1 }];                    // no gaps now
  return fetchSuggestionRows('PULL').then(merged2=>{
    eq(merged2.length, 1, 'no gap -> returns just this day');
    eq(calls, 1, 'no gap -> only ONE request (no extra fetches)');
  });
  });
}

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
crossDayTests().then(()=>{
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
