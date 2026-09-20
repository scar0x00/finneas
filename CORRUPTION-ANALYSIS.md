# Analysis: Machine-wide `node_modules` corruption (hono / grammy / undici-types / zod)

**Date of analysis:** 2026-09-18 (evening, EDT)
**Trigger:** `TS2339: Property 'get' does not exist on type 'Hono<...>'` in `finneas-finances-api/src/index.ts:5`
**Scope of findings:** the `finneas` repo, two other repos (`~/Repos/hyperdrive`, `~/Repos/remain-monorepo`), and the shared pnpm store
**Status:** root cause of the *rewrite event* narrowed to a ~5-minute window with a prime suspect, but not conclusively attributed (agent transcript not retained). All other mechanics fully established with on-disk evidence.

---

## TL;DR

1. The TypeScript error was **not** caused by your code, config, or the hono release. It was caused by **corrupted hono type-declaration files inside `node_modules`** whose relative imports had been rewritten to bogus pnpm virtual-store paths.
2. The corruption is **machine-wide**: ~192 declaration files across 5 projects in 3 repos, plus ~143 corrupted copies inside the pnpm store itself (`files/`, `links/`, `global/`), covering **4 packages**: `hono`, `@grammyjs/types`, `undici-types`, `zod`.
3. The propagation mechanism is **pnpm hard links**: byte-identical `.d.ts` files are shared via one inode across *every* version and project that contains them. Hono's `dist/types/types.d.ts` is identical from 4.12.33 → 4.13.8, so **one single in-place edit** at 15:27:25 corrupted 7 different installs simultaneously — across different versions and different repos — while `node_modules` copies of *other* packages were hit in the same window by separate shared inodes.
4. The **npm registry is exonerated**: the published `hono@4.13.8` tarball is clean, its integrity hash matches what your git-HEAD lockfile recorded, and a clean-room install in `/tmp` typechecks fine.
5. **The sibling projects did not cause the problem** — they are co-victims. All three `finneas` projects (plus hyperdrive and remain-monorepo) were rewritten in the **same 5-minute window (15:27:04–15:31:58)**, which is only possible through the shared store, not through any per-project config.
6. Prime suspect for the rewriting actor: **an opencode agent session opened in `finneas-finances-api` at 15:26:25** — the first corrupted write landed 39 seconds later, and that session demonstrably operated across projects during the window (`finneas-tg-bot/.dev.vars` edited at 15:33:48). The session's transcript was not retained, so this is circumstantial but strong.

---

## 1. The original error and how it was fixed

```
src/index.ts(5,5): error TS2339: Property 'get' does not exist on type
'Hono<{ Bindings: CloudflareBindings; }, BlankSchema, "/">'.
src/index.ts(5,15): error TS7006: Parameter 'c' implicitly has an 'any' type.
```

**Cause chain:** `Hono` (in `hono/dist/types/hono.d.ts`) extends `HonoBase` (in `hono-base.d.ts`), which declares `.get()`, `.post()`, etc. The corrupted files rewrote that internal import to a non-resolvable specifier:

```ts
// hono.d.ts, corrupted
import { HonoBase } from '.pnpm/hono@4.13.8/node_modules/hono/hono-base';
```

TypeScript could not resolve `.pnpm/hono@4.13.8/...` as a module path, so `HonoBase` became `any`, the inheritance chain broke, and every `HonoBase` member vanished from the `Hono` type.

**Fix applied in the evening session:** pin `hono` to exactly `4.13.7` (no caret) and add `typescript@7.0.2` as devDependency → `pnpx tsc --noEmit` passed. Verified by A/B: reinstalling 4.13.8 (from the then-corrupted store) reproduced the exact error; restoring 4.13.7 passed again.

> ⚠️ **Current state of `finneas-finances-api/package.json`:** `"hono": "^4.13.7"` — the *exact* pin was lost/reverted at some point, and the lockfile resolves back to `4.13.8`. `node_modules/hono` currently symlinks to a **clean** `4.13.8` copy (materialized during the evening reinstalls, after the store entry had been repaired). This inconsistency should be reconciled — see §8.

---

## 2. What the corruption looks like

All four affected packages show the same rewriting pattern: a **relative import specifier replaced by a path relative to the enclosing `node_modules` directory** (the one that contains `.pnpm`), pointing at the *resolved real location* of the target module.

```ts
// hono@4.13.7 install (finneas-tg-bot) — note it references 4.13.8 paths!
import { HonoBase } from '.pnpm/hono@4.13.8/node_modules/hono/hono-base';

// @grammyjs/types@5.0.0 (finneas-tg-bot)
export * from ".pnpm/@grammyjs+types@5.0.0/node_modules/@grammyjs/types/api";

// undici-types@6.21.0 (extractors + tg-bot)
import { FormData } from '.pnpm/undici-types@6.21.0/node_modules/undici-types/formdata'
```

Observations:

- The rewriter clearly *resolved* each relative specifier to its absolute real path (through pnpm's symlink maze) and then re-emitted it relative to the `node_modules` root. Such specifiers resolve for **nobody** — they're broken from every possible importing location.
- **Cross-version smoking gun:** files inside a `hono@4.13.7` install contain imports to `.pnpm/hono@4.13.8/...`. The rewrite was performed in a context where hono **4.13.8** was the resolved version (i.e., `finneas-finances-api`, which had 4.13.8 at the time, or the global 4.13.8 layout — see §3).
- Every affected file found is a **TypeScript declaration file** (`.d.ts` or `.d.cts`), including 12 zod `v3/v4 .d.cts` files in tg-bot. Under `skipLibCheck: true` these break silently — no error in the d.ts itself, only downstream "type is any / property does not exist" symptoms in user code.
- The corrupted hono `types.d.ts` contains **4 rewritten import lines**; the finances-api 4.13.8 copy (before replacement) had **18 affected files** in `dist/types/` plus a stray whitespace-only line at `hono-base.d.ts:61` — a fingerprint of mechanical text rewriting, not of a build artifact.

---

## 3. Why one edit poisoned seven installs (the hard-link mechanic)

pnpm stores every file **content-addressed** in `~/.local/share/pnpm/store/v11/files/` and hard-links it into every `node_modules` that needs it. Two consequences, both confirmed on disk:

**a) Identical files across versions share ONE inode.** Hono's `dist/types/types.d.ts` is byte-identical from 4.12.33 through 4.13.8. `stat` showed the tg-bot copy has **8 hard links**, and `find -samefile` located them all:

| # | Location | hono version |
|---|----------|--------------|
| 1 | `~/Repos/finneas/finneas-tg-bot/node_modules/.pnpm/hono@4.13.7/...` | 4.13.7 |
| 2 | `~/Repos/finneas/finneas-finances-api/node_modules/.pnpm/hono@4.13.8/...` *(replaced during evening session)* | 4.13.8 |
| 3 | `~/Repos/hyperdrive/node_modules/.pnpm/hono@4.13.5/...` | 4.13.5 |
| 4 | `~/Repos/remain-monorepo/frontend/node_modules/.pnpm/hono@4.13.2/...` | 4.13.2 |
| 5 | `~/Repos/remain-monorepo/main-backend/node_modules/.pnpm/hono@4.12.34/...` | 4.12.34 |
| 6 | `~/.local/share/pnpm/global/v11/7bc4-18d6412d41aba651-0/.../hono@4.13.8/...` | 4.13.8 (global) |
| 7 | `~/.local/share/pnpm/store/v11/links/@/hono/4.13.2/...` | 4.13.2 (dlx cache) |
| 8 | `~/.local/share/pnpm/store/v11/links/@/hono/4.13.3/...` and `.../4.12.33/...` | (same-file scan showed these layouts share the inode too) |

All copies carry the corrupted content **and the identical mtime `2026-09-18 15:27:25.581432604`** — the same nanosecond, because they *are* the same file. One write anywhere in that list corrupted everything else instantly. The same mechanism hit `undici-types` (shared between extractors + tg-bot, edited 15:27:04) and `@grammyjs/types` (edited 15:31:58) — i.e., the rewriter ran sequentially over many files for at least ~5 minutes.

**b) The store's pristine copy diverged from the corrupted inode.** The content-addressed `files/` copy of that hono `types.d.ts` is **clean** and is *not* the same inode. At some point pnpm re-materialized/repaired the store entry (consistent with `finneas-finances-api` receiving clean 4.13.8 files during the evening reinstalls), leaving the corrupted inode orphaned in `links/`, `global/`, and project `node_modules`. However — **the store is not fully clean**: a full scan of `files/` still finds **64 files** containing the corrupted-import signature (undici-types etc.), plus **79** in `links/`+`global/`. Future installs can re-materialize corruption from these until they're purged (§8).

---

## 4. Timeline (2026-09-18, local EDT)

| Time | Event | Evidence |
|---|---|---|
| 14:13 | `npm list --global --depth 0` from `~/Repos/finneas/register-bot` (dir no longer exists — pre-restructure) | `~/.npm/_logs/2026-09-18T18_13_14_363Z-debug-0.log` |
| 15:06 | Repo restructured: `AGENTS.md`, `extractors/`, `finneas-tg-bot/`, `.gitignore` etc. stamped | file mtimes |
| **15:26:25** | **`.opencode/opencode.jsonc` created in `finneas-finances-api`** → an opencode session was opened here | file mtime |
| **15:27:04.911** | **`undici-types` d.ts files rewritten** (shared inode: extractors + tg-bot) | file mtime |
| **15:27:25.581** | **hono `types.d.ts` rewritten** (one inode → 7 installs, 4 versions, 3 repos) | identical mtime on all links |
| 15:28:46 | Screenshot taken (user investigating) | `~/Pictures/Screenshots/…15-28-46.png` |
| **15:31:58.137** | **`@grammyjs/types` d.ts rewritten** | file mtime |
| **15:33:48** | `finneas-tg-bot/.dev.vars` modified — session activity in the *sibling* project | file mtime |
| 15:37:53 | Second screenshot | `~/Pictures/Screenshots/…15-37-53.png` |
| 15:38:44 | pnpm store `projects/` record updated → `pnpm install` ran | store file mtime |
| 15:38:49 / 15:39:17 | `wrangler` ran twice against `finneas-finances-api` | `~/.config/.wrangler/logs/wrangler-2026-09-18_19-38-49_385.log` (+19-39-17) |
| ~22:00–24:00 | Evening session (this analysis): exact-pin fix, A/B verification, clean-room repro, forensics | `opencode.log` run `4b88f92d` |

The corruption writes sit **inside** the window of active tool use (opencode session + pnpm + wrangler + screenshots). First write is **39 seconds** after the opencode config file was created.

---

## 5. Blast radius

Corrupted **declaration files** found by scanning for `from .pnpm/` / `from ".pnpm/` specifiers:

| Location | Files | Packages hit |
|---|---|---|
| `finneas/finneas-finances-api/node_modules` | **0** now (was **18** in hono@4.13.8; replaced during evening reinstalls) | hono |
| `finneas/finneas-tg-bot/node_modules` | **84** (72 `.d.ts` + 12 zod `.d.cts`) | hono, @grammyjs/types, undici-types, zod |
| `finneas/extractors/node_modules` | **29** | undici-types |
| `~/Repos/hyperdrive/node_modules` | **18** | hono |
| `~/Repos/remain-monorepo/{frontend,main-backend}` | **61** | hono (4.13.2 + 4.12.34) |
| pnpm store `files/` (content-addressed) | **64** | undici-types et al. |
| pnpm store `links/` + `global/` | **79** | hono et al. |
| **Total** | **≈ 335** | 4 packages |

Also observed in tg-bot: an **orphaned** `node_modules/.pnpm/hono@4.13.7` directory that is **not referenced by its `pnpm-lock.yaml`** (leftover from the pre-restructure `register-bot` project / corruption era). A clean reinstall will remove it.

---

## 6. Hypotheses tested and ruled out

| Hypothesis | Verdict | Evidence |
|---|---|---|
| Bad `hono@4.13.8` publish on npm | **Ruled out** | Registry tarball integrity `sha512-/Gng7NfoykZl2pjuk…` **matches** git-HEAD lockfile entry; unpkg copy clean; clean-room install in `/tmp/opencode/hono-repro` (4.13.8 + tsc 7.0.2) passes `tsc --noEmit` |
| Registry mirror / proxy serving different bytes | **Ruled out** | No `.npmrc` anywhere (home, repo root, projects); registry = `https://registry.npmjs.org/` |
| Sibling projects / "monorepo" coupling | **Ruled out as cause** | No root `pnpm-workspace.yaml` linking packages, independent lockfiles, no shared installs; `extractors` has **no hono**; siblings share only the global store — which is the *propagation* vector, not the cause. All three were hit in the same window → co-victims |
| TypeScript compiler / `tsc` rewriting files | **Ruled out** | `tsc` never modifies existing `node_modules` files in place |
| `wrangler types` | **Ruled out** | Only generates `worker-configuration.d.ts`; wrangler activity (15:38) *postdates* the corruption (15:27–15:32) |
| pnpm serving a corrupted tarball from store | **Partially superseded** | The store *does* currently contain 64 corrupted files, but the original tarball bytes matched the lockfile integrity — the corrupted store content is a **post-download modification** of specific files, not a bad fetch |
| pnpm version / node-linker config issue | **Ruled out as trigger** | Configs are default; the observed rewrite pattern is not produced by any pnpm feature |

---

## 7. Prime suspect for the rewriting actor (open question)

**Most probable: the opencode agent session opened at 15:26:25 in `finneas-finances-api`.**

Supporting evidence:
- Session config created 39s before the first corrupted write; `.dev.vars` of the *sibling* tg-bot project edited mid-window (cross-project agent activity); pnpm + wrangler runs immediately after.
- The rewrite style (resolve → relativize against `node_modules` root → write back) is characteristic of an automated "fix broken module resolution" pass over `node_modules` — the kind of script an agent writes when told to fix import errors, iterated across packages/projects.
- The user was actively screenshotting (15:28, 15:37) — investigating this very problem area.

**Why not conclusive:** the session transcript was not retained. `~/.local/share/opencode/log/opencode.log` contains only the current evening session (run `4b88f92d`); prior rotated logs are from May. Bash/zsh history has no relevant commands. `.claude` / `.gemini` dirs were untouched today.

**Ask of the user:** do you recall what you asked the AI session this afternoon (~15:26–15:40)? If you asked it to "fix" TypeScript import/resolution errors, that session's script is the likely culprit. The screenshots from 15:28/15:37 may show its output.

---

## 8. Recommended remediation

1. **Purge corrupted content from the shared store** (do this *before* reinstalling, or corruption re-materializes):
   ```bash
   # surgical: remove every corrupted file; pnpm re-fetches on next install
   grep -rlE "from ['\"]\.pnpm/" ~/.local/share/pnpm/store/v11/files | xargs rm -f
   rm -rf ~/.local/share/pnpm/store/v11/links
   rm -rf ~/.local/share/pnpm/global/v11/7bc4-18d6412d41aba651-0
   ```
   (Nuclear alternative: `rm -rf ~/.local/share/pnpm/store/v11/files` — forces full re-download everywhere.)
2. **Reinstall every affected project** (`finneas-finances-api`, `finneas-tg-bot`, `extractors`, `~/Repos/hyperdrive`, `~/Repos/remain-monorepo/*`):
   ```bash
   rm -rf node_modules && pnpm install
   ```
3. **Verify:** signature scan returns 0 in all projects + store; `pnpx tsc --noEmit` passes per project.
4. **Reconcile the hono pin in `finneas-finances-api`:** currently `"^4.13.7"` with lockfile at 4.13.8. Either re-apply the exact `"4.13.7"` pin, or — since the registry copy is proven clean — intentionally keep 4.13.8 after the store purge.
5. **Guard rails going forward:**
   - Never edit anything under `node_modules` (or the store) in place — pnpm hard links mean an edit in one project silently corrupts every other project sharing that inode, across versions.
   - Use `pnpm patch` for deliberate package overrides instead of hand edits.
   - Be careful granting agent sessions permission to run bulk "fix" scripts across `node_modules` or multiple repos.

---

## Appendix — key artifacts and commands used

- **Corruption signature:** `grep -rEl "from ['\"]\.pnpm/" <dir> --include='*.d.ts' --include='*.d.cts'`
- **Inode forensics:** `stat -c 'links=%h inode=%i %n' <file>`; `find <store> -samefile <file>`
- Corrupted example: `finneas-tg-bot/node_modules/.pnpm/hono@4.13.7/.../dist/types/types.d.ts:6` → `import type { HonoBase } from '.pnpm/hono@4.13.8/node_modules/hono/hono-base';` (4 rewritten lines, inode 11825723, 8 links, mtime `2026-09-18 15:27:25.581432604 -0400`)
- Store: `~/.local/share/pnpm/store/v11/{files,links,projects,index.db}`; global layout `~/.local/share/pnpm/global/v11/7bc4-…`
- Clean-room repro: `/tmp/opencode/hono-repro` (hono 4.13.8 fresh from registry → `tsc` exit 0)
- `hono@4.13.8` published 2026-09-15T07:31:34.010Z; `4.13.7` published 2026-09-04; integrity of 4.13.8: `sha512-/Gng7NfoykZl2pjukW5Z6+8Yxm3BPRf86GTbQnt0SbySkvax4fyL4H3HhY1cCpBGmiW9XDRFzRV+CXK2W8QudQ==` (matches git-HEAD lockfile)
- Scratch files from this analysis: `/tmp/opencode/tgbot-all.txt`, `/tmp/opencode/tgbot-ts.txt`, `/tmp/opencode/hono-repro/`
