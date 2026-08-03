// ============================================================
// CJ Dropshipping API 客戶端 (簡化版)
// ------------------------------------------------------------
// 官方文件: https://developers.cjdropshipping.cn/en/api/api2/
//
// 認證流程:
//   1. 用 CJ_API_KEY 去換一個 accessToken (有效期較短)
//   2. accessToken 過期後用 refreshToken 去換新嘅
//
// ⚠️ 注意:Vercel Serverless Function 每次執行都可能係新嘅執行環境,
// 記憶體內快取(下面嘅 tokenCache)唔一定跨請求保留。
// 呢個簡化版每次都會重新攞 token,方便你盡快跑得通。
// 如果之後訂單量大咗,建議加返 Vercel KV (vercel.com/docs/storage/vercel-kv)
// 嚟真正儲存 token,減少對 CJ API 嘅認證請求次數(CJ 對認證請求有頻率限制)。
// ============================================================

const CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1";

async function getAccessToken() {
  const res = await fetch(`${CJ_BASE}/authentication/getAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: process.env.CJ_API_KEY }),
  });
  const data = await res.json();
  if (!data.result) {
    throw new Error(`CJ getAccessToken 失敗: ${data.message}`);
  }
  return data.data.accessToken;
}

async function cjRequest(path, method, body, accessToken) {
  const res = await fetch(`${CJ_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "CJ-Access-Token": accessToken,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!data.result && !data.success) {
    throw new Error(`CJ API 錯誤 [${path}]: ${data.message || "未知錯誤"}`);
  }
  return data.data;
}

// 建立/查詢收貨地址 —— CJ 官方建議流程係:先查地址簿,冇就開一個新嘅
async function ensureShippingAddress(accessToken, shipping) {
  // shipping 格式: { name, phone, country, province, city, address, zip }
  // 呢個係簡化示範,實際欄位名要對照 CJ 文件 "05. Shopping" 嗰頁嘅
  // address/list 同 address/create 完整欄位表,因為唔同國家要求嘅欄位有出入
  return await cjRequest(
    "/shopping/privateInventory/outbound/address/create",
    "POST",
    shipping,
    accessToken
  );
}

// 開草稿訂單
async function createDraftOrder(accessToken, orderPayload) {
  // orderPayload 需要包含:產品清單 (cjPid/cjVid + 數量) + 收貨地址參考 + 你自己嘅訂單編號
  return await cjRequest(
    "/shopping/order/create",
    "POST",
    orderPayload,
    accessToken
  );
}

// 送出訂單(即刻用 CJ 錢包餘額扣錢,正式落單)
async function submitOrder(accessToken, cjOrderId) {
  return await cjRequest(
    "/shopping/order/submit",
    "POST",
    { orderId: cjOrderId },
    accessToken
  );
}

// 查詢訂單狀態/物流追蹤
async function getOrderDetail(accessToken, cjOrderId) {
  return await cjRequest(
    `/shopping/order/getOrderDetail?orderId=${cjOrderId}`,
    "GET",
    null,
    accessToken
  );
}

// 攞返CJ嘅分類樹(用嚟自動搵返「家居/美妝/電子」對應嘅categoryId,唔使人手查)
async function getCategoryTree(accessToken) {
  return await cjRequest("/product/getCategory", "GET", null, accessToken);
}

// 喺分類樹入面,搵返個名有包含指定關鍵字嘅categoryId清單
function findCategoryIds(tree, keywords) {
  const ids = [];
  const kw = keywords.map((k) => k.toLowerCase());
  (tree || []).forEach((first) => {
    const firstMatch = kw.some((k) => (first.categoryFirstName || "").toLowerCase().includes(k));
    (first.categoryFirstList || []).forEach((second) => {
      const secondMatch = kw.some((k) => (second.categorySecondName || "").toLowerCase().includes(k));
      (second.categorySecondList || []).forEach((third) => {
        const thirdMatch = kw.some((k) => (third.categoryName || "").toLowerCase().includes(k));
        if (firstMatch || secondMatch || thirdMatch) ids.push(third.categoryId);
      });
    });
  });
  return ids;
}

// 搵「熱賣趨勢」產品(searchType=2),按上架次數(listedNum)由高到低排,
// 可以夾埋 deliveryTime 篩選,務求配合「48小時出貨」呢個承諾
async function searchTrendingProducts(accessToken, { categoryId, deliveryTime, pageSize = 10 } = {}) {
  const params = new URLSearchParams({
    searchType: "2",
    orderBy: "listedNum",
    sort: "desc",
    pageNum: "1",
    pageSize: String(pageSize),
  });
  if (categoryId) params.set("categoryId", categoryId);
  if (deliveryTime) params.set("deliveryTime", String(deliveryTime));
  return await cjRequest(`/product/list?${params.toString()}`, "GET", null, accessToken);
}

// 攞單一產品嘅完整資料(包括variants/vid),畀你揀中之後補完productMap用
async function getProductDetail(accessToken, pid) {
  return await cjRequest(`/product/query?pid=${pid}`, "GET", null, accessToken);
}

module.exports = {
  getAccessToken,
  ensureShippingAddress,
  createDraftOrder,
  submitOrder,
  getOrderDetail,
  getCategoryTree,
  findCategoryIds,
  searchTrendingProducts,
  getProductDetail,
};
