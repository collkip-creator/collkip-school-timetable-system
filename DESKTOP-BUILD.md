# Collkip School Timetable System — Windows Desktop Build (Phase 1E)

## What this prepares

The application now has explicit Tauri development/build commands and a GitHub Actions workflow that can compile the Windows desktop shell and publish the generated installer as a downloadable workflow artifact. The hosted AppDeploy deployment validates the web application only; it does **not** compile Rust/Tauri or prove native SQLite behavior.

## Build on a Windows development machine

Prerequisites:
- Windows 10/11, 64-bit
- Node.js 22 LTS and npm
- Rust stable with the MSVC toolchain
- Microsoft C++ Build Tools (Desktop development with C++)
- WebView2 Runtime (normally present on current Windows installations)

From the project root:

```powershell
npm ci
npm run desktop:dev
```

To create a release installer:

```powershell
npm run desktop:build
```

The NSIS installer should be generated under `src-tauri/target/release/bundle/nsis/`. Confirm the actual output path from the build log rather than assuming the build succeeded.

## Build using GitHub Actions

1. Export or place the complete project source in a GitHub repository.
2. Ensure `package-lock.json` is committed and matches `package.json`.
3. Push the source to the `main` branch, or open Actions and manually run **Build Collkip Windows Desktop**.
4. Wait for the workflow to pass. Download the `collkip-windows-installer` artifact from that successful run.
5. Do not distribute an installer from a failed or unverified workflow run.

The workflow file is `.github/workflows/windows-desktop.yml`. It runs on a Windows runner, installs Node/Rust prerequisites, invokes `npm run desktop:build`, and uploads NSIS/MSI files if present.

## Phase 1E acceptance checklist — must be tested on Windows

- [ ] `npm ci` completes without dependency or lockfile errors.
- [ ] `npm run build` completes successfully.
- [ ] `npm run desktop:dev` opens the native desktop window and initializes SQLite.
- [ ] Create or edit a test school record, close the application fully, reopen it, and verify the record remains.
- [ ] Add a scheduling constraint and a timetable candidate; close/reopen and verify both remain.
- [ ] Disconnect the internet and confirm core school setup, timetable generation, validation, editing, and printing still work.
- [ ] Verify an existing SQLite value is not overwritten by a stale browser-storage value on startup.
- [ ] Verify the database survives application restart and Windows reboot.
- [ ] Test a clean first launch with no existing database and confirm the database/table are created.
- [ ] Test backup and restore once those workflows are available; do not treat this checklist as proof backup/restore exists yet.
- [ ] Confirm the installer installs, launches, and uninstalls cleanly on a separate Windows test account or machine.
- [ ] Record the installer version and SHA-256 checksum before distribution.

## Important data migration limitation

The current startup migration copies recognized keys from `localStorage` that are accessible to the desktop WebView into SQLite, only when the corresponding SQLite key does not already exist. It does **not** automatically read data stored in a separate browser profile or the hosted AppDeploy website. Browser data in the hosted website is origin/profile-specific. A dedicated export/import workflow is needed if you want to move hosted browser workspace data into the Windows desktop app.

## Current status

This phase prepares the native build path; it does not claim the Windows installer has been compiled or tested. Complete the Windows build and acceptance checklist above before calling the desktop release verified. The timetable engine in `src/scheduler.ts` is intentionally unchanged.
