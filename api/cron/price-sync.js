// ============================================================
// /api/cron/price-sync
// ------------------------------------------------------------
// 自動價格同步:每日自動(Vercel Cron)或手動觸發。
// 逐件產品去CJ查最新成本價,如果成本變咗:
//   新賣價 = 新成本 × 匯率 × 該產品原本嘅利潤倍數
// (倍數喺上架嗰刻鎖定:原賣價 ÷ (原成本×匯率),所以CJ加價,你自動跟住加)
//
// 安全網:
//   - 成本變動<2% 唔會郁(避免匯率式微調成日改價)
//   - 新價最少 = 成本×匯率×1.2(永遠唔會自動變蝕本價)
//   - 每次最多處理30件(避免超時)
//
// 觸發方式:
//   1. Vercel Cron 每日自動(vercel.json 已設定)
//   2. 手動:GET /api/cron/price-sync?secret=你嘅ADMIN_SYNC_SECRET
// ============================================================

const CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1";
const USD_TO_HKD = 7.8;
const MIN_MARKUP = 1.2;        // 安全底線倍數
const CHANGE_THRESHOLD = 0.02; // 成本變動2%以上先郁
const MAX_PER_RUN = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCostUSD(v) {
  if (v == null) return null;
  const nums = String(v).match(/[\d.]+/g);
  return nums ? parseFloat(nums[0]) : null;
}
function prettyPrice(raw) {
  const rounded = Math.ceil(raw / 10) * 10 - 2;
  return Math.max(rounded, 48);
}

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
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "User-Agent": "picked-right-it",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  const data = await res.json();
  if (!data.commit) throw new Error(`GitHub write failed: ${data.message || "unknown"}`);
}

module.exports = async (req, res) => {
  // 認證:接受 Vercel Cron 嘅 Authorization header,或者手動用 ?secret=
  const authHeader = req.headers["authorization"] || "";
  const isCron = process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isManual = req.query.secret === process.env.ADMIN_SYNC_SECRET;
  if (!isCron && !isManual) {
    return res.status(401).json({ error: "未授權" });
  }
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
    return res.status(500).json({ error: "未設定 GITHUB_TOKEN / GITHUB_REPO" });
  }

  const report = { checked: 0, updated: [], unchanged: 0, errors: [], skipped: 0 };

  try {
    const { content, sha } = await ghGetFile("data/products.json");
    const list = content ? JSON.parse(content) : [];
    if (list.length === 0) {
      return res.status(200).json({ message: "冇產品需要同步", report });
    }

    const accessToken = await cjAuth();
    await sleep(1100);

    let anyChange = false;
    const toProcess = list.slice(0, MAX_PER_RUN);
    if (list.length > MAX_PER_RUN) report.skipped = list.length - MAX_PER_RUN;

    for (const p of toProcess) {
      if (!p.cjPid) { continue; }
      report.checked++;
      try {
        const cjRes = await fetch(`${CJ_BASE}/product/query?pid=${encodeURIComponent(p.cjPid)}`, {
          headers: { "CJ-Access-Token": accessToken },
        });
        const cjData = await cjRes.json();
        if (!cjData.result && !cjData.success) throw new Error(cjData.message || "查詢失敗");

        const detail = cjData.data;
        // 用返同一個variant嘅價;搵唔返個vid就用產品整體價
        const variant = (detail.variants || []).find((v) => v.vid === p.cjVid);
        const newCostUSD = parseCostUSD(variant ? variant.variantSellPrice : detail.sellPrice);

        if (newCostUSD == null || !p.costUSD) { await sleep(1100); continue; }

        const changeRatio = Math.abs(newCostUSD - p.costUSD) / p.costUSD;
        if (changeRatio < CHANGE_THRESHOLD) {
          report.unchanged++;
          await sleep(1100);
          continue;
        }

        // 鎖定上架時嘅倍數:原賣價 ÷ (原成本×匯率)
        const lockedMarkup = p.price / (p.costUSD * USD_TO_HKD);
        const effectiveMarkup = Math.max(lockedMarkup, MIN_MARKUP);
        const newPrice = prettyPrice(newCostUSD * USD_TO_HKD * effectiveMarkup);

        report.updated.push({
          id: p.id,
          name: (p.i18n && p.i18n["zh-Hant"] && p.i18n["zh-Hant"].name) || "",
          costUSD: `${p.costUSD} → ${newCostUSD}`,
          priceHKD: `${p.price} → ${newPrice}`,
        });

        p.costUSD = newCostUSD;
        p.price = newPrice;
        p.priceSyncedAt = new Date().toISOString();
        anyChange = true;
      } catch (e) {
        report.errors.push(`#${p.id}: ${e.message}`);
      }
      await sleep(1100); // 避開CJ每秒1次限制
    }

    if (anyChange) {
      await ghPutFile(
        "data/products.json",
        JSON.stringify(list, null, 2),
        sha,
        `price-sync: ${report.updated.length} product(s) repriced`
      );
    }

    res.status(200).json({
      message: anyChange
        ? `已更新 ${report.updated.length} 件產品價格,約1分鐘後生效`
        : "全部價格無需調整",
      report,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, report });
  }
};

module.exports.config = { maxDuration: 60 };
