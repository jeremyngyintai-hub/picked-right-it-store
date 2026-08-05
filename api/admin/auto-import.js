// ============================================================
// POST /api/admin/auto-import
// ------------------------------------------------------------
// 自動化上架核心:收到pid+利潤倍數,自動:
//   1. 去CJ攞產品詳情(相/variants/成本)
//   2. 按你設定嘅倍數計售價
//   3. 生成三語文案
//   4. 直接commit入GitHub嘅 data/products.json
//   → Vercel會自動重新部署,產品即刻上架,唔使人手改code
//
// 需要環境變數:
//   GITHUB_TOKEN — GitHub Personal Access Token(要有repo contents寫入權)
//   GITHUB_REPO  — 例如 "jeremyngyintai-hub/picked-right-it-store"
// ============================================================

const CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1";
const USD_TO_HKD = 7.8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { aiCopy } = require("../_lib/copywriter");

function parseCostUSD(v) {
  if (v == null) return null;
  const nums = String(v).match(/[\d.]+/g);
  return nums ? parseFloat(nums[0]) : null;
}

function prettyPrice(raw) {
  const rounded = Math.ceil(raw / 10) * 10 - 2;
  return Math.max(rounded, 48);
}

function draftCopy(nameEn, cat) {
  const short = (nameEn || "New Product").slice(0, 60).replace(/'/g, "");
  const t = {
    home: {
      "zh-Hant": { name: short, desc: "香港細單位都啱用,慳位實用之選。團隊嚴選先上架,48小時內出貨,順豐站自取。" },
      "zh-Hans": { name: short, desc: "小户型也适用,省空间实用之选。团队严选才上架,48小时内发货,顺丰站自取。" },
      "en": { name: short, desc: "A practical, space-saving pick hand-picked by our team — ships within 48 hours with SF Locker pickup." },
    },
    beauty: {
      "zh-Hant": { name: short, desc: "屋企就做到嘅精緻感。團隊嚴選先上架,溫和好用,48小時內出貨直送到你手。" },
      "zh-Hans": { name: short, desc: "在家也能拥有的精致感。团队严选才上架,温和好用,48小时内发货直达。" },
      "en": { name: short, desc: "Salon-level results at home. Hand-picked by our team — ships within 48 hours." },
    },
    tech: {
      "zh-Hant": { name: short, desc: "返工打機兩用嘅實用之選。團隊嚴選先上架,即插即用,落單48小時內安排出貨。" },
      "zh-Hans": { name: short, desc: "办公游戏两用的实用之选。团队严选才上架,即插即用,下单48小时内安排发货。" },
      "en": { name: short, desc: "A practical pick for work and play, hand-picked by our team. Dispatched within 48 hours." },
    },
    pets: {
      "zh-Hant": { name: short, desc: "毛孩都值得好嘢。團隊嚴選用料先上架,主子鍾意先算數,落單48小時內安排出貨。" },
      "zh-Hans": { name: short, desc: "毛孩也值得好东西。团队严选用料才上架,下单48小时内安排发货。" },
      "en": { name: short, desc: "Your furry friend deserves the good stuff. Carefully selected by our team." },
    },
    baby: {
      "zh-Hant": { name: short, desc: "陪住小朋友成長嘅好幫手。團隊嚴選用料先上架,爸媽買得放心。" },
      "zh-Hans": { name: short, desc: "陪伴孩子成长的好帮手。团队严选用料才上架,爸妈买得放心。" },
      "en": { name: short, desc: "A trusted companion for growing kids — carefully selected by our team." },
    },
    sports: {
      "zh-Hant": { name: short, desc: "行山跑步健身都用得著。團隊嚴選耐用款式先上架,運動裝備一步到位。" },
      "zh-Hans": { name: short, desc: "登山跑步健身都用得上。团队严选耐用款式才上架,运动装备一步到位。" },
      "en": { name: short, desc: "Built for hikes, runs, and workouts — durability-hand-picked by our team." },
    },
    accessories: {
      "zh-Hant": { name: short, desc: "日常造型點睛之選。團隊嚴選質感先上架,返工約會都襯得起。" },
      "zh-Hans": { name: short, desc: "日常造型点睛之选。团队严选质感才上架,上班约会都配得上。" },
      "en": { name: short, desc: "The finishing touch to any look — carefully selected by our team." },
    },
    bags: {
      "zh-Hant": { name: short, desc: "返工返學旅行都啱用。團隊嚴選做工先上架,實用又襯衫。" },
      "zh-Hans": { name: short, desc: "上班上学旅行都合适。团队严选做工才上架,实用又百搭。" },
      "en": { name: short, desc: "For work, school, and travel — carefully selected by our team." },
    },
    auto: {
      "zh-Hant": { name: short, desc: "架車嘅實用升級。團隊嚴選易裝款式先上架,新手都裝到。" },
      "zh-Hans": { name: short, desc: "爱车的实用升级。团队严选易装款式才上架,新手也能装。" },
      "en": { name: short, desc: "A practical upgrade for your car — installation-hand-picked by our team." },
    },
  };
  return t[cat] || t.tech;
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

// ---- GitHub contents API helpers ----
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
  const body = {
    message,
    content: Buffer.from(contentStr, "utf8").toString("base64"),
  };
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
  return data.commit.sha;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { secret, pid, cat, markup, priceHKD, vid, items } = req.body || {};
  if (secret !== process.env.ADMIN_SYNC_SECRET) {
    return res.status(401).json({ error: "密碼錯誤" });
  }
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
    return res.status(500).json({ error: "未設定 GITHUB_TOKEN / GITHUB_REPO 環境變數" });
  }

  // 批量模式:items = [{pid, cat}, ...](最多10件);單件模式照舊用pid
  const queue = Array.isArray(items) && items.length
    ? items.slice(0, 10)
    : (pid ? [{ pid, cat, priceHKD, vid }] : []);
  if (queue.length === 0) return res.status(400).json({ error: "要提供 pid 或 items" });

  const mk = parseFloat(markup) || 2.8;
  const shipEstUSD = Math.max(0, parseFloat(req.body.shipEstUSD) || 5); // 查唔到真實運費時嘅預估值
  const report = { imported: [], skipped: [], errors: [] };

  try {
    const accessToken = await cjAuth();
    await sleep(1100);

    // 讀一次products.json,批量處理完先commit一次
    const { content, sha } = await ghGetFile("data/products.json");
    const list = content ? JSON.parse(content) : [];
    let nextId = Math.max(12, ...list.map((x) => x.id || 0)) + 1;
    let anyAdded = false;

    for (const item of queue) {
      const VALID_CATS = ["home","beauty","tech","pets","baby","sports","accessories","bags","auto"];
        const itemCat = VALID_CATS.includes(item.cat) ? item.cat : "tech";
      try {
        if (list.some((x) => x.cjPid === item.pid)) {
          report.skipped.push({ pid: item.pid, reason: "已上架(pid重複)" });
          continue;
        }
        const cjRes = await fetch(`${CJ_BASE}/product/query?pid=${encodeURIComponent(item.pid)}`, {
          headers: { "CJ-Access-Token": accessToken },
        });
        const cjData = await cjRes.json();
        if (!cjData.result && !cjData.success) throw new Error(cjData.message || "CJ查詢失敗");
        const p = cjData.data;

        const variants = p.variants || [];
        const chosenVariant = item.vid
          ? variants.find((v) => v.vid === item.vid) || variants[0]
          : variants[0];
        if (!chosenVariant) throw new Error("冇variants,無法自動落單");

        const costUSD = parseCostUSD(chosenVariant.variantSellPrice) || parseCostUSD(p.sellPrice) || 0;

        // === 查CJ寄香港嘅真實運費(揀最平物流);失敗就用預估 ===
        let shipUSD = shipEstUSD;
        try {
          await sleep(1100);
          const fRes = await fetch(`${CJ_BASE}/logistic/freightCalculate`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "CJ-Access-Token": accessToken },
            body: JSON.stringify({ startCountryCode: "CN", endCountryCode: "HK", products: [{ quantity: 1, vid: chosenVariant.vid }] }),
          });
          const fData = await fRes.json();
          const opts = (fData && fData.data) || [];
          const prices = opts.map((o) => parseFloat(o.logisticPrice)).filter((x) => !isNaN(x) && x > 0);
          if (prices.length) shipUSD = Math.min(...prices);
        } catch {}

        // 售價 = 貨價×倍數 + 運費直通(運費唔賺唔蝕),調靚尾數
        const finalPrice = parseInt(item.priceHKD) || prettyPrice(costUSD * USD_TO_HKD * mk + shipUSD * USD_TO_HKD);
        const copy = (await aiCopy(p.productNameEn, itemCat)) || draftCopy(p.productNameEn, itemCat);
        const images = (p.productImageSet || [p.bigImage].filter(Boolean)).slice(0, 6);
        const video = p.productVideo || p.video || "";

        list.push({
          id: nextId,
          catClass: itemCat,
          price: finalPrice,
          icon: "box",
          image: images[0] || "",
          images,
          video,
          trending: true,
          rating: 4.5,
          reviews: 30,
          i18n: copy,
          cjPid: item.pid,
          cjVid: chosenVariant.vid,
          shipUSD: Math.round(shipUSD * 100) / 100,
          variants: variants.slice(0, 60).map((v) => ({ vid: v.vid, name: v.variantNameEn || v.variantKey || "" })),
          costUSD,
          addedAt: new Date().toISOString(),
        });
        report.imported.push({
          id: nextId,
          name: copy["zh-Hant"].name,
          priceHKD: finalPrice,
          shipUSD: Math.round(shipUSD * 100) / 100,
          estGrossMarginHKD: Math.round(finalPrice - (costUSD + shipUSD) * USD_TO_HKD),
        });
        nextId++;
        anyAdded = true;
      } catch (e) {
        report.errors.push({ pid: item.pid, error: e.message });
      }
      await sleep(1100); // CJ每秒1次限制
    }

    if (anyAdded) {
      await ghPutFile(
        "data/products.json",
        JSON.stringify(list, null, 2),
        sha,
        `auto-import: ${report.imported.length} product(s)`
      );
    }

    // 單件模式維持返舊回應格式,dashboard批量模式用report
    if (!Array.isArray(items) && report.imported.length === 1) {
      return res.status(200).json({
        success: true,
        message: "已上架!等Vercel重新部署完(約1分鐘)就會喺網站見到。",
        product: { ...report.imported[0], vid: undefined },
      });
    }
    if (!Array.isArray(items) && report.imported.length === 0) {
      const why = report.skipped[0] ? report.skipped[0].reason : (report.errors[0] ? report.errors[0].error : "未知錯誤");
      return res.status(409).json({ error: why });
    }

    res.status(200).json({
      success: true,
      message: `批量完成:上架${report.imported.length}件、跳過${report.skipped.length}件、失敗${report.errors.length}件`,
      report,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, report });
  }
};

module.exports.config = { maxDuration: 60 };
