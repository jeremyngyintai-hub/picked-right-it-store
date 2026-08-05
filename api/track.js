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

const { kvReady, pipeline } = require("./_lib/kv");

function ymdHK(ts) {
  const d = new Date(ts + 8 * 3600e3);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

module.exports = async (req, res) => {
  // ===== 瀏覽量beacon(由/api/pv合併入嚟):/api/track?t=page 或 ?t=product&id=13 =====
  if (req.query.t) {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (!kvReady()) return res.status(200).json({ ok: false });
      const day = ymdHK(Date.now());
      const cmds = [];
      if (req.query.t === "page") {
        cmds.push(["INCR", `pv:day:${day}`]);
      } else if (req.query.t === "product") {
        const id = parseInt(req.query.id);
        if (!id || id < 1 || id > 100000) return res.status(400).json({ ok: false });
        cmds.push(["INCR", `pv:product:${id}`]);
        cmds.push(["INCR", `pv:day:${day}`]);
      } else {
        return res.status(400).json({ ok: false });
      }
      await pipeline(cmds);
      return res.status(200).json({ ok: true });
    } catch {
      return res.status(200).json({ ok: false });
    }
  }

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
