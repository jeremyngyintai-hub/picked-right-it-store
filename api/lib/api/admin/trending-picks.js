// ============================================================
// GET /api/admin/trending-picks?secret=xxx
// ------------------------------------------------------------
// 一撳,自動幫你喺CJ Dropshipping搵返「家居/美妝/電子」三個類別
// 各自最啱嘅熱賣候選產品,連建議售價、pid/vid都幫你計好。
//
// 用法:瀏覽器打開
//   https://picked-right.it.com/api/admin/trending-picks?secret=你設定嘅密碼
//
// ⚠️ 呢個係「搵貨」工具,唔會自動幫你上架 —— 攞到結果之後,
// 你揀返啱心水嘅產品,人手寫返地道廣東話文案,先copy去
// index.html 個 PRODUCTS 同 api/lib/productMap.js 度。
// ============================================================

const cj = require("../lib/cjClient");

// 你想搵嘅三大系列,同埋CJ分類樹入面用嚟匹配嘅英文關鍵字
const CATEGORY_KEYWORDS = {
  home: ["Home", "Garden", "Storage", "Kitchen"],
  beauty: ["Beauty", "Health", "Skin"],
  tech: ["Consumer Electronics", "Phone", "Computer"],
};

const USD_TO_HKD = 7.8;   // 港元同美元掛鈎匯率,基本唔會大變
const MARKUP = 2.8;       // 建議零售倍數(成本 x 2.8),可以自己調整

// 將美金成本轉做「靚仔」嘅港幣建議售價(例如168, 198, 268呢種尾數)
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

    for (const [ourCat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      const categoryIds = cj.findCategoryIds(tree, keywords);
      let candidates = [];

      // 逐個categoryId搵熱賣產品,盡量夾埋48小時內出貨嘅
      for (const categoryId of categoryIds.slice(0, 5)) {
        try {
          const list = await cj.searchTrendingProducts(accessToken, {
            categoryId,
            deliveryTime: 48,
            pageSize: 5,
          });
          if (list && list.list) candidates.push(...list.list);
        } catch (e) {
          // 某個分類搵唔到都唔緊要,繼續搵下一個
        }
      }

      // 冇48小時貨嘅,retry一次唔限出貨時間,起碼有結果睇
      if (candidates.length === 0) {
        for (const categoryId of categoryIds.slice(0, 3)) {
          try {
            const list = await cj.searchTrendingProducts(accessToken, { categoryId, pageSize: 5 });
            if (list && list.list) candidates.push(...list.list);
          } catch (e) {}
        }
      }

      // 去重(同一個pid可能因為跨分類而重複),取頭5件
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
        nameRaw: p.productName, // CJ原廠中文名(通常係簡體),上架前記得用地道廣東話改寫
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
      results,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
