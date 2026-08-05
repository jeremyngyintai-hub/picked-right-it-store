// ============================================================
// 瀏覽量統計helper(_lib唔計function數)
// ============================================================

const { kvReady, kv, pipeline } = require("./kv");

const DAY = 86400e3;

function ymdHK(ts) {
  return new Date(ts + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
}
function labelHK(ts) {
  const d = new Date(ts + 8 * 3600e3);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

// 攞最近N日每日瀏覽量(舊→新)
async function getViewsSeries(days) {
  if (!kvReady()) return [];
  const now = Date.now();
  const items = [];
  for (let i = days - 1; i >= 0; i--) {
    const ts = now - i * DAY;
    items.push({ ts, key: ymdHK(ts), label: labelHK(ts) });
  }
  const results = await pipeline(items.map((d) => ["GET", `pv:day:${d.key}`]));
  return items.map((d, i) => ({ ...d, views: parseInt(results[i]) || 0 }));
}

// 將數字序列變Discord入面嘅迷你趨勢圖 ▁▂▃▄▅▆▇█
function spark(values) {
  const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const max = Math.max(1, ...values);
  return values.map((v) => blocks[Math.min(7, Math.floor((v / max) * 7.99))]).join("");
}

module.exports = { getViewsSeries, spark, ymdHK };
