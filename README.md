# Vecmocon Industrial Leak Tester — Scan Station

A mobile web app (PWA) for the factory operator's Android phone. The operator scans each charger's QR/barcode **before** the leak test. The scan is saved to Google Sheets with a unique **Test ID**. The ESP32 leak tester later uploads its PASS/FAIL result against the **same Test ID**, linking both records perfectly.

```
Operator phone (this app)          ESP32 leak tester
        │                                │
   POST action:"scan"             POST action:"leaktest"
        │                                │
        └──────► Google Apps Script ◄────┘
                        │
                  Google Sheets
        (ScanData / LeakTestData / Master)
```

## Project files

| File | Purpose |
|---|---|
| `index.html` | App structure: home, scanner, success, duplicate, error screens |
| `style.css` | Dark industrial theme, glove-friendly 64–96 px touch targets |
| `script.js` | Scanner, upload, duplicate blocking, IndexedDB offline queue, sync |
| `apps_script.gs` | Google Apps Script backend: Test ID generation, doGet/doPost, setup() |
| `manifest.json` | PWA manifest (installable, standalone, portrait) |
| `service-worker.js` | Offline app shell caching |
| `icon-192.png`, `icon-512.png` | App icons |

---

## 1. Create the Spreadsheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a new spreadsheet.
2. Name it **Leak Tester Data** (any name works).
3. Do **not** create the sheets manually — the script does it for you in step 2.

## 2. Create the Apps Script

1. In the spreadsheet: **Extensions → Apps Script**. (This binds the script to the sheet — required.)
2. Delete the default code in `Code.gs`.
3. Paste the entire contents of **`apps_script.gs`**.
4. In `CONFIG` at the top, set `TIMEZONE` if you are not in `Asia/Kolkata`.
5. Save (Ctrl+S).
6. In the function dropdown (toolbar), select **`setup`** and click **Run**.
   - Grant the permissions when Google asks (it only accesses this spreadsheet).
   - This creates **ScanData**, **LeakTestData** and **Master** with headers, green header bands, frozen rows and the Master linking formulas.

## 3. Deploy the Web App

1. In the Apps Script editor: **Deploy → New deployment**.
2. Click the gear icon → choose **Web app**.
3. Settings:
   - **Description:** Leak Tester Scan Station
   - **Execute as:** `Me`
   - **Who has access:** `Anyone`  ← required so the phones and the ESP32 can POST without login
4. Click **Deploy** and **copy the Web App URL** (ends in `/exec`).

> **After any code change**, use **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**. The URL stays the same. Creating a brand-new deployment changes the URL.

## 4. Connect the Website

1. Open **`script.js`**.
2. In the `CONFIG` block at the top:
   - Paste your Web App URL into `SCRIPT_URL`.
   - Edit `OPERATORS` and `TESTERS` to your real names/machines.
3. Save. That is the only file you need to touch.

## 5. Deploy to GitHub Pages

The scanner needs **HTTPS** for camera access — GitHub Pages provides this free.

1. Create a GitHub account (if needed) and a new **public** repository, e.g. `leak-scanner`.
2. Upload all project files to the repository root (`index.html` must be at the root).
3. Repository → **Settings → Pages**.
4. Under **Build and deployment**: Source = `Deploy from a branch`, Branch = `main`, folder = `/ (root)`. Save.
5. Wait 1–2 minutes. Your app is live at:
   `https://<your-username>.github.io/leak-scanner/`

## 6. How to use

**One-time on each operator phone (Android Chrome):**
1. Open the app URL.
2. Allow **camera** permission when asked.
3. Chrome menu (⋮) → **Add to Home screen** → it installs as a full-screen app.

**Daily operation:**
1. Open the app. The LED badge shows **ONLINE**.
2. Select **Operator** and **Tester** (remembered between sessions).
3. Tap **SCAN CHARGER** → camera opens with a green target frame.
4. Point at the charger QR/barcode → beep + vibration → **SUCCESSFULLY SAVED** with the Test ID.
5. Tap **SCAN NEXT** and continue. The operator never types anything.

**Duplicate protection:** the same charger scanned again within **30 seconds** shows an amber **DUPLICATE SCAN** screen and nothing is uploaded. Checked on the phone *and* on the server (covers two phones scanning the same unit).

**Offline mode:** with no internet, scans are stored in the phone (IndexedDB), the badge shows **OFFLINE**, and **PENDING SCANS** counts up. When internet returns, everything uploads automatically and Test IDs are assigned on upload.

**Torch / camera:** in the scanner screen, **TORCH** toggles the flashlight (if the camera supports it) and the dropdown switches between front/back cameras.

---

## ESP32 integration (LeakTestData)

The ESP32 posts its result to the **same Web App URL**:

```json
{
  "action": "leaktest",
  "testId": "20260713-000001",
  "pressureStart": 0.151,
  "pressureEnd": 0.141,
  "pressureDrop": 0.010,
  "result": "PASS"
}
```

HTTP POST, `Content-Type: text/plain`. The script appends the row to **LeakTestData** and automatically updates the matching **ScanData** row's Status from `Pending` to `PASS`/`FAIL`. The **Master** sheet then shows the fully linked record. (Tip: display the Test ID on the tester's QR scanner input, or have the tester's own QR scanner read the same charger code and look up the latest Test ID.)

## Master sheet

`Master` links both sheets by Test ID using ARRAYFORMULA + VLOOKUP — it fills itself, never type into it. Columns: Test ID, Scan Timestamp, Operator, Tester, Charger ID, Test Timestamp, Pressure Start/End/Drop, Result. Leak-test columns stay blank until the ESP32 uploads.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "SCRIPT_URL is not configured" | Paste the `/exec` URL into `CONFIG.SCRIPT_URL` in `script.js` |
| Camera never opens | Must be HTTPS (GitHub Pages is). Check site camera permission in Chrome |
| Badge stuck on OFFLINE while phone has internet | Re-deploy the Web App with access = **Anyone**; check the URL ends in `/exec` |
| Scans succeed but no rows appear | You edited the script but didn't create a **New version** deployment |
| Wrong Test ID date | Set `TIMEZONE` in `apps_script.gs` CONFIG and redeploy |

## Scale

At ~500 tests/day (~180,000 rows/year) a single sheet stays workable, but for long-term performance archive yearly: File → Make a copy, then delete old rows from ScanData/LeakTestData. The Master formulas keep working. Dashboards (PASS %, daily production, trends) can be built on top with Google Looker Studio pointed at this spreadsheet — no firmware or website changes needed.
