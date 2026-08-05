// ============================================================
// POST /api/chat
// ------------------------------------------------------------
// AI客服:用Claude Haiku(平價快速)回答一般客服問題。
// 特別功能:客人message入面有追蹤號碼,會自動查CJ物流,答埋去到邊。
//
// 需要環境變數:ANTHROPIC_API_KEY(console.anthropic.com攞)
// ============================================================

const CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1";

const SYSTEM_PROMPT = `你係「揀啱 PICKED RIGHT IT」(picked-right.it.com)嘅網店客服助手。用客人嘅語言回覆(廣東話客人用廣東話,簡體用簡體,英文用英文),語氣親切、簡潔,每次回覆唔好超過120字。

商店資料:
- 香港生活選物店,9大類:家居、美妝(主打PDRN韓系護膚)、電子、寵物、母嬰玩具、運動戶外、飾物配件、袋鞋、汽車用品
- 出貨:落單後48小時內安排出貨,一般7-12日送到,支援順豐站/智能櫃自取,全程有追蹤號碼
- 退換政策:只限「壞貨、寄錯款、運送損壞」— 收貨7日內影相WhatsApp客服可補寄或退款;「唔啱心水/改變主意」唔屬退換範圍,可以引導客人落單前先問清楚
- 付款:信用卡(Visa/Mastercard,經Stripe安全處理),或者WhatsApp落單
- 新客優惠碼:PICKED10(首單9折)
- 訂單追蹤:picked-right.it.com/track.html,或者直接畀追蹤號碼我
- WhatsApp真人客服:+852 5104 4417(https://wa.me/85251044417)

規則:
- 唔好作資料。唔知/查唔到嘅嘢(例如具體訂單內容、退款進度),叫客人WhatsApp真人客服跟進
- 涉及改地址、取消訂單、退款申請:一律引導去WhatsApp真人處理
- 唔好承諾確實送達日期,只講一般7-12日
- 如果對話入面有[物流查詢結果],用嗰啲資料簡潔咁答客人件貨去到邊`;

async function tryTrack(text) {
  // 偵測似追蹤號碼嘅字串(8-30位英數,起碼有2個數字)
  const m = text.match(/\b[A-Z]{0,6}\d[\dA-Z-]{7,28}\b/i);
  if (!m || !process.env.CJ_API_KEY) return null;
  const num = m[0];
  try {
    const authRes = await fetch(`${CJ_BASE}/authentication/getAccessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: process.env.CJ_API_KEY }),
    });
    const auth = await authRes.json();
    if (!auth.result) return null;
    await new Promise((r) => setTimeout(r, 1100));
    const tRes = await fetch(`${CJ_BASE}/logistic/getTrackInfo?trackNumber=${encodeURIComponent(num)}`, {
      headers: { "CJ-Access-Token": auth.data.accessToken },
    });
    const t = await tRes.json();
    if (!t.result && !t.success) return { num, info: "查唔到呢個號碼,可能未起卷或者號碼有誤" };
    return { num, info: JSON.stringify(t.data).slice(0, 1200) };
  } catch {
    return null;
  }
}

// 免費Gemini:model名會隨Google更新,自動輪替試到通為止
const GEMINI_MODELS = [
  process.env.GEMINI_MODEL,        // 你手動指定嘅(如有)
  "gemini-flash-latest",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
].filter(Boolean);

async function askGeminiModel(model, systemPrompt, messages) {
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: 400, temperature: 0.5 },
      }),
    }
  );
  const data = await res.json();
  if (data.error) {
    const err = new Error(`[${model}] ${data.error.message || "Gemini API錯誤"}`);
    err.code = data.error.code;
    throw err;
  }
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  return (parts || []).map((p) => p.text || "").join("").trim();
}

async function askGemini(systemPrompt, messages) {
  let lastErr = null;
  for (const model of GEMINI_MODELS) {
    try {
      const reply = await askGeminiModel(model, systemPrompt, messages);
      if (reply) return reply;
    } catch (e) {
      lastErr = e;
      // model唔存在(404/400)或該model冇quota(429)→試下一個;其他錯誤先停
      if (e.code && ![404, 400, 429].includes(e.code)) throw e;
    }
  }
  throw lastErr || new Error("所有Gemini model都試唔通");
}

async function askClaude(systemPrompt, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      system: systemPrompt,
      messages,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "AI API錯誤");
  return (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

module.exports = async (req, res) => {
  // ===== 診斷模式(店主用):/api/chat?debug=你嘅ADMIN_SYNC_SECRET =====
  if (req.method === "GET") {
    if (req.query.debug !== process.env.ADMIN_SYNC_SECRET) {
      return res.status(405).json({ error: "Method not allowed" });
    }
    const diag = { hasGeminiKey: !!process.env.GEMINI_API_KEY, hasClaudeKey: !!process.env.ANTHROPIC_API_KEY, models: {} };
    if (process.env.GEMINI_API_KEY) {
      for (const model of GEMINI_MODELS) {
        try {
          const r = await askGeminiModel(model, "You are a test.", [{ role: "user", content: "Reply with OK only." }]);
          diag.models[model] = "✅ " + (r || "").slice(0, 20);
          break; // 有一個通就夠
        } catch (e) {
          diag.models[model] = "❌ " + e.message.slice(0, 160);
        }
      }
    }
    return res.status(200).json(diag);
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const hasClaude = !!process.env.ANTHROPIC_API_KEY;
  if (!hasGemini && !hasClaude) {
    return res.status(200).json({ reply: "AI客服暫時未啟用。請直接WhatsApp我哋:+852 5104 4417" });
  }

  try {
    let { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "要提供messages" });
    }
    // 防濫用:最多留最近12個message,每個最長1200字
    messages = messages.slice(-12).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 1200),
    }));

    // 最後一個user message有追蹤號碼?自動查埋
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    let systemExtra = "";
    if (lastUser) {
      const track = await tryTrack(lastUser.content);
      if (track) systemExtra = `\n\n[物流查詢結果] 追蹤號碼 ${track.num}:${track.info}`;
    }

    let reply = "";
    const sys = SYSTEM_PROMPT + systemExtra;
    if (hasGemini) {
      try {
        reply = await askGemini(sys, messages);
      } catch (gErr) {
        console.error("Gemini失敗,試後備引擎:", gErr.message);
        if (hasClaude) reply = await askClaude(sys, messages);
        else throw gErr;
      }
    } else {
      reply = await askClaude(sys, messages);
    }
    if (!reply) reply = "唔好意思,暫時答唔到,請WhatsApp我哋:+852 5104 4417";
    res.status(200).json({ reply });
  } catch (err) {
    console.error(err);
    res.status(200).json({ reply: "系統繁忙,請稍後再試,或者直接WhatsApp真人客服:+852 5104 4417" });
  }
};

module.exports.config = { maxDuration: 30 };
