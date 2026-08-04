// ============================================================
// GET /api/admin/sales-stats?secret=xxx
// 銷售數據:總營業額、訂單數、平均單值、30日營業額、每件產品表現
// ============================================================

const { kvReady, kv } = require("../lib/kv");

module.exports = async (req, res) => {
  if (req.query.secret !== process.env.ADMIN_SYNC_SECRET) {
    return res.status(401).json({ error: "密碼錯誤" });
  }
  if (!kvReady()) {
    return res.status(500).json({
      error: "未設定Vercel KV。去Vercel → Storage → Create Database → 揀KV/Upstash Redis,連接到project之後redeploy就得。",
    });
  }

  try {
    const raw = await kv(["LRANGE", "orders", "0", "999"]);
    const orders = (raw || []).map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);

    const now = Date.now();
    const d30 = now - 30 * 86400e3;
    let revenue = 0, revenue30 = 0;
    const byProduct = {};

    orders.forEach((o) => {
      revenue += o.totalHKD || 0;
      if (o.ts >= d30) revenue30 += o.totalHKD || 0;
      (o.items || []).forEach((it) => {
        if (!byProduct[it.id]) byProduct[it.id] = { id: it.id, name: it.name, qty: 0, revenue: 0, lastTs: 0 };
        byProduct[it.id].qty += it.qty;
        byProduct[it.id].revenue += (it.priceHKD || 0) * it.qty;
        if (o.ts > byProduct[it.id].lastTs) byProduct[it.id].lastTs = o.ts;
      });
    });

    const products = Object.values(byProduct).sort((a, b) => b.revenue - a.revenue);

    res.status(200).json({
      summary: {
        revenueHKD: Math.round(revenue),
        revenue30HKD: Math.round(revenue30),
        orders: orders.length,
        avgOrderHKD: orders.length ? Math.round(revenue / orders.length) : 0,
      },
      products,
      recentOrders: orders.slice(0, 20).map((o) => ({
        ts: o.ts, totalHKD: o.totalHKD,
        summary: (o.items || []).map((i) => `${i.name}×${i.qty}`).join(", "),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
