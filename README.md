# FitLog: AI calorie and workout log (iPhone PWA)

A dark-mode web app you install on your iPhone Home Screen. Snap meal photos and Gemini estimates calories and macros, which you can then edit. It also logs workouts, gives an AI review of each day, and forecasts when you'll reach your goal weight.

There's no build step: the folder is plain HTML/CSS/JS. Signed out, data stays on the device (IndexedDB). With Google sign-in (optional), data syncs through your own free Firebase project.

## 1. Choose an AI (Settings: gear icon, top right)
| | Gemini (Google) | Claude (Anthropic) |
|---|---|---|
| Cost | Free tier | Paid per use: roughly US$0.03–0.05 per photo meal on Opus 5.5, ~$0.02 on Sonnet 5.5, under $0.005 on Haiku 5.5 |
| Key | https://aistudio.google.com/apikey | https://console.anthropic.com/settings/keys (add credit; set a spend limit) |
| Notes | Daily/minute limits; can be busy or slow at peak times | Generally faster and steadier; model is selectable |

Pick the provider with the **Gemini · free / Claude · paid** switch. If both keys are entered and **Use the other one as backup** is on, a busy or rate-limited request is retried automatically on the other provider.
Keys stay on your device (or in your account if signed in) and are sent only to Google or Anthropic. Backups never include keys.

Free-tier note: Google may use free-tier Gemini inputs to improve its models, so don't photograph anything sensitive.

## 2. Set up Google sign-in and sync (Firebase, free Spark plan)
1. Go to https://console.firebase.google.com and click **Create a project** (e.g. `fitlog`). Google Analytics isn't needed.
2. Turn on sign-in: **Build → Authentication → Get started → Sign-in method → Google → Enable**, choose a support email, and **Save**.
3. Create the database: **Build → Firestore Database → Create database**. Pick a location near you (e.g. `asia-east1` for Taiwan) and start in **production mode**.
4. Lock it down: in Firestore, open the **Rules** tab, replace everything with the contents of `firestore.rules`, and **Publish**. Only you can then read or write your own data.
5. Register the web app: click the **gear icon → Project settings → General → Your apps → Web (`</>`)**, use the nickname `FitLog`, and **Register**. Copy the `firebaseConfig = { ... }` object into `js/firebase-config.js`, replacing `null`.
   These values identify your project and are safe to publish. Access is protected by the rules and by Google sign-in.

## 3. Put it online with Firebase Hosting (free, needed for sign-in on iPhone)
On iPhone, Google sign-in from a Home Screen app works reliably only when the app is served from the same domain Firebase uses for sign-in, which is Firebase Hosting.
1. Install the Firebase CLI: https://firebase.google.com/docs/cli (the standalone macOS binary works without Node).
2. In this folder run `firebase login`, then `firebase deploy --project <your-project-id>`. This uploads the app and the security rules.
3. Your app is at **`https://<project-id>.firebaseapp.com`**. Use this address; the `.web.app` address redirects to it.

**No sign-in?** You can still host on GitHub Pages: upload everything in this folder to a public repo, then **Settings → Pages → Deploy from branch `main` / root**. Google sign-in may work in a Safari tab there (via pop-up), but it's unreliable from the Home Screen. If you try it, add `<username>.github.io` under **Authentication → Settings → Authorized domains**.

## 4. Install on iPhone
1. Open the URL in **Safari**.
2. Tap **Share → Add to Home Screen → Add**.
3. Launch FitLog from the Home Screen icon and go to **Settings → Sign in with Google**.
4. On first sign-in, if the device already has data, FitLog offers to copy it into your account.

> Safari and the Home Screen app have **separate** storage on iOS. When signed in, both show the same data because it comes from your account. When signed out, each has its own local copy.

## How sync works
- Stored in Firestore under `users/<your uid>/` (profile, goals, settings and API key), plus `meals`, `workouts`, `days` (reviews), `weights` and `photos` (meal photos as ~60–120 KB JPEGs).
- It works offline: changes are cached on the device and upload when you're back online. Edits on one device appear on the others within seconds.
- The app loads the last 365 days of meals, workouts and reviews, plus all weigh-ins. Older records stay in your account, and **Export backup** includes everything.
- Free-plan limits (1 GB storage, 50k reads and 20k writes a day) are far above one person's use.
- **Sign out** keeps your data in the account. **Erase all account data** deletes it from every device.

## Features
| Area | What it does |
|---|---|
| **Today** | Calorie ring (goal / eaten / burned / net), protein-carb-fat bars, Breakfast / Lunch / Dinner / Snack sections |
| **Your foods** | Every item you log builds a personal food list. In the meal sheet, search it, tap to add (½× / 1.5× / 2× to rescale), or repeat a recent meal, with no AI call needed |
| **Log meal** | Add several photos plus optional notes, then **Analyze with AI** for per-item kcal, protein, carbs, fat, fiber, sugar and sodium. Edit any number directly, or type a correction ("rice was half a bowl") and tap **Apply** |
| **Workouts** | Pick from 20+ activities with MET values and an intensity setting, or describe it in words and let the AI estimate. Burn = (MET − 1) × kg × hours, so resting calories aren't double counted |
| **Done for today** | AI review: score 1–10, headline, wins, improvements, and a focus for tomorrow. Falls back to a rule-based summary when offline |
| **Activity** | Weekly goals in active days and minutes, week streak, 16-week workout calendar (green), and a 16-week food-log calendar (yellow = day completed with Done & review) |
| **Progress** | Weight chart with smoothed trend and goal line, plus 14-day calorie bars and averages. Goal-date forecast three ways: your planned pace, your actual weight trend, and your logged calorie balance |
| **Settings** | Mifflin-St Jeor BMR → maintenance → goal calories (7,700 kcal ≈ 1 kg), protein 1.8 g/kg when losing (capped at BMI-25 weight), safety floor of 1,200 kcal (female) / 1,500 kcal (male), custom override, eat-back-exercise %, backup/restore |

## Files
```
index.html            app shell + tab bar
styles.css            dark theme
js/app.js             UI, views, sheets, review logic
js/ai.js              Gemini (REST) / Claude (Anthropic SDK) calls with automatic backup
js/cloud.js           Google sign-in + Firestore sync (optional)
js/firebase-config.js your Firebase project config (null = sync off)
firestore.rules       database security rules (each user sees only their own data)
firebase.json         Firebase Hosting + rules deploy config
js/calc.js            BMR/TDEE, macros, MET table, trends
js/charts.js          inline SVG charts
js/db.js              IndexedDB storage
sw.js                 offline cache
manifest.webmanifest  install metadata
```

## Updating
**GitHub Pages:** open your repo → **Add file → Upload files** → drag in everything inside this folder again → **Commit changes**. Files with the same name are replaced. After 1–2 minutes, close the app on your phone (swipe it away) and reopen it.
**Firebase Hosting:** run `firebase deploy` again. The service worker fetches the network first, so the phone picks up changes the next time the app is opened online.

*Estimates are approximate and not medical advice.*
