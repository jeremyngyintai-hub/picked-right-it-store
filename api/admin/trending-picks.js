// ============================================================
// GET /api/admin/trending-picks?secret=xxx
// ------------------------------------------------------------
// 一撳,自動幫你喺CJ Dropshipping搵返「家居/美妝/電子」三個類別
// 各自最啱嘅熱賣候選產品,連建議售價、pid/vid都幫你計好。
// ============================================================

const cj = require("../lib/cjClient");

const CATEGORY_KEYWORDS = {
  home: ["Home", "Garden", "Storage", "Kitchen"],
  beauty: ["Beauty", "Health", "Skin"],
  tech: ["Consumer Electronics", "Phone", "Computer"],
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
    const debug = { treeTopLevelNames: [], treeSecondLevelNames: [], matchedCategoryIds: {}, rawCandidatesFound: {} };

    (tree || []).forEach((first) => {
      debug.treeTopLevelNames.push(first.categoryFirstName);
      (first.categoryFirstList || []).forEach((second) => {
        debug.treeSecondLevelNames.push(second.categorySecondName);
      });
    });

    for (const [ourCat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      const categoryIds = cj.findCategoryIds(tree, keywords);
      debug.matchedCategoryIds[ourCat] = categoryIds.length;
      let candidates = [];

      for (const categoryId of categoryIds.slice(0, 5)) {
        try {
          const list = await cj.searchTrendingProducts(accessToken, {
            categoryId,
            deliveryTime: 48,
            pageSize: 5,
          });
          if (list && list.list) candidates.push(...list.list);
        } catch (e) {}
      }

      if (candidates.length === 0) {
        for (const categoryId of categoryIds.slice(0, 3)) {
          try {
            const list = await cj.searchTrendingProducts(accessToken, { categoryId, pageSize: 5 });
            if (list && list.list) candidates.push(...list.list);
          } catch (e) {}
        }
      }

      if (categoryIds.length === 0) {
        for (const kw of keywords) {
          try {
            const list = await cj.searchTrendingProducts(accessToken, { pageSize: 5 });
            if (list && list.list) {
              const filtered = list.list.filter(p =>
                (p.productNameEn || "").toLowerCase().includes(kw.toLowerCase()) ||
                (p.categoryName || "").toLowerCase().includes(kw.toLowerCase())
              );
              candidates.push(...filtered);
            }
          } catch (e) {}
        }
      }

      debug.rawCandidatesFound[ourCat] = candidates.length;

      const seen = new Set();
      const uniqueTop = candidates.filter((p) => {
        if (seen.has(p.pid)) return false;
        seen.add(p.pid);
        return true;
      }).slice(0, 5);

      results[ourCat] = uniqueTop.map((p) => ({
        cjPid: p.pid,
        cjSku: p.productSku,
        nameEn: p.productNameEn,
        nameRaw: p.productName,
        image: p.productImage,
        cjCostUSD: p.sellPrice,
        suggestedSellHKD: toRetailPriceHKD(p.sellPrice),
        listedNum: p.listedNum,
        deliveryTimeHours: p.deliveryTime || null,
        categoryPath: p.categoryName,
      }));
    }

    res.status(200).json({
      note: "呢啲只係搵貨建議,上架前記得人手覆核圖片/文案/成分聲稱,並用 pid 去 CJ 網站或者 /product/query 攞返完整variants(vid)。",
      debug,
      results,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
