// ============================================================
// GET /api/admin/trending-picks?secret=xxx
// 自動喺CJ搵「家居/美妝/電子」熱賣候選產品(有速度控制版)
// ============================================================

const CATEGORY_KEYWORDS = {
  home: ["Home, Garden & Furniture", "Home Improvement"],
  beauty: ["Health, Beauty & Hair"],
  tech: ["Consumer Electronics", "Phones & Accessories"],
  pets: ["Pet Supplies"],
  baby: ["Toys, Kids & Babies"],
  sports: ["Sports & Outdoors"],
  accessories: ["Jewelry & Watches"],
  bags: ["Bags & Shoes"],
  auto: ["Automobiles & Motorcycles"],
};

const USD_TO_HKD = 7.8;
const MARKUP = 2.8;
const CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCostUSD(sellPrice) {
  if (sellPrice == null) return null;
  const str = String(sellPrice);
  const nums = str.match(/[\d.]+/g);
  if (!nums || nums.length === 0) return null;
  return parseFloat(nums[0]);
}

function toRetailPriceHKD(costUSD) {
  const cost = parseCostUSD(costUSD);
  if (cost == null) return null;
  const raw = cost * USD_TO_HKD * MARKUP;
  const rounded = Math.ceil(raw / 10) * 10 - 2;
  return Math.max(rounded, 48);
}

async function getAccessToken() {
  const res = await fetch(`${CJ_BASE}/authentication/getAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: process.env.CJ_API_KEY }),
  });
  const data = await res.json();
  if (!data.result) throw new Error(`CJ auth: ${data.message}`);
  return data.data.accessToken;
}

async function cjGet(path, accessToken) {
  const res = await fetch(`${CJ_BASE}${path}`, {
    headers: { "CJ-Access-Token": accessToken },
  });
  const data = await res.json();
  if (!data.result && !data.success) throw new Error(data.message || "CJ error");
  return data.data;
}

function findCategoryIds(tree, keywords) {
  const ids = [];
  const kw = keywords.map((k) => k.toLowerCase());
  (tree || []).forEach((first) => {
    const firstMatch = kw.some((k) => (first.categoryFirstName || "").toLowerCase().includes(k));
    (first.categoryFirstList || []).forEach((second) => {
      const secondMatch = kw.some((k) => (second.categorySecondName || "").toLowerCase().includes(k));
      (second.categorySecondList || []).forEach((third) => {
        if (firstMatch || secondMatch) ids.push(third.categoryId);
      });
    });
  });
  return ids;
}

module.exports = async (req, res) => {
  if (req.query.secret !== process.env.ADMIN_SYNC_SECRET) {
    return res.status(401).json({ error: "密碼錯誤" });
  }

  const pageNum = Math.max(1, parseInt(req.query.page) || 1);
  try {
    const accessToken = await getAccessToken();
    await sleep(1100);
    const tree = await cjGet("/product/getCategory", accessToken);
    await sleep(1100);

    const results = {};
    const debug = { rawCandidatesFound: {}, errors: [] };

    for (const [ourCat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      const categoryIds = findCategoryIds(tree, keywords);
      let candidates = [];

      for (const categoryId of categoryIds.slice(0, 2)) {
        try {
          const params = new URLSearchParams({
            categoryId,
            orderBy: "listedNum",
            sort: "desc",
            pageNum: String(pageNum),
            pageSize: "20",
          });
          const list = await cjGet(`/product/list?${params.toString()}`, accessToken);
          if (list && list.list) candidates.push(...list.list);
        } catch (e) {
          debug.errors.push(`${ourCat}: ${e.message}`);
        }
        await sleep(1100);
      }

      debug.rawCandidatesFound[ourCat] = candidates.length;

      const seen = new Set();
      const uniqueTop = candidates
        .filter((p) => {
          if (seen.has(p.pid)) return false;
          seen.add(p.pid);
          return true;
        })
        .sort((a, b) => (b.listedNum || 0) - (a.listedNum || 0))
        .slice(0, 20);

      results[ourCat] = uniqueTop.map((p) => ({
        cjPid: p.pid,
        cjSku: p.productSku,
        nameEn: p.productNameEn,
        image: p.productImage,
        cjCostUSD: p.sellPrice,
        suggestedSellHKD: toRetailPriceHKD(p.sellPrice),
        listedNum: p.listedNum,
        categoryPath: p.categoryName,
      }));
    }

    res.status(200).json({
      note: "建議售價=CJ成本下限xUSD匯率x2.8倍。上架前記得人手覆核,並用pid攞返variants(vid)。",
      debug,
      results,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};


module.exports.config = { maxDuration: 60 };
