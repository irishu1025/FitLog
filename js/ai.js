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

// Per-attempt limits for Claude, so a stuck connection fails instead of spinning forever.
// Gemini has no limit: its free tier can take minutes, and the user prefers to wait for the answer.
const TIMEOUT_MS = { images: 60_000, text: 35_000 };

let getSettings = () => ({});
let onModelPicked = () => {};
let onStatus = () => {};
export function configure(getter, modelCallback, statusCallback = () => {}) {
  getSettings = getter; onModelPicked = modelCallback; onStatus = statusCallback;
}

// Small per-device activity log (Settings → AI activity) to diagnose slow or failed calls.
const LOG_KEY = 'fitlog-ai-log';
export function getLog() { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; } }
function logAttempt(entry) {
  try { localStorage.setItem(LOG_KEY, JSON.stringify([entry, ...getLog()].slice(0, 20))); } catch { /* storage unavailable */ }
}

class AIError extends Error {
  constructor(message, { retryable = false } = {}) { super(message); this.retryable = retryable; }
}

// ---------- Gemini ----------
export async function listModels(apiKey) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  const r = await fetch(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': apiKey }, signal: ctl.signal })
    .finally(() => clearTimeout(timer));
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

// Photo analysis and reviews use the model's default (full) thinking; quick text edits think lightly.
function thinkingFor(model, effort) {
  if (effort !== 'low') return null;
  if (/^gemini-2\.5/.test(model)) return { thinkingBudget: 0 };
  if (/^gemini-[3-9]/.test(model)) return { thinkingLevel: 'low' };
  return null;
}

async function geminiOnce(model, apiKey, body, timeoutMs) {
  const ctl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const r = await fetch(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const j = await r.json().catch(() => ({}));
    return { r, j };
  } catch {
    if (ctl.signal.aborted) throw new AIError(`Gemini didn't answer within ${timeoutMs / 1000} s.`, { retryable: true });
    throw new AIError('Network error reaching Gemini.', { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini({ images, text, system, schema, effort }, timeoutMs) {
  const { apiKey } = getSettings();
  const model = await ensureGeminiModel(apiKey);
  callGemini.model = model;
  const parts = images.map((d) => ({ inlineData: { mimeType: 'image/jpeg', data: d.split(',')[1] } }));
  parts.push({ text });
  const body = {
    contents: [{ role: 'user', parts }],
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: { responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema) },
  };
  const thinking = thinkingFor(model, effort);
  if (thinking) body.generationConfig.thinkingConfig = thinking;

  let { r, j } = await geminiOnce(model, apiKey, body, timeoutMs);
  if (r.status === 400 && thinking && /thinking/i.test(j.error?.message || '')) {
    delete body.generationConfig.thinkingConfig; // model doesn't accept this thinking setting
    ({ r, j } = await geminiOnce(model, apiKey, body, timeoutMs));
  }
  if (r.status === 503 || r.status === 500) { // "model overloaded": one quick retry
    await new Promise((res) => setTimeout(res, 1500));
    ({ r, j } = await geminiOnce(model, apiKey, body, timeoutMs));
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

async function claudeClient(apiKey, timeoutMs = TIMEOUT_MS.text) {
  let Anthropic;
  try { Anthropic = await loadSdk(); } catch { throw new AIError('Could not load the Claude library (offline?).', { retryable: true }); }
  // The key is the user's own and stays on their device, so direct browser calls are acceptable here.
  // timeout is in milliseconds in the TypeScript SDK; one automatic retry for 429/5xx/connection errors.
  return { Anthropic, client: new Anthropic({ apiKey, dangerouslyAllowBrowser: true, timeout: timeoutMs, maxRetries: 1 }) };
}

function claudeError(Anthropic, e) {
  if (e instanceof Anthropic.AuthenticationError) return new AIError('Claude API key is invalid.');
  if (e instanceof Anthropic.PermissionDeniedError) return new AIError('Claude key lacks permission (check credit/billing in the Claude Console).');
  if (e instanceof Anthropic.NotFoundError) return new AIError('Claude model not available for this key.');
  if (e instanceof Anthropic.RateLimitError) return new AIError('Claude rate limit reached.', { retryable: true });
  if (e instanceof Anthropic.BadRequestError) return new AIError(`Claude rejected the request: ${e.message}`);
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new AIError("Claude didn't answer in time.", { retryable: true });
  if (e instanceof Anthropic.APIConnectionError) return new AIError('Network error reaching Claude.', { retryable: true });
  if (e instanceof Anthropic.APIError) return new AIError(`Claude error ${e.status ?? ''}: ${e.message}`, { retryable: (e.status ?? 500) >= 500 });
  return e;
}

async function callClaude({ images, text, system, schema, effort }, timeoutMs) {
  const { claudeKey, claudeModel } = getSettings();
  const model = claudeModel || DEFAULT_CLAUDE_MODEL;
  callClaude.model = model;
  const { Anthropic, client } = await claudeClient(claudeKey, timeoutMs);
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
  const timeoutMs = req.images.length ? TIMEOUT_MS.images : TIMEOUT_MS.text;
  let lastErr;
  for (const p of order) {
    const started = Date.now();
    const entry = { at: new Date().toISOString(), task: req.task, provider: PROVIDERS[p].name, images: req.images.length };
    onStatus(PROVIDERS[p].name);
    try {
      const text = await PROVIDERS[p].call(req, p === 'gemini' ? null : timeoutMs);
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new AIError('Could not read the AI answer.', { retryable: true }); }
      logAttempt({ ...entry, model: PROVIDERS[p].call.model, ms: Date.now() - started, ok: true });
      lastUsed = p === first ? PROVIDERS[p].name : `${PROVIDERS[p].name} (backup: ${lastErr?.message || 'first choice failed'})`;
      return parsed;
    } catch (e) {
      logAttempt({ ...entry, model: PROVIDERS[p].call.model, ms: Date.now() - started, ok: false, error: e.message });
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
  return generate({ task: 'meal', images, text, system: MEAL_SYSTEM, schema: MEAL, effort: 'medium' });
}

export function refineMeal({ items, note, correction }) {
  const text = `Current estimate (JSON): ${JSON.stringify(items)}
Original user notes: ${note?.trim() || 'none'}
User correction: ${correction}
Apply the correction and return the full updated item list. Keep items the correction does not affect unchanged.`;
  return generate({ task: 'adjust', images: [], text, system: MEAL_SYSTEM, schema: MEAL, effort: 'low' });
}

export function estimateWorkout({ text, profile }) {
  const prompt = `Estimate a workout from this description: "${text}".
Person: ${profile.sex}, ${profile.age} y, ${profile.heightCm} cm, ${profile.weightKg} kg.
Return a short name, duration in minutes (assume a typical duration if not given), average MET,
and NET active kcal burned above resting, i.e. (MET - 1) x kg x hours.`;
  return generate({ images: [], text: prompt, system: 'You are an exercise physiologist. Be realistic and concise.', schema: WORKOUT, effort: 'low', task: 'workout' });
}

export function dayReview(ctx) {
  const system = `You are a supportive, evidence-based nutrition and fitness coach reviewing one day of a user's log.
Be specific: reference the actual foods, numbers and workouts. Be honest but kind; no shaming. No medical diagnoses.
- score: 1-10 for how well the day supports the user's goal (energy balance, protein, food quality, activity).
- headline: max 8 words.
- summary: 2-3 sentences on intake vs target, macros, and burn.
- wins: 1-3 short bullets. improvements: 1-3 short, practical, concrete suggestions (e.g. food swaps, timing, portion).
- tomorrow: one actionable focus for tomorrow.`;
  return generate({ images: [], text: `Day data (JSON):\n${JSON.stringify(ctx)}`, system, schema: REVIEW, effort: 'medium', task: 'review' });
}
