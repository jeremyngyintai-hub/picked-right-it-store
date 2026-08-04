// ============================================================
// 統一產品目錄:合併靜態 productMap.js + 動態 data/products.json
// 收銀(create-checkout-session)同落單(stripe-webhook)都用呢個,
// 確保經管理台自動上架嘅新產品即刻買得、落到單。
// ============================================================

const productMap = require("./productMap");

async function getCatalog() {
  const dynamic = {};
  try {
    const res = await fetch(`${process.env.SITE_URL}/data/products.json`);
    if (res.ok) {
      const list = await res.json();
      (list || []).forEach((p) => {
        dynamic[p.id] = {
          name: (p.i18n && p.i18n["zh-Hant"] && p.i18n["zh-Hant"].name) || `Product ${p.id}`,
          sellPriceHKD: p.price,
          costUSD: p.costUSD || null,
          shipUSD: p.shipUSD || 0,
          cjPid: p.cjPid,
          cjVid: p.cjVid,
          variants: p.variants || [],
        };
      });
    }
  } catch (e) {
    console.error("讀取 products.json 失敗,淨係用靜態 productMap:", e.message);
  }
  return { ...productMap, ...dynamic };
}

module.exports = { getCatalog };
