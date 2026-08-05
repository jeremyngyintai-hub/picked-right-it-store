// ============================================================
// AI文案師:用Gemini幫每件新上架產品寫三語名稱+描述
// (根治「全站英文機器名」問題 — 令個店睇落係真人打理)
// 冇GEMINI_API_KEY或者失敗 → 安全fallback用模板
// ============================================================

const GEMINI_MODELS = [process.env.GEMINI_MODEL, "gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"].filter(Boolean);

async function aiCopy(nameEn, cat) {
  if (!process.env.GEMINI_API_KEY) return null;
  const prompt = `你係香港生活選物店「揀啱」嘅文案師。根據以下英文產品名,寫出三語產品名同一句描述。

英文原名:${nameEn}
分類:${cat}

要求:
- 廣東話名:8-16字,地道香港口語感,講清件貨係乜(例:「磁吸無線充電座」「寵物自動飲水機」)
- 描述:20-40字,講用途同賣點,語氣親切,唔好誇大功效,唔好用「實測」「最」「第一」呢類字眼
- 簡體:同樣意思嘅普通話版本
- 英文:簡潔自然嘅產品名(唔好照抄原名嘅冗長格式)

只回覆JSON,唔好有任何其他文字或markdown:
{"zhHantName":"","zhHantDesc":"","zhHansName":"","zhHansDesc":"","enName":"","enDesc":""}`;

  for (const model of GEMINI_MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 800, temperature: 0.6 },
          }),
        }
      );
      const data = await res.json();
      if (data.error) {
        if ([404, 400, 429].includes(data.error.code)) continue;
        return null;
      }
      const text = ((data.candidates || [])[0]?.content?.parts || []).map((p) => p.text || "").join("");
      const clean = text.replace(/```json|```/g, "").trim();
      const j = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
      if (!j.zhHantName || !j.enName) return null;
      return {
        "zh-Hant": { name: String(j.zhHantName).slice(0, 40), desc: String(j.zhHantDesc || "").slice(0, 120) },
        "zh-Hans": { name: String(j.zhHansName || j.zhHantName).slice(0, 40), desc: String(j.zhHansDesc || "").slice(0, 120) },
        "en": { name: String(j.enName).slice(0, 60), desc: String(j.enDesc || "").slice(0, 160) },
      };
    } catch {
      continue;
    }
  }
  return null;
}

module.exports = { aiCopy };
