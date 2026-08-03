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
      "zh-Hant": { name: short, desc: "香港細單位都啱用,慳位實用之選。團隊實測過質素先上架,48小時內出貨,順豐站自取。" },
      "zh-Hans": { name: short, desc: "小户型也适用,省空间实用之选。团队实测质量才上架,48小时内发货,顺丰站自取。" },
      "en": { name: short, desc: "A practical, space-saving pick tested by our team — ships within 48 hours with SF Locker pickup." },
    },
    beauty: {
      "zh-Hant": { name: short, desc: "屋企就做到嘅精緻感。團隊親身試用先上架,溫和好用,48小時內出貨直送到你手。" },
      "zh-Hans": { name: short, desc: "在家也能拥有的精致感。团队亲身试用才上架,温和好用,48小时内发货直达。" },
      "en": { name: short, desc: "Salon-level results at home. Tested by our team before listing — ships within 48 hours." },
    },
    tech: {
      "zh-Hant": { name: short, desc: "返工打機兩用嘅實用之選。團隊實測先上架,即插即用,48小時內出貨,順豐站自取。" },
      "zh-Hans": { name: short, desc: "办公游戏两用的实用之选。团队实测才上架,即插即用,48小时内发货,顺丰站自取。" },
      "en": { name: short, desc: "A practical pick for work and play, tested by our team. Plug and play — ships within 48 hours." },
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

  const { secret, pid, cat, markup, priceHKD, vid } = req.body || {};
  if (secret !== process.env.ADMIN_SYNC_SECRET) {
    return res.status(401).json({ error: "密碼錯誤" });
  }
  if (!pid) return res.status(400).json({ error: "要提供 pid" });
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
    return res.status(500).json({ error: "未設定 GITHUB_TOKEN / GITHUB_REPO 環境變數" });
  }

  const category = ["home", "beauty", "tech"].includes(cat) ? cat : "tech";

  try {
    // 1. 攞CJ產品詳情
    const accessToken = await cjAuth();
    await sleep(1100);
    const cjRes = await fetch(`${CJ_BASE}/product/query?pid=${encodeURIComponent(pid)}`, {
      headers: { "CJ-Access-Token": accessToken },
    });
    const cjData = await cjRes.json();
    if (!cjData.result && !cjData.success) throw new Error(cjData.message || "CJ查詢失敗");
    const p = cjData.data;

    const variants = p.variants || [];
    const chosenVariant = vid
      ? variants.find((v) => v.vid === vid) || variants[0]
      : variants[0];
    if (!chosenVariant) throw new Error("呢個產品冇variants,無法自動落單,唔建議上架");

    const costUSD = parseCostUSD(chosenVariant.variantSellPrice) || parseCostUSD(p.sellPrice) || 0;

    // 2. 計售價:優先用你直接指定嘅priceHKD;否則用倍數markup(預設2.8)
    const mk = parseFloat(markup) || 2.8;
    const finalPrice = parseInt(priceHKD) || prettyPrice(costUSD * USD_TO_HKD * mk);

    // 3. 讀取而家嘅products.json,計新id
    const { content, sha } = await ghGetFile("data/products.json");
    const list = content ? JSON.parse(content) : [];
    const maxExisting = Math.max(12, ...list.map((x) => x.id || 0)); // 12 = index.html內置產品最大id
    const newId = maxExisting + 1;

    // 防止重複上架同一件貨
    if (list.some((x) => x.cjPid === pid)) {
      return res.status(409).json({ error: "呢件產品已經上架咗(pid重複)" });
    }

    const copy = draftCopy(p.productNameEn, category);
    const images = p.productImageSet || [p.bigImage].filter(Boolean);

    const newProduct = {
      id: newId,
      catClass: category,
      price: finalPrice,
      icon: "box",
      image: images[0] || "",
      trending: true,
      rating: 4.5,
      reviews: 30,
      i18n: copy,
      cjPid: pid,
      cjVid: chosenVariant.vid,
      costUSD,
      addedAt: new Date().toISOString(),
    };
    list.push(newProduct);

    // 4. commit返上GitHub → Vercel自動重新部署
    await ghPutFile(
      "data/products.json",
      JSON.stringify(list, null, 2),
      sha,
      `auto-import: ${copy["zh-Hant"].name} (HK$${finalPrice})`
    );

    res.status(200).json({
      success: true,
      message: `已上架!等Vercel重新部署完(約1分鐘)就會喺網站見到。`,
      product: {
        id: newId,
        name: copy["zh-Hant"].name,
        priceHKD: finalPrice,
        costUSD,
        estGrossMarginHKD: Math.round(finalPrice - costUSD * USD_TO_HKD),
        vid: chosenVariant.vid,
        image: images[0],
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
