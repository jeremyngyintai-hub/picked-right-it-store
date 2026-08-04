// ============================================================
// /api/cron/store-maintain
// ------------------------------------------------------------
// 每日自動(或手動 ?secret=)做兩件事:
//   1. 將KV嘅累計銷量(soldQty)寫入products.json
//      → 商店前台會自動將bestseller排最前
//   2. 自動落架滯銷貨:上架超過X日(預設14,可用AUTO_DELIST_DAYS改)
//      而且期間一單都冇 → 設 delisted:true(前台隱藏,可喺dashboard還原)
//      如果之後有單返嚟,會自動上返架
// ============================================================

const { kvReady, pipeline } = require("../lib/kv");

const DELIST_DAYS = parseInt(process.env.AUTO_DELIST_DAYS) || 14;

async function ghGetFile(path) {
  const res = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${path}`,
    { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "User-Agent": "picked-right-it" } }
  );
  if (res.status === 404) return { content: null, sha: null };
  const data = await res.json();
  if (!data.content) throw new Error(`GitHub read failed: ${data.message || "unknown"}`);
  return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
}
async function ghPutFile(path, contentStr, sha, message) {
  const body = { message, content: Buffer.from(contentStr, "utf8").toString("base64") };
  if (sha) body.sha = sha;
  const res = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${path}`,
    { method: "PUT", headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "User-Agent": "picked-right-it", "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  const data = await res.json();
  if (!data.commit) throw new Error(`GitHub write failed: ${data.message || "unknown"}`);
}

module.exports = async (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  const isCron = process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isManual = req.query.secret === process.env.ADMIN_SYNC_SECRET;
  if (!isCron && !isManual) return res.status(401).json({ error: "未授權" });
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
    return res.status(500).json({ error: "未設定 GITHUB_TOKEN / GITHUB_REPO" });
  }

  const report = { salesSynced: 0, delisted: [], relisted: [], kv: kvReady() };

  try {
    const { content, sha } = await ghGetFile("data/products.json");
    const list = content ? JSON.parse(content) : [];
    if (list.length === 0) return res.status(200).json({ message: "冇產品", report });

    let changed = false;
    const now = Date.now();

    if (kvReady()) {
      // 一次過攞晒所有產品嘅銷量+最後成交時間
      const cmds = [];
      list.forEach((p) => {
        cmds.push(["GET", `sold:qty:${p.id}`]);
        cmds.push(["GET", `lastsale:${p.id}`]);
      });
      const results = await pipeline(cmds);

      list.forEach((p, i) => {
        const soldQty = parseInt(results[i * 2]) || 0;
        const lastSale = parseInt(results[i * 2 + 1]) || 0;

        if (p.soldQty !== soldQty) { p.soldQty = soldQty; changed = true; report.salesSynced++; }
        if (lastSale && p.lastSaleAt !== lastSale) { p.lastSaleAt = lastSale; changed = true; }

        const ageMs = now - new Date(p.addedAt || 0).getTime();
        const staleSale = !lastSale || (now - lastSale > DELIST_DAYS * 86400e3);

        // 上架夠耐+一直冇單 → 自動落架
        if (!p.delisted && ageMs > DELIST_DAYS * 86400e3 && soldQty === 0 && staleSale) {
          p.delisted = true;
          p.delistedAt = new Date().toISOString();
          changed = true;
          report.delisted.push({ id: p.id, name: (p.i18n?.["zh-Hant"]?.name) || "" });
        }
        // 自動落架咗但之後有單 → 自動上返架
        if (p.delisted && lastSale && now - lastSale < DELIST_DAYS * 86400e3) {
          p.delisted = false;
          changed = true;
          report.relisted.push({ id: p.id });
        }
      });
    }

    if (changed) {
      await ghPutFile("data/products.json", JSON.stringify(list, null, 2), sha,
        `store-maintain: sales sync + ${report.delisted.length} delisted`);
    }

    res.status(200).json({
      message: changed
        ? `完成:同步${report.salesSynced}件銷量,自動落架${report.delisted.length}件,上返架${report.relisted.length}件`
        : "冇嘢需要更新",
      report,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, report });
  }
};

module.exports.config = { maxDuration: 60 };
