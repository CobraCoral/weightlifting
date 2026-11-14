// Iron Log — `workouts` edge function (source of truth lives in this repo;
// deploy with the Supabase MCP / CLI, verify_jwt=false — see TODO.md #1).
//
// Data model
//   exercises      the library: one row per movement (name, muscle, default
//                  prescription). `day` / `sort_order` / `superset_group` on
//                  this table are legacy and no longer drive the program.
//   program_slots  what each day uses: (day, sort_order, exercise_id,
//                  superset_group). A day "links" to library exercises.
//   workouts       logged sets, keyed by exercise_id, so history follows the
//                  movement no matter which day or slot it was done in.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const DAYS = ['PUSH', 'PULL', 'LEGS', 'FULL', 'HOME'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  const bad = (msg: string) => json({ error: msg }, 400);

  // rest_s: target rest between sets in seconds. Optional; null clears it.
  const restVal = (v: unknown) => {
    if (v === undefined || v === null || v === '') return null;
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  // Coerce logged values into the ranges the table's CHECK constraints accept.
  const intOrNull = (v: unknown, lo: number, hi: number) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
  };
  const numOrNull = (v: unknown, lo: number, hi: number) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
  };
  const tsOrNull = (v: unknown) => {
    if (typeof v !== 'string' || !v) return null;
    return Number.isNaN(Date.parse(v)) ? null : v;
  };
  const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

  // PostgREST caps a response at 1000 rows; page through anything that can grow.
  async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>) {
    const out: T[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await build(from, from + 999);
      if (error) throw error;
      out.push(...(data ?? []));
      if (!data || data.length < 1000) return out;
    }
  }

  async function nextSortOrder(day: string) {
    const { data, error } = await supabase.from('program_slots')
      .select('sort_order').eq('day', day).order('sort_order', { ascending: false }).limit(1);
    if (error) throw error;
    return data && data.length ? (data[0].sort_order ?? 0) + 1 : 0;
  }

  try {
    // ── Library ────────────────────────────────────────────────────────────
    // Legacy (pre-library clients): live exercises bucketed by their old day.
    if (req.method === 'GET' && action === 'get_exercises') {
      const day = url.searchParams.get('day');
      let q = supabase.from('exercises').select('*').eq('is_deleted', false).order('day').order('sort_order');
      if (day) q = q.eq('day', day);
      const { data, error } = await q;
      if (error) throw error;
      return json(data);
    }

    // Every exercise (archived included, so history can always resolve a
    // name), each day it is used on, and its logged-set stats.
    if (req.method === 'GET' && action === 'get_library') {
      const { data: exs, error } = await supabase.from('exercises').select('*').order('name');
      if (error) throw error;
      const { data: slots, error: sErr } = await supabase.from('program_slots')
        .select('id, day, sort_order, exercise_id, superset_group').order('day').order('sort_order');
      if (sErr) throw sErr;
      const rows = await fetchAll<{ exercise_id: number; date: string }>((a, b) =>
        supabase.from('workouts').select('exercise_id, date').order('id').range(a, b));
      const stats: Record<number, { sets: number; last: string | null; sessions: Set<string> }> = {};
      for (const r of rows) {
        const s = (stats[r.exercise_id] ||= { sets: 0, last: null, sessions: new Set() });
        s.sets++; s.sessions.add(r.date);
        if (!s.last || r.date > s.last) s.last = r.date;
      }
      return json({
        exercises: (exs ?? []).map(e => ({
          ...e,
          days: (slots ?? []).filter(s => s.exercise_id === e.id).map(s => s.day),
          n_sets: stats[e.id]?.sets ?? 0,
          n_sessions: stats[e.id]?.sessions.size ?? 0,
          last_date: stats[e.id]?.last ?? null,
        })),
        slots: slots ?? [],
      });
    }

    // The program: each day's slots with the linked exercise embedded.
    if (req.method === 'GET' && action === 'get_program') {
      const { data, error } = await supabase.from('program_slots')
        .select('id, day, sort_order, superset_group, exercise_id, exercise:exercises(*)')
        .order('day').order('sort_order').order('id');
      if (error) throw error;
      return json(data);
    }

    if (req.method === 'POST' && action === 'save_exercise') {
      const ex = await req.json();
      const name = typeof ex.name === 'string' ? ex.name.trim() : '';
      if (!name) return bad('name is required');
      const fields: Record<string, unknown> = {
        name,
        alt: (typeof ex.alt === 'string' && ex.alt.trim()) ? ex.alt.trim() : null,
        ds: Math.min(20, Math.max(1, parseInt(ex.ds, 10) || 3)),
        rt: (typeof ex.rt === 'string' && ex.rt.trim()) ? ex.rt.trim() : '8-10',
        dw: numOrNull(ex.dw, -1000, 10000) ?? 0,
        u: typeof ex.u === 'string' ? ex.u.trim() : 'lb',
        rest_s: restVal(ex.rest_s),
        updated_at: new Date().toISOString(),
      };
      if (ex.muscle !== undefined) fields.muscle = (typeof ex.muscle === 'string' && ex.muscle.trim()) ? ex.muscle.trim() : null;
      if (ex.step !== undefined) {
        const st = Number(ex.step);
        if (Number.isFinite(st) && st > 0) fields.step = st;
      }
      if (isId(ex.id)) {
        const { data: existing, error: gErr } = await supabase
          .from('exercises').select('name, historical_names').eq('id', ex.id).maybeSingle();
        if (gErr) throw gErr;
        if (!existing) return bad('exercise not found');
        const historical: string[] = Array.isArray(existing.historical_names) ? [...existing.historical_names] : [];
        if (existing.name && existing.name !== name && !historical.includes(existing.name)) historical.push(existing.name);
        const { data, error } = await supabase.from('exercises')
          .update({ ...fields, historical_names: historical }).eq('id', ex.id).select().single();
        if (error) throw error;
        return json(data);
      }
      const { data, error } = await supabase.from('exercises')
        .insert({ ...fields, day: DAYS.includes(ex.day) ? ex.day : null, sort_order: 999 }).select().single();
      if (error) throw error;
      // A legacy client adding "to this day" expects it to show up there.
      if (DAYS.includes(ex.day)) {
        await supabase.from('program_slots').insert({ day: ex.day, exercise_id: data.id, sort_order: await nextSortOrder(ex.day) });
      }
      return json(data);
    }

    // Archive (soft delete): leaves history intact, takes it off every day.
    if (req.method === 'POST' && (action === 'archive_exercise' || action === 'delete_exercise')) {
      const { id } = await req.json();
      if (!isId(id)) return bad('id required');
      const { error: sErr } = await supabase.from('program_slots').delete().eq('exercise_id', id);
      if (sErr) throw sErr;
      const { error } = await supabase.from('exercises')
        .update({ is_deleted: true, updated_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
      return json({ success: true });
    }

    if (req.method === 'POST' && action === 'restore_exercise') {
      const { id } = await req.json();
      if (!isId(id)) return bad('id required');
      const { data, error } = await supabase.from('exercises')
        .update({ is_deleted: false, updated_at: new Date().toISOString() }).eq('id', id).select().single();
      if (error) throw error;
      return json(data);
    }

    // Fold a duplicate into another exercise: its logged sets, its day slots
    // and its name(s) move over, then it is archived.
    if (req.method === 'POST' && action === 'merge_exercises') {
      const { from, into } = await req.json();
      if (!isId(from) || !isId(into) || from === into) return bad('from and into must be two different ids');
      const { data: pair, error: pErr } = await supabase.from('exercises')
        .select('id, name, historical_names').in('id', [from, into]);
      if (pErr) throw pErr;
      const src = pair?.find(e => e.id === from), dst = pair?.find(e => e.id === into);
      if (!src || !dst) return bad('exercise not found');

      // Refuse if both were logged in the same session — the sets would collide.
      const key = (r: { date: string; day: string }) => `${r.date}|${r.day}`;
      const srcRows = await fetchAll<{ date: string; day: string }>((a, b) =>
        supabase.from('workouts').select('date, day').eq('exercise_id', from).range(a, b));
      const dstRows = await fetchAll<{ date: string; day: string }>((a, b) =>
        supabase.from('workouts').select('date, day').eq('exercise_id', into).range(a, b));
      const dstKeys = new Set(dstRows.map(key));
      const clash = [...new Set(srcRows.map(key).filter(k => dstKeys.has(k)))];
      if (clash.length) {
        return json({ error: `Both were logged in the same session on ${clash.slice(0, 3).join(', ')} — merge refused so no sets collide.` }, 409);
      }

      const { error: wErr } = await supabase.from('workouts').update({ exercise_id: into }).eq('exercise_id', from);
      if (wErr) throw wErr;

      const { data: srcSlots, error: ssErr } = await supabase.from('program_slots').select('id, day').eq('exercise_id', from);
      if (ssErr) throw ssErr;
      const { data: dstSlots, error: dsErr } = await supabase.from('program_slots').select('day').eq('exercise_id', into);
      if (dsErr) throw dsErr;
      const dstDays = new Set((dstSlots ?? []).map(s => s.day));
      for (const s of srcSlots ?? []) {
        const q = dstDays.has(s.day)
          ? supabase.from('program_slots').delete().eq('id', s.id)
          : supabase.from('program_slots').update({ exercise_id: into, updated_at: new Date().toISOString() }).eq('id', s.id);
        const { error } = await q;
        if (error) throw error;
      }

      const names = new Set<string>([...(dst.historical_names ?? []), src.name, ...(src.historical_names ?? [])]);
      names.delete(dst.name);
      const { error: hErr } = await supabase.from('exercises')
        .update({ historical_names: [...names], updated_at: new Date().toISOString() }).eq('id', into);
      if (hErr) throw hErr;
      const { error: aErr } = await supabase.from('exercises')
        .update({ is_deleted: true, updated_at: new Date().toISOString() }).eq('id', from);
      if (aErr) throw aErr;
      return json({ success: true, moved_sets: srcRows.length });
    }

    // ── Program slots ──────────────────────────────────────────────────────
    if (req.method === 'POST' && action === 'add_slot') {
      const { day, exercise_id } = await req.json();
      if (!DAYS.includes(day) || !isId(exercise_id)) return bad('day and exercise_id required');
      const { data, error } = await supabase.from('program_slots')
        .insert({ day, exercise_id, sort_order: await nextSortOrder(day) })
        .select('id, day, sort_order, superset_group, exercise_id, exercise:exercises(*)').single();
      if (error) throw error;
      return json(data);
    }

    if (req.method === 'POST' && action === 'remove_slot') {
      const { id } = await req.json();
      if (!isId(id)) return bad('id required');
      const { error } = await supabase.from('program_slots').delete().eq('id', id);
      if (error) throw error;
      return json({ success: true });
    }

    // Point a slot at a different library exercise (a swap made permanent).
    if (req.method === 'POST' && action === 'set_slot_exercise') {
      const { id, exercise_id } = await req.json();
      if (!isId(id) || !isId(exercise_id)) return bad('id and exercise_id required');
      const { data, error } = await supabase.from('program_slots')
        .update({ exercise_id, updated_at: new Date().toISOString() }).eq('id', id)
        .select('id, day, sort_order, superset_group, exercise_id, exercise:exercises(*)').single();
      if (error) {
        if ((error as { code?: string }).code === '23505') return json({ error: 'That exercise is already on this day.' }, 409);
        throw error;
      }
      return json(data);
    }

    // Order and superset links: [{id, sort_order?, superset_group?}].
    if (req.method === 'POST' && (action === 'update_slots' || action === 'reorder_slots')) {
      const { updates, orders } = await req.json();
      const list = Array.isArray(updates) ? updates : Array.isArray(orders) ? orders : null;
      if (!list) return bad('updates must be an array');
      for (const u of list as { id: number; sort_order?: number; superset_group?: number | null }[]) {
        if (!isId(u.id)) continue;
        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (Number.isInteger(u.sort_order)) patch.sort_order = u.sort_order;
        if (u.superset_group === null || Number.isInteger(u.superset_group)) patch.superset_group = u.superset_group;
        const { error } = await supabase.from('program_slots').update(patch).eq('id', u.id);
        if (error) throw error;
      }
      return json({ success: true });
    }

    // Library page: which days an exercise belongs to. Adds at the end of a
    // newly ticked day, removes it from unticked ones.
    if (req.method === 'POST' && action === 'set_exercise_days') {
      const { exercise_id, days } = await req.json();
      if (!isId(exercise_id) || !Array.isArray(days)) return bad('exercise_id and days required');
      const want = new Set(days.filter((d: string) => DAYS.includes(d)));
      const { data: cur, error } = await supabase.from('program_slots').select('id, day').eq('exercise_id', exercise_id);
      if (error) throw error;
      const have = new Set((cur ?? []).map(s => s.day));
      for (const s of cur ?? []) {
        if (!want.has(s.day)) {
          const { error: e } = await supabase.from('program_slots').delete().eq('id', s.id);
          if (e) throw e;
        }
      }
      for (const d of want) {
        if (!have.has(d)) {
          const { error: e } = await supabase.from('program_slots')
            .insert({ day: d, exercise_id, sort_order: await nextSortOrder(d) });
          if (e) throw e;
        }
      }
      return json({ success: true, days: [...want] });
    }

    // Legacy reorder from pre-library clients.
    if (req.method === 'POST' && action === 'reorder_exercises') {
      const { orders } = await req.json();
      if (!Array.isArray(orders)) return bad('orders must be an array');
      for (const o of orders as { id: number; sort_order: number }[]) {
        const { error } = await supabase.from('exercises').update({ sort_order: o.sort_order }).eq('id', o.id);
        if (error) throw error;
      }
      return json({ success: true });
    }

    // ── Logged sets ────────────────────────────────────────────────────────
    if (req.method === 'GET' && action === 'get_today') {
      const day  = url.searchParams.get('day');
      const date = url.searchParams.get('date');
      const { data, error } = await supabase
        .from('workouts').select('*').eq('day', day).eq('date', date)
        .order('exercise_id').order('set_number', { ascending: true });
      if (error) throw error;
      return json(data);
    }

    if (req.method === 'GET' && action === 'get_last_session') {
      const day  = url.searchParams.get('day');
      const date = url.searchParams.get('date');
      const { data, error } = await supabase
        .from('workouts').select('*').eq('day', day).lt('date', date)
        .order('date', { ascending: false }).order('set_number', { ascending: true }).limit(300);
      if (error) throw error;
      if (!data || data.length === 0) return json([]);
      const mostRecentDate = data[0].date;
      return json(data.filter((r: Record<string,unknown>) => r.date === mostRecentDate));
    }

    if (req.method === 'GET' && action === 'get_by_day') {
      const day = url.searchParams.get('day');
      const data = await fetchAll((a, b) => supabase
        .from('workouts').select('*').eq('day', day)
        .order('date', { ascending: false }).order('set_number', { ascending: true }).order('id').range(a, b));
      return json(data);
    }

    // History for specific exercises on any day — progression and charts
    // follow the movement, not the day it was logged under.
    if (req.method === 'GET' && action === 'get_by_exercises') {
      const ids = (url.searchParams.get('ids') || '').split(',').map(s => parseInt(s, 10)).filter(n => n > 0);
      if (!ids.length) return json([]);
      const before = url.searchParams.get('before');
      const data = await fetchAll((a, b) => {
        let q = supabase.from('workouts').select('*').in('exercise_id', ids.slice(0, 100));
        if (before && /^\d{4}-\d{2}-\d{2}$/.test(before)) q = q.lt('date', before);
        return q.order('date', { ascending: false }).order('set_number', { ascending: true }).order('id').range(a, b);
      });
      return json(data);
    }

    if (req.method === 'POST' && action === 'save_session') {
      const { date, day, rows } = await req.json();
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof day !== 'string' || !day) {
        return bad('date (YYYY-MM-DD) and day are required');
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        return json({ success: true, inserted: 0 });
      }

      // Resolve missing exercise_id from exercise name (stale clients only).
      const namesNeedingResolve = [...new Set(
        rows.filter((r: any) => (r.exercise_id == null || typeof r.exercise_id !== 'number') && r.exercise)
            .map((r: any) => r.exercise)
      )];
      const nameToId: Record<string, number> = {};
      if (namesNeedingResolve.length > 0) {
        const { data: existing } = await supabase
          .from('exercises').select('id, name, historical_names').eq('is_deleted', false);
        for (const ex of existing || []) {
          nameToId[ex.name] = ex.id;
          for (const old of (ex.historical_names || [])) {
            if (!nameToId[old]) nameToId[old] = ex.id;
          }
        }
        const unresolved = namesNeedingResolve.filter((n: string) => !nameToId[n]);
        for (const name of unresolved) {
          const { data: created, error: createErr } = await supabase.from('exercises').insert({
            day, name, ds: 3, rt: '8-10', dw: 0, u: 'lb', sort_order: 999,
          }).select().single();
          if (createErr) throw createErr;
          if (created) nameToId[name] = created.id;
        }
      }

      const cleanRows = rows.map((r: any) => ({
        ...r,
        exercise_id: typeof r.exercise_id === 'number' ? r.exercise_id : (nameToId[r.exercise] ?? null),
      })).filter((r: any) => r.exercise_id != null && Number.isInteger(Number(r.set_number)));

      if (cleanRows.length === 0) {
        return json({ error: 'No valid exercises in payload', received_rows: rows.length }, 400);
      }

      const payload = cleanRows.map((r: Record<string, unknown>) => ({
        date, day,
        exercise_id: r.exercise_id,
        exercise: String(r.exercise ?? ''),
        set_number: Number(r.set_number),
        weight: numOrNull(r.weight, -1000, 10000),
        reps:   intOrNull(r.reps, 0, 10000),
        done:   r.done === true,
        rir:    intOrNull(r.rir, 0, 5),
        started_at:   tsOrNull(r.started_at),
        completed_at: tsOrNull(r.completed_at),
        saved_at: new Date().toISOString(),
      }));

      // UPSERT on (date, day, exercise_id, set_number) is one statement — if it
      // fails the previous session is untouched — then prune sets that are no
      // longer part of the session (e.g. an exercise swapped out today).
      const { data: kept, error: upErr } = await supabase
        .from('workouts')
        .upsert(payload, { onConflict: 'date,day,exercise_id,set_number' })
        .select('id');
      if (upErr) throw upErr;

      const keepIds = (kept ?? []).map((r: { id: string }) => r.id);
      let prune = supabase.from('workouts').delete().eq('date', date).eq('day', day);
      if (keepIds.length) prune = prune.not('id', 'in', `(${keepIds.map(id => `"${id}"`).join(',')})`);
      const { error: pruneErr } = await prune;

      return json({
        success: true,
        inserted: keepIds.length,
        skipped: rows.length - cleanRows.length,
        ...(pruneErr ? { warning: 'saved, but stale sets were not pruned: ' + pruneErr.message } : {}),
      });
    }

    return bad('Unknown action: ' + action);
  } catch (e) {
    return json({ error: (e as Error).message ?? String(e) }, 500);
  }
});
