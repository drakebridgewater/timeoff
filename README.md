Days off work, one page per year, with a box for whether each day is reported to my employer. It replaces the "Time off work" Google Sheet. Runs at `timeoff.bridgewater.digital`.

- **Year page** (`/`, `/2025`): every day with its hours, type, reason and a Reported box, grouped by month. The page head counts days used against the yearly target. A panel lists what is not reported yet, with "Mark all reported".
- **Years** (`/years`): days per year against the target, back to 2015. Download everything as CSV from here.
- **Settings** (`/settings`): the expected days per year and the list of types.

A company holiday with no hours does not need reporting, so it shows "not needed". Everything else does, including volunteering at 0 hours.

## Run it

Node 22.13 or later. No dependencies: the server uses `node:http` and `node:sqlite`.

```bash
npm run dev
```

It listens on `http://127.0.0.1:3000` and keeps its data in `data/timeoff.sqlite`.

```bash
npm test
```

## Import the sheet

`data/sheet-export.json` holds every year tab of the sheet as it was. It is gitignored, since it is personal. Days before today import as reported; later days import as not reported.

```bash
node scripts/import-sheet.js data/sheet-export.json
```

On the server, copy the file into the app's data folder and run the import inside the container once:

```bash
docker exec timeoff node scripts/import-sheet.js /data/sheet-export.json
```

It refuses to touch a database that already has entries unless you add `--replace`. It checks every year against the sheet's Totals tab and lists anything worth a look.

## Deploy

Same as Tabletop: push to `main`, GitHub Actions publishes `ghcr.io/drakebridgewater/timeoff` and calls the Dockhand webhook. `deploy/docker-compose.yml` puts it behind Traefik and Authelia; variables are in `deploy/.env.example`.

To stop it when idle, add `deploy/docker-compose.sablier.yml` to the stack. The comments in that file list what Traefik needs first.

## Brand

`public/brand/` is copied from the brand repo. After the brand changes:

```bash
BRAND_DIR=../bridgewater-brand npm run sync-brand
```
