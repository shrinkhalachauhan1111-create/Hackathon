# WaterWatch — ANAVANDI Grand Finale MVP

**Challenge:** Household Drinking-Water Contamination Logging and Alerts (PS-04). A field-worker or household can record a test, view positive/negative observations on a map, identify configurable spatial clusters, overlay three-day rainfall context, simulate household alerts and see ward-level response summaries.

**Important:** This is a prototype, **not a drinking-water safety diagnosis**. Do not interpret negative tests as a safety certificate. Cluster flags are only potential signals. Confirm using authorised testing and the organiser's approved public-health guidance. No real SMS is sent. Use anonymous household codes, not personal phone numbers or medical data.

## Team split (one shared GitHub repository)

- **Windows teammate:** copy `frontend/` into `D:\Hackathon\frontend/`. Work only on frontend files.
- **Mac teammate:** copy `backend/`, `.gitignore`, `README.md` and `samples/` into their cloned `Hackathon` folder. Work only on backend and shared setup files.
- Both should use the repository they **already cloned**. **Do not run `git clone` a second time inside it.**
- Backend teammate pushes their commit first. Frontend teammate pulls it, then pushes frontend. Both pull the finished `main` branch.

### Mac: backend commands

```bash
cd ~/Hackathon/backend  # replace with actual folder path if different
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn main:app --reload
```

Check http://127.0.0.1:8000/docs and http://127.0.0.1:8000/api/health. If port 8000 is in use, close the old server or use `--port 8001` and update frontend URL.

In a **second** Mac terminal (repository root):

```bash
cd ~/Hackathon
git status
git add backend/ .gitignore README.md samples/
git commit -m "Build water logging and alert backend"
git pull --rebase origin main
git push origin main
```

Never add `.venv`, `.env` or `*.db` to GitHub. If Git asks for your identity, set your own name and email using `git config --global user.name "Your Name"` and `git config --global user.email "your-github-email@example.com"`.

### Windows PowerShell: frontend commands

```powershell
cd D:\Hackathon\frontend
node --version
npm install
Copy-Item .env.example .env
npm run dev
```

Open http://localhost:5173. Keep the Vite terminal running. The `.env` default points to a backend on **the same computer**. To test integration on your Windows laptop, after your teammate pushes the backend:

```powershell
cd D:\Hackathon
git pull origin main
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn main:app --reload
```

Now React and FastAPI run on **Windows**, even though the backend was written on Mac. Go to http://localhost:5173 and click **Load fictional demo data**. If `py` is unavailable use `python` instead. Windows venv activation errors: `cmd /c .venv\Scripts\activate.bat` opens a different shell; in PowerShell you may temporarily use `Set-ExecutionPolicy -Scope Process Bypass` if your local policy permits it.

In a **new** Windows terminal after testing frontend:

```powershell
cd D:\Hackathon
git status
git add frontend/
git commit -m "Build offline-first React dashboard"
git pull --rebase origin main
git push origin main
```

Mac teammate then runs `git pull origin main` and both folders will appear. If a command reports a conflict, stop and coordinate — **never force-push**.

### If React on Windows must call Mac's running backend

1. Connect both laptops to the **same trusted Wi-Fi**.
2. Mac backend: `python -m uvicorn main:app --host 0.0.0.0 --port 8000`.
3. Mac: `ipconfig getifaddr en0` to find Wi-Fi IPv4 (or view Wi-Fi details if `en0` is not the active interface).
4. Windows: set `VITE_API_URL=http://MAC_WIFI_IP:8000` in `frontend/.env`. Restart `npm run dev`. Test `http://MAC_WIFI_IP:8000/api/health` from Windows first.
5. The Mac firewall may ask for permission. **Do not expose port 8000 to the public internet.** The easiest approach remains running both parts together on Windows after Git pull.

## Three-minute demo

1. Load the clearly labeled **fictional demo dataset**, unless the organiser's actual data is already imported. A few positive tests close together form potential clusters; a distant test does not join.
2. Open **Log water test**. Enter one new test. Disconnect from Wi-Fi before saving to demonstrate local offline queue. Reconnect, click Sync and verify it appears in Observations.
3. Change the cluster threshold (e.g. 2 to 4 positive households), click Recalculate and watch cluster counts change.
4. Click **Simulate household alert**. Point out that no message is really sent, and the count is limited to household IDs observed in the dataset within the chosen radius.
5. Show the ward dashboard and three-day rainfall context. Import the supplied ward GeoJSON to display actual ward shapes.
6. Show a missing-location observation, use **+ Add location** to correct it, and demonstrate duplicate submission protection using `/docs`.

## Import the organiser's resource pack

The **organiser-supplied data is not included in this repository**. Before presenting factual geographic results, use the actual files given at the event; the synthetic Demo Ward A/B data is *not real*. Header-only example files are in `samples/`.

- Tests CSV columns: `client_id,household_id,ward_id,test_type,result,tested_at,latitude,longitude` (client_id is optional; if not supplied a new id is generated). `result` must be `positive` or `negative`; date format `YYYY-MM-DD`; both coordinates may be blank together. Use anonymous `household_id`.
- Rainfall CSV: `ward_id,date,rainfall_mm` with ISO date `YYYY-MM-DD`; 3-day totals are measured relative to the latest test date in the imported dataset, so historical datasets still work.
- Ward boundaries: GeoJSON `FeatureCollection`, with recommended `properties.ward_id` matching the CSV `ward_id`, and polygon/multipolygon geometries. Importing polygons draws outlines on the map; it does **not** automatically identify a ward from coordinates. Record `ward_id` must be supplied.
- If the organiser uses different field names or an Excel workbook, first map/export it to the template CSV headers. Do not claim their files were imported unless that succeeds.
- Do not mix synthetic demo data with organiser data when evaluating clusters. Use **Remove demo records** first.

## Detection rule (transparent, not ML)

The backend considers only **positive tests with complete coordinates** within the configured lookback window. It connects observations of the same test type whose points are within the chosen `radius_km`; each connected component forms a cluster only if it contains at least `min_positive` **distinct household IDs**. This is a simple prototype spatial grouping rule, not a statistical/clinical risk estimate. Nearby positive tests could reflect multiple causes. Map rings indicate the configured *simulated* household alert radius, not official hazard boundaries.

Ward dashboard groups by the provided ward IDs. Three-day rainfall totals are summed per ward. Rainfall is contextual data and does not establish causality. No real phone numbers or alerts are processed. Repeated exact household/type/result/day/location observations are de-duplicated; legitimate repeat tests on the same day may need separate identifiers or a future dedup redesign. Missing-location observations are stored but excluded from spatial clustering until corrected. Offline queue uses browser localStorage and is local to that browser/device.

## Tests and production notes

From backend virtual environment: `python -m unittest -v test_smoke.py` (requires `httpx`, included in requirements). Smoke test covers load, cluster, simulated alert, idempotency, location correction and importer. Test database is temporary.

For **local hackathon demo**, SQLite is simple and works well. On a cloud host with an ephemeral filesystem, SQLite data can vanish on restart/redeploy: use persistent disk, or replace storage with a managed database before claiming a production deployment. Configure production CORS and add authentication and rate limiting before any public or real-world usage. OpenStreetMap tiles and remote fonts need internet; test logging itself can queue offline, but the map tiles are not guaranteed offline.
