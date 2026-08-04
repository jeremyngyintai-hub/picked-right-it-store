// ============================================================
// /api/reviews — 真實客戶評價系統(KV儲存,先審後出)
//
// 公開:
//   GET  /api/reviews            → 已批核評價(儲夠5個前台先顯示)
//   POST /api/reviews            → 客人提交 {name, rating, text, pid?}
// 管理(要secret):
//   GET  /api/reviews?secret=x&pending=1        → 待審清單
//   POST /api/reviews {secret, action:"approve"|"delete", id}
// ============================================================

const { kvReady, kv } = require("./_lib/kv");

const MIN_TO_SHOW = 5;

module.exports = async (req, res) => {
  if (!kvReady()) return res.status(200).json({ enabled: false, reviews: [] });

  try {
    const isAdmin =
      (req.method === "GET" && req.query.secret === process.env.ADMIN_SYNC_SECRET) ||
      (req.method === "POST" && (req.body || {}).secret === process.env.ADMIN_SYNC_SECRET);

    // ===== 管理:待審清單 =====
    if (req.method === "GET" && isAdmin && req.query.pending) {
      const raw = await kv(["LRANGE", "reviews:pending", "0", "99"]);
      return res.status(200).json({ pending: (raw || []).map((s) => JSON.parse(s)) });
    }

    // ===== 公開:已批核評價 =====
    if (req.method === "GET") {
      const raw = await kv(["LRANGE", "reviews:approved", "0", "49"]);
      const list = (raw || []).map((s) => JSON.parse(s));
      return res.status(200).json({
        enabled: list.length >= MIN_TO_SHOW, // 儲夠5個先開評論區
        count: list.length,
        reviews: list.length >= MIN_TO_SHOW ? list : [],
      });
    }

    if (req.method === "POST") {
      const body = req.body || {};

      // ===== 管理:批核/刪除 =====
      if (isAdmin && body.action) {
        const raw = await kv(["LRANGE", "reviews:pending", "0", "199"]);
        const pending = (raw || []).map((s) => JSON.parse(s));
        const target = pending.find((r) => r.id === body.id);
        if (!target) return res.status(404).json({ error: "搵唔到呢個評價" });
        // 由pending移除
        await kv(["LREM", "reviews:pending", "1", JSON.stringify(target)]);
        if (body.action === "approve") {
          await kv(["LPUSH", "reviews:approved", JSON.stringify(target)]);
          await kv(["LTRIM", "reviews:approved", "0", "199"]);
        }
        return res.status(200).json({ success: true });
      }

      // ===== 公開:客人提交評價 =====
      const name = String(body.name || "").trim().slice(0, 30);
      const text = String(body.text || "").trim().slice(0, 400);
      const rating = Math.min(5, Math.max(1, parseInt(body.rating) || 5));
      if (!name || text.length < 5) {
        return res.status(400).json({ error: "請填寫稱呼同評價內容(最少5個字)" });
      }
      const review = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name, rating, text,
        pid: parseInt(body.pid) || null,
        ts: Date.now(),
      };
      await kv(["LPUSH", "reviews:pending", JSON.stringify(review)]);
      await kv(["LTRIM", "reviews:pending", "0", "199"]);
      return res.status(200).json({ success: true, message: "多謝你嘅評價!審核後就會刊出。" });
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
