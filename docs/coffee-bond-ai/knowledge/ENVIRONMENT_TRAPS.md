# Environment Traps

Each of these cost real debugging time. All present as **silent hangs or misleading
errors** — check here before diagnosing.

## 1. Tailwind v4 scan escape in git worktrees — FIXED

**Symptom:** `vite build` prints `transforming...` and hangs indefinitely at 0% CPU.
No error, ever.

**Cause:** `frontend/index.css` used `@import "tailwindcss"` with no `@source` and no
`tailwind.config.*`. Tailwind v4 auto-detects its scan root by walking up for a `.git`
**directory**. In a git worktree `.git` is a **file** (a pointer), so detection escaped to
the shared parent and scanned ~40 sibling repositories, reading their test fixtures and
READMEs looking for class names. Caught red-handed via `lsof` on the stalled process.

**Fix, in `frontend/index.css`:**

```css
@import "tailwindcss" source(none);
@source ".";
@source "../index*.html";
```

`@source` alone does **not** fix it — in v4 it *adds* paths. Only `source(none)` disables
auto-detection.

**Result:** customer build went from an indefinite hang to ~3 seconds.

This is a **generic repository fix**, not a preview workaround — it affects any worktree
checkout and both staff and customer builds. Preserve it.

## 2. Shared / symlinked `node_modules` between worktrees

**Never share or symlink `node_modules` between Coffee Bond worktrees.**

Both of these must resolve **inside** the active worktree:

```bash
realpath node_modules
realpath functions/node_modules
```

A foreign symlink caused, in sequence:

- **Firebase Functions discovery timeout** — `User code failed to load. Cannot determine
  backend specification. Timeout after 10000`, while a plain `require('./index.js')`
  completed in 164 ms. The discovery server never bound a port and emitted nothing.
- **Misleading module resolution** — vite resolving packages out of a sibling repository.

Fix: give the worktree its own tree with `npm ci` in both the root and `functions/`.

### Do not leave backup symlinks inside `functions/`

Firebase packaging ignores the literal name `node_modules` (default ignore list is
`["node_modules", ".git"]`). A renamed symlink such as `node_modules.foreign-link` is
**not** matched, so packaging follows it into the other repository and hangs at
`preparing functions directory for uploading...` with 0% CPU and zero open TCP sockets.

Park such backups **outside** `functions/`.

## 3. `.env` files are not inherited by a new worktree

`.env*` is gitignored, so `git worktree add` produces a tree that builds successfully but
ships an app with missing or wrong Firebase config.

Required files, per project:

- root `.env` (production), `.env.customer-preview`, `.env.staff-preview`
- `functions/.env.<projectId>` for `defineString` params

## 4. Corrupted preview env values — the `nexport` bug

The staff preview bundle once contained env values with a literal `nexport` suffix:

```
VITE_FIREBASE_API_KEY = "AIza…<redacted>nexport"  ← 46 chars; a real key is 39
VITE_FIREBASE_AUTH_DOMAIN = "…firebaseapp.comnexport"
```

**Symptom:** login failed with *"Email or password is incorrect"*.
**Actual error:** `auth/api-key-not-valid` — HTTP 400 `INVALID_ARGUMENT`, *"API key not
valid"* — rejected at the API-key layer **before any password check**. Resetting the
password could never have fixed it.

Cause: a malformed `.env.staff-preview` where `\nexport` separators lost their backslash.

**Lesson:** when auth fails, capture the real Firebase error code before trusting the UI's
generic message.

## 5. Firebase param resolution ignores `--only`

`defineSecret` / `defineString` params are declared at **module scope**, so they are
codebase-global and land in the discovery spec's top-level `params`. The CLI resolves
**every** param before applying `--only`.

Consequence: you cannot skip a missing secret by narrowing the deploy. All declared
secrets must exist in the target project, and `functions/.env.<projectId>` must define all
string params, even for functions you are not deploying.

## 6. Substring matching on project ids is unsafe

`coffee-bond-pos` is a **prefix** of `coffee-bond-pos-preview`. Never verify a bundle's
target with a substring grep. Extract whole quoted tokens:

```bash
grep -oE '"[A-Za-z0-9-]*coffee-bond[A-Za-z0-9-]*"' dist-customer/assets/*.js | sort -u
```

## 7. Diagnosing hangs

- **Check CPU before assuming a code defect.** A process at 0.0% CPU is blocked, not slow.
- **Check open sockets** — 0 TCP sockets during an "upload" means it is not uploading.
- **Pipe buffering eats diagnostics.** A killed Node process piped to `tail`/`head` loses
  buffered stdout entirely. Redirect to a file, or `fs.appendFileSync` per step.
- `gcloud auth list` reporting "No credentialed accounts" does **not** mean ADC is missing —
  ADC is a separate store. Test with
  `gcloud auth application-default print-access-token >/dev/null; echo $?`.

## 8. Node version

`functions/package.json` pins `engines.node: "20"`. Use `nvm use 20`. Node 22 was
investigated and **ruled out** as a cause of the discovery hang — it behaves identically.
