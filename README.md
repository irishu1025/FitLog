# FitLog: AI calorie and workout log (iPhone PWA)

A dark-mode web app you install on your iPhone Home Screen. Snap meal photos and Gemini estimates calories and macros, which you can then edit. It also logs workouts, gives an AI review of each day, and forecasts when you'll reach your goal weight.

There's no build step: the folder is plain HTML/CSS/JS. All data stays on your phone in IndexedDB.

## 1. Get a free Gemini API key
1. Go to https://aistudio.google.com/apikey and sign in with a Google account.
2. Click **Create API key** and copy it.
3. In FitLog, open **Settings → AI** and paste the key. The app detects the best available free Flash model automatically.

Free-tier notes: there are per-minute and per-day request limits, which are plenty for one person. Google may use free-tier inputs to improve its models, so don't photograph anything sensitive.

## 2. Put it online (free, HTTPS needed for iPhone install)
**Option A: GitHub Pages (recommended, permanent)**
1. Create a free GitHub account, then a new **public** repository, e.g. `fitlog`.
2. Choose **Add file → Upload files** and drag in *everything inside* this `fitlog` folder (index.html, styles.css, sw.js, manifest.webmanifest, `js/`, `icons/`). Commit.
3. Open **Settings → Pages**, set Source to *Deploy from a branch*, choose branch `main` and folder `/ (root)`, then Save.
4. After about a minute your app is at `https://<username>.github.io/fitlog/`.

**Option B: Netlify Drop.** Go to https://app.netlify.com/drop, drag in the `fitlog` folder, and sign up (free) so the site isn't deleted.

## 3. Install on iPhone
1. Open the URL in **Safari**.
2. Tap **Share → Add to Home Screen → Add**.
3. Launch FitLog from the Home Screen icon. It runs full-screen and works offline, except for the AI features.

> Keep using it from the Home Screen icon. iOS can clear website data from Safari tabs that go unvisited, but Home Screen apps are exempt. Use **Settings → Export backup** occasionally anyway.

## Features
| Area | What it does |
|---|---|
| **Today** | Calorie ring (goal / eaten / burned / net), protein-carb-fat bars, Breakfast / Lunch / Dinner / Snack sections |
| **Log meal** | Add several photos plus optional notes, then **Analyze with AI** for per-item kcal, protein, carbs, fat, fiber, sugar and sodium. Edit any number directly, or type a correction ("rice was half a bowl") and tap **Apply** |
| **Workouts** | Pick from 20+ activities with MET values and an intensity setting, or describe it in words and let the AI estimate. Burn = (MET − 1) × kg × hours, so resting calories aren't double counted |
| **Done for today** | AI review: score 1–10, headline, wins, improvements, and a focus for tomorrow. Falls back to a rule-based summary when offline |
| **Activity** | Weekly session goal, week streak, food-log streak, 16-week heatmap |
| **Progress** | Weight chart with smoothed trend and goal line, plus 14-day calorie bars and averages. Goal-date forecast three ways: your planned pace, your actual weight trend, and your logged calorie balance |
| **Settings** | Mifflin-St Jeor BMR → maintenance → goal calories (7,700 kcal ≈ 1 kg), protein 1.8 g/kg when losing (capped at BMI-25 weight), safety floor of 1,200 kcal (female) / 1,500 kcal (male), custom override, eat-back-exercise %, backup/restore |

## Files
```
index.html            app shell + tab bar
styles.css            dark theme
js/app.js             UI, views, sheets, review logic
js/ai.js              Gemini calls (meal analysis, corrections, workouts, day review)
js/calc.js            BMR/TDEE, macros, MET table, trends
js/charts.js          inline SVG charts
js/db.js              IndexedDB storage
sw.js                 offline cache
manifest.webmanifest  install metadata
```

## Updating
Edit the files and re-upload them to the same place. The service worker fetches the network first, so the phone picks up changes the next time the app is opened online.

*Estimates are approximate and not medical advice.*
