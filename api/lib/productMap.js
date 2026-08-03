// ============================================================
// 產品對照表 (Product Mapping)
// ------------------------------------------------------------
// 呢個檔案將你網站嘅產品,對應返 CJ Dropshipping 嘅產品資料。
// 你需要入返 CJ Dropshipping 網站,搵返每件產品嘅 pid (Product ID)
// 同 vid (Variant ID),先可以用嚟自動落單。
//
// 搵法:登入 my.cjdropshipping.com → 搵返你想賣嘅產品 → 個網址
// 或者產品詳情頁通常會顯示 pid;variant (例如顏色/尺寸) 就係 vid。
//
// 呢度嘅價錢一律用「你賣畀客人嘅價錢」(HKD),同 CJ 嘅成本價分開,
// 千祈唔好信任前端傳嚟嘅價錢 —— 一定要以呢個檔案(伺服器嗰邊)嘅價錢為準,
// 否則有人可以竄改網頁前端數據,用假價錢落單。
// ============================================================

module.exports = {
  1: { name: "三件套摺疊收納箱",   sellPriceHKD: 168, cjPid: "REPLACE_ME", cjVid: "REPLACE_ME" },
  2: { name: "靜音迷你風扇",       sellPriceHKD: 128, cjPid: "REPLACE_ME", cjVid: "REPLACE_ME" },
  3: { name: "USB香薰加濕器",      sellPriceHKD: 158, cjPid: "REPLACE_ME", cjVid: "REPLACE_ME" },
  4: { name: "PDRN鮭魚精華面霜",   sellPriceHKD: 268, cjPid: "REPLACE_ME", cjVid: "REPLACE_ME" },
  5: { name: "PDRN保濕爽膚水",     sellPriceHKD: 198, cjPid: "REPLACE_ME", cjVid: "REPLACE_ME" },
  6: { name: "LED光療美容儀",      sellPriceHKD: 398, cjPid: "REPLACE_ME", cjVid: "REPLACE_ME" },
  7: { name: "磁吸無線充電座",     sellPriceHKD: 178, cjPid: "REPLACE_ME", cjVid: "REPLACE_ME" },
  8: { name: "真無線藍牙耳機",     sellPriceHKD: 328, cjPid: "REPLACE_ME", cjVid: "REPLACE_ME" },
  9: { name: "手機摺疊支架",       sellPriceHKD: 88,  cjPid: "REPLACE_ME", cjVid: "REPLACE_ME" },
};
