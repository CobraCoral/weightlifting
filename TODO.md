# Iron Log — open items

## 1. Lock down the edge functions (security, not yet done)

**Status:** open · **Found:** 2026-10-17 code review · **Effort:** ~1 hour

### The problem

Both edge functions (`workouts`, `bjj`) run with `verify_jwt: false`, use the
`SUPABASE_SERVICE_ROLE_KEY`, answer CORS `*`, and perform no auth check of their
own. Anyone who knows the function URL can read or delete everything without a key:

```
POST https://skfuygyygrapnrkwzsmj.supabase.co/functions/v1/workouts?action=delete_exercise
{"id": 1}
```

Because the service role bypasses RLS, this hole is **independent** of the
`USING (true)` policies on the tables. Tightening the policies alone would not
close it; the functions have to authenticate the caller.

### Recommended fix: Supabase Auth magic link + `verify_jwt: true`

1. **Supabase dashboard → Authentication → Providers:** enable Email, turn off
   "Enable email signups" after creating the one account (fernando's email), so
   nobody else can register.
2. **Client (`index.html`, `bjj.html`):** add `@supabase/supabase-js` from a CDN,
   `createClient(URL, ANON_KEY)`. On boot, `getSession()`; if none, show a
   one-field email form → `signInWithOtp({ email })`. Session persists in
   localStorage, so this is a once-per-device step. Send
   `Authorization: Bearer <session.access_token>` in `HDRS` instead of the anon
   key (the `apikey` header stays the anon key).
3. **Edge functions:** redeploy both with `verify_jwt: true`. Inside the handler,
   additionally check the caller is the expected user:
   ```ts
   const auth = req.headers.get('Authorization') ?? '';
   const { data: { user } } = await createClient(URL, ANON_KEY,
     { global: { headers: { Authorization: auth } } }).auth.getUser();
   if (!user || user.email !== Deno.env.get('OWNER_EMAIL')) return json({ error: 'forbidden' }, 401);
   ```
   Set `OWNER_EMAIL` as a function secret. Keep the service-role client for the
   actual queries (so no RLS rewrite is needed for the functions themselves).
4. **CORS:** narrow `Access-Control-Allow-Origin` from `*` to the GitHub Pages
   origin (`https://cobracoral.github.io`).
5. **RLS (the second hole):** replace the `USING (true) WITH CHECK (true)` policies
   on `workouts`, `exercises`, `body_comp`, `bjj_*`, `whoop_*`, `handoff_notes`,
   `memory_dump` with `TO authenticated USING (auth.jwt() ->> 'email' = '<owner email>')`
   (or simply drop anon access: `TO authenticated USING (true)`), so direct REST
   access with the publishable key is closed as well.
6. **Verify:** `curl` the function URL with no token → expect 401. Open the app
   on the phone, sign in once, log a set, confirm the save.

### Cheaper stopgap (15 min) if the above has to wait

Shared secret: add `APP_SECRET` as a function secret, send it as an
`x-app-key` header from the client, reject requests without it. Weak (the key
sits in the page source, readable by anyone who opens the HTML), but it stops
drive-by URL abuse and takes a quarter of an hour. Do not treat it as done.

### Related, already fixed on 2026-10-17

- `save_session` is no longer delete-then-insert; it upserts on
  `(date, day, exercise_id, set_number)` and prunes stale sets afterwards, so a
  rejected row can no longer wipe the day.
- Both functions now check every write's error and whitelist writable columns.
- `derive_rep_target()` has a fixed `search_path`.
- The remaining advisor warning, `rls_auto_enable`, is Supabase's own
  event-trigger helper and is not reachable in any useful way over REST.

## 2. Nice-to-haves

- Phase (CUT / BULK) is stored per device in `localStorage`. If the app is used
  on more than one device, tap the chip on each. A `settings` table would make
  it follow the account; not worth it until auth (item 1) exists.
- Festive theme for `bjj.html` (only `index.html` has it).
- `reorder_exercises` is sequential but not transactional; a proper fix is a
  Postgres RPC, which needs a DB migration (the one attempted on 2026-10-17 was
  not approved).
