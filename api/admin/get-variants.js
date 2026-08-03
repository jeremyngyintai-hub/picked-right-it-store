// ============================================================
// GET /api/admin/get-variants?secret=xxx&pid=xxxxx
// ------------------------------------------------------------
// 輸入CJ產品pid,攞返佢所有variants(vid/顏色/款式/實際成本價)。
// 自動落單一定要有vid,所以上架新產品前用呢個工具攞一次。
//
// 用法:
//   /api/admin/get-variants?secret=你的密碼&pid=產品PID
// ============================================================

const CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1";

async function getAccessToken() {
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
  if (req.query.secret !== process.env.ADMIN_SYNC_SECRET) {
    return res.status(401).json({ error: "密碼錯誤" });
  }
  const pid = req.query.pid;
  if (!pid) {
    return res.status(400).json({ error: "要提供 ?pid=xxx" });
  }

  try {
    const accessToken = await getAccessToken();
    await new Promise((r) => setTimeout(r, 1100)); // 避開QPS限制

    const apiRes = await fetch(
      `${CJ_BASE}/product/query?pid=${encodeURIComponent(pid)}`,
      { headers: { "CJ-Access-Token": accessToken } }
    );
    const data = await apiRes.json();
    if (!data.result && !data.success) throw new Error(data.message || "CJ error");

    const p = data.data;
    res.status(200).json({
      productName: p.productNameEn,
      productSku: p.productSku,
      images: p.productImageSet,
      variants: (p.variants || []).map((v) => ({
        vid: v.vid,
        name: v.variantNameEn,
        sku: v.variantSku,
        option: v.variantKey,
        costUSD: v.variantSellPrice,
        weightG: v.variantWeight,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
