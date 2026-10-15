// Gemini API (free tier via Google AI Studio key). All calls return structured JSON.
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const FALLBACK_MODEL = 'gemini-2.5-flash';

let getSettings = () => ({});
let onModelPicked = () => {};
export function configure(getter, modelCallback) { getSettings = getter; onModelPicked = modelCallback; }

export async function listModels(apiKey) {
  const r = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': apiKey } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
  return (j.models || [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => n.startsWith('gemini') && !/image|tts|audio|live|embedding/.test(n));
}

// Prefer the newest stable "gemini-X-flash"; previews and lite variants rank lower.
export function pickModel(names) {
  const score = (n) => {
    const m = n.match(/^gemini-(\d+(?:\.\d+)?)-flash(-[a-z0-9.-]+)?$/);
    if (!m) return -1;
    const suf = m[2] || '';
    let s = parseFloat(m[1]) * 100;
    if (suf.includes('lite')) s -= 60;
    if (/preview|exp/.test(suf)) s -= 200;
    else if (suf && !suf.includes('lite')) s -= 5;
    return s;
  };
  return names.filter((n) => score(n) >= 0).sort((a, b) => score(b) - score(a))[0] || FALLBACK_MODEL;
}

async function ensureModel(apiKey) {
  const { model } = getSettings();
  if (model) return model;
  let picked = FALLBACK_MODEL;
  try { picked = pickModel(await listModels(apiKey)); } catch { /* keep fallback */ }
  onModelPicked(picked);
  return picked;
}

async function generate({ parts, schema, system, temperature = 0.2 }) {
  const { apiKey } = getSettings();
  if (!apiKey) throw new Error('Add your free Gemini API key in Settings first.');
  const model = await ensureModel(apiKey);
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature, responseMimeType: 'application/json', responseSchema: schema },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  let r;
  try {
    r = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Network error. Check your connection and try again.');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 429) throw new Error('Free-tier rate limit reached. Wait a minute and try again.');
    if (r.status === 404) throw new Error(`Model "${model}" not available. Pick another in Settings.`);
    throw new Error(j.error?.message || `AI request failed (HTTP ${r.status})`);
  }
  const text = (j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  if (!text) throw new Error('The AI returned no answer' + (j.promptFeedback?.blockReason ? ` (${j.promptFeedback.blockReason})` : '.'));
  try { return JSON.parse(text); } catch { throw new Error('Could not read the AI answer. Try again.'); }
}

// ---------- schemas ----------
const NUM = { type: 'NUMBER' };
const STR = { type: 'STRING' };
const ITEM = {
  type: 'OBJECT',
  properties: { name: STR, portion: STR, kcal: NUM, protein: NUM, carbs: NUM, fat: NUM, fiber: NUM, sugar: NUM, sodium: NUM },
  required: ['name', 'portion', 'kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium'],
};
const MEAL = {
  type: 'OBJECT',
  properties: {
    items: { type: 'ARRAY', items: ITEM },
    confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
    notes: STR,
  },
  required: ['items', 'confidence', 'notes'],
};

const MEAL_SYSTEM = `You are an experienced registered dietitian estimating nutrition for a calorie-tracking app.
- Identify each distinct food or drink. Several photos may show the same meal from different angles: never double count.
- Estimate realistic portions from visual cues (plate/bowl size, utensils, hands, packaging). Include likely cooking oil, sauces and dressings.
- If a nutrition label, menu or receipt is visible, use it.
- The user's notes override what you see (e.g. "ate half", "no sugar", brand names).
- Units: kcal; protein, carbs, fat, fiber, sugar in grams; sodium in mg. Keep names short (2-4 words), portion like "1 bowl (~200 g)".
- notes: one or two short sentences on the key assumptions the user may want to correct.`;

export async function analyzeMeal({ images, mealType, note }) {
  const parts = images.map((dataUrl) => ({ inlineData: { mimeType: 'image/jpeg', data: dataUrl.split(',')[1] } }));
  parts.push({ text: `Meal: ${mealType}.\nUser notes: ${note?.trim() || 'none'}\n${images.length ? '' : 'No photo: estimate from the description only.'}` });
  return generate({ parts, schema: MEAL, system: MEAL_SYSTEM });
}

export async function refineMeal({ items, note, correction }) {
  const text = `Current estimate (JSON): ${JSON.stringify(items)}
Original user notes: ${note?.trim() || 'none'}
User correction: ${correction}
Apply the correction and return the full updated item list. Keep items the correction does not affect unchanged.`;
  return generate({ parts: [{ text }], schema: MEAL, system: MEAL_SYSTEM });
}

const WORKOUT = {
  type: 'OBJECT',
  properties: { name: STR, minutes: NUM, met: NUM, kcal: NUM },
  required: ['name', 'minutes', 'met', 'kcal'],
};

export async function estimateWorkout({ text, profile }) {
  const prompt = `Estimate a workout from this description: "${text}".
Person: ${profile.sex}, ${profile.age} y, ${profile.heightCm} cm, ${profile.weightKg} kg.
Return a short name, duration in minutes (assume a typical duration if not given), average MET,
and NET active kcal burned above resting, i.e. (MET - 1) x kg x hours.`;
  return generate({ parts: [{ text: prompt }], schema: WORKOUT });
}

const REVIEW = {
  type: 'OBJECT',
  properties: {
    score: { type: 'INTEGER' },
    headline: STR,
    summary: STR,
    wins: { type: 'ARRAY', items: STR },
    improvements: { type: 'ARRAY', items: STR },
    tomorrow: STR,
  },
  required: ['score', 'headline', 'summary', 'wins', 'improvements', 'tomorrow'],
};

export async function dayReview(ctx) {
  const system = `You are a supportive, evidence-based nutrition and fitness coach reviewing one day of a user's log.
Be specific: reference the actual foods, numbers and workouts. Be honest but kind; no shaming. No medical diagnoses.
- score: 1-10 for how well the day supports the user's goal (energy balance, protein, food quality, activity).
- headline: max 8 words.
- summary: 2-3 sentences on intake vs target, macros, and burn.
- wins: 1-3 short bullets. improvements: 1-3 short, practical, concrete suggestions (e.g. food swaps, timing, portion).
- tomorrow: one actionable focus for tomorrow.`;
  return generate({ parts: [{ text: `Day data (JSON):\n${JSON.stringify(ctx)}` }], schema: REVIEW, system, temperature: 0.5 });
}
