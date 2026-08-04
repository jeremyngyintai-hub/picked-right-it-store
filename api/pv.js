// ============================================================
// GET /api/pv?t=page  或  /api/pv?t=product&id=13
// 輕量瀏覽量追蹤(KV有設定先記,冇就靜靜跳過)
// ============================================================

const { kvReady, pipeline } = require("./lib/kv");

function ymdHK(ts) {
  // 香港時區(UTC+8)嘅YYYYMMDD
  const d = new Date(ts + 8 * 3600e3);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!kvReady()) return res.status(200).json({ ok: false });
    const t = req.query.t;
    const day = ymdHK(Date.now());
    const cmds = [];
    if (t === "page") {
      cmds.push(["INCR", `pv:day:${day}`]);
    } else if (t === "product") {
      const id = parseInt(req.query.id);
      if (!id || id < 1 || id > 100000) return res.status(400).json({ ok: false });
      cmds.push(["INCR", `pv:product:${id}`]);
      cmds.push(["INCR", `pv:day:${day}`]);
    } else {
      return res.status(400).json({ ok: false });
    }
    await pipeline(cmds);
    res.status(200).json({ ok: true });
  } catch {
    res.status(200).json({ ok: false });
  }
};
