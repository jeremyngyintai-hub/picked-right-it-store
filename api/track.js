// ============================================================
// GET /api/track?num=追蹤號碼
// ------------------------------------------------------------
// 客人輸入追蹤號碼,查CJ物流軌跡。公開endpoint(唔使密碼),
// 因為追蹤號碼本身就係客人先知嘅嘢。
//
// ⚠️ CJ物流查詢endpoint路徑以官方文件「07 Logistic」為準,
// 如果呢個路徑回傳錯誤,去 developers.cjdropshipping.cn 對返
// 最新路徑改一改就得。前端有後備方案(cjpacket.com連結)。
// ============================================================

const CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1";

async function cjAuth() {
  const res = await fetch(`${CJ_BASE}/authentication/getAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: process.env.CJ_API_KEY }),
  });
  const data = await res.json();
  if (!data.result) throw new Error(`CJ auth: ${data.message}`);
  return data.data.accessToken;
}

module.exports = async (req, res) => {
  const num = (req.query.num || "").trim();
  if (!num || num.length < 6 || num.length > 40 || !/^[A-Za-z0-9-]+$/.test(num)) {
    return res.status(400).json({ error: "追蹤號碼格式不正確" });
  }

  try {
    const accessToken = await cjAuth();
    await new Promise((r) => setTimeout(r, 1100));

    const apiRes = await fetch(
      `${CJ_BASE}/logistic/getTrackInfo?trackNumber=${encodeURIComponent(num)}`,
      { headers: { "CJ-Access-Token": accessToken } }
    );
    const data = await apiRes.json();
    if (!data.result && !data.success) {
      throw new Error(data.message || "查詢唔到呢個追蹤號碼");
    }

    res.status(200).json({ tracking: data.data });
  } catch (err) {
    res.status(502).json({
      error: err.message,
      fallbackUrl: `https://www.cjpacket.com/?trackNumber=${encodeURIComponent(num)}`,
    });
  }
};
