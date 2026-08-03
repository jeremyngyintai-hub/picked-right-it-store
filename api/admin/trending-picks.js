// ============================================================
// GET /api/admin/trending-picks?secret=xxx
// 自動喺CJ搵「家居/美妝/電子」熱賣候選產品
// ============================================================

const cj = require("../lib/cjClient");

// 每個系列直接用CJ第一層分類名匹配(對返debug見到嘅真實名稱)
const CATEGORY_KEYWORDS = {
  home: ["Home, Garden & Furniture", "Home Improvement", "Home Appliances"],
  beauty: ["Health, Beauty & Hair"],
  tech: ["Consumer Electronics", "Phones & Accessories", "Computer & Office"],
};

const USD_TO_HKD = 7.8;
const MARKUP = 2.8;

function toRetailPriceHKD(costUSD) {
  const raw = Number(costUSD) * USD_TO_HKD * MARKUP;
  const rounded = Math.ceil(raw / 10) * 10 - 2;
  return Math.max(rounded, 48);
}

module.exports = async (req, res) => {
  if (req.query.secret !== process.env.ADMIN_SYNC_SECRET) {
    return res.status(401).json({ error: "密碼錯誤" });
  }

  try {
    const accessToken = await cj.getAccessToken();
    const tree = await cj.getCategoryTree(accessToken);

    const results = {};
    const debug = { matchedCategoryIds: {}, rawCandidatesFound: {}, errors: [] };

    for (const [ourCat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      const categoryIds = cj.findCategoryIds(tree, keywords);
      debug.matchedCategoryIds[ourCat] = categoryIds.length;
      let candidates = [];

      // 唔用trending篩選,改用「最多人上架」排序,逐個分類搵
      for (const categoryId of categoryIds.slice(0, 8)) {
        if (candidates.length >= 10) break;
        try {
          const params = new URLSearchParams({
            categoryId,
            orderBy: "listedNum",
            sort: "desc",
            pageNum: "1",
            pageSize: "5",
          });
          const list = await require("../lib/cjClient").rawGet
            ? null
            : await cjListRaw(accessToken, params);
          if (list && list.list) candidates.push(...list.list);
        } catch (e) {
          debug.errors.push(`${ourCat}: ${e.message}`);
        }
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
        .slice(0, 5);

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
      note: "建議售價=CJ成本xUSD匯率x2.8倍再調靚尾數。上架前記得人手覆核,並用pid攞返variants(vid)。",
      debug,
      results,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// 直接call CJ product/list(唔經searchType篩選)
async function cjListRaw(accessToken, params) {
  const res = await fetch(
    `https://developers.cjdropshipping.com/api2.0/v1/product/list?${params.toString()}`,
    { headers: { "CJ-Access-Token": accessToken } }
  );
  const data = await res.json();
  if (!data.result && !data.success) throw new Error(data.message || "CJ list error");
  return data.data;
}
