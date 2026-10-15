// Pure helpers: dates, nutrition math, energy targets, workouts, projections.

export const KCAL_PER_KG = 7700; // approx. energy in 1 kg of body fat

// ---------- dates (local, YYYY-MM-DD) ----------
export const ymd = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
export const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const today = () => ymd(new Date());
export const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
export const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
export const weekStart = (s) => { const d = parseYmd(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); };
export const fmtDate = (s, opts = { month: 'short', day: 'numeric' }) => parseYmd(s).toLocaleDateString('en-US', opts);

// ---------- meals ----------
export const MEAL_TYPES = [
  { key: 'breakfast', label: 'Breakfast' },
  { key: 'lunch', label: 'Lunch' },
  { key: 'dinner', label: 'Dinner' },
  { key: 'snack', label: 'Snack' },
];
export const NUTRIENTS = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium'];

export function guessMealType(date = new Date()) {
  const h = date.getHours();
  if (h >= 4 && h < 11) return 'breakfast';
  if (h >= 11 && h < 15) return 'lunch';
  if (h >= 17 && h < 22) return 'dinner';
  return 'snack';
}

export function sumItems(items) {
  const t = Object.fromEntries(NUTRIENTS.map((k) => [k, 0]));
  for (const it of items) for (const k of NUTRIENTS) t[k] += +it[k] || 0;
  return t;
}

// ---------- energy targets ----------
export const ACTIVITY_LEVELS = [
  { v: 1.2, label: 'Sedentary', desc: 'Desk job, little walking' },
  { v: 1.375, label: 'Lightly active', desc: 'On your feet part of the day' },
  { v: 1.55, label: 'Active', desc: '~10k steps/day or physical job' },
  { v: 1.725, label: 'Very active', desc: 'Heavy manual work' },
];
export const RATES = [0.25, 0.5, 0.75, 1];

export function profileReady(p, weight) {
  return !!(p && p.age && p.heightCm && weight && p.sex);
}

// Mifflin-St Jeor BMR -> TDEE (activity excludes logged workouts, which are added separately).
export function calcGoals(p, weight) {
  if (!profileReady(p, weight)) return null;
  const bmr = 10 * weight + 6.25 * p.heightCm - 5 * p.age + (p.sex === 'male' ? 5 : -161);
  const tdee = bmr * (p.activity || 1.2);
  const goalW = +p.goalWeightKg || weight;
  const dir = goalW < weight - 0.2 ? -1 : goalW > weight + 0.2 ? 1 : 0;
  const rate = dir > 0 ? Math.min(p.rate || 0.25, 0.5) : p.rate || 0.5; // lean gain caps at 0.5 kg/wk
  const floor = p.sex === 'male' ? 1500 : 1200;
  let kcal = tdee + (dir * rate * KCAL_PER_KG) / 7;
  const floored = kcal < floor;
  kcal = Math.max(floor, kcal);

  // Protein on a reference weight (BMI 25 cap) so it isn't inflated by excess fat mass.
  const h = p.heightCm / 100;
  const refW = Math.min(weight, 25 * h * h);
  const protein = refW * (dir < 0 ? 1.8 : 1.6);
  const fat = (kcal * 0.28) / 9;
  const carbs = Math.max(0, (kcal - protein * 4 - fat * 9) / 4);
  return {
    bmr: Math.round(bmr), tdee: Math.round(tdee), kcal: Math.round(kcal / 10) * 10,
    protein: Math.round(protein), fat: Math.round(fat), carbs: Math.round(carbs),
    dir, rate, floored, bmi: weight / (h * h),
  };
}

// ---------- workouts ----------
// MET values approximated from the Compendium of Physical Activities.
export const ACTIVITIES = [
  { key: 'walk', name: 'Walking', met: 3.5 },
  { key: 'brisk', name: 'Brisk walking', met: 4.8 },
  { key: 'jog', name: 'Jogging', met: 7.0 },
  { key: 'run', name: 'Running', met: 9.5 },
  { key: 'hike', name: 'Hiking', met: 6.0 },
  { key: 'cycle', name: 'Cycling', met: 7.5 },
  { key: 'spin', name: 'Stationary bike', met: 6.8 },
  { key: 'swim', name: 'Swimming', met: 7.0 },
  { key: 'weights', name: 'Strength training', met: 5.0 },
  { key: 'hiit', name: 'HIIT / circuit', met: 8.0 },
  { key: 'elliptical', name: 'Elliptical', met: 5.0 },
  { key: 'row', name: 'Rowing machine', met: 7.0 },
  { key: 'stairs', name: 'Stair climber', met: 8.8 },
  { key: 'rope', name: 'Jump rope', met: 11.0 },
  { key: 'yoga', name: 'Yoga', met: 2.8 },
  { key: 'pilates', name: 'Pilates', met: 3.0 },
  { key: 'dance', name: 'Dance', met: 5.5 },
  { key: 'basketball', name: 'Basketball', met: 7.5 },
  { key: 'badminton', name: 'Badminton', met: 5.5 },
  { key: 'tennis', name: 'Tennis', met: 7.3 },
  { key: 'soccer', name: 'Soccer', met: 7.0 },
  { key: 'other', name: 'Other', met: 5.0 },
];
export const INTENSITY = { light: 0.75, moderate: 1, vigorous: 1.25 };

// Net active kcal: (MET - 1) excludes resting energy already counted in TDEE.
export function workoutKcal(met, minutes, kg, intensity = 'moderate') {
  const m = met * (INTENSITY[intensity] || 1);
  return Math.max(0, Math.round(((m - 1) * (kg || 70) * (minutes || 0)) / 60));
}

// ---------- trends & projections ----------
export function linreg(pts) {
  const n = pts.length;
  if (n < 2) return null;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
  if (!den) return null;
  const slope = num / den;
  return { slope, intercept: my - slope * mx };
}

// Exponential moving average to smooth daily weight noise.
export function ema(weights, alpha = 0.25) {
  let t = null;
  return weights.map((w) => { t = t == null ? w.kg : t + alpha * (w.kg - t); return { date: w.date, kg: t }; });
}
