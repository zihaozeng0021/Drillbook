# Changing the site

Change code only when the user explicitly asks you to change the site.

## Principles

- No new dependencies: the backend uses only the Python standard library; the front end is plain ES modules, with third-party libraries in `web/vendor/`, never loaded from a CDN (the user may be offline, or on a network that can't reach CDNs abroad).
- Keep the file formats under `data/` backward compatible: the old `data/positions/`, `position.json`, `jd.md` and the `company` field must keep loading.
- Interface style: dark navy background; color only encodes data state (Weak / Fair / Mastered / New); no decorative text. Interface text, messages, code comments and docs are in English.

## The Android app

- The Android app (`android/`) is only a WebView shell; the site code is copied in from `web/` at build time. `android/build.py` drives the Android SDK using only the Python standard library, without Gradle. After changing `web/`, run `python android/build.py` to rebuild it.
- Pages in the phone app read and write the phone's own data through `web/js/api.js` (implemented by `web/js/local.js`) and never call the computer directly; when you add or change an interface in `api.js`, implement the same interface in `local.js`.

## Phone–computer sync

- The phone side is in `web/js/phone.js` and `web/js/autosync.js`, the computer side in `apply_phone_sync` in `server.py`.
- Answer records are merged by "time + question", and question reports by "time + question + kind" (both are append-only logs). For notes, if only one side changed, that version is used; if both changed, the later edit wins and the other copy goes to `_history/`. The topic order (drag sorting) works the same way as notes. Each topic's reset time is in `data/records/resets.json`.
- When you change how answer records, question reports, notes or the topic order are stored, take care of all three places. The phone keeps its data in IndexedDB (`web/js/local.js`), so a new store needs a higher `DB_VERSION` and an upgrade step that keeps existing data.

## Before you finish

Walk through the affected flows in a real browser and run `python server.py --check`.
