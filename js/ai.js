// AI providers: Google Gemini (free tier, REST) and Anthropic Claude (paid, official SDK).
// Every call returns JSON that matches a schema. If the chosen provider is busy or out of quota
// and the other one has a key, the request is retried there automatically.
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_FALLBACK_MODEL = 'gemini-2.5-flash';
const ANTHROPIC_SDK = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.136.0/+esm';

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 · most accurate (~US$0.03–0.05 per meal)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 · balanced (~US$0.02 per meal)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 · fastest, cheapest (<US$0.005 per meal)' },
];
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

let getSettings = () => ({});
let onModelPicked = () => {};
export function configure(getter, modelCallback) { getSettings = getter; onModelPicked = modelCallback; }

class AIError extends Error {
  constructor(message, { retryable = false } = {}) { super(message); this.retryable = retryable; }
}

// ---------- Gemini ----------
export async function listModels(apiKey) {
  const r = await fetch(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': apiKey } });
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
  return names.filter((n) => score(n) >= 0).sort((a, b) => score(b) - score(a))[0] || GEMINI_FALLBACK_MODEL;
}

async function ensureGeminiModel(apiKey) {
  const { model } = getSettings();
  if (model) return model;
  let picked = GEMINI_FALLBACK_MODEL;
  try { picked = pickModel(await listModels(apiKey)); } catch { /* keep fallback */ }
  onModelPicked(picked);
  return picked;
}

// Gemini's responseSchema uses an OpenAPI subset: upper-case types, no additionalProperties.
function toGeminiSchema(s) {
  const out = { type: s.type.toUpperCase() };
  if (s.enum) out.enum = s.enum;
  if (s.items) out.items = toGeminiSchema(s.items);
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.required = s.required;
  }
  return out;
}

// Light thinking keeps answers fast; the field differs between Gemini generations.
function thinkingFor(model, effort) {
  if (/^gemini-2\.5/.test(model)) return { thinkingBudget: effort === 'low' ? 0 : 1024 };
  if (/^gemini-[3-9]/.test(model)) return { thinkingLevel: 'low' };
  return null;
}

async function geminiOnce(model, apiKey, body) {
  let r;
  try {
    r = await fetch(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AIError('Network error. Check your connection.', { retryable: true });
  }
  const j = await r.json().catch(() => ({}));
  return { r, j };
}

async function callGemini({ images, text, system, schema, effort }) {
  const { apiKey } = getSettings();
  const model = await ensureGeminiModel(apiKey);
  const parts = images.map((d) => ({ inlineData: { mimeType: 'image/jpeg', data: d.split(',')[1] } }));
  parts.push({ text });
  const body = {
    contents: [{ role: 'user', parts }],
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: { responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema) },
  };
  const thinking = thinkingFor(model, effort);
  if (thinking) body.generationConfig.thinkingConfig = thinking;

  let { r, j } = await geminiOnce(model, apiKey, body);
  if (r.status === 400 && thinking && /thinking/i.test(j.error?.message || '')) {
    delete body.generationConfig.thinkingConfig; // model doesn't accept this thinking setting
    ({ r, j } = await geminiOnce(model, apiKey, body));
  }
  if (r.status === 503 || r.status === 500) { // "model overloaded": one quick retry
    await new Promise((res) => setTimeout(res, 1500));
    ({ r, j } = await geminiOnce(model, apiKey, body));
  }
  if (!r.ok) {
    if (r.status === 429) throw new AIError('Gemini free-tier limit reached.', { retryable: true });
    if (r.status === 503 || r.status === 500) throw new AIError('Gemini is overloaded right now.', { retryable: true });
    if (r.status === 404) throw new AIError(`Gemini model "${model}" not available. Pick another in Settings.`);
    throw new AIError(j.error?.message || `Gemini request failed (HTTP ${r.status})`);
  }
  const out = (j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  if (!out) throw new AIError('Gemini returned no answer.', { retryable: true });
  return out;
}

// ---------- Claude ----------
let sdkPromise;
const loadSdk = () => (sdkPromise ||= import(ANTHROPIC_SDK).then((m) => m.default).catch((e) => { sdkPromise = null; throw e; }));

async function claudeClient(apiKey) {
  let Anthropic;
  try { Anthropic = await loadSdk(); } catch { throw new AIError('Could not load the Claude library (offline?).', { retryable: true }); }
  // The key is the user's own and stays on their device, so direct browser calls are acceptable here.
  return { Anthropic, client: new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 }) };
}

function claudeError(Anthropic, e) {
  if (e instanceof Anthropic.AuthenticationError) return new AIError('Claude API key is invalid.');
  if (e instanceof Anthropic.PermissionDeniedError) return new AIError('Claude key lacks permission (check credit/billing in the Claude Console).');
  if (e instanceof Anthropic.NotFoundError) return new AIError('Claude model not available for this key.');
  if (e instanceof Anthropic.RateLimitError) return new AIError('Claude rate limit reached.', { retryable: true });
  if (e instanceof Anthropic.BadRequestError) return new AIError(`Claude rejected the request: ${e.message}`);
  if (e instanceof Anthropic.APIConnectionError) return new AIError('Network error reaching Claude.', { retryable: true });
  if (e instanceof Anthropic.APIError) return new AIError(`Claude error ${e.status ?? ''}: ${e.message}`, { retryable: (e.status ?? 500) >= 500 });
  return e;
}

async function callClaude({ images, text, system, schema, effort }) {
  const { claudeKey, claudeModel } = getSettings();
  const model = claudeModel || DEFAULT_CLAUDE_MODEL;
  const { Anthropic, client } = await claudeClient(claudeKey);
  const content = images.map((d) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: d.split(',')[1] } }));
  content.push({ type: 'text', text });
  const params = {
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content }],
    output_config: { effort, format: { type: 'json_schema', schema } },
  };
  // Server-side refusal fallback (Opus/Sonnet 5.5): a declined request is re-run on Anthropic's recommended model.
  if (model !== 'claude-haiku-5-5') Object.assign(params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  let res;
  try { res = await client.beta.messages.create(params); } catch (e) { throw claudeError(Anthropic, e); }
  if (res.stop_reason === 'refusal') throw new AIError('Claude declined this request.');
  if (res.stop_reason === 'max_tokens') throw new AIError('Claude ran out of room. Try fewer photos.', { retryable: true });
  const out = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!out) throw new AIError('Claude returned no answer.', { retryable: true });
  return out;
}

export async function testClaude(apiKey, model) {
  const { Anthropic, client } = await claudeClient(apiKey);
  // Token counting is free and, unlike the models endpoint, reachable from a browser.
  try {
    await client.messages.countTokens({ model: model || DEFAULT_CLAUDE_MODEL, messages: [{ role: 'user', content: 'ping' }] });
  } catch (e) { throw claudeError(Anthropic, e); }
}

// ---------- routing ----------
const PROVIDERS = {
  gemini: { name: 'Gemini', call: callGemini, ready: (s) => !!s.apiKey },
  claude: { name: 'Claude', call: callClaude, ready: (s) => !!s.claudeKey },
};
let lastUsed = null;
export const lastProvider = () => lastUsed;

async function generate(req) {
  const s = getSettings();
  const first = s.provider === 'claude' ? 'claude' : 'gemini';
  const second = first === 'claude' ? 'gemini' : 'claude';
  const order = [first, second].filter((p) => PROVIDERS[p].ready(s));
  if (!order.length) throw new Error('Add a Gemini or Claude API key in Settings first.');
  let lastErr;
  for (const p of order) {
    try {
      const text = await PROVIDERS[p].call(req);
      lastUsed = p === first ? PROVIDERS[p].name : `${PROVIDERS[p].name} (backup: ${lastErr?.message || 'first choice failed'})`;
      try { return JSON.parse(text); } catch { throw new AIError('Could not read the AI answer.', { retryable: true }); }
    } catch (e) {
      lastErr = e;
      if (!e.retryable || s.autoFallback === false) break;
    }
  }
  throw lastErr;
}

// ---------- schemas (standard JSON Schema; converted for Gemini) ----------
const NUM = { type: 'number' };
const STR = { type: 'string' };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const ITEM = obj({ name: STR, portion: STR, kcal: NUM, protein: NUM, carbs: NUM, fat: NUM, fiber: NUM, sugar: NUM, sodium: NUM });
const MEAL = obj({ items: { type: 'array', items: ITEM }, confidence: { type: 'string', enum: ['low', 'medium', 'high'] }, notes: STR });
const WORKOUT = obj({ name: STR, minutes: NUM, met: NUM, kcal: NUM });
const REVIEW = obj({
  score: { type: 'integer' }, headline: STR, summary: STR,
  wins: { type: 'array', items: STR }, improvements: { type: 'array', items: STR }, tomorrow: STR,
});

const MEAL_SYSTEM = `You are an experienced registered dietitian estimating nutrition for a calorie-tracking app.
- Identify each distinct food or drink. Several photos may show the same meal from different angles: never double count.
- Estimate realistic portions from visual cues (plate/bowl size, utensils, hands, packaging). Include likely cooking oil, sauces and dressings.
- If a nutrition label, menu or receipt is visible, use it.
- The user's notes override what you see (e.g. "ate half", "no sugar", brand names).
- Units: kcal; protein, carbs, fat, fiber, sugar in grams; sodium in mg. Keep names short (2-4 words), portion like "1 bowl (~200 g)".
- notes: one or two short sentences on the key assumptions the user may want to correct.`;

export function analyzeMeal({ images, mealType, note }) {
  const text = `Meal: ${mealType}.\nUser notes: ${note?.trim() || 'none'}\n${images.length ? '' : 'No photo: estimate from the description only.'}`;
  return generate({ images, text, system: MEAL_SYSTEM, schema: MEAL, effort: 'medium' });
}

export function refineMeal({ items, note, correction }) {
  const text = `Current estimate (JSON): ${JSON.stringify(items)}
Original user notes: ${note?.trim() || 'none'}
User correction: ${correction}
Apply the correction and return the full updated item list. Keep items the correction does not affect unchanged.`;
  return generate({ images: [], text, system: MEAL_SYSTEM, schema: MEAL, effort: 'low' });
}

export function estimateWorkout({ text, profile }) {
  const prompt = `Estimate a workout from this description: "${text}".
Person: ${profile.sex}, ${profile.age} y, ${profile.heightCm} cm, ${profile.weightKg} kg.
Return a short name, duration in minutes (assume a typical duration if not given), average MET,
and NET active kcal burned above resting, i.e. (MET - 1) x kg x hours.`;
  return generate({ images: [], text: prompt, system: 'You are an exercise physiologist. Be realistic and concise.', schema: WORKOUT, effort: 'low' });
}

export function dayReview(ctx) {
  const system = `You are a supportive, evidence-based nutrition and fitness coach reviewing one day of a user's log.
Be specific: reference the actual foods, numbers and workouts. Be honest but kind; no shaming. No medical diagnoses.
- score: 1-10 for how well the day supports the user's goal (energy balance, protein, food quality, activity).
- headline: max 8 words.
- summary: 2-3 sentences on intake vs target, macros, and burn.
- wins: 1-3 short bullets. improvements: 1-3 short, practical, concrete suggestions (e.g. food swaps, timing, portion).
- tomorrow: one actionable focus for tomorrow.`;
  return generate({ images: [], text: `Day data (JSON):\n${JSON.stringify(ctx)}`, system, schema: REVIEW, effort: 'medium' });
}
