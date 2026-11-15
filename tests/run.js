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
for (const file of ['index.html', 'bjj.html', 'exercises.html']) {
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
ok(blocks.length >= 2, `found ${blocks.length} @@TESTABLE blocks in index.html (expected at least 2)`);
{
  const shared = fs.readFileSync(path.join(ROOT, 'shared.js'), 'utf8');
  try { new vm.Script(shared, { filename: 'shared.js' }); ok(true, 'shared.js parses'); } catch (e) { ok(false, 'shared.js parses — ' + e.message); }
  const sb = [...shared.matchAll(/\/\/ @@TESTABLE-START[^\n]*\n([\s\S]*?)\/\/ @@TESTABLE-END/g)].map(m => m[1]);
  ok(sb.length === 1, 'shared.js has the festive testable block');
  blocks.push(...sb);
  for (const f of ['index.html', 'exercises.html', 'bjj.html']) {
    const h = fs.readFileSync(path.join(ROOT, f), 'utf8');
    ok(h.includes('src="./shared.js"') && h.includes('href="./shared.css"'), `${f} loads the shared script and stylesheet`);
    ok(h.includes('id="festive-banner"'), `${f} has the festive banner slot`);
  }
}

// Sandbox with the globals the pure functions reference.
const ctx = { PROGRAM: {}, draft: {}, suggestions: {}, bodyCompHistory: [],
  numToStr: (v) => (v == null || v === '') ? '' : String(v),
  makeDefaultDraft: (day) => {
    const o = {};
    ((ctx.PROGRAM[day] && ctx.PROGRAM[day].exercises) || []).forEach(ex => {
      o[ex.id] = Array.from({ length: ex.ds || 1 }, () => ({ w: String(ex.dw ?? ''), r: '', done: false, startedAt: null, completedAt: null, rir: null }));
    });
    return o;
  }, console };
vm.createContext(ctx);
vm.runInContext(blocks.join('\n'), ctx);
const { computeSuggestions, parseRepRange, getRepRange, progStep, dayStats, fmtSecs, bodyWeightOn, isBodyweightEx, dayProjection, computeLastSessions, rowsToDraft, clusterSupersets,
        weekBounds, nthWeekday, easterDate, eventsForWeek, festiveLabel, festiveTheme, isoLocal, csvCell,
        emptySwaps, exFromRow, buildDayList, inferSwaps, pickerOptions, sessionExerciseGroups,
        e1rm, computeBests, prCheck, topSet, computeLastNotes, weeklyMuscleSets, volumeBand, isFinished, currentRest, sanitizeSwaps, sparkPath, sessionsByExercise } = ctx;

// ── 2b. Local dates and CSV cells ───────────────────────────────────────────
console.log('\n[dates]');
// 11:30 PM local on Oct 16 is already Oct 17 in UTC for any zone west of
// Greenwich; the app must file it under the lifter's own calendar day.
eq(isoLocal(new Date(2026, 9, 16, 23, 30)), '2026-10-16', 'late-evening local time stays on the local date');
eq(isoLocal(new Date(2026, 0, 1, 0, 5)),    '2026-01-01', 'just after local midnight is the new local day');
eq(isoLocal(new Date(2026, 2, 5, 12)),      '2026-03-05', 'month and day are zero-padded');
ok(!/function todayKey\(\)[^\n]*toISOString/.test(main), 'index.html todayKey does not use the UTC date');
{
  const bjj = fs.readFileSync(path.join(ROOT, 'bjj.html'), 'utf8');
  ok(!/function todayKey\(\)[^\n]*toISOString/.test(bjj), 'bjj.html todayKey does not use the UTC date');
}
ok(!/currentDay==='FULL'\s*&&\s*setPhase\(true\)/.test(main), 'saving a FULL session no longer flips the schedule phase');
ok(!/async function detectPhase/.test(main), 'no boot-time phase detection from the DB');

console.log('\n[csv]');
eq(csvCell('Leg Press'),            'Leg Press',          'plain text is unquoted');
eq(csvCell('Flat/Low-Incline DB Press (-ve 10 deg)'), 'Flat/Low-Incline DB Press (-ve 10 deg)', 'slashes and parens need no quoting');
eq(csvCell('Dumbbell waiter\u2019s curl'), 'Dumbbell waiter\u2019s curl', 'typographic apostrophe passes through');
eq(csvCell('Pull-ups, weighted'),   '"Pull-ups, weighted"', 'comma forces quoting');
eq(csvCell('6" box step'),          '"6"" box step"',     'inner quote is doubled and the cell quoted');
eq(csvCell('=HYPERLINK("x")'),      '"\'=HYPERLINK(""x"")"', 'leading = is neutralised against formula injection');
eq(csvCell('-ve incline'),          "'-ve incline",       'leading - is neutralised too');
eq(csvCell(null),                   '',                   'null is an empty cell');
eq(csvCell(12.5),                   '12.5',               'numbers stringify');

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

// ── 4b. Superset clustering ──────────────────────────────────────────────────
// exercises.superset_group -> ex.ssGroup. Members must render adjacent even
// after a reorder renumbers sort_order, so loadExercises() runs the day list
// through clusterSupersets() after sorting.
console.log('\n[supersets]');
{
  const ids = l => l.map(e => e.id);
  eq(ids(clusterSupersets([{id:1},{id:2},{id:3}])), [1,2,3],
     'no groups: order preserved');
  eq(ids(clusterSupersets([{id:1},{id:2,ssGroup:1},{id:3,ssGroup:1},{id:4}])), [1,2,3,4],
     'adjacent pair stays put');
  eq(ids(clusterSupersets([{id:1},{id:2,ssGroup:1},{id:3},{id:4,ssGroup:1}])), [1,2,4,3],
     'split pair is rejoined behind its first member');
  eq(ids(clusterSupersets([{id:1,ssGroup:1},{id:2,ssGroup:2},{id:3,ssGroup:1},{id:4,ssGroup:2}])), [1,3,2,4],
     'two interleaved groups untangle independently');
  eq(ids(clusterSupersets([{id:1,ssGroup:7},{id:2},{id:3,ssGroup:7},{id:4,ssGroup:7}])), [1,3,4,2],
     'tri-set pulls both partners in');
  eq(ids(clusterSupersets([{id:1},{id:2,ssGroup:3}])), [1,2],
     'lone group member is harmless');
  eq(ids(clusterSupersets([{id:1,ssGroup:null},{id:2},{id:3,ssGroup:null}])), [1,2,3],
     'null groups never cluster with each other');
  ok(clusterSupersets([]).length === 0,   'empty list');
  ok(clusterSupersets(null).length === 0, 'null list');
  // Input is never mutated.
  const src = [{id:1},{id:2,ssGroup:1},{id:3},{id:4,ssGroup:1}];
  clusterSupersets(src);
  eq(ids(src), [1,2,3,4], 'source array is not mutated');
}

// ── 4c. Festive weeks ────────────────────────────────────────────────────────
// Birthdays + holidays theme the Mon–Sun week that contains them. All dates
// are local-midnight so the week flips at the user's midnight, not UTC's.
console.log('\n[festive]');
{
  const D   = (y,m,d) => new Date(y, m-1, d);
  const ymd = x => `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`;
  const names = evs => evs.map(e => e.name);

  // week bounds: Mon 00:00 → Sun 23:59:59.999
  const wb = weekBounds(D(2026,10,17));                         // Saturday
  eq([ymd(wb.start), ymd(wb.end)], ['2026-10-12','2026-10-18'], 'Sat Oct 17 → week Mon 12 – Sun 18');
  eq(ymd(weekBounds(D(2026,10,12)).start), '2026-10-12',        'Monday is its own week start');
  eq(ymd(weekBounds(D(2026,10,18)).start), '2026-10-12',        'Sunday belongs to the preceding Monday');
  eq([wb.end.getHours(), wb.end.getMinutes(), wb.end.getMilliseconds()], [23,59,999], 'week end is end of Sunday');

  // moveable feasts
  eq(ymd(nthWeekday(2025,11,4,4)), '2025-11-27', 'Thanksgiving 2025');
  eq(ymd(nthWeekday(2026,11,4,4)), '2026-11-26', 'Thanksgiving 2026');
  eq(ymd(nthWeekday(2027,11,4,4)), '2027-11-25', 'Thanksgiving 2027');
  eq(ymd(easterDate(2025)), '2025-04-20', 'Easter 2025');
  eq(ymd(easterDate(2026)), '2026-04-05', 'Easter 2026');
  eq(ymd(easterDate(2027)), '2027-03-28', 'Easter 2027');

  // single events
  let ev = eventsForWeek(D(2026,10,17));
  eq(names(ev), ['Daniel'], 'Oct 17 2026 → Daniel (Tue Oct 13)');
  eq(ev[0].age, 39,         'Daniel turns 39 in 2026');
  eq(names(eventsForWeek(D(2026,10,29))), ['Halloween'],    'Oct 29 → Halloween week (Sat Oct 31)');
  eq(names(eventsForWeek(D(2026,11,25))), ['Thanksgiving'], 'Nov 25 → Thanksgiving week');
  eq(names(eventsForWeek(D(2026, 4, 2))), ['Easter'],       'Apr 2 2026 → Easter week (Sun Apr 5)');
  eq(names(eventsForWeek(D(2026, 8,12))), [],               'mid-August: quiet week');

  // stacked events — these recur every year, not edge cases
  ev = eventsForWeek(D(2026,12,16));
  eq(names(ev), ['Maya','Fernando'],   'Dec 14–20 → Maya then Fernando, by date');
  eq([ev[0].age, ev[1].age], [5, 50],  'Maya 5, Fernando 50 in 2026');
  ev = eventsForWeek(D(2026,7,1));
  eq(names(ev), ['Arya','Fourth of July'], 'Jun 29–Jul 5 → Arya (Thu 2nd) before the 4th');
  eq(ev[0].age, 7, 'Arya turns 7 in 2026');

  // year boundary: Dec 28 2026 – Jan 3 2027 holds New Year but not Christmas
  eq(names(eventsForWeek(D(2026,12,30))), ['New Year'],  'week straddling the year picks up Jan 1');
  eq(names(eventsForWeek(D(2026,12,23))), ['Christmas'], 'Christmas week does not bleed into New Year');

  // banner text + theme selection
  eq(festiveLabel(eventsForWeek(D(2026,10,17))), '🎂 Daniel turns 39',                    'single birthday label');
  eq(festiveLabel(eventsForWeek(D(2026,12,16))), '🎂 Maya turns 5 · Fernando turns 50',   'two birthdays share one cake');
  eq(festiveLabel(eventsForWeek(D(2026,7,1))),   '🎂 Arya turns 7 · 🎆 Fourth of July',   'birthday + holiday both labelled');
  eq(festiveLabel([]), '',                                                                'no events → empty label');
  eq(festiveTheme(eventsForWeek(D(2026,7,1))),   'birthday',  'birthday wins the colour scheme over a holiday');
  eq(festiveTheme(eventsForWeek(D(2026,10,29))), 'halloween', 'lone holiday sets its own scheme');
  eq(festiveTheme([]), null, 'no events → no theme');
}

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

// ── 4e. Last-session header badge ───────────────────────────────────────────
console.log('\n[last session badge]');
{
  ctx.PROGRAM = { PUSH: { exercises: [
    { id: 70, name: 'Rope', u: 'lb' },
    { id: 71, name: 'Row',  u: 'lb/hand' },
    { id: 72, name: 'New',  u: 'lb' },
  ] } };
  const r = (id,date,i,w,rp) => ({ exercise_id:id, date, set_number:i+1, weight:w, reps:rp });
  const L = computeLastSessions([
    ...[10,10,10,10].map((v,i)=>r(70,'2026-10-03',i,65,v)),      // newest
    ...[14,14,14,14].map((v,i)=>r(70,'2026-09-26',i,85,v)),      // older, ignored
    ...[9,9,8,8].map((v,i)=>r(71,'2026-10-03',i,85,v)),          // varied reps
  ], 'PUSH');
  eq(L[70].n, 4, 'set count from last session');
  eq(L[70].reps, '10', 'uniform reps render as one number');
  eq(L[70].topW, 65, 'uses the most recent session, not the heaviest ever');
  eq(L[71].reps, '8\u20139', 'varied reps render as a low-high range');
  eq(L[72], undefined, 'no history -> no badge data (falls back to static target)');
}

// ── 4f. Mid-session refresh keeps the prefill ───────────────────────────────
console.log('\n[refresh / rowsToDraft]');
{
  ctx.PROGRAM = { PULL: { exercises: [
    { id: 80, name: 'Row',  ds: 3, dw: 40, repMin: 8,  repMax: 12, u: 'lb' },  // partially done
    { id: 81, name: 'Curl', ds: 3, dw: 40, repMin: 8,  repMax: 12, u: 'lb' },  // untouched
  ] } };
  // history gives both a suggestion of 85 (blue: hold weight, chase reps)
  const h = (id,date,i,w,r) => ({ exercise_id:id, date, set_number:i+1, weight:w, reps:r });
  ctx.suggestions = computeSuggestions([
    ...[9,9,9].map((v,i)=>h(80,'2026-09-27',i,85,v)),
    ...[9,9,9].map((v,i)=>h(81,'2026-09-27',i,70,v)),
  ], 'PULL');
  // today: only the 2 sets actually completed on exercise 80 were saved
  const saved = [
    { exercise_id:80, set_number:1, weight:85, reps:10, done:true,  started_at:'t', completed_at:'t', rir:null },
    { exercise_id:80, set_number:2, weight:85, reps:10, done:true,  started_at:'t', completed_at:'t', rir:2 },
  ];
  const d = rowsToDraft(saved, 'PULL');
  eq(d[80].length, 3, 'partially-done exercise keeps all planned sets');
  eq(d[80][0].done, true, 'saved set 1 restored as done');
  eq(d[80][1].rir, 2, 'saved RIR survives a refresh');
  eq(d[80][2].w, '85', 'unfinished set keeps the SUGGESTED weight, not the 40 lb default');
  eq(d[80][2].r, '10', 'unfinished set keeps the suggested reps, not blank');
  eq(d[80][2].done, false, 'unfinished set is not marked done');
  eq(d[81].map(x=>x.w), ['70','70','70'], 'untouched exercise keeps its suggested weight');
  eq(d[81].every(x=>x.r==='10'), true, 'untouched exercise keeps suggested reps (not blank)');
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
  // The real fetchSuggestionRows, run against a stubbed apiGet: one request,
  // by exercise id, across every day, excluding today.
  const src = (main.match(/async function fetchSuggestionRows[\s\S]*?\n}\n/) || [''])[0];
  ok(src.length > 0, 'fetchSuggestionRows extracted from index.html');
  const calls = [];
  const sb = { PROGRAM: { PULL: { exercises: [{ id: 1 }, { id: 99 }] } }, todayKey: () => '2026-11-14',
    apiGet: async (p) => { calls.push(p); return [{ exercise_id: 99, day: 'EXTRA', date: '2026-09-07' }]; } };
  vm.createContext(sb);
  vm.runInContext(src + ';this.f=fetchSuggestionRows;', sb);
  return sb.f('PULL').then(rows => {
    eq(calls.length, 1, 'one request for the whole day');
    eq(calls[0].action, 'get_by_exercises', 'history is fetched by exercise, not by day');
    eq(calls[0].ids, '1,99', 'asks for every exercise on the list');
    eq(calls[0].before, '2026-11-14', 'excludes today so a mid-session save is never "last time"');
    eq(rows.length, 1, 'rows logged under another day come back');
    calls.length = 0;
    return sb.f('PULL', [42]).then(() => {
      eq(calls[0].ids, '42', 'a single swapped-in exercise can be fetched on its own');
      calls.length = 0;
      sb.PROGRAM.PULL.exercises = [];
      return sb.f('PULL').then(r => { eq([calls.length, r.length], [0, 0], 'empty day makes no request'); });
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

// ── 6b. Library-linked days, swaps, picker, history grouping ───────────────
console.log('\n[library days]');
{
  const lib = {};
  [[1,'Rope Pushdown','Triceps'],[2,'Ext Machine','Triceps'],[3,'Waiter Curl','Biceps'],
   [4,'Overhead Ext','Triceps'],[5,'Incline Press','Chest'],[6,'Old Thing','Triceps',true],[7,'Leg Press','Quads']]
    .forEach(([id,name,muscle,del]) => { lib[id] = exFromRow({ id, name, muscle, ds:3, rt:'8-10', dw:'40', u:'lb', step:'2.5', rest_s:105, is_deleted:!!del, historical_names:['x'] }); });
  eq([lib[1].dw, lib[1].step, lib[1].rest, lib[1].muscle, lib[6].archived], [40, 2.5, 105, 'Triceps', true], 'exFromRow normalises numbers, muscle and archived flag');

  const slots = [ {slotId:10, exId:5, ssGroup:null}, {slotId:11, exId:1, ssGroup:null},
                  {slotId:12, exId:2, ssGroup:1},    {slotId:13, exId:3, ssGroup:1} ];
  const ids = l => l.map(e => e.id);
  eq(ids(buildDayList(slots, lib, emptySwaps())), [5,1,2,3], 'no swaps -> the program as stored');
  const sw = { s: { 11: 4 }, x: [7] };
  const d = buildDayList(slots, lib, sw);
  eq(ids(d), [5,4,2,3,7], 'swap replaces the slot in place; today-only extra goes last');
  eq([d[1].slotId, d[1].swappedFrom, d[1].defaultId], [11, 1, 1], 'swapped card keeps its slot and remembers the usual exercise');
  eq([d[4].extra, d[4].slotId], [true, null], 'extra is flagged and has no slot');
  eq([d[2].ssGroup, d[3].ssGroup], [1, 1], 'superset belongs to the slot, so it survives a swap');
  eq(ids(buildDayList(slots, lib, { s: { 12: 4 }, x: [] })).slice(2,4), [4,3], 'swapping one superset member keeps the pair together');
  eq(ids(buildDayList(slots, lib, { s: { 11: 2 }, x: [] })), [5,2,3], 'an exercise can only appear once per day');
  eq(ids(buildDayList([{slotId:1, exId:999}], lib, emptySwaps())), [], 'a slot pointing at an unknown exercise is skipped, not crashed on');
  eq(ids(buildDayList(slots, lib, { s: { 11: 999 }, x: [] })), [5,1,2,3], 'swap to an unknown exercise falls back to the usual one');

  // inferSwaps: sets saved today for something not on the list
  eq(inferSwaps(slots, lib, emptySwaps(), [4]).s, { 11: 4 }, 'stray triceps sets land in the triceps slot with nothing logged');
  eq(inferSwaps(slots, lib, emptySwaps(), [4, 1]).s, { 12: 4 }, 'a slot that already has logged sets is never overwritten');
  eq(inferSwaps(slots, lib, emptySwaps(), [7]), { s: {}, x: [7], h: [] }, 'no same-muscle slot -> kept as a today-only extra');
  eq(inferSwaps(slots, lib, { s:{11:4}, x:[] }, [4]), { s: {11:4}, x: [], h: [] }, 'already on the list -> nothing changes');
  eq(inferSwaps(slots, lib, emptySwaps(), [12345]), { s: {}, x: [], h: [] }, 'unknown ids are ignored');

  // picker
  const po = pickerOptions(lib, { exclude:[1,2], muscle:'Triceps' });
  eq(ids(po.same), [4], 'same-muscle choices exclude ones already on the day and archived ones');
  eq(ids(po.rest), [3,5,7], 'everything else follows, grouped by muscle');
  eq(ids(pickerOptions(lib, { q:'press' }).rest), [5,7], 'search matches name');
  eq(ids(pickerOptions(lib, { q:'quads' }).rest), [7], 'search matches muscle');
  eq(ids(pickerOptions(lib, {}).rest).includes(6), false, 'archived exercises never offered');

  // history grouping
  const rows = [ {exercise_id:4,set_number:2},{exercise_id:5,set_number:1},{exercise_id:4,set_number:1},
                 {exercise_id:null,exercise:'Legacy',set_number:1},{exercise_id:9,set_number:1} ];
  const g = sessionExerciseGroups(rows, [5,1,2,3]);
  eq(g.map(x=>x.id), [5,4,null,9], 'day order first, then swapped/removed exercises in logged order');
  eq(g[1].rows.map(r=>r.set_number), [1,2], 'sets sorted within each exercise');
}

console.log('\n[library page]');
{
  const lsrc = fs.readFileSync(path.join(ROOT, 'exercises.html'), 'utf8');
  const lb = [...lsrc.matchAll(/\/\/ @@TESTABLE-START[^\n]*\n([\s\S]*?)\/\/ @@TESTABLE-END/g)].map(m => m[1]);
  ok(lb.length === 1, 'exercises.html has one testable block');
  const L = {}; vm.createContext(L); vm.runInContext(lb.join('\n') + ';Object.assign(this,{normName,findDuplicates,filterLibrary,groupByMuscle,prescription,fmtRest,duplicateGroups,daysAgoIso});', L);
  eq(L.normName("Dumbbell Waiter’s  Curl!"), 'dumbbell waiters curl', 'normName ignores case, apostrophes, punctuation, spacing');
  const exs = [ {id:1,name:'Calf Raises',muscle:'Calves',days:['LEGS']}, {id:2,name:'calf raises',muscle:'Calves',days:['FULL']},
                {id:3,name:'Lu Raises',muscle:'Side delts',days:['PUSH'],alt:'Y raise'}, {id:4,name:'Calf Raises',is_deleted:true},
                {id:5,name:'Mystery',muscle:'',days:[]}, {id:6,name:'Leg Press',muscle:'Quads',days:['LEGS'],historical_names:['Hack squat']} ];
  eq([...L.findDuplicates(exs)].sort(), [1,2], 'live same-name exercises flagged; archived one is not');
  eq(L.filterLibrary(exs,{q:'raise'}).map(e=>e.id), [1,2,3], 'search hits names');
  eq(L.filterLibrary(exs,{q:'y raise'}).map(e=>e.id), [3], 'search hits alt names');
  eq(L.filterLibrary(exs,{q:'hack'}).map(e=>e.id), [6], 'search hits former names');
  eq(L.filterLibrary(exs,{day:'LEGS'}).map(e=>e.id), [1,6], 'day filter');
  eq(L.filterLibrary(exs,{archived:true}).map(e=>e.id), [4], 'archived view shows only archived');
  eq(L.groupByMuscle(L.filterLibrary(exs)).map(g=>g.muscle), ['Side delts','Quads','Calves',''], 'groups follow muscle order, unassigned last');
  eq(L.prescription({ds:4,rt:'10-15',dw:'85',u:'lb',rest_s:105,step:'1.5'}), '4×10-15 · 85 lb · rest 1:45 · step 1.5', 'prescription line');
  eq(L.prescription({ds:3,rt:'8-12',dw:'0',u:'lb assist',rest_s:null,step:'5'}), '3×8-12 · lb assist', 'no weight / rest / default step are omitted');
  eq(L.duplicateGroups(exs).map(g=>g.map(e=>e.id)), [[1,2]], 'duplicate groups pair up live same-name exercises');
  eq(L.filterLibrary(exs,{dups:new Set([1,2])}).map(e=>e.id), [1,2], 'duplicates-only view');
  eq(L.daysAgoIso('2026-11-14', 90), '2026-08-16', '90 days before Nov 14');
  const ex2 = [{id:1,name:'A',last_date:'2026-11-01'},{id:2,name:'B',last_date:'2026-06-01'},{id:3,name:'C',last_date:null}];
  eq(L.filterLibrary(ex2,{staleBefore:'2026-08-16'}).map(e=>e.id), [2,3], 'unused filter keeps never-logged and long-idle exercises');
}

// ── 6c. Records, warm-ups, notes, weekly volume, rest state ────────────────
console.log('\n[records + warm-ups]');
{
  eq(Math.round(e1rm(100,10)*10)/10, 133.3, 'Epley e1RM');
  eq(e1rm(100,60), e1rm(100,30), 'reps capped at 30 for e1RM');
  const rows = [
    {exercise_id:1,date:'2026-11-01',set_number:1,weight:50,reps:10,done:true},
    {exercise_id:1,date:'2026-11-01',set_number:2,weight:60,reps:5,done:true},
    {exercise_id:1,date:'2026-11-01',set_number:3,weight:90,reps:3,done:true,is_warmup:true},
    {exercise_id:1,date:'2026-11-01',set_number:4,weight:70,reps:8,done:false},
    {exercise_id:2,date:'2026-11-01',set_number:1,weight:0,reps:12,done:true},
  ];
  const b = computeBests(rows);
  eq([b[1].w, Math.round(b[1].e1*10)/10, b[2]], [60, 70, undefined], 'bests ignore warm-ups, unfinished sets and zero-weight sets');
  eq(prCheck(b[1], 65, 3), 'weight', 'heavier than ever -> weight PR');
  eq(prCheck(b[1], 60, 6), 'e1rm', 'same top weight for more reps -> e1RM PR');
  eq(prCheck(b[1], 60, 5), null, 'matching the best is not a PR');
  eq(prCheck(b[1], 50, 10), null, 'lower e1RM is not a PR');
  eq(prCheck(undefined, 100, 10), null, 'no history -> baseline, not a PR');
  eq(topSet([{w:'50',r:'10',done:true},{w:'80',r:'5',done:true,wu:true},{w:'55',r:'9',done:true},{w:'90',r:'9',done:false}]).i, 2, 'top set skips warm-ups and unfinished sets');
  eq(topSet([{w:'',r:'10',done:true}]), null, 'no loaded set -> no top set');

  // warm-ups never reach the progression engine
  const hist = sessionsByExercise([
    {exercise_id:1,date:'2026-11-01',set_number:1,weight:20,reps:15,is_warmup:true},
    {exercise_id:1,date:'2026-11-01',set_number:2,weight:50,reps:10},
    {exercise_id:1,date:'2026-11-01',set_number:3,weight:50,reps:9}]);
  eq(hist[1][0].sets.map(x=>x.w), [50,50], 'warm-up sets are excluded from "last session"');

  eq(computeLastNotes([{exercise_id:1,date:'2026-10-01',note:'seat 3'},{exercise_id:1,date:'2026-11-01',note:'seat 4'},{exercise_id:1,date:'2026-11-05',note:null},{exercise_id:2,date:'2026-11-01'}]),
     {1:{note:'seat 4',date:'2026-11-01'}}, 'latest non-empty note per exercise');

  const lib = {1:{muscle:'Triceps'},2:{muscle:'Chest'},3:{}};
  eq(weeklyMuscleSets([{exercise_id:1,done:true},{exercise_id:1,done:true},{exercise_id:1,done:true,is_warmup:true},{exercise_id:1,done:false},{exercise_id:2,done:true},{exercise_id:3,done:true},{exercise_id:9,done:true}], lib),
     {Triceps:2, Chest:1, Other:2}, 'weekly sets: done working sets by muscle, unknown -> Other');
  eq([volumeBand(4), volumeBand(10), volumeBand(20), volumeBand(21)], ['low','ok','ok','high'], 'volume bands around the 10-20 target');
  eq([isFinished([]), isFinished([{done:true},{done:false}]), isFinished([{done:true}])], [false,false,true], 'isFinished');

  // rest state
  const t = n => new Date(Date.UTC(2026,10,14,15,0,n)).toISOString();
  const list = [{id:1,name:'A',rest:90},{id:2,name:'B',rest:60}];
  eq(currentRest(list, {1:[{done:false}],2:[{done:false}]}), null, 'nothing done -> no rest state');
  let d = {1:[{done:true,startedAt:t(0),completedAt:t(30)},{done:false}],2:[{done:false}]};
  let r = currentRest(list, d);
  eq([r.kind,r.exId,r.set,r.tgt,r.since], ['rest',1,2,90,new Date(t(30)).getTime()], 'resting before the next set of the same exercise');
  d[1][1].startedAt = t(100);
  eq(currentRest(list, d), null, 'a set in progress -> no rest bar');
  d = {1:[{done:true,completedAt:t(30)},{done:true,completedAt:t(200)}],2:[{done:false}]};
  r = currentRest(list, d);
  eq([r.kind,r.exId,r.name], ['next',2,'B'], 'exercise finished -> points at the next unfinished one');
  d[2][0] = {done:true,completedAt:t(400)};
  eq(currentRest(list, d), null, 'everything finished -> nothing to show');

  // templates
  const lib2 = {1:{id:1},2:{id:2},3:{id:3,archived:true}};
  eq(sanitizeSwaps({s:{10:2,99:2,11:3,12:77},x:[2,3,55],h:[10,98]}, [{slotId:10},{slotId:11},{slotId:12}], lib2),
     {s:{10:2},x:[2],h:[10]}, 'a saved plan drops slots/exercises that no longer exist or are archived');
  const slots = [{slotId:10,exId:1,ssGroup:null},{slotId:11,exId:2,ssGroup:null}];
  eq(buildDayList(slots, lib2, {s:{},x:[],h:[10]}).map(e=>e.id), [2], 'a slot skipped for today is left out');

  eq(sparkPath([1],10,10), '', 'sparkline needs two points');
  eq(sparkPath([1,3],10,10), 'M0.0,9.0 L10.0,1.0', 'sparkline scales into the box (higher value = higher on screen)');
  eq(sparkPath([5,5,5],10,10).startsWith('M0.0,'), true, 'flat series does not divide by zero');
}

// ── 6d. Deliberate load reset ───────────────────────────────────────────────
console.log('\n[restart weight]');
{
  const day = Object.keys(ctx.PROGRAM)[0];
  const keep = ctx.PROGRAM[day].exercises;
  const ex = { id: 9001, name: 'Rear delt', ds: 2, rt: '12-15', u: 'lb/hand', restartW: 30, restartOn: '2026-11-15' };
  ctx.PROGRAM[day].exercises = [ex];
  const old = [1,2].map(n => ({ exercise_id: 9001, date: '2026-11-14', set_number: n, weight: 52.5, reps: 14, done: true }));
  let s = computeSuggestions(old, day)[9001];
  eq([s.mode, s.sets.length, s.sets[0].w, s.sets[0].r], ['restart', 2, 30, 12], 'reset weight replaces progression from the old load');
  ok(/reset to 30 lb\/hand/.test(s.text) && /12.15/.test(s.text), 'reset is spelled out on the card');
  s = computeSuggestions([], day)[9001];
  eq(s.mode, 'restart', 'reset applies even with no history');
  const after = old.concat([1,2].map(n => ({ exercise_id: 9001, date: '2026-11-21', set_number: n, weight: 30, reps: 13, done: true })));
  s = computeSuggestions(after, day)[9001];
  eq([s.mode, s.sets[0].w, s.sets[0].r], ['progress', 30, 14], 'once a session is logged after the reset date, normal progression resumes from it');
  ctx.PROGRAM[day].exercises = keep;
}

// ── 7. Day/tab wiring ────────────────────────────────────────────────────────
// Days are data-driven (exercises come from the DB by `day`), but the tab
// labels, accents and week strip are client-side. A day in DAYS with no
// PROGRAM entry crashes renderAll(), so assert they stay in sync.
console.log('\n[day wiring]');
{
  // Run the real declaration block, so DAYS/week()/split() behave as the app
  // computes them. A fake localStorage stands in for the cached phase.
  const block = (main.match(/const PROGRAM[\s\S]*?\nconst split\s*=[^\n]*\n/) || [''])[0];
  ok(block.length > 0, 'schedule block extracted from index.html');
  const load = (cached) => {
    const store = { [ 'ironlog_phase' ]: cached };
    const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
    const api = vm.runInNewContext(block + `
      ;({ P:PROGRAM, D:DAYS, setPhase,
          read: () => ({ W: week(), SPLIT: split(), onBulk }) })`, { localStorage: ls });
    return { ...api, store };
  };

  // The phase is sticky across reloads and survives a localStorage that throws.
  { const a = load(undefined); ok(a.read().onBulk === false, 'fresh install boots on the cut schedule'); }
  { const b = load('bulk');    ok(b.read().onBulk === true,  'cached phase is honoured on the next load'); }
  {
    const c = load(undefined);
    ok(c.setPhase(true)  === true,  'setPhase reports the change so the caller re-renders');
    ok(c.store['ironlog_phase'] === 'bulk', 'the switch is persisted for the first paint next time');
    ok(c.setPhase(true)  === false, 'setPhase is a no-op when the phase already matches');
    ok(c.setPhase(false) === true,  'the phase switches back to cut on request');
    ok(c.store['ironlog_phase'] === 'cut', 'switching back is persisted too');
  }
  ok(/function togglePhase\(\)[\s\S]*?confirm\(/.test(main), 'the phase toggle asks for confirmation');
  ok(vm.runInNewContext(block + ';({ onBulk })',
      { localStorage: { getItem(){ throw new Error('blocked'); } } }).onBulk === false,
    'a blocked localStorage falls back to the cut schedule instead of throwing');

  for (const name of ['cut', 'bulk']) {
    const app = load(undefined);
    app.setPhase(name === 'bulk');
    const { P, D } = app, { W, SPLIT } = app.read();
    const all = Object.keys(P);
    ok(D.length >= 4, `${name}: DAYS parsed (${D.join(',')})`);
    ok(D.every(d => P[d] && P[d].label && P[d].accent), `${name}: every tab has a label + accent`);
    // Retired days stay in PROGRAM — fetchSuggestionRows scans its keys for an
    // exercise's history under the day it used to live on — but get no tab.
    ok(all.filter(d => P[d].retired).every(d => !D.includes(d)), `${name}: retired days get no tab`);
    ok(all.filter(d => !P[d].retired).every(d => D.includes(d)), `${name}: every live day has a tab`);
    ok(all.includes('EXTRA') && P.EXTRA.retired === true, `${name}: EXTRA kept for history lookup only`);
    ok(W.filter(w => w.lift).every(w => P[w.prog] && !P[w.prog].retired), `${name}: strip lift cells point at live days`);
    ok(W.filter(w => w.pm).every(w => P[w.pm] && !P[w.pm].retired), `${name}: strip pm cells point at live days`);
    ok(Object.values(SPLIT).every(d => P[d] && !P[d].retired), `${name}: weekday defaults point at live days`);
    ok(new Set(all.map(d => P[d].accent)).size === all.length, `${name}: accents are distinct`);
    ok(W.length === 7, `${name}: week strip covers 7 days`);
  }

  const cutApp = load(undefined), bulkApp = load('bulk');
  const cut = cutApp.read(), bulk = bulkApp.read();
  eq(cut.SPLIT, {0:'PULL',2:'LEGS',6:'PUSH'}, 'cut: Sat push, Sun pull, Tue legs');
  eq([cut.W[3].lift, cut.W[3].pm], [false, 'HOME'], 'cut: Thursday is BJJ with the evening delt block');
  eq(cut.W[6].prog, 'PULL', 'cut: Sunday is the pull day');
  eq(bulk.W[3].prog, 'FULL', 'bulk: Thursday becomes full body');
  eq(bulk.W[3].pm, 'HOME',   'bulk: Thursday keeps the evening delt block');
  eq(bulk.W[6].prog, 'PULL', 'bulk: Sunday becomes the pull day');
  eq(bulk.SPLIT, {0:'PULL',2:'LEGS',4:'FULL',6:'PUSH'}, 'bulk: weekday defaults follow the strip');
  ok(bulk.W.filter(w => w.lift).length === 4, 'bulk: four lifting days in the strip');
}

// ── Result ───────────────────────────────────────────────────────────────────
crossDayTests().then(()=>{
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
