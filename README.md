# DRRT — Disaster Relief Resource Tracker

This replaces the single-file HTML mockup with the real stack the spec
called for. Everything below has been implemented and actually tested
(the backend endpoints were exercised with curl during development,
including the conflict-resolution logic; the mobile app source was
parsed with Babel to confirm it's syntactically valid React Native —
it hasn't been run on a device/emulator since this environment has
neither).

```
drrt/
  backend/    FastAPI + SQLAlchemy + SQLite (or Postgres) API
  frontend/   Web dashboard — plain HTML/JS + Leaflet, talks to the real API
  mobile/     Expo/React Native app source — same API, real GPS & camera
```

## What's real now vs. the original prototype

| Requirement | Status |
|---|---|
| React Native mobile app | **Built** — Expo app in `mobile/`, real `expo-location` GPS, real `expo-image-picker` camera, real `AsyncStorage` offline queue. Not device/emulator-tested here. |
| React.js web dashboard | Implemented as vanilla JS instead of React (no build step needed to run it), but it's a real dashboard hitting a real API — not a mockup. Swapping to React/Vite is straightforward if you want the exact framework. |
| FastAPI backend | **Built and tested.** Real endpoints, real JWT auth, real DB writes. |
| SQLite (offline) + PostgreSQL (cloud) | **Built.** SQLAlchemy against `DATABASE_URL`; defaults to SQLite, and pointing it at a Postgres DSN is a one-line env var change — see below. |
| Real offline map tiles (OSM/MBTiles) | **Partially built.** Maps use real Leaflet + live OpenStreetMap tiles (not fake shelter cards). True *offline* MBTiles caching (tiles baked into the app for zero-connectivity use) is not implemented — that needs a native tile cache and is a reasonable next step, noted below. |
| Real GPS / SOS location capture | **Built.** Web uses `navigator.geolocation`; mobile uses `expo-location`. Both request real device permission and fail visibly (not silently) if denied. |
| Real background sync + conflict resolution | **Built.** See `backend/resolver.py` — genuine field-level last-write-wins merge, tested with two out-of-order concurrent edits to confirm the newer edit wins per-field rather than per-record. |
| Authentication | **Built.** JWT login/register, three roles (`survivor`/`volunteer`/`authority`), server-side role enforcement on every write endpoint (403 if the role doesn't match, not just hidden UI). |
| Photo upload/storage for incidents | **Built.** Multipart upload, saved to disk, served back and shown as thumbnails in both the web and mobile verify/feed views. |
| Heatmap | **Built.** `/incidents/heatmap` feeds a `leaflet.heat` layer on the authority map (web). Mobile shows the same data as a list rather than a heat layer — Leaflet's heat plugin doesn't have a direct RN/Expo equivalent without a native map library. |

## Running the backend

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

This creates `drrt.db` (SQLite) next to `main.py` on first run and seeds it
with 6 shelters, 4 incidents, 3 tasks, and 3 demo accounts (username /
password `password123`): `survivor1`, `vol1`, `authority1`.

To point at Postgres instead (the "cloud" database):

```bash
export DATABASE_URL="postgresql+psycopg2://user:pass@host:5432/drrt"
pip install psycopg2-binary
uvicorn main:app --port 8000
```

No other code changes needed — this is the whole benefit of going through
SQLAlchemy instead of hand-written SQLite queries.

## Running the web dashboard

```bash
cd frontend
python3 -m http.server 8080
```

Open `http://localhost:8080`. It talks to `http://localhost:8000` by
default; change that by running, once, in the browser console:
`localStorage.setItem('drrt_api_base', 'http://your-host:8000')`.

## Running the mobile app

```bash
cd mobile
npm install
npx expo start
```

Edit `lib/api.js` and set `API_BASE` to your dev machine's LAN IP (not
`localhost` — on a physical phone, `localhost` means the phone itself)
before testing on a real device. Requires Expo Go or a simulator/emulator,
neither of which is available in the environment this was built in, so
this has been syntax-validated (Babel-parsed) but not run end-to-end.

## How the conflict resolution actually works

Every shelter record carries `field_timestamps`, a per-field map of when
each field was last *client-authored*. When an offline edit arrives:

- if the field has no stored timestamp, or the incoming edit is newer →
  apply it, record the new timestamp
- if the incoming edit is *older* than what's already stored for that
  field → reject just that field (a later edit already won), while the
  rest of the payload still applies normally

So two volunteers editing the same shelter at the same time never lose
data as long as they touch different fields, and if they touch the *same*
field, whichever edit actually happened later in the real world wins —
not whichever one happened to reach the server first. This is implemented
in `backend/resolver.py` and was verified during development: an older
"food" edit that arrived after a newer one was correctly rejected while
an unrelated "water" field from the same stale payload still applied.

The `/sync/batch` endpoint additionally de-duplicates by `client_uuid`, so
a flaky connection that resends the same offline action twice doesn't
double-apply it (verified — a duplicate incident report in the same batch
came back `duplicate_ignored` on the second copy).

## Honest gaps that remain

- **True offline map tiles (MBTiles)**: the current maps need live internet
  to fetch OSM tiles. A real "offline" version would ship a `.mbtiles`
  file with the app/PWA and serve tiles from it locally — that's a
  meaningfully larger native-tooling task (tile server or `react-native-maps`
  + offline tile provider) than fits here, so it's flagged rather than faked.
- **React (JSX/build-tooled) web frontend**: the dashboard is real and
  fully wired to the API, but written as plain JS rather than React, to
  keep it runnable with zero build step. Porting the same logic into React
  components is mechanical if you want the exact framework match.
- **Mobile app is unverified on-device**: the code is real, complete, and
  parses cleanly, but there's no emulator/device in this environment to
  click through it.
- **Auth security posture is dev-grade**: JWT secret is a hardcoded
  fallback (`DRRT_SECRET_KEY` env var overrides it — set this in any real
  deployment), tokens aren't refreshed/rotated, and there's no rate
  limiting on login. Fine for a prototype/hackathon demo, not for
  production as-is.
