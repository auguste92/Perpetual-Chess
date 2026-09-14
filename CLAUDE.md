# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Perpetual Chess: a dependency-free vanilla HTML/CSS/JS chess game (playable directly by opening `index.html`, no build step), wrapped with Capacitor into a native Android app. Visual language is deliberately minimal: pure black background, white grid lines only, custom monochrome SVG piece icons (white pieces = hollow outline, black pieces = solid fill). No in-game reset control — reload is the only way to restart a game.

## Commands

**Run the web version**: open `index.html` directly in a browser. No server, no build step.

**Live web deployment**: hosted on GitHub Pages at `https://auguste92.github.io/Perpetual-Chess/`, served directly from the `main` branch root (Settings → Pages → Deploy from a branch → `main` / root) — no build step, no Actions workflow. `.nojekyll` at the repo root skips GitHub's default Jekyll processing since this is plain static HTML/CSS/JS. `manifest.json` + `icon-192.png`/`icon-512.png` make it installable as a home-screen app on both Android and iOS (`display: standalone`); update these together with `index.html` if the app name/icon/theme color ever changes.

**After editing `index.html` / `style.css` / `script.js` / `manifest.json` / the icon PNGs**, the Android app reads from `www/`, not the project root — these are a manual mirror, not a symlink:
```powershell
Copy-Item "index.html","style.css","script.js","manifest.json","icon-192.png","icon-512.png" -Destination "www\" -Force
npx cap sync android
```

**Build a debug APK**:
```powershell
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
cd android
.\gradlew.bat assembleDebug
```
Output: `android\app\build\outputs\apk\debug\app-debug.apk`

**Build a signed release bundle for the Play Store**:
```powershell
.\gradlew.bat bundleRelease
```
Output: `android\app\build\outputs\bundle\release\app-release.aab`. Signing is wired via `android\keystore.properties`, which points at `android\keystore\perpetual-chess-release.jks`. **That keystore is the only way to ever publish an update to the app once it's live on the Play Store — back it up outside this project; if it's lost, updates to the existing listing become impossible.**

PowerShell tool invocations do not persist `$env:` vars between calls — `JAVA_HOME`/`ANDROID_HOME`/`PATH` must be re-set in every command that needs them (Gradle, `adb`, `keytool`, `sdkmanager`, `emulator`).

**No test suite or linter is configured** (`package.json`'s `test` script is an unfilled placeholder).

**iOS/App Store**: not currently buildable — that requires Xcode on macOS, which this Windows environment doesn't have. Would need a cloud macOS CI (Codemagic, GitHub Actions macOS runner) or an actual Mac.

## Architecture

Everything client-side lives in `script.js` as one file, organized top-to-bottom by section comment headers (`/* ---------- ... ---------- */`):

- **Game state** is a single plain object `{ board, turn, castling, enPassant, status }`; `board` is an 8x8 array of `{ type, color } | null`. `cloneState`/`applyMove` are the only functions that mutate/copy it — the AI search clones state per candidate move rather than doing/undoing moves.
- **Move generation is two-phase**: `pseudoMovesForPiece` generates moves ignoring check ("pseudo-legal"), then `legalMovesForPiece`/`allLegalMoves` filter out any that leave the mover's own king in check by cloning + applying + calling `isKingInCheck`. Attack-square detection (`attackSquaresFor`/`isSquareAttacked`) is reused for both check detection and castling-through-check checks.
- **The AI** (`chooseAIMove`) is minimax with alpha-beta pruning (`search`) over `evaluate` (material via `PIECE_VALUE` + positional score via per-piece-type `PST` piece-square tables), with capture-first move ordering (`orderedMoves`).
- **Difficulty is adaptive, not fixed**: `DIFFICULTY_TIERS` is a 0-3 ladder of `{ depth, optimal }`. A human win bumps the tier up, a loss bumps it down (`recordResult`, clamped via `MAX_DIFFICULTY`), and the current tier is persisted to `localStorage` (`perpetualChess.difficulty`) alongside the win/loss tallies (`perpetualChess.wins`/`.losses`) so it survives reloads. At tier 0 the AI sometimes plays a non-optimal tied-score move (`optimal: false`) to give new players a foothold.
- **Rendering is a full re-render on every state change**: `render()` clears and rebuilds the entire `#board` grid from `state`/`selected`/`legalForSelected` — there's no incremental DOM diffing. Piece icons are built as inline SVG (`pieceIcon`) from hand-authored path data in `PIECE_PATHS` (viewBox `0 0 24 24`); there are no image assets or icon fonts for pieces.
- **Turn flow**: `onSquareClick` only accepts input when it's `HUMAN_COLOR`'s turn and `inputLocked` is false. After a human move, `finishMove` checks for checkmate/stalemate, then if it's the AI's turn, sets `inputLocked` and schedules `chooseAIMove` after `AI_MOVE_DELAY` (so the human's move visibly renders before the AI "thinks").
- **Promotion always auto-queens** (`applyMove`) — there's no promotion-choice UI.

### Android wrapper

- `capacitor.config.json` sets `webDir: "www"` — Capacitor packages whatever is in `www/` at `cap sync` time, so that folder must be manually kept in sync with the root web files (see Commands above).
- App icon: black background + white crown (reusing the king's `PIECE_PATHS.k` glyph, scaled into a 108x108 adaptive-icon safe zone) — defined both as vector XML (`android/app/src/main/res/values/ic_launcher_background.xml` + `drawable-v24/ic_launcher_foreground.xml`, used on API 26+) and as baked PNGs per density under `mipmap-*/` (legacy fallback + the actual adaptive-icon foreground layers, since Android resolves `@mipmap/ic_launcher_foreground` to the PNGs, not the same-named vector under `drawable-v24/`). A 512x512 copy for the Play Console store listing lives at `store-assets/play-store-icon-512.png`. Regenerate all of these together if the icon changes — there's a generator script pattern in git history/session logs using `System.Drawing` from PowerShell (no ImageMagick/Node canvas dependency needed).
- `android/app/src/main/res/values/styles.xml` + `colors.xml` force black `windowBackground`/status/nav bars to avoid a white splash flash on launch.
- Toolchain requirements: JDK 21 specifically (Capacitor's Android library fails on JDK 17 with "invalid source release: 21"), Android SDK cmdline-tools/platform-tools/platform/build-tools installed via `sdkmanager`.
