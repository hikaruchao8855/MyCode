/**
 * /api/sentence —— 給「AI 造句填空」用的後端
 *
 * 放在 Vercel 專案裡（跟 api/calculate.js 同一個資料夾）就會自動變成 /api/sentence。
 * key 只讀環境變數，永遠不會出現在前端。
 *
 * 需要的環境變數（Vercel → Settings → Environment Variables）：
 *   GROQ_API_KEY = gsk_...            ← 必填
 *   GROQ_MODEL   = openai/gpt-oss-120b       ← 選填，不填預設就是這個
 *
 * 請求：POST /api/sentence   { "word": "anticipate", "zh": "期盼" }
 * 回應：200 { "sentence": "...", "zh": "中文翻譯", "model": "..." }
 *       錯誤一律 { "error": "說明", "detail": "..." }，狀態碼照實際情況回
 *
 * 註：如果這個專案的 package.json 設了 "type": "module"，把檔案最後一行
 *     module.exports = handler;  改成  export default handler;
 */

const GROQ_URL = process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1/chat/completions";
/* 2026-08-16 Groq 已把 llama-3.3-70b-versatile 下線（免費／developer 方案），
   官方建議的替代品是 openai/gpt-oss-120b（小一點的 20b 當備援）。
   模型代號這種東西會過期，所以這裡排一串：前一個回「模型不存在」就自動換下一個。 */
const FALLBACK_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];

function clean(s, max) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max);
}

function buildPrompt(word, meaning) {
  return 'Target word: "' + word + '"' + (meaning ? ' (meaning in Chinese: ' + meaning + ')' : '') + '.\n' +
    'Write ONE natural English sentence at Taiwanese senior-high (高中) level, 12 to 20 words long, ' +
    'that uses the exact word "' + word + '" exactly once, in that exact form (no inflection, no plural, no -ing/-ed). ' +
    'The sentence must make the meaning clear from context.\n' +
    'Then give a natural Traditional Chinese (Taiwan) translation of that sentence.\n' +
    'Reply only with JSON: {"sentence":"...","zh":"..."}';
}

function hasWord(sentence, word) {
  const safe = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|[^A-Za-z])" + safe + "([^A-Za-z]|$)", "i").test(sentence);
}

async function askGroq(key, model, word, meaning) {
  const body = {
    model: model,
    temperature: 0.8,
    max_tokens: 400,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "You write example sentences for a Taiwanese senior-high school student learning English vocabulary. " +
          "Always reply with a single JSON object and nothing else."
      },
      { role: "user", content: buildPrompt(word, meaning) }
    ]
  };
  const r = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  if (!r.ok) return { ok: false, status: r.status, text: text };
  let obj = null;
  try { obj = JSON.parse(text); } catch (e) { return { ok: false, status: 502, text: "Groq 回傳不是 JSON" }; }
  const content = (obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.content) || "";
  let out = null;
  try { out = JSON.parse(content); } catch (e) {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) { try { out = JSON.parse(m[0]); } catch (e2) {} }
  }
  if (!out || !out.sentence) return { ok: false, status: 502, text: "Groq 回傳的內容沒有句子：" + String(content).slice(0, 200) };
  return { ok: true, sentence: clean(out.sentence, 400), zh: clean(out.zh, 400) };
}

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") { res.statusCode = 405; return res.json({ error: "只接受 POST" }); }

  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: "伺服器沒有設定 GROQ_API_KEY 環境變數" });

  let payload = req.body;
  if (typeof payload === "string") { try { payload = JSON.parse(payload || "{}"); } catch (e) { payload = {}; } }
  payload = payload || {};

  const word = clean(payload.word, 60).replace(/[^A-Za-z\- ]/g, "");
  const meaning = clean(payload.zh || payload.meaning, 120);
  if (!word) return res.status(400).json({ error: "缺少 word（要出的單字）" });

  /* 候選模型：環境變數指定的排第一，其餘照備援清單 */
  const models = [];
  const envModel = clean(process.env.GROQ_MODEL, 80);
  if (envModel) models.push(envModel);
  FALLBACK_MODELS.forEach(function (m) { if (models.indexOf(m) < 0) models.push(m); });

  function isModelGone(status, text) {
    return status === 404 || status === 400 && /model|decommission|not\s*found|does not exist/i.test(text);
  }

  let last = null, triedModel = null;
  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    triedModel = model;
    let nextModel = false;
    /* 同一個字最多要兩次：第二次還是不含該字就回錯誤，讓前端換一題 */
    for (let attempt = 0; attempt < 2; attempt++) {
      let r;
      try { r = await askGroq(key, model, word, meaning); }
      catch (e) { return res.status(502).json({ error: "連不上 Groq", detail: String(e && e.message || e) }); }
      if (!r.ok) {
        last = r;
        if (r.status === 401 || r.status === 403) return res.status(401).json({ error: "Groq 不接受這組 API Key", detail: r.text.slice(0, 300) });
        if (r.status === 429) return res.status(429).json({ error: "Groq 免費額度暫時用完", detail: r.text.slice(0, 300) });
        if (isModelGone(r.status, r.text)) { nextModel = true; break; }   /* 這個模型沒了 → 換下一個 */
        continue;
      }
      if (hasWord(r.sentence, word)) {
        return res.status(200).json({ sentence: r.sentence, zh: r.zh, model: model });
      }
      last = { status: 502, text: "句子裡沒有出現指定的單字" };
    }
    if (!nextModel) break;   /* 不是模型問題就別再換了 */
  }

  if (last && isModelGone(last.status, last.text)) {
    return res.status(500).json({
      error: "可用的模型都叫不到（最後試的是 " + triedModel + "），請更新模型代號",
      detail: String(last.text).slice(0, 300)
    });
  }
  return res.status(502).json({
    error: "AI 這次沒把指定單字寫進句子，請再試一次",
    detail: last ? String(last.text).slice(0, 300) : ""
  });
}

module.exports = handler;
