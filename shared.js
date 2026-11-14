/* Iron Log — shared across index.html, exercises.html and bjj.html:
   festive weeks (theme + particles) and the bottom navigation bar. */
function _sesc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

// @@TESTABLE-START  (pure date logic — unit-tested by tests/run.js)
// ── Festive weeks ────────────────────────────────────────────────────────────
// Birthdays and holidays theme the app for the Mon–Sun week that contains
// them. Pure date logic lives here so it is unit-tested; the DOM side
// (applyFestive) is below the block.
//
// Each entry is either a fixed {m, d} or a {date: (year) => Date} resolver
// for moveable feasts. Birthdays carry `y` so the banner can say "turns N".
// `theme` picks the colour scheme + particle set in CSS/applyFestive.
const FESTIVE_EVENTS = [
  // birthdays
  { kind:'birthday', name:'Arya',     m:7,  d:2,  y:2019, theme:'birthday', emoji:'🎂' },
  { kind:'birthday', name:'Maya',     m:12, d:14, y:2021, theme:'birthday', emoji:'🎂' },
  { kind:'birthday', name:'Priya',    m:5,  d:4,  y:1990, theme:'birthday', emoji:'🎂' },
  { kind:'birthday', name:'Fernando', m:12, d:15, y:1976, theme:'birthday', emoji:'🎂' },
  { kind:'birthday', name:'Marinice', m:4,  d:16, y:1954, theme:'birthday', emoji:'🎂' },
  { kind:'birthday', name:'Daniel',   m:10, d:13, y:1987, theme:'birthday', emoji:'🎂' },
  // fixed holidays
  { kind:'holiday', name:'New Year',       m:1,  d:1,  theme:'newyear',   emoji:'🎆' },
  { kind:'holiday', name:"Valentine's",    m:2,  d:14, theme:'valentine', emoji:'❤️' },
  { kind:'holiday', name:"St. Patrick's",  m:3,  d:17, theme:'stpatrick', emoji:'☘️' },
  { kind:'holiday', name:'Fourth of July', m:7,  d:4,  theme:'july4',     emoji:'🎆' },
  { kind:'holiday', name:'Halloween',      m:10, d:31, theme:'halloween', emoji:'🎃' },
  { kind:'holiday', name:'Christmas',      m:12, d:25, theme:'xmas',      emoji:'🎄' },
  // moveable holidays
  { kind:'holiday', name:'Easter',       date:(y)=>easterDate(y),          theme:'easter',       emoji:'🐣' },
  { kind:'holiday', name:'Thanksgiving', date:(y)=>nthWeekday(y,11,4,4),   theme:'thanksgiving', emoji:'🦃' },
];

// Local-midnight Date for y/m/d (m is 1-based). Never UTC: a user in Miami
// should see the week flip at their midnight, not at 8pm the night before.
function localDate(y,m,d){ return new Date(y, m-1, d, 0,0,0,0); }

// Nth occurrence (1-based) of a weekday (0=Sun..6=Sat) in a month.
// nthWeekday(2026, 11, 4, 4) = fourth Thursday of November = Thanksgiving.
function nthWeekday(y,m,weekday,n){
  const first = localDate(y,m,1);
  const offset = (weekday - first.getDay() + 7) % 7;
  return localDate(y, m, 1 + offset + (n-1)*7);
}

// Anonymous Gregorian algorithm (Meeus/Jones/Butcher). Western Easter.
function easterDate(y){
  const a=y%19, b=Math.floor(y/100), c=y%100, d=Math.floor(b/4), e=b%4,
        f=Math.floor((b+8)/25), g=Math.floor((b-f+1)/3), h=(19*a+b-d-g+15)%30,
        i=Math.floor(c/4), k=c%4, l=(32+2*e+2*i-h-k)%7, m=Math.floor((a+11*h+22*l)/451),
        month=Math.floor((h+l-7*m+114)/31), day=((h+l-7*m+114)%31)+1;
  return localDate(y, month, day);
}

// Monday 00:00 → Sunday 23:59:59.999 of the week containing `date`, local time.
function weekBounds(date){
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dow = (d.getDay() + 6) % 7;          // Mon=0 … Sun=6
  const start = new Date(d); start.setDate(d.getDate() - dow);
  const end   = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23,59,59,999);
  return { start, end };
}

// Resolve an event's calendar date for a given year.
function festiveDateFor(ev, y){ return ev.date ? ev.date(y) : localDate(y, ev.m, ev.d); }

// All events whose date falls in the same Mon–Sun week as `date`, sorted by
// date within the week. Birthdays first on ties so a shared week with a
// holiday (Arya + Fourth of July, every year) leads with the person.
// The week can straddle a year boundary, so three candidate years are tried.
function eventsForWeek(date){
  const { start, end } = weekBounds(date);
  const yrs = [date.getFullYear()-1, date.getFullYear(), date.getFullYear()+1];
  const out = [];
  FESTIVE_EVENTS.forEach(ev => {
    for (const y of yrs) {
      const when = festiveDateFor(ev, y);
      if (when >= start && when <= end) {
        const hit = { kind: ev.kind, name: ev.name, theme: ev.theme, emoji: ev.emoji, when };
        if (ev.kind === 'birthday') hit.age = y - ev.y;
        out.push(hit);
        break;
      }
    }
  });
  out.sort((a,b) => (a.when - b.when) || ((a.kind==='birthday'?0:1) - (b.kind==='birthday'?0:1)));
  return out;
}

// Banner text: "🎂 Daniel turns 39" / "🎂 Maya turns 5 · Fernando turns 50" /
// "🎂 Arya turns 7 · 🎆 Fourth of July". Birthdays share one leading emoji.
function festiveLabel(events){
  if (!events.length) return '';
  const parts = [];
  let lastEmoji = null;
  events.forEach(ev => {
    const text = ev.kind === 'birthday' ? `${ev.name} turns ${ev.age}` : ev.name;
    parts.push((ev.emoji !== lastEmoji ? ev.emoji + ' ' : '') + text);
    lastEmoji = ev.emoji;
  });
  return parts.join(' · ');
}

// Colour scheme comes from the primary event: the first birthday if any,
// else the first holiday. Particles are drawn for every active theme.
function festiveTheme(events){
  if (!events.length) return null;
  return (events.find(e => e.kind === 'birthday') || events[0]).theme;
}
// @@TESTABLE-END

// ── Festive weeks: DOM side ──────────────────────────────────────────────────
const FESTIVE_KEY = 'ironlog_festive';   // 'off' = user tapped the banner to hide decorations
function festiveOn(){ try{ return localStorage.getItem(FESTIVE_KEY) !== 'off'; }catch{ return true; } }
function toggleFestive(){ try{ localStorage.setItem(FESTIVE_KEY, festiveOn() ? 'off' : 'on'); }catch{} applyFestive(); }

// Particle recipes per theme. Each returns {cls, txt, style[, lights]} items
// that applyFestive turns into .fp nodes. Counts stay small (≤ ~16 moving
// nodes per theme) so this is cheap on a phone GPU. Negative --delay starts
// every animation mid-flight so the first paint is already populated.
const _r  = (a,b) => a + Math.random()*(b-a);
const _p  = v => `${v.toFixed(1)}%`;
const _n  = (n,fn) => Array.from({length:n}, (_,i)=>fn(i));
const _pk = arr => arr[Math.floor(Math.random()*arr.length)];
const FESTIVE_PARTICLES = {
  birthday: () => [
    ..._n(7, ()=>({cls:'rise', txt:_pk(['🎈','🎈','🎈','🎉']), style:`left:${_p(_r(2,92))};font-size:${_r(18,30)|0}px;--dur:${_r(11,17).toFixed(1)}s;--delay:-${_r(0,16).toFixed(1)}s;--sway:${_r(-40,40)|0}px`})),
    ..._n(10,()=>({cls:'fall', txt:'▪', style:`left:${_p(_r(0,98))};font-size:${_r(9,13)|0}px;color:hsl(${_r(0,360)|0} 90% 65%);--dur:${_r(7,12).toFixed(1)}s;--delay:-${_r(0,12).toFixed(1)}s;--sway:${_r(-60,60)|0}px`})),
  ],
  xmas: () => [
    {cls:'tree', txt:'🎄', style:'', lights:['#f87171','#fbbf24','#60a5fa','#4ade80','#f472b6']},
    ..._n(14,()=>({cls:'fall', txt:'❄', style:`left:${_p(_r(0,98))};font-size:${_r(10,18)|0}px;color:#e2e8f0;opacity:.85;--dur:${_r(9,16).toFixed(1)}s;--delay:-${_r(0,16).toFixed(1)}s;--sway:${_r(-30,30)|0}px`})),
  ],
  halloween: () => [
    {cls:'web l', txt:'🕸️', style:''}, {cls:'web r', txt:'🕸️', style:''},
    ..._n(2, i=>({cls:'drift', txt:'👻', style:`top:${_p(_r(18,60))};font-size:${_r(26,34)|0}px;opacity:.85;--dur:${_r(14,20).toFixed(1)}s;--delay:-${i*7}s`})),
    ..._n(3, i=>({cls:'flap',  txt:'🦇', style:`top:${_p(_r(8,40))};font-size:${_r(18,26)|0}px;--dur:${_r(9,13).toFixed(1)}s;--delay:-${i*4}s`})),
    {cls:'spider', txt:'🕷️', style:`left:${_p(_r(10,30))};font-size:22px;--dur:11s;--delay:-2s;--drop:${_r(120,220)|0}px`},
    {cls:'spider', txt:'🕷️', style:`left:${_p(_r(65,88))};font-size:18px;--dur:14s;--delay:-7s;--drop:${_r(90,180)|0}px`},
  ],
  thanksgiving: () => [
    {cls:'bob', txt:'🦃', style:'left:auto;right:10px;bottom:12px;font-size:48px;--dur:3s'},
    ..._n(12,()=>({cls:'fall', txt:_pk(['🍂','🍁','🍃']), style:`left:${_p(_r(0,98))};font-size:${_r(14,22)|0}px;--dur:${_r(10,16).toFixed(1)}s;--delay:-${_r(0,16).toFixed(1)}s;--sway:${_r(-70,70)|0}px`})),
  ],
  newyear: () => [
    ..._n(6, ()=>({cls:'burst', txt:_pk(['🎆','🎇','✨']), style:`left:${_p(_r(5,85))};top:${_p(_r(6,45))};font-size:${_r(26,44)|0}px;--dur:${_r(2.4,3.6).toFixed(1)}s;--delay:-${_r(0,3.5).toFixed(1)}s`})),
    ..._n(10,()=>({cls:'fall', txt:'▪', style:`left:${_p(_r(0,98))};font-size:${_r(8,12)|0}px;color:${_pk(['#fbbf24','#f8fafc','#fde68a'])};--dur:${_r(7,12).toFixed(1)}s;--delay:-${_r(0,12).toFixed(1)}s;--sway:${_r(-50,50)|0}px`})),
  ],
  valentine: () => _n(9, ()=>({cls:'rise', txt:_pk(['❤️','💗','💕']), style:`left:${_p(_r(2,92))};font-size:${_r(14,26)|0}px;--dur:${_r(10,16).toFixed(1)}s;--delay:-${_r(0,16).toFixed(1)}s;--sway:${_r(-30,30)|0}px`})),
  stpatrick: () => _n(10,()=>({cls:'fall', txt:_pk(['☘️','🍀']), style:`left:${_p(_r(0,98))};font-size:${_r(12,20)|0}px;--dur:${_r(9,15).toFixed(1)}s;--delay:-${_r(0,15).toFixed(1)}s;--sway:${_r(-50,50)|0}px`})),
  july4: () => [
    ..._n(5, ()=>({cls:'burst', txt:'🎆', style:`left:${_p(_r(5,85))};top:${_p(_r(6,40))};font-size:${_r(28,44)|0}px;--dur:${_r(2.4,3.6).toFixed(1)}s;--delay:-${_r(0,3.5).toFixed(1)}s`})),
    ..._n(10,()=>({cls:'fall', txt:'▪', style:`left:${_p(_r(0,98))};font-size:${_r(8,12)|0}px;color:${_pk(['#f87171','#f8fafc','#60a5fa'])};--dur:${_r(7,12).toFixed(1)}s;--delay:-${_r(0,12).toFixed(1)}s;--sway:${_r(-50,50)|0}px`})),
  ],
  easter: () => _n(7, i=>({cls:'bob', txt:['🐣','🥚','🐰','🌷'][i%4], style:`left:${_p(8+i*13)};bottom:${_r(8,40)|0}px;font-size:${_r(20,30)|0}px;--dur:${_r(2.2,3.4).toFixed(1)}s;--delay:-${_r(0,3).toFixed(1)}s`})),
};

// Apply this week's theme: banner text always; colour scheme + overlay only
// while the user has not hidden them. Idempotent — safe to call on boot, on
// toggle, and when the PWA comes back to the foreground after a date change.
function applyFestive(){
  const events = eventsForWeek(new Date());
  const theme  = festiveTheme(events);
  const on     = festiveOn();
  const banner = document.getElementById('festive-banner');
  let   layer  = document.getElementById('festive-layer');

  if (banner) {
    if (!events.length) banner.style.display = 'none';
    else {
      banner.style.display = '';
      banner.className = 'festive' + (on ? '' : ' off');
      banner.innerHTML = `${_sesc(festiveLabel(events))}<span class="hint">${on ? 'tap to hide' : 'tap to show'}</span>`;
    }
  }

  if (!theme || !on) {
    document.body.removeAttribute('data-theme');
    if (layer) layer.remove();
    return;
  }

  document.body.dataset.theme = theme;
  const key = events.map(e => e.theme + ':' + e.when.toDateString()).join('|');
  if (layer && layer.dataset.built === key) return;          // already drawn for this exact week
  if (!layer) { layer = document.createElement('div'); layer.id = 'festive-layer'; layer.className = 'festive-layer'; document.body.appendChild(layer); }

  // Particles from every active theme, so a shared week (Arya + Fourth of
  // July; Maya + Fernando) gets both sets. Colour scheme stays the primary's.
  const themes = [...new Set(events.map(e => e.theme))];
  const parts  = themes.flatMap(t => (FESTIVE_PARTICLES[t] || (() => []))());
  layer.innerHTML = parts.map(p => {
    const lights = p.lights ? p.lights.map((c,i) =>
      `<i style="background:${c};color:${c};left:${[46,30,62,38,54][i]}%;top:${[28,48,52,70,74][i]}%;--dur:${(1.1+i*.23).toFixed(2)}s;--delay:-${(i*.37).toFixed(2)}s"></i>`).join('') : '';
    return `<span class="fp ${p.cls}" style="${p.style}">${p.txt}${lights}</span>`;
  }).join('');
  layer.dataset.built = key;
}

// A PWA left open across Sunday midnight should pick up the new week.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') applyFestive(); });

// ─── Bottom navigation ───────────────────────────────────────────────────────
// One bar on every page. On the log page LOG/HISTORY switch views in place;
// elsewhere they are plain links.
const NAV_ITEMS = [
  { id:'log',     label:'LOG',     icon:'\u270e', href:'./index.html' },
  { id:'history', label:'HISTORY', icon:'\u25f7', href:'./index.html#history' },
  { id:'library', label:'LIBRARY', icon:'\u2630', href:'./exercises.html' },
  { id:'bjj',     label:'BJJ',     icon:'\u2694', href:'./bjj.html' },
];
function navPage(){
  const f = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  if (f.startsWith('exercises')) return 'library';
  if (f.startsWith('bjj')) return 'bjj';
  return location.hash === '#history' ? 'history' : 'log';
}
function setNavActive(id){
  document.querySelectorAll('.bnav a').forEach(a => a.classList.toggle('on', a.dataset.nav === id));
}
function navClick(ev, id){
  if ((id === 'log' || id === 'history') && typeof window.switchView === 'function') {
    ev.preventDefault();
    window.switchView(id);
    try { history.replaceState(null, '', id === 'history' ? '#history' : location.pathname + location.search); } catch {}
  }
}
function mountNav(){
  if (document.querySelector('.bnav')) return;
  const nav = document.createElement('nav');
  nav.className = 'bnav';
  nav.innerHTML = NAV_ITEMS.map(n =>
    `<a href="${n.href}" data-nav="${n.id}" onclick="navClick(event,'${n.id}')"><span class="bnav-i">${n.icon}</span><span>${n.label}</span></a>`).join('');
  document.body.appendChild(nav);
  setNavActive(navPage());
}
if (typeof document !== 'undefined') {
  const boot = () => { mountNav(); applyFestive(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}
