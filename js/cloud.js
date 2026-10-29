// Optional Google sign-in + Firestore sync. Loaded only when js/firebase-config.js is filled in.
// Layout: users/{uid} (profile, goals, settings) with sub-collections meals, workouts, days, weights, photos.
import { firebaseConfig } from './firebase-config.js';
import { ymd } from './calc.js';

const CDN = 'https://www.gstatic.com/firebasejs/12.19.0';
const COLS = ['meals', 'workouts', 'days', 'weights'];
const WINDOW_DAYS = 365; // meals/workouts/days older than this are kept in the cloud but not loaded

export const enabled = !!firebaseConfig?.apiKey;

let A, F, auth, db, user = null, unsubs = [], synced = null, pushTimer = null, H = {};

// Key-order independent JSON, so local and server copies compare equal.
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

function authMessage(e) {
  const code = e?.code || '';
  if (code.includes('popup-closed') || code.includes('cancelled-popup')) return 'Sign-in cancelled';
  if (code.includes('popup-blocked')) return 'Pop-up blocked. Allow pop-ups and try again.';
  if (code.includes('unauthorized-domain')) return `This site isn't in Firebase Auth → Settings → Authorized domains (${location.hostname}).`;
  if (code.includes('operation-not-allowed')) return 'Enable Google sign-in in Firebase console → Authentication.';
  if (code.includes('network')) return 'Network error during sign-in.';
  return e?.message || 'Sign-in failed';
}

export async function init(handlers) {
  H = handlers;
  if (!enabled) return;
  // web.app and firebaseapp.com serve the same site; sign-in redirects only work on the authDomain.
  if (location.hostname === `${firebaseConfig.projectId}.web.app`) {
    location.replace(location.href.replace('.web.app', '.firebaseapp.com'));
    return;
  }
  let appMod;
  try {
    [appMod, A, F] = await Promise.all([
      import(`${CDN}/firebase-app.js`), import(`${CDN}/firebase-auth.js`), import(`${CDN}/firebase-firestore.js`),
    ]);
  } catch {
    H.onError('Could not load sync (offline?). Showing data on this device.');
    return;
  }
  const app = appMod.initializeApp(firebaseConfig);
  auth = A.initializeAuth(app, {
    persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence],
    popupRedirectResolver: A.browserPopupRedirectResolver,
  });
  try {
    db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  } catch {
    db = F.initializeFirestore(app, {}); // memory cache fallback (e.g. private browsing)
  }
  A.getRedirectResult(auth).catch((e) => H.onError(authMessage(e)));
  A.onAuthStateChanged(auth, (u) => { stop(); user = u; H.onUser(u); });
}

export const currentUser = () => user;

export async function signIn() {
  const p = new A.GoogleAuthProvider();
  p.setCustomParameters({ prompt: 'select_account' });
  try {
    // Same-origin redirect is the reliable path for iPhone Home Screen apps; popup elsewhere (e.g. localhost).
    if (location.hostname === firebaseConfig.authDomain) await A.signInWithRedirect(auth, p);
    else await A.signInWithPopup(auth, p);
  } catch (e) {
    throw new Error(authMessage(e));
  }
}

export async function signOut() {
  await pushNow();
  await A.signOut(auth);
}

const uref = () => F.doc(db, 'users', user.uid);
const ucol = (c) => F.collection(db, 'users', user.uid, c);

function build() {
  const parse = (m) => [...m.values()].map((j) => JSON.parse(j));
  return {
    root: synced.root ? JSON.parse(synced.root) : null,
    meals: parse(synced.meals),
    workouts: parse(synced.workouts),
    weights: parse(synced.weights),
    days: Object.fromEntries([...synced.days].map(([id, j]) => [id, JSON.parse(j)])),
  };
}

// Subscribe to the user's data. Resolves with {data, empty} on first load; later changes go to H.onData.
export function start() {
  synced = { root: null, meals: new Map(), workouts: new Map(), days: new Map(), weights: new Map() };
  const cutoff = ymd(Date.now() - WINDOW_DAYS * 864e5);
  const fail = (e) => H.onError(e.code === 'permission-denied' ? 'Sync blocked: deploy firestore.rules (see README).' : `Sync error: ${e.message}`);
  return new Promise((resolve) => {
    const seen = new Set();
    let ready = false;
    const mark = (k) => {
      seen.add(k);
      if (!ready && seen.size === COLS.length + 1) {
        ready = true;
        const empty = !synced.root && COLS.every((c) => !synced[c].size);
        resolve({ data: build(), empty });
      } else if (ready) H.onData(build());
    };
    unsubs.push(F.onSnapshot(uref(), (s) => { synced.root = s.exists() ? stable(s.data()) : null; mark('root'); }, fail));
    for (const c of COLS) {
      const q = c === 'weights' ? ucol(c) : F.query(ucol(c), F.where('date', '>=', cutoff));
      unsubs.push(F.onSnapshot(q, (s) => {
        const m = new Map();
        s.forEach((d) => m.set(d.id, stable(d.data())));
        synced[c] = m;
        mark(c);
      }, fail));
    }
  });
}

function stop() {
  unsubs.forEach((u) => u());
  unsubs = [];
  synced = null;
}

function entries(S, c) {
  if (c === 'days') return new Map(Object.entries(S.days).map(([d, v]) => [d, { ...v, date: d }]));
  const key = c === 'weights' ? 'date' : 'id';
  return new Map(S[c].map((x) => [x[key], x]));
}
const rootOf = (S) => {
  const { models, ...settings } = S.settings; // the detected model list is per device
  return { profile: S.profile, goals: S.goals, settings };
};

let latest = null;
export function push(S) {
  latest = S;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 0);
}

// Write only the documents that differ from what the server last sent us.
export async function pushNow() {
  clearTimeout(pushTimer);
  pushTimer = null;
  const S = latest;
  if (!user || !synced || !S) return;
  const clean = (o) => JSON.parse(JSON.stringify(o));
  const ops = [];
  const root = rootOf(S);
  if (stable(root) !== synced.root) { ops.push([uref(), clean(root)]); synced.root = stable(root); }
  for (const c of COLS) {
    const cur = entries(S, c), m = synced[c];
    for (const [id, obj] of cur) {
      const j = stable(obj);
      if (m.get(id) !== j) { ops.push([F.doc(ucol(c), id), clean(obj)]); m.set(id, j); }
    }
    for (const id of [...m.keys()]) if (!cur.has(id)) { ops.push([F.doc(ucol(c), id), null]); m.delete(id); }
  }
  for (let i = 0; i < ops.length; i += 400) {
    const b = F.writeBatch(db);
    for (const [ref, data] of ops.slice(i, i + 400)) data ? b.set(ref, data) : b.delete(ref);
    // Resolves when the server confirms; offline writes stay queued in the local cache.
    b.commit().catch((e) => H.onError(`Sync error: ${e.message}`));
  }
}

// ---------- photos (small JPEG data URLs, one doc each) ----------
export async function photoGet(id) {
  if (!user) return null;
  try {
    const s = await F.getDoc(F.doc(ucol('photos'), id));
    return s.exists() ? s.data().data : null;
  } catch { return null; }
}
export function photoSet(id, data) {
  if (user) F.setDoc(F.doc(ucol('photos'), id), { data, date: ymd(Date.now()) }).catch(() => {});
}
export function photoDel(id) {
  if (user) F.deleteDoc(F.doc(ucol('photos'), id)).catch(() => {});
}

// ---------- whole-account operations ----------
export async function fetchAll() {
  const out = { meals: [], workouts: [], weights: [], days: {} };
  const root = await F.getDoc(uref());
  Object.assign(out, root.exists() ? root.data() : {});
  for (const c of COLS) {
    const s = await F.getDocs(ucol(c));
    s.forEach((d) => { if (c === 'days') out.days[d.id] = d.data(); else out[c].push(d.data()); });
  }
  return out;
}

export async function eraseAll() {
  for (const c of [...COLS, 'photos']) {
    const s = await F.getDocs(ucol(c));
    const refs = s.docs.map((d) => d.ref);
    for (let i = 0; i < refs.length; i += 400) {
      const b = F.writeBatch(db);
      refs.slice(i, i + 400).forEach((r) => b.delete(r));
      await b.commit();
    }
  }
  await F.deleteDoc(uref());
}
