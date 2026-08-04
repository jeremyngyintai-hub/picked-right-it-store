// ============================================================
// GET /api/admin/analytics?secret=xxx
// 完整數據分析:
//   - 30日每日:營業額 / 成本 / Stripe手續費估算 / 毛利 / 訂單數 / 瀏覽量
//   - 8週及6個月匯總
//   - 每件產品:瀏覽量、銷量、營業額、轉換率
// ============================================================

const { kvReady, kv, pipeline } = require("../_lib/kv");
const { getCatalog } = require("../_lib/catalog");

const USD_TO_HKD = 7.8;
const DAY = 86400e3;

function ymdHK(ts) {
  return new Date(ts + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
}
function dateLabelHK(ts) {
  const d = new Date(ts + 8 * 3600e3);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

module.exports = async (req, res) => {
  if (req.query.secret !== process.env.ADMIN_SYNC_SECRET) {
    return res.status(401).json({ error: "密碼錯誤" });
  }
  if (!kvReady()) {
    return res.status(500).json({ error: "未設定Vercel KV(Storage → Create Database → Upstash Redis),設定完redeploy。" });
  }

  try {
    const now = Date.now();

    // ===== 訂單 =====
    const raw = await kv(["LRANGE", "orders", "0", "999"]);
    const orders = (raw || []).map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);

    // ===== 產品資料(名/成本)=====
    let productMeta = {};
    try {
      const pj = await fetch(`${process.env.SITE_URL}/data/products.json`).then((r) => r.json());
      (pj || []).forEach((p) => {
        productMeta[p.id] = {
          name: (p.i18n?.["zh-Hant"]?.name) || `#${p.id}`,
          costHKD: p.costUSD ? Math.round(p.costUSD * USD_TO_HKD) : null,
          delisted: !!p.delisted,
        };
      });
    } catch {}
    const catalog = await getCatalog();
    Object.entries(catalog).forEach(([id, p]) => {
      if (!productMeta[id]) productMeta[id] = { name: p.name, costHKD: null, delisted: false };
    });

    // ===== 30日每日數據 =====
    const dayKeys = [];
    for (let i = 29; i >= 0; i--) dayKeys.push({ ts: now - i * DAY, key: ymdHK(now - i * DAY) });
    const pvResults = await pipeline(dayKeys.map((d) => ["GET", `pv:day:${d.key}`]));

    const dailyMap = {};
    dayKeys.forEach((d, i) => {
      dailyMap[d.key] = { label: dateLabelHK(d.ts), revenue: 0, cost: 0, orders: 0, views: parseInt(pvResults[i]) || 0 };
    });

    orders.forEach((o) => {
      const key = ymdHK(o.ts);
      const bucket = dailyMap[key];
      const cost = (o.items || []).reduce((s, it) => {
        const c = it.costHKD != null ? it.costHKD : (productMeta[it.id]?.costHKD ?? 0);
        return s + c * it.qty;
      }, 0);
      if (bucket) {
        bucket.revenue += o.totalHKD || 0;
        bucket.cost += cost;
        bucket.orders += 1;
      }
    });

    const daily = Object.values(dailyMap).map((d) => {
      const stripeFee = d.revenue > 0 ? d.revenue * 0.034 + d.orders * 2.35 : 0;
      return { ...d, stripeFee: Math.round(stripeFee), profit: Math.round(d.revenue - d.cost - stripeFee) };
    });

    // ===== 週/月匯總(由訂單直接計,涵蓋最多1000張單)=====
    const weekly = {}, monthly = {};
    orders.forEach((o) => {
      const d = new Date(o.ts + 8 * 3600e3);
      const weeksAgo = Math.floor((now - o.ts) / (7 * DAY));
      if (weeksAgo < 8) {
        const wk = `W-${weeksAgo}`;
        if (!weekly[wk]) weekly[wk] = { label: weeksAgo === 0 ? "本週" : `${weeksAgo}週前`, revenue: 0, orders: 0, sort: -weeksAgo };
        weekly[wk].revenue += o.totalHKD || 0;
        weekly[wk].orders += 1;
      }
      const mo = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      if (!monthly[mo]) monthly[mo] = { label: mo, revenue: 0, orders: 0 };
      monthly[mo].revenue += o.totalHKD || 0;
      monthly[mo].orders += 1;
    });

    // ===== 每件產品:瀏覽/銷量/轉換 =====
    const ids = Object.keys(productMeta);
    const prodCmds = [];
    ids.forEach((id) => {
      prodCmds.push(["GET", `pv:product:${id}`]);
      prodCmds.push(["GET", `sold:qty:${id}`]);
      prodCmds.push(["GET", `sold:rev:${id}`]);
    });
    const prodResults = prodCmds.length ? await pipeline(prodCmds) : [];
    const products = ids.map((id, i) => {
      const views = parseInt(prodResults[i * 3]) || 0;
      const qty = parseInt(prodResults[i * 3 + 1]) || 0;
      const revenue = Math.round(parseFloat(prodResults[i * 3 + 2]) || 0);
      return {
        id: Number(id),
        name: productMeta[id].name,
        delisted: productMeta[id].delisted,
        views, qty, revenue,
        convRate: views > 0 ? +((qty / views) * 100).toFixed(1) : null,
      };
    }).filter((p) => p.views > 0 || p.qty > 0)
      .sort((a, b) => b.revenue - a.revenue || b.views - a.views);

    // ===== KPI總結 =====
    const revenue30 = daily.reduce((s, d) => s + d.revenue, 0);
    const profit30 = daily.reduce((s, d) => s + d.profit, 0);
    const views30 = daily.reduce((s, d) => s + d.views, 0);
    const orders30 = daily.reduce((s, d) => s + d.orders, 0);
    const totalRevenue = orders.reduce((s, o) => s + (o.totalHKD || 0), 0);

    res.status(200).json({
      summary: {
        totalRevenueHKD: Math.round(totalRevenue),
        revenue30HKD: Math.round(revenue30),
        profit30HKD: profit30,
        orders30,
        views30,
        avgOrderHKD: orders30 ? Math.round(revenue30 / orders30) : 0,
        convRate30: views30 ? +((orders30 / views30) * 100).toFixed(2) : null,
      },
      daily,
      weekly: Object.values(weekly).sort((a, b) => a.sort - b.sort),
      monthly: Object.entries(monthly).sort((a, b) => a[0].localeCompare(b[0])).slice(-6).map(([, v]) => v),
      products,
      mostViewed: [...products].sort((a, b) => b.views - a.views).slice(0, 5),
      bestSellers: [...products].sort((a, b) => b.qty - a.qty).slice(0, 5),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

module.exports.config = { maxDuration: 30 };
