// ============================================================
// GET /api/admin/import-product?secret=xxx&pid=xxx&price=98&cat=tech
// ------------------------------------------------------------
// 一條pid,自動幫你:
//   1. 去CJ攞產品詳情(真實產品相、所有variants、成本價)
//   2. 計建議售價(如果你冇指定 price)
//   3. 生成三語宣傳文案草稿
//   4. 出埋兩段直接copy得嘅code:
//      - PRODUCTS entry(貼落 index.html)
//      - productMap entry(貼落 api/lib/productMap.js)
//
// 參數:
//   pid    (必填) CJ產品ID
//   price  (選填) 你想賣嘅港幣價,唔填就自動計(成本x2.8)
//   cat    (選填) home / beauty / tech,唔填預設 tech
//   id     (選填) 網站產品編號,唔填預設 99(記得改返做下一個未用嘅號碼)
//
// ⚠️ 文案係模板草稿,上架前建議人手潤色返做地道廣東話。
// ============================================================

const CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1";
const USD_TO_HKD = 7.8;
const MARKUP = 2.8;

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

function parseCostUSD(sellPrice) {
  if (sellPrice == null) return null;
  const nums = String(sellPrice).match(/[\d.]+/g);
  return nums ? parseFloat(nums[0]) : null;
}

function toRetailPriceHKD(costUSD) {
  const cost = parseCostUSD(costUSD);
  if (cost == null) return 98;
  const raw = cost * USD_TO_HKD * MARKUP;
  const rounded = Math.ceil(raw / 10) * 10 - 2;
  return Math.max(rounded, 48);
}

// 由英文產品名生成三語文案草稿(模板式,上架前記得人手潤色)
function draftCopy(nameEn, cat) {
  const short = (nameEn || "New Product").slice(0, 60);
  const angles = {
    home: {
      hant: { name: short, desc: `香港細單位都啱用,慳位實用之選。團隊嚴選先上架,48小時內出貨,順豐站自取。` },
      hans: { name: short, desc: `小户型也适用,省空间实用之选。团队严选才上架,48小时内发货,顺丰站自取。` },
      en:   { name: short, desc: `A practical, space-saving pick hand-picked by our team — ships within 48 hours with SF Locker pickup.` },
    },
    beauty: {
      hant: { name: short, desc: `屋企就做到嘅精緻感。團隊嚴選先上架,溫和好用,48小時內出貨直送到你手。` },
      hans: { name: short, desc: `在家也能拥有的精致感。团队严选才上架,温和好用,48小时内发货直达。` },
      en:   { name: short, desc: `Salon-level results at home. Hand-picked by our team — ships within 48 hours.` },
    },
    tech: {
      hant: { name: short, desc: `返工打機兩用嘅實用之選。團隊嚴選先上架,即插即用,48小時內出貨,順豐站自取。` },
      hans: { name: short, desc: `办公游戏两用的实用之选。团队严选才上架,即插即用,48小时内发货,顺丰站自取。` },
      en:   { name: short, desc: `A practical pick for work and play, hand-picked by our team. Plug and play — ships within 48 hours.` },
    },
  };
  return angles[cat] || angles.tech;
}

module.exports = async (req, res) => {
  if (req.query.secret !== process.env.ADMIN_SYNC_SECRET) {
    return res.status(401).json({ error: "密碼錯誤" });
  }
  const pid = req.query.pid;
  if (!pid) return res.status(400).json({ error: "要提供 ?pid=xxx" });

  const cat = ["home", "beauty", "tech"].includes(req.query.cat) ? req.query.cat : "tech";
  const newId = parseInt(req.query.id) || 99;

  try {
    const accessToken = await getAccessToken();
    await new Promise((r) => setTimeout(r, 1100));

    const apiRes = await fetch(`${CJ_BASE}/product/query?pid=${encodeURIComponent(pid)}`, {
      headers: { "CJ-Access-Token": accessToken },
    });
    const data = await apiRes.json();
    if (!data.result && !data.success) throw new Error(data.message || "CJ error");

    const p = data.data;
    const variants = (p.variants || []).map((v) => ({
      vid: v.vid,
      name: v.variantNameEn,
      option: v.variantKey,
      costUSD: v.variantSellPrice,
    }));
    const firstVariant = variants[0] || {};
    const price = parseInt(req.query.price) || toRetailPriceHKD(firstVariant.costUSD || p.sellPrice);
    const images = p.productImageSet || [p.bigImage].filter(Boolean);
    const mainImage = images[0] || "";
    const copy = draftCopy(p.productNameEn, cat);

    // 生成直接貼得嘅 PRODUCTS entry
    const productsSnippet =
`  {id:${newId},catClass:'${cat}',price:${price},icon:'box',image:'${mainImage}',trending:true,rating:4.5,reviews:50,i18n:{
    'zh-Hant':{name:'${copy.hant.name}',desc:'${copy.hant.desc}'},
    'zh-Hans':{name:'${copy.hans.name}',desc:'${copy.hans.desc}'},
    'en':{name:'${copy.en.name}',desc:'${copy.en.desc}'}}},`;

    // 生成直接貼得嘅 productMap entry
    const productMapSnippet =
`  ${newId}: { name: "${copy.hant.name}", sellPriceHKD: ${price}, cjPid: "${pid}", cjVid: "${firstVariant.vid || 'REPLACE_ME'}" },`;

    res.status(200).json({
      note: "以下兩段code直接copy貼落對應檔案。文案係草稿,建議人手潤色。cjVid預設用咗第一個variant,如果想賣第二款(顏色/尺寸),自己換返個vid。",
      product: {
        nameEn: p.productNameEn,
        costUSD: firstVariant.costUSD || p.sellPrice,
        suggestedPriceHKD: price,
        images,
        variants,
      },
      paste_into_index_html_PRODUCTS: productsSnippet,
      paste_into_productMap_js: productMapSnippet,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
