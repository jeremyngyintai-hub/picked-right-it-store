// ============================================================
// /api/cron/daily — 每日總管家(四合一,慳Vercel function額度)
//
// 每日自動執行(或手動 ?secret=xxx&task=price|maintain|notify|autoimport):
//   1. price      — CJ成本變→按鎖定倍數自動調價(連運費)
//   2. maintain   — 同步銷量+自動落架滯銷貨
//   3. notify     — 有追蹤號碼嘅訂單,自動email通知客人(連評價邀請)
//   4. autoimport — AI規則自動搵贏家產品上架(要env AUTO_IMPORT_DAILY=true先開)
//
// AI自動入貨篩選規則:
//   - 上架數(listedNum) ≥ 2000(市場實證需求)
//   - 成本 US$1-12(輕貨甜蜜點,運費佔比健康)
//   - 黑名單關鍵字排除(煙/刀/窗簾/地毯等唔啱香港/唔畀落廣告嘅)
//   - 未上架過嘅先入圍;每日最多 AUTO_IMPORT_MAX 件(預設3)
//   - 總產品數 ≥ 80 就停(keep個店精)
// ============================================================

const { kvReady, kv, pipeline } = require("../_lib/kv");
const { sendEmail, shippedHTML } = require("../_lib/mail");
const { sendDiscord } = require("../_lib/discord");

const CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1";
const USD_TO_HKD = 7.8;
const MIN_MARKUP = 1.2;
const CHANGE_THRESHOLD = 0.02;
const DELIST_DAYS = parseInt(process.env.AUTO_DELIST_DAYS) || 14;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCostUSD(v){ if(v==null) return null; const m=String(v).match(/[\d.]+/g); return m?parseFloat(m[0]):null; }
function prettyPrice(raw){ const r=Math.ceil(raw/10)*10-2; return Math.max(r,48); }

async function cjAuth(){
  const res = await fetch(`${CJ_BASE}/authentication/getAccessToken`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({apiKey:process.env.CJ_API_KEY})});
  const d = await res.json();
  if(!d.result) throw new Error(`CJ auth: ${d.message}`);
  return d.data.accessToken;
}
async function cjGet(path, token){
  const res = await fetch(`${CJ_BASE}${path}`,{headers:{"CJ-Access-Token":token}});
  const d = await res.json();
  if(!d.result && !d.success) throw new Error(d.message||"CJ error");
  return d.data;
}
async function ghGetFile(path){
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${path}`,{headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,"User-Agent":"picked-right-it"}});
  if(res.status===404) return {content:null,sha:null};
  const d = await res.json();
  if(!d.content) throw new Error(`GitHub read failed: ${d.message||"unknown"}`);
  return {content:Buffer.from(d.content,"base64").toString("utf8"), sha:d.sha};
}
async function ghPutFile(path, contentStr, sha, message){
  const body={message,content:Buffer.from(contentStr,"utf8").toString("base64")};
  if(sha) body.sha=sha;
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${path}`,{method:"PUT",headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,"User-Agent":"picked-right-it","Content-Type":"application/json"},body:JSON.stringify(body)});
  const d = await res.json();
  if(!d.commit) throw new Error(`GitHub write failed: ${d.message||"unknown"}`);
}

function draftCopy(nameEn, cat){
  const short=(nameEn||"New Product").slice(0,60).replace(/'/g,"");
  const base={
    "zh-Hant":{name:short,desc:"團隊嚴選先上架,一般48小時內安排出貨,順豐站自取。"},
    "zh-Hans":{name:short,desc:"团队严选才上架,一般48小时内安排发货,顺丰站自取。"},
    "en":{name:short,desc:"Hand-picked by our team. Usually dispatched within 48 hours, SF Locker pickup."},
  };
  return base;
}

// ============ TASK 1:調價 ============
async function taskPrice(token, list, report){
  let changed=false;
  const toDo = list.filter(p=>p.cjPid).slice(0,15);
  for(const p of toDo){
    try{
      const d = await cjGet(`/product/query?pid=${encodeURIComponent(p.cjPid)}`, token);
      const variant=(d.variants||[]).find(v=>v.vid===p.cjVid);
      const newCost=parseCostUSD(variant?variant.variantSellPrice:d.sellPrice);
      if(newCost!=null && p.costUSD && Math.abs(newCost-p.costUSD)/p.costUSD >= CHANGE_THRESHOLD){
        const shipHKD=(p.shipUSD||0)*USD_TO_HKD;
        const locked=Math.max((p.price-shipHKD)/(p.costUSD*USD_TO_HKD), MIN_MARKUP);
        const newPrice=prettyPrice(newCost*USD_TO_HKD*locked + shipHKD);
        report.repriced.push({id:p.id, price:`${p.price}→${newPrice}`});
        p.costUSD=newCost; p.price=newPrice; p.priceSyncedAt=new Date().toISOString();
        changed=true;
      }
    }catch(e){ report.errors.push(`price#${p.id}: ${e.message}`); }
    await sleep(1100);
  }
  return changed;
}

// ============ TASK 2:銷量同步+自動落架 ============
async function taskMaintain(list, report){
  if(!kvReady()) return false;
  let changed=false;
  const now=Date.now();
  const cmds=[];
  list.forEach(p=>{ cmds.push(["GET",`sold:qty:${p.id}`]); cmds.push(["GET",`lastsale:${p.id}`]); });
  const results = cmds.length ? await pipeline(cmds) : [];
  list.forEach((p,i)=>{
    const soldQty=parseInt(results[i*2])||0;
    const lastSale=parseInt(results[i*2+1])||0;
    if(p.soldQty!==soldQty){ p.soldQty=soldQty; changed=true; }
    if(lastSale && p.lastSaleAt!==lastSale){ p.lastSaleAt=lastSale; changed=true; }
    const age=now-new Date(p.addedAt||0).getTime();
    const stale=!lastSale || (now-lastSale > DELIST_DAYS*86400e3);
    if(!p.delisted && age>DELIST_DAYS*86400e3 && soldQty===0 && stale){
      p.delisted=true; p.delistedAt=new Date().toISOString(); changed=true;
      report.delisted.push(p.id);
    }
    if(p.delisted && lastSale && now-lastSale < DELIST_DAYS*86400e3){ p.delisted=false; changed=true; }
  });
  return changed;
}

// ============ TASK 3:出貨通知email ============
async function taskNotify(token, report){
  if(!kvReady() || !process.env.RESEND_API_KEY) return;
  const raw = await kv(["LRANGE","orders","0","29"]);
  const orders=(raw||[]).map(s=>{try{return JSON.parse(s)}catch{return null}}).filter(Boolean);
  let done=0;
  for(const o of orders){
    if(done>=8) break;
    if(!o.email) continue;
    try{
      const notified = await kv(["GET",`notified:${o.sid}`]);
      if(notified) continue;
      const cjOrderId = await kv(["GET",`cjorder:${o.sid}`]);
      if(!cjOrderId) continue;
      const d = await cjGet(`/shopping/order/getOrderDetail?orderId=${encodeURIComponent(cjOrderId)}`, token);
      await sleep(1100);
      const tn = d && (d.trackNumber || d.trackingNumber || d.logisticNumber || (Array.isArray(d.orderList)&&d.orderList[0]&&d.orderList[0].trackNumber));
      if(tn){
        const r = await sendEmail({
          to:o.email,
          subject:`📦 你件貨出發喇!追蹤號碼 ${tn} — 揀啱`,
          html: shippedHTML({trackNumber:tn, siteUrl:process.env.SITE_URL||"https://picked-right.it.com"}),
        });
        if(r.ok||r.skipped){ await kv(["SET",`notified:${o.sid}`,"1"]); report.notified.push(o.sid.slice(-8)); done++; }
      }
    }catch(e){ report.errors.push(`notify: ${e.message}`); }
  }
}

// ============ TASK 4:AI自動入贏家貨 ============
const BLACKLIST = /cigarette|lighter|tobacco|vape|knife|weapon|gun|curtain|rug|carpet|mattress|furniture|sofa/i;
const AUTO_CATS = [
  {cat:"tech", kw:["Consumer Electronics","Phones & Accessories"]},
  {cat:"beauty", kw:["Health, Beauty & Hair"]},
  {cat:"pets", kw:["Pet Supplies"]},
];
async function taskAutoImport(token, list, report){
  const MAXNEW = parseInt(process.env.AUTO_IMPORT_MAX)||3;
  if(list.filter(p=>!p.delisted).length >= 80){ report.autoimport.push("店已有80+件,今日唔加"); return false; }
  const listedPids = new Set(list.map(p=>p.cjPid));
  const mk = parseFloat(process.env.AUTO_IMPORT_MARKUP)||2.8;

  const tree = await cjGet("/product/getCategory", token); await sleep(1100);
  const candidates=[];
  for(const grp of AUTO_CATS){
    const ids=[];
    (tree||[]).forEach(f=>{
      const fMatch=grp.kw.some(k=>(f.categoryFirstName||"").includes(k));
      (f.categoryFirstList||[]).forEach(s=>{
        (s.categorySecondList||[]).forEach(t3=>{ if(fMatch) ids.push(t3.categoryId); });
      });
    });
    if(!ids.length) continue;
    try{
      const params=new URLSearchParams({categoryId:ids[0],orderBy:"listedNum",sort:"desc",pageNum:"1",pageSize:"20"});
      const r = await cjGet(`/product/list?${params}`, token);
      (r&&r.list||[]).forEach(p=>candidates.push({...p,_cat:grp.cat}));
    }catch{}
    await sleep(1100);
  }

  // AI規則篩選
  const picked = candidates.filter(p=>{
    const cost=parseCostUSD(p.sellPrice);
    return !listedPids.has(p.pid)
      && (p.listedNum||0)>=2000
      && cost!=null && cost>=1 && cost<=12
      && !BLACKLIST.test(p.productNameEn||"");
  }).sort((a,b)=>(b.listedNum||0)-(a.listedNum||0)).slice(0,MAXNEW);

  let changed=false;
  let nextId=Math.max(12,...list.map(x=>x.id||0))+1;
  for(const p of picked){
    try{
      const d = await cjGet(`/product/query?pid=${encodeURIComponent(p.pid)}`, token); await sleep(1100);
      const variants=d.variants||[];
      const cv=variants[0];
      if(!cv) continue;
      const costUSD=parseCostUSD(cv.variantSellPrice)||parseCostUSD(d.sellPrice)||0;
      // 查真實運費
      let shipUSD=5;
      try{
        const fRes=await fetch(`${CJ_BASE}/logistic/freightCalculate`,{method:"POST",headers:{"Content-Type":"application/json","CJ-Access-Token":token},body:JSON.stringify({startCountryCode:"CN",endCountryCode:"HK",products:[{quantity:1,vid:cv.vid}]})});
        const fd=await fRes.json();
        const prices=((fd&&fd.data)||[]).map(o=>parseFloat(o.logisticPrice)).filter(x=>!isNaN(x)&&x>0);
        if(prices.length) shipUSD=Math.min(...prices);
      }catch{}
      await sleep(1100);
      const price=prettyPrice(costUSD*USD_TO_HKD*mk + shipUSD*USD_TO_HKD);
      const images=(d.productImageSet||[d.bigImage].filter(Boolean)).slice(0,6);
      list.push({
        id:nextId, catClass:p._cat, price, icon:"box",
        image:images[0]||"", images, video:d.productVideo||"",
        trending:true, rating:4.5, reviews:0,
        i18n:draftCopy(d.productNameEn,p._cat),
        cjPid:p.pid, cjVid:cv.vid,
        shipUSD:Math.round(shipUSD*100)/100,
        variants:variants.slice(0,60).map(v=>({vid:v.vid,name:v.variantNameEn||v.variantKey||""})),
        costUSD, addedAt:new Date().toISOString(), autoImported:true,
      });
      report.autoimport.push(`#${nextId} ${(d.productNameEn||"").slice(0,40)} HK$${price}`);
      nextId++; changed=true;
    }catch(e){ report.errors.push(`autoimport: ${e.message}`); }
  }
  return changed;
}

// ============ 主流程 ============
module.exports = async (req, res) => {
  const authHeader=req.headers["authorization"]||"";
  const isCron=process.env.CRON_SECRET && authHeader===`Bearer ${process.env.CRON_SECRET}`;
  const isManual=req.query.secret===process.env.ADMIN_SYNC_SECRET;
  if(!isCron && !isManual) return res.status(401).json({error:"未授權"});
  if(!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) return res.status(500).json({error:"未設定GITHUB_TOKEN/GITHUB_REPO"});

  const only=req.query.task; // price|maintain|notify|autoimport,唔指定=全套
  const report={repriced:[],delisted:[],notified:[],autoimport:[],errors:[]};
  const started=Date.now();
  const timeLeft=()=> 50000-(Date.now()-started); // 50秒預算,留buffer

  try{
    const {content,sha}=await ghGetFile("data/products.json");
    const list=content?JSON.parse(content):[];
    const token=await cjAuth(); await sleep(1100);
    let changed=false;

    if((!only||only==="price") && list.length && timeLeft()>15000) changed=(await taskPrice(token,list,report))||changed;
    if((!only||only==="maintain") && list.length && timeLeft()>5000) changed=(await taskMaintain(list,report))||changed;
    if((!only||only==="notify") && timeLeft()>10000) await taskNotify(token,report);
    const autoOn = only==="autoimport" || (!only && process.env.AUTO_IMPORT_DAILY==="true");
    if(autoOn && timeLeft()>20000) changed=(await taskAutoImport(token,list,report))||changed;

    if(changed){
      await ghPutFile("data/products.json", JSON.stringify(list,null,2), sha,
        `daily: reprice ${report.repriced.length} / delist ${report.delisted.length} / auto-import ${report.autoimport.length}`);
    }
    // ===== Discord每日統計digest =====
    try {
      let statLine = "";
      if (kvReady()) {
        const raw = await kv(["LRANGE", "orders", "0", "199"]);
        const orders = (raw || []).map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
        const d1 = Date.now() - 86400e3;
        const today = orders.filter((o) => o.ts >= d1);
        const rev = today.reduce((s, o) => s + (o.totalHKD || 0), 0);
        const ymd = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
        const pv = parseInt(await kv(["GET", `pv:day:${ymd}`])) || 0;
        statLine = `24小時營業額 **HK$${rev}** · 訂單 **${today.length}** 張 · 今日瀏覽 **${pv}**`;
      }
      await sendDiscord({
        title: "📊 揀啱每日戰報",
        color: 0x8b5cf6,
        description: statLine || "(KV未設定,冇統計數據)",
        fields: [
          { name: "🔄 自動調價", value: String(report.repriced.length), inline: true },
          { name: "🧹 自動落架", value: String(report.delisted.length), inline: true },
          { name: "📦 出貨通知", value: String(report.notified.length), inline: true },
          { name: "🤖 AI入貨", value: report.autoimport.length ? report.autoimport.join("\n").slice(0, 900) : "0", inline: false },
        ],
      });
    } catch {}

    res.status(200).json({
      message:`調價${report.repriced.length} · 落架${report.delisted.length} · 出貨通知${report.notified.length} · 自動入貨${report.autoimport.length}`,
      report,
    });
  }catch(err){
    console.error(err);
    res.status(500).json({error:err.message, report});
  }
};

module.exports.config = { maxDuration: 60 };
