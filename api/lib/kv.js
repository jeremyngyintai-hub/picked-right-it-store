// ============================================================
// Vercel KV (Upstash Redis) REST 輔助庫
// ------------------------------------------------------------
// 喺Vercel加咗KV/Upstash integration之後,會自動有呢兩個環境變數:
//   KV_REST_API_URL, KV_REST_API_TOKEN
// 未設定嘅話,kvReady()會回false,所有功能安全跳過(唔會令收銀爆錯)。
// ============================================================

const URL_ = process.env.KV_REST_API_URL;
const TOKEN = process.env.KV_REST_API_TOKEN;

function kvReady() {
  return !!(URL_ && TOKEN);
}

// 單一指令:kv(["SET","key","value"])
async function kv(command) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const data = await res.json();
  if (data.error) throw new Error(`KV: ${data.error}`);
  return data.result;
}

// 批量指令:pipeline([["INCRBY","a","1"],["SET","b","2"]])
async function pipeline(commands) {
  const res = await fetch(`${URL_}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  const data = await res.json();
  if (data.error) throw new Error(`KV pipeline: ${data.error}`);
  return data.map((d) => d.result);
}

module.exports = { kvReady, kv, pipeline };
