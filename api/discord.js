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
const { getViewsSeries, spark } = require("./_lib/stats");

// GitHub helpers(/price /delist 用)
async function ghGetFile(path) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${path}`,
    { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "User-Agent": "picked-right-it" } });
  if (res.status === 404) return { content: null, sha: null };
  const d = await res.json();
  if (!d.content) throw new Error(d.message || "GitHub read failed");
  return { content: Buffer.from(d.content, "base64").toString("utf8"), sha: d.sha };
}
async function ghPutFile(path, contentStr, sha, message) {
  const body = { message, content: Buffer.from(contentStr, "utf8").toString("base64") };
  if (sha) body.sha = sha;
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${path}`,
    { method: "PUT", headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "User-Agent": "picked-right-it", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await res.json();
  if (!d.commit) throw new Error(d.message || "GitHub write failed");
}

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
  return new Promise((resolve) => {
    const chunks = [];
    // 保險絲:1.5秒內讀唔到(stream已被Vercel消化咗)就放棄,行fallback
    const timer = setTimeout(() => resolve(null), 1500);
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    req.on("error", () => { clearTimeout(timer); resolve(null); });
  });
}

// 攞原始body:優先讀raw stream;Vercel已parse咗就用req.body重組
async function getRawBody(req) {
  if (typeof req.body === "string" && req.body.length) return Buffer.from(req.body);
  if (Buffer.isBuffer(req.body)) return req.body;
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length) {
    return Buffer.from(JSON.stringify(req.body));
  }
  const raw = await readRaw(req);
  if (raw && raw.length) return raw;
  // 最後fallback:parse咗但上面miss咗
  if (req.body != null) return Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body));
  return Buffer.alloc(0);
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

async function cmdViews() {
  const series = await getViewsSeries(30);
  if (!series.length) return { title: "👀 瀏覽量", color: 0x8b5cf6, description: "KV未設定,冇數據" };
  const today = series[series.length - 1].views;
  const last7 = series.slice(-7);
  const v7 = last7.reduce((s, d) => s + d.views, 0);
  const v30 = series.reduce((s, d) => s + d.views, 0);
  const prev7 = series.slice(-14, -7).reduce((s, d) => s + d.views, 0);
  const wow = prev7 ? Math.round(((v7 - prev7) / prev7) * 100) : null;
  return {
    title: "👀 網站瀏覽量",
    color: 0x8b5cf6,
    description: `**近7日趨勢**\n\`${spark(last7.map(d => d.views))}\`\n${last7.map(d => d.label).join(" · ")}`,
    fields: [
      { name: "今日", value: `${today}`, inline: true },
      { name: "7日", value: `${v7}${wow != null ? ` (${wow >= 0 ? "+" : ""}${wow}% vs上週)` : ""}`, inline: true },
      { name: "30日", value: `${v30}`, inline: true },
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

async function cmdOrders() {
  const orders = (await getOrders()).slice(0, 10);
  if (!orders.length) return { title: "🧾 最近訂單", color: 0x3ddc84, description: "未有訂單" };
  const lines = orders.map((o) => {
    const when = new Date(o.ts + 8 * 3600e3).toISOString().slice(5, 16).replace("T", " ");
    const items = (o.items || []).map((i) => `${i.name}×${i.qty}`).join(", ").slice(0, 80);
    const mail = o.email ? o.email.replace(/^(..).*(@.*)$/, "$1***$2") : "—";
    return `**HK$${o.totalHKD}** · ${when} · ${mail}\n${items}`;
  }).join("\n\n");
  return { title: "🧾 最近10張訂單", color: 0x3ddc84, description: lines.slice(0, 3900) };
}

async function cmdReviewQ() {
  if (!kvReady()) return { title: "💬 待審評價", color: 0xffb547, description: "KV未設定" };
  const raw = await kv(["LRANGE", "reviews:pending", "0", "9"]);
  const list = (raw || []).map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  const approved = parseInt(await kv(["LLEN", "reviews:approved"])) || 0;
  if (!list.length) return { title: "💬 評價隊列", color: 0xffb547, description: `冇待審評價\n已刊出:**${approved}** 個${approved < 5 ? `(仲爭${5 - approved}個開放評論區)` : "(評論區已開放)"}` };
  const lines = list.map((r) => `**${r.name}** ${"★".repeat(r.rating)}\n${String(r.text).slice(0, 100)}`).join("\n\n");
  return { title: `💬 待審評價(${list.length})`, color: 0xffb547, description: lines.slice(0, 3800) + "\n\n→ 去Dashboard產品管理批核", };
}

async function cmdPrice(opts) {
  const id = parseInt(opts.id), price = parseInt(opts.hkd);
  if (!id || !price || price < 1) throw new Error("格式:/price id:<產品編號> hkd:<新價錢>");
  const { content, sha } = await ghGetFile("data/products.json");
  const list = content ? JSON.parse(content) : [];
  const p = list.find((x) => x.id === id);
  if (!p) throw new Error(`搵唔到產品 #${id}`);
  const old = p.price;
  p.price = price;
  await ghPutFile("data/products.json", JSON.stringify(list, null, 2), sha, `discord: reprice #${id} ${old}→${price}`);
  const costHKD = p.costUSD ? Math.round((p.costUSD + (p.shipUSD || 0)) * 7.8) : null;
  return {
    title: "💵 已改價",
    color: 0x3de0ff,
    description: `**#${id} ${(p.i18n?.["zh-Hant"]?.name || "").slice(0, 40)}**\nHK$${old} → **HK$${price}**${costHKD != null ? `\n毛利(連運):HK$${price - costHKD}` : ""}\n約1分鐘後生效`,
  };
}

async function cmdDelist(opts) {
  const id = parseInt(opts.id);
  if (!id) throw new Error("格式:/delist id:<產品編號>");
  const { content, sha } = await ghGetFile("data/products.json");
  const list = content ? JSON.parse(content) : [];
  const p = list.find((x) => x.id === id);
  if (!p) throw new Error(`搵唔到產品 #${id}`);
  p.delisted = !p.delisted;
  await ghPutFile("data/products.json", JSON.stringify(list, null, 2), sha, `discord: ${p.delisted ? "delist" : "relist"} #${id}`);
  return {
    title: p.delisted ? "🧹 已落架" : "✅ 已上返架",
    color: p.delisted ? 0xff5c5c : 0x3ddc84,
    description: `**#${id} ${(p.i18n?.["zh-Hant"]?.name || "").slice(0, 40)}**\n約1分鐘後生效(再打一次 /delist id:${id} 可還原)`,
  };
}

const HELP_EMBED = {
  title: "🤖 揀啱 Bot 指令",
  color: 0xff3d7a,
  description: "`/stats` — 今日戰報\n`/sales` — 30日銷售總覽\n`/products` — 店舖產品狀態\n`/views` — 瀏覽量趨勢\n`/orders` — 最近10張訂單\n`/reviewq` — 待審評價隊列\n`/price id: hkd:` — 即刻改價\n`/delist id:` — 落架/上返架\n`/help` — 呢張清單",
};

// ===== 指令註冊 =====
const COMMANDS = [
  { name: "stats", description: "今日戰報:營業額/訂單/瀏覽量" },
  { name: "sales", description: "30日銷售總覽 + Top產品" },
  { name: "products", description: "店舖產品狀態 + Bestsellers" },
  { name: "views", description: "瀏覽量:今日/7日/30日 + 趨勢圖" },
  { name: "orders", description: "最近10張訂單" },
  { name: "reviewq", description: "待審評價隊列" },
  { name: "price", description: "改產品價錢", options: [
    { name: "id", description: "產品編號(#後面個數字)", type: 4, required: true },
    { name: "hkd", description: "新價錢(港幣)", type: 4, required: true }] },
  { name: "delist", description: "落架/上返架產品", options: [
    { name: "id", description: "產品編號", type: 4, required: true }] },
  { name: "help", description: "指令清單" },
];

module.exports = async (req, res) => {
  // ===== 一次性註冊指令(店主用)=====
  if (req.method === "GET") {
    if (req.query.register !== process.env.ADMIN_SYNC_SECRET) {
      // 自檢:public key格式啱唔啱
      const pk = process.env.DISCORD_PUBLIC_KEY || "";
      let pkValid = false;
      try {
        if (/^[0-9a-fA-F]{64}$/.test(pk.trim())) {
          crypto.createPublicKey({
            key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pk.trim(), "hex")]),
            format: "der", type: "spki",
          });
          pkValid = true;
        }
      } catch {}
      return res.status(200).json({
        status: "揀啱 Discord Bot endpoint 運作中",
        hasPublicKey: !!pk,
        publicKeyLength: pk.length,
        publicKeyValid: pkValid,
      });
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
  const raw = await getRawBody(req);
  const rawSource = typeof req.body === "string" ? "string-body" : (req.body && Object.keys(req.body || {}).length ? "parsed-body" : "raw-stream");
  const verified = sig && ts && process.env.DISCORD_PUBLIC_KEY
    ? verifySig(process.env.DISCORD_PUBLIC_KEY.trim(), ts, raw, sig)
    : false;
  console.log(`[discord] sig=${!!sig} ts=${!!ts} pk=${!!process.env.DISCORD_PUBLIC_KEY} rawLen=${raw.length} src=${rawSource} verified=${verified}`);
  if (!verified) {
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
      else if (name === "views") embed = await cmdViews();
      else if (name === "orders") embed = await cmdOrders();
      else if (name === "reviewq") embed = await cmdReviewQ();
      else if (name === "price" || name === "delist") {
        const opts = {};
        (body.data.options || []).forEach((o) => { opts[o.name] = o.value; });
        embed = name === "price" ? await cmdPrice(opts) : await cmdDelist(opts);
      }
      else embed = HELP_EMBED;
      return res.status(200).json({ type: 4, data: { embeds: [embed] } });
    } catch (e) {
      return res.status(200).json({ type: 4, data: { content: `⚠️ 出錯:${e.message}` } });
    }
  }

  res.status(200).json({ type: 4, data: { content: "未支援嘅互動類型" } });
};

module.exports.config = { api: { bodyParser: false } };
