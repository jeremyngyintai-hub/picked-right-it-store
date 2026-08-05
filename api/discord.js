// ============================================================
// /api/discord — Discord Slash Command Bot(Interactions HTTP模式)
//
// 指令:
//   /stats    — 今日戰報(營業額/訂單/瀏覽量)
//   /sales    — 30日銷售總覽 + Top產品
//   /products — 店舖產品狀態
//   /help     — 指令清單
//
// 需要環境變數(Discord Developer Portal攞):
//   DISCORD_PUBLIC_KEY  — General Information頁
//   DISCORD_APP_ID      — General Information頁
//   DISCORD_BOT_TOKEN   — Bot頁(Reset Token)
//
// 一次性註冊指令:開瀏覽器去
//   /api/discord?register=你嘅ADMIN_SYNC_SECRET
// ============================================================

const crypto = require("crypto");
const { kvReady, kv } = require("./_lib/kv");

const USD_TO_HKD = 7.8;

// Ed25519簽名驗證(Discord要求,防偽冒)
function verifySig(publicKeyHex, timestamp, rawBody, sigHex) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, Buffer.concat([Buffer.from(timestamp), rawBody]), key, Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function getOrders() {
  if (!kvReady()) return [];
  const raw = await kv(["LRANGE", "orders", "0", "499"]);
  return (raw || []).map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}

// ===== 指令實作 =====
async function cmdStats() {
  const orders = await getOrders();
  const d1 = Date.now() - 86400e3;
  const today = orders.filter((o) => o.ts >= d1);
  const rev = today.reduce((s, o) => s + (o.totalHKD || 0), 0);
  let pv = 0;
  if (kvReady()) {
    const ymd = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
    pv = parseInt(await kv(["GET", `pv:day:${ymd}`])) || 0;
  }
  return {
    title: "📊 今日戰報",
    color: 0x8b5cf6,
    fields: [
      { name: "💰 24小時營業額", value: `HK$${rev.toLocaleString()}`, inline: true },
      { name: "🧾 訂單", value: `${today.length} 張`, inline: true },
      { name: "👀 今日瀏覽", value: `${pv}`, inline: true },
    ],
  };
}

async function cmdSales() {
  const orders = await getOrders();
  const d30 = Date.now() - 30 * 86400e3;
  const recent = orders.filter((o) => o.ts >= d30);
  const rev = recent.reduce((s, o) => s + (o.totalHKD || 0), 0);
  const byProd = {};
  recent.forEach((o) => (o.items || []).forEach((it) => {
    if (!byProd[it.name]) byProd[it.name] = { qty: 0, rev: 0 };
    byProd[it.name].qty += it.qty;
    byProd[it.name].rev += (it.priceHKD || 0) * it.qty;
  }));
  const top = Object.entries(byProd).sort((a, b) => b[1].rev - a[1].rev).slice(0, 5)
    .map(([name, v], i) => `${i + 1}. ${name.slice(0, 40)} — ${v.qty}件 · HK$${Math.round(v.rev)}`)
    .join("\n") || "(未有銷售)";
  return {
    title: "📈 30日銷售總覽",
    color: 0x3de0ff,
    description: `**Top 產品**\n${top}`,
    fields: [
      { name: "營業額", value: `HK$${Math.round(rev).toLocaleString()}`, inline: true },
      { name: "訂單", value: `${recent.length} 張`, inline: true },
      { name: "平均單值", value: recent.length ? `HK$${Math.round(rev / recent.length)}` : "—", inline: true },
    ],
  };
}

async function cmdProducts() {
  let list = [];
  try {
    list = await fetch(`${process.env.SITE_URL || "https://picked-right.it.com"}/data/products.json`).then((r) => r.json());
  } catch {}
  const active = (list || []).filter((p) => !p.delisted);
  const delisted = (list || []).length - active.length;
  const best = [...active].sort((a, b) => (b.soldQty || 0) - (a.soldQty || 0)).slice(0, 5)
    .map((p, i) => `${i + 1}. ${(p.i18n?.["zh-Hant"]?.name || "#" + p.id).slice(0, 40)} — 賣出${p.soldQty || 0}件 · HK$${p.price}`)
    .join("\n") || "(未有產品)";
  const cats = {};
  active.forEach((p) => { cats[p.catClass] = (cats[p.catClass] || 0) + 1; });
  return {
    title: "📦 店舖產品狀態",
    color: 0xff3d7a,
    description: `**Bestsellers**\n${best}`,
    fields: [
      { name: "上架中", value: `${active.length} 件`, inline: true },
      { name: "已落架", value: `${delisted} 件`, inline: true },
      { name: "分類分佈", value: Object.entries(cats).map(([k, v]) => `${k}:${v}`).join(" · ") || "—", inline: false },
    ],
  };
}

const HELP_EMBED = {
  title: "🤖 揀啱 Bot 指令",
  color: 0xff3d7a,
  description: "`/stats` — 今日戰報\n`/sales` — 30日銷售總覽\n`/products` — 店舖產品狀態\n`/help` — 呢張清單",
};

// ===== 指令註冊 =====
const COMMANDS = [
  { name: "stats", description: "今日戰報:營業額/訂單/瀏覽量" },
  { name: "sales", description: "30日銷售總覽 + Top產品" },
  { name: "products", description: "店舖產品狀態 + Bestsellers" },
  { name: "help", description: "指令清單" },
];

module.exports = async (req, res) => {
  // ===== 一次性註冊指令(店主用)=====
  if (req.method === "GET") {
    if (req.query.register !== process.env.ADMIN_SYNC_SECRET) {
      return res.status(200).json({ status: "揀啱 Discord Bot endpoint 運作中" });
    }
    if (!process.env.DISCORD_APP_ID || !process.env.DISCORD_BOT_TOKEN) {
      return res.status(500).json({ error: "未設定 DISCORD_APP_ID / DISCORD_BOT_TOKEN" });
    }
    const r = await fetch(`https://discord.com/api/v10/applications/${process.env.DISCORD_APP_ID}/commands`, {
      method: "PUT",
      headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(COMMANDS),
    });
    const data = await r.json();
    return res.status(r.ok ? 200 : 500).json({ registered: r.ok, detail: Array.isArray(data) ? data.map((c) => c.name) : data });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // ===== 簽名驗證 =====
  const sig = req.headers["x-signature-ed25519"];
  const ts = req.headers["x-signature-timestamp"];
  const raw = await readRaw(req);
  if (!sig || !ts || !process.env.DISCORD_PUBLIC_KEY || !verifySig(process.env.DISCORD_PUBLIC_KEY, ts, raw, sig)) {
    return res.status(401).json({ error: "invalid request signature" });
  }

  const body = JSON.parse(raw.toString("utf8"));

  // PING(Discord驗證endpoint用)
  if (body.type === 1) return res.status(200).json({ type: 1 });

  // Slash Command
  if (body.type === 2) {
    const name = body.data && body.data.name;
    try {
      let embed;
      if (name === "stats") embed = await cmdStats();
      else if (name === "sales") embed = await cmdSales();
      else if (name === "products") embed = await cmdProducts();
      else embed = HELP_EMBED;
      return res.status(200).json({ type: 4, data: { embeds: [embed] } });
    } catch (e) {
      return res.status(200).json({ type: 4, data: { content: `⚠️ 出錯:${e.message}` } });
    }
  }

  res.status(200).json({ type: 4, data: { content: "未支援嘅互動類型" } });
};

module.exports.config = { api: { bodyParser: false } };
