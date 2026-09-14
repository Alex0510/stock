/**
 * Market Research Cockpit - Cloudflare Workers Full Edition
 * Independent Workers implementation for the one-screen dashboard.
 *
 * Data sources:
 * Tencent Finance, Sina Finance, Eastmoney, Wallstreetcn, CNBC, Binance.
 *
 * No fake market values are generated. If an upstream is unavailable the
 * corresponding API returns [] / {} or an error and the UI shows unavailable.
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/139 Safari/537.36 MRD-Workers/2.0";
const EM_REF = "https://quote.eastmoney.com/";
const mem = new Map();

const TTL = {
  quote: 5, minute: 5, boards: 8, boardStocks: 10,
  rank: 8, flow: 10, boardFlow: 20, futures: 10,
  news: 15, treasury: 60, search: 20, finance: 300
};

function n(v){ const x=Number(v); return Number.isFinite(x)?x:0 }
function clamp(x,a,b){ return Math.max(a,Math.min(b,x)) }
function pchg(price,prev){ return prev ? +(((price-prev)/prev)*100).toFixed(4) : 0 }
function chg(price,prev){ return +(price-prev).toFixed(6) }
function marketCode(code6){
  const s=String(code6||"");
  if (/^(60|68|90)/.test(s)) return "sh"+s;
  if (/^(00|30|20)/.test(s)) return "sz"+s;
  if (/^(4|8|92)/.test(s)) return "bj"+s;
  return s;
}

function ok(data, extra={}) {
  return new Response(JSON.stringify({ok:true,data}), {
    headers:{
      "content-type":"application/json; charset=utf-8",
      "cache-control":"no-store",
      "access-control-allow-origin":"*",
      ...extra
    }
  });
}
function fail(error,status=502){
  return new Response(JSON.stringify({ok:false,error:String(error?.message||error)}),{
    status,headers:{
      "content-type":"application/json; charset=utf-8",
      "cache-control":"no-store",
      "access-control-allow-origin":"*"
    }
  })
}
function page(body){
  return new Response(body,{headers:{
    "content-type":"text/html; charset=utf-8",
    "cache-control":"no-store",
    "x-content-type-options":"nosniff",
    "referrer-policy":"same-origin"
  }})
}

async function text(url, opts={}){
  const c=new AbortController();
  const t=setTimeout(()=>c.abort(),opts.timeout||9000);
  const h=new Headers(opts.headers||{});
  h.set("user-agent",UA);
  if(opts.referer) h.set("referer",opts.referer);
  h.set("accept",opts.accept||"*/*");
  try{
    const r=await fetch(url,{headers:h,signal:c.signal,redirect:"follow"});
    if(!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    if(!opts.gbk) return await r.text();
    const ab=await r.arrayBuffer();
    try{return new TextDecoder("gbk").decode(ab)}
    catch{return new TextDecoder().decode(ab)}
  } finally { clearTimeout(t) }
}
async function jget(url,opts={}){
  const s=await text(url,opts);
  return JSON.parse(s);
}
async function cached(key,ttl,fn,env){
  const now=Date.now();
  const hit=mem.get(key);
  if(hit && hit.exp>now) return hit.data;
  if(env?.MRD_KV){
    try{
      const raw=await env.MRD_KV.get("c:"+key);
      if(raw){
        const r=JSON.parse(raw);
        if(r.exp>now){ mem.set(key,r); return r.data }
      }
    }catch{}
  }
  const data=await fn();
  const rec={exp:now+ttl*1000,data};
  mem.set(key,rec);
  if(env?.MRD_KV){
    try{ await env.MRD_KV.put("c:"+key,JSON.stringify(rec),{expirationTtl:Math.max(60,ttl)}) }catch{}
  }
  return data;
}

/* ---------------- Quotes ---------------- */

function parseTencentLine(line){
  const m=line.match(/v_([A-Za-z0-9_]+)="([^"]*)"/);
  if(!m)return null;
  const symbol=m[1], f=m[2].split("~");
  if(symbol.startsWith("wh") && f.length>13){
    return {symbol,name:f[1],price:n(f[3]),change:n(f[12]),pct:n(f[13]),
      open:n(f[6]),high:n(f[8]),low:n(f[9]),prev:n(f[3])-n(f[12]),time:f[5],amount:0,turnover:0};
  }
  if(f.length<40)return null;
  return {symbol,name:f[1],price:n(f[3]),prev:n(f[4]),open:n(f[5]),vol:n(f[6]),
    time:f[30],change:n(f[31]),pct:n(f[32]),high:n(f[33]),low:n(f[34]),
    amount:n(f[37]),turnover:n(f[38]),pe:n(f[39]),amplitude:n(f[43])};
}
async function quotes(codes){
  const a=[...new Set(String(codes||"").split(",").map(x=>x.trim())
    .filter(x=>/^[A-Za-z0-9_]{2,24}$/.test(x)))].slice(0,180);
  const out=Object.create(null);
  for(let i=0;i<a.length;i+=60){
    const c=a.slice(i,i+60);
    const s=await text("https://qt.gtimg.cn/q="+encodeURIComponent(c.join(",")),{gbk:true});
    for(const line of s.split(";")){
      const q=parseTencentLine(line.trim()); if(q)out[q.symbol]=q;
    }
  }
  return out;
}
async function minute(code){
  if(!/^[A-Za-z0-9_]{2,24}$/.test(code)) throw new Error("bad code");
  if(code.startsWith("wh")){
    const u="https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=133.USDCNH&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=1&fqt=1&beg=0&end=20500101&lmt=240";
    const j=await jget(u,{referer:EM_REF});
    return {code,prec:n(j?.data?.preKPrice),source:"eastmoney",
      points:(j?.data?.klines||[]).map(s=>{const x=s.split(",");return {t:x[0].slice(11,16).replace(":",""),p:n(x[2])}}).filter(x=>x.p)};
  }
  const u=code.startsWith("us")
    ?`https://web.ifzq.gtimg.cn/appstock/app/usMinute/query?code=${encodeURIComponent(code)}`
    :`https://ifzq.gtimg.cn/appstock/app/minute/query?code=${encodeURIComponent(code)}`;
  const j=await jget(u);
  const d=j?.data?.[code], a=d?.data?.data||[];
  return {code,prec:n(d?.data?.prec||d?.qt?.[code]?.[4]),
    points:a.map(s=>{const x=String(s).split(" ");return {t:x[0],p:n(x[1])}})};
}

async function batchMinutes(codes){
  const list=[...new Set(String(codes||"").split(",").map(x=>x.trim())
    .filter(x=>/^[A-Za-z0-9_]{2,24}$/.test(x)))].slice(0,32);
  const out={};
  for(let i=0;i<list.length;i+=8){
    const part=list.slice(i,i+8);
    const rs=await Promise.all(part.map(async c=>{
      try{return [c,await minute(c)]}catch{return [c,{code:c,prec:0,points:[],degraded:true}]}
    }));
    for(const [c,m] of rs) out[c]=m;
  }
  return out;
}

/* ---------------- Boards ---------------- */

async function boards(type="01",dir="0",cnt=30){
  type=["01","02"].includes(type)?type:"01"; dir=dir==="1"?"1":"0";
  cnt=clamp(parseInt(cnt)||30,1,100);
  const u=`https://ifzq.gtimg.cn/appstock/app/mktHs/rank?l=${cnt}&p=1&t=${type}/averatio&o=${dir}`;
  const j=await jget(u);
  return (j?.data||[]).map(b=>({
    code:b.bd_code,name:b.bd_name,price:n(b.bd_zxj),change:n(b.bd_zd),pct:n(b.bd_zdf),
    pct5:n(b.bd_zdf5),pct20:n(b.bd_zdf20),leadCode:b.nzg_code,leadName:b.nzg_name,
    leadPrice:n(b.nzg_zxj),leadPct:n(b.nzg_zdf)
  }));
}
async function boardStocks(code,cnt=18,dir="down"){
  if(!/^[A-Za-z0-9]{4,24}$/.test(code)) return [];
  cnt=clamp(parseInt(cnt)||18,1,100);
  const direct=dir==="up"?"up":"down";
  // Same endpoint/semantics as upstream qq-rank.cjs + tencent.cjs:
  // getBoardRankList({boardCode, sortType:"PriceRatio", direct})
  const u=`https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList?board_code=${encodeURIComponent(code)}&sort_type=PriceRatio&direct=${direct}&offset=0&count=${cnt}`;
  try{
    const j=await jget(u,{referer:"https://gu.qq.com/"});
    const a=j?.data?.rank_list||[];
    if(Array.isArray(a) && a.length) return a.map(x=>({
      code:x.code||"",name:x.name||"",price:n(x.zxj),pct:n(x.zdf),turnover:n(x.hsl),
      pe:n(x.pe_ttm),speed:n(x.speed),circ_mv:n(x.ltsz),total_mv:n(x.zsz),
      amount:n(x.volume)*100*n(x.zxj)
    })).filter(x=>x.name);
  }catch{}
  // Eastmoney fallback when the board id itself is Eastmoney BKxxxx.
  if(/^BK\d{4}$/.test(code)){
    const u2=`https://push2delay.eastmoney.com/api/qt/clist/get?fid=f3&po=${direct==="down"?1:0}&pz=${cnt}&pn=1&np=1&fltt=2&invt=2&fs=${encodeURIComponent("b:"+code)}&fields=f12,f14,f2,f3,f8,f9,f20,f21`;
    const j=await jget(u2,{referer:EM_REF});
    return (j?.data?.diff||[]).map(x=>({code:marketCode(x.f12),name:x.f14,price:n(x.f2),pct:n(x.f3),
      turnover:n(x.f8),pe:n(x.f9),total_mv:n(x.f20),circ_mv:n(x.f21)}));
  }
  return [];
}

/* ---------------- Rankings & money flow ---------------- */

async function stockRank(sort="changepercent",asc="0",cnt=15){
  cnt=clamp(parseInt(cnt)||15,1,60);
  const allowed={changepercent:"changepercent",amount:"amount",turnoverratio:"turnoverratio"};
  sort=allowed[sort]||"changepercent"; asc=asc==="1"?"1":"0";
  const fetchN=Math.min(100,Math.max(cnt*3,60));
  const u=`https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=1&num=${fetchN}&sort=${sort}&asc=${asc}&node=hs_a&symbol=&_s_r_a=page`;
  const a=await jget(u,{referer:"https://finance.sina.com.cn/"});
  return (Array.isArray(a)?a:[]).filter(s=>n(s.trade)>0).slice(0,cnt).map(s=>({
    symbol:s.symbol,code:s.code,name:s.name,price:n(s.trade),change:n(s.pricechange),
    pct:n(s.changepercent),open:n(s.open),high:n(s.high),low:n(s.low),vol:n(s.volume),
    amount:n(s.amount),pe:n(s.per),pb:n(s.pb),total_mv:n(s.mktcap),circ_mv:n(s.nmc),
    turnover:n(s.turnoverratio),time:s.ticktime
  }));
}
function limitPctOf(x){
  const code=String(x.code||x.symbol||"").replace(/^(sh|sz|bj)/,"");
  const name=String(x.name||"").toUpperCase();
  if(name.includes("ST")) return 5;
  if(/^(300|301|688|689)/.test(code)) return 20;
  if(/^(4|8|92)/.test(code)) return 30;
  return 10;
}

async function auctionRush(cnt=20){
  cnt=clamp(parseInt(cnt)||20,5,50);
  // Pull a broader real-market window and score by opening gap, turnover and amount.
  // This is a ranking/observation view, not fabricated auction volume.
  const rows=await stockRank("amount","0",Math.min(60,Math.max(cnt*3,40)));
  const maxAmount=Math.max(1,...rows.map(x=>n(x.amount)));
  return rows
    .filter(x=>x.price>0 && x.open>0)
    .map(x=>{
      const prev=x.change!==0 ? x.price-x.change : (x.pct!==-100 ? x.price/(1+x.pct/100) : x.price);
      const openPct=prev ? ((x.open-prev)/prev)*100 : 0;
      const amountScore=Math.log10(1+n(x.amount))/Math.log10(1+maxAmount);
      const score=openPct*1.6 + Math.min(n(x.turnover),20)*0.28 + amountScore*10 + Math.max(n(x.pct),0)*0.45;
      return {...x,openPct:+openPct.toFixed(2),score:+score.toFixed(2)};
    })
    .filter(x=>x.openPct>-4 && x.pct>-5)
    .sort((a,b)=>b.score-a.score)
    .slice(0,cnt);
}

async function limitRush(cnt=20){
  cnt=clamp(parseInt(cnt)||20,5,50);
  const rows=await stockRank("changepercent","0",Math.min(80,Math.max(cnt*3,50)));
  return rows.map(x=>{
    const limitPct=limitPctOf(x);
    const distance=Math.max(0,limitPct-n(x.pct));
    const progress=clamp((n(x.pct)/limitPct)*100,0,120);
    return {...x,limitPct,distance:+distance.toFixed(2),progress:+progress.toFixed(1)};
  })
  .filter(x=>x.pct>1 && x.distance<=6)
  .sort((a,b)=>a.distance-b.distance || b.amount-a.amount)
  .slice(0,cnt);
}

async function boardStats(cnt=30){
  cnt=clamp(parseInt(cnt)||30,10,80);
  const [iu,id,cu,cd]=await Promise.all([
    boards("01","0",cnt),boards("01","1",cnt),boards("02","0",cnt),boards("02","1",cnt)
  ]);
  const pack=(type,up,down)=>{
    const map=new Map();
    for(const x of [...up,...down]){
      if(!map.has(x.code))map.set(x.code,{...x,type,direction:x.pct>=0?"up":"down"});
    }
    return [...map.values()];
  };
  const all=[...pack("行业",iu,id),...pack("概念",cu,cd)];
  const upCount=all.filter(x=>x.pct>0).length;
  const downCount=all.filter(x=>x.pct<0).length;
  const flatCount=all.length-upCount-downCount;
  const avg=all.length?all.reduce((a,b)=>a+n(b.pct),0)/all.length:0;
  return {
    summary:{total:all.length,up:upCount,down:downCount,flat:flatCount,avgPct:+avg.toFixed(2)},
    strongest:[...all].sort((a,b)=>b.pct-a.pct).slice(0,15),
    weakest:[...all].sort((a,b)=>a.pct-b.pct).slice(0,15)
  };
}
const FULL_A_FS="m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048";
async function marketSnapshot(limit=6000){
  limit=clamp(parseInt(limit)||6000,100,6000);
  const fields="f12,f14,f2,f3,f4,f5,f6,f8,f15,f16,f17,f18,f20,f21,f22";
  const u=`https://push2delay.eastmoney.com/api/qt/clist/get?fid=f6&po=1&pz=${limit}&pn=1&np=1&fltt=2&invt=2&fs=${encodeURIComponent(FULL_A_FS)}&fields=${fields}`;
  const j=await jget(u,{referer:EM_REF,timeout:15000});
  return (j?.data?.diff||[]).map(x=>({
    code:x.f12,name:x.f14,symbol:marketCode(x.f12),price:n(x.f2),pct:n(x.f3),
    change:n(x.f4),vol:n(x.f5),amount:n(x.f6),turnover:n(x.f8),
    high:n(x.f15),low:n(x.f16),open:n(x.f17),prev:n(x.f18),
    totalMv:n(x.f20),circMv:n(x.f21),speed:n(x.f22)
  })).filter(x=>x.price>0&&x.name);
}
function limitPctByCode(code,name=""){
  code=String(code||"").replace(/^(sh|sz|bj)/,"");
  const nm=String(name||"").toUpperCase();
  if(nm.includes("ST"))return 5;
  if(/^(300|301|688|689)/.test(code))return 20;
  if(/^(4|8|92)/.test(code))return 30;
  return 10;
}
function isLimitLike(x, tolerance=.35){
  const lp=limitPctByCode(x.code,x.name);
  return n(x.pct)>=lp-tolerance;
}
async function marketSentiment(){
  const rows=await marketSnapshot();
  const tradable=rows.filter(x=>Number.isFinite(x.pct));
  const up=tradable.filter(x=>x.pct>0).length,down=tradable.filter(x=>x.pct<0).length;
  const flat=tradable.length-up-down;
  const limitUp=tradable.filter(x=>isLimitLike(x)).length;
  const limitDown=tradable.filter(x=>x.pct<=-limitPctByCode(x.code,x.name)+.35).length;
  const nearLimit=tradable.filter(x=>{const lp=limitPctByCode(x.code,x.name);return x.pct>lp-3&&x.pct<lp-.35}).length;
  const highTurn=tradable.filter(x=>x.turnover>=10).length;
  const avgPct=tradable.length?tradable.reduce((a,b)=>a+b.pct,0)/tradable.length:0;
  const redRate=tradable.length?up/tradable.length*100:0;
  const score=clamp(50+(redRate-50)*.8+limitUp*.18-limitDown*.35+avgPct*4,0,100);
  return {
    total:tradable.length,up,down,flat,limitUp,limitDown,nearLimit,highTurn,
    avgPct:+avgPct.toFixed(2),redRate:+redRate.toFixed(1),score:+score.toFixed(0),
    hottest:[...tradable].sort((a,b)=>b.pct-a.pct).slice(0,12),
    weakest:[...tradable].sort((a,b)=>a.pct-b.pct).slice(0,12)
  };
}
function secidFor(code){
  code=String(code||"");
  if(/^(60|68|90)/.test(code))return "1."+code;
  return "0."+code;
}
async function stockDailyPct(code,days=8){
  const u=`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secidFor(code)}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&beg=0&end=20500101&lmt=${days}`;
  const j=await jget(u,{referer:EM_REF,timeout:10000});
  return (j?.data?.klines||[]).map(x=>{const f=x.split(",");return {date:f[0],open:n(f[1]),close:n(f[2]),high:n(f[3]),low:n(f[4]),pct:n(f[8])}});
}
async function limitLadder(){
  const rows=(await marketSnapshot()).filter(x=>isLimitLike(x,.45)).sort((a,b)=>b.amount-a.amount).slice(0,36);
  const out=[];
  for(let i=0;i<rows.length;i+=6){
    const rs=await Promise.all(rows.slice(i,i+6).map(async x=>{
      let streak=1;
      try{
        const d=await stockDailyPct(x.code,8);
        streak=0;
        for(let k=d.length-1;k>=0;k--){
          const lp=limitPctByCode(x.code,x.name);
          if(d[k].pct>=lp-.45)streak++; else break;
        }
        if(streak<1)streak=1;
      }catch{}
      return {...x,streak};
    }));
    out.push(...rs);
  }
  const groups={};
  for(const x of out){
    const k=String(Math.min(x.streak,6));
    (groups[k]||(groups[k]=[])).push(x);
  }
  return {max:Math.max(0,...out.map(x=>x.streak)),groups,all:out.sort((a,b)=>b.streak-a.streak||b.amount-a.amount)};
}
async function boardFlowSnapshot(cnt=60){
  cnt=clamp(parseInt(cnt)||60,20,100);
  const u=`https://push2delay.eastmoney.com/api/qt/clist/get?fid=f62&po=1&pz=${cnt}&pn=1&np=1&fltt=2&invt=2&fs=${encodeURIComponent("m:90+t:2")}&fields=f12,f14,f3,f6,f62,f184`;
  const j=await jget(u,{referer:EM_REF});
  return (j?.data?.diff||[]).map(x=>({code:x.f12,name:x.f14,pct:n(x.f3),amount:n(x.f6),netIn:n(x.f62),netRatio:n(x.f184)}));
}
async function boardQuadrant(){
  const a=await boardFlowSnapshot(80);
  const maxAbs=Math.max(1,...a.map(x=>Math.abs(x.netIn)));
  return a.map(x=>({...x,x:+x.pct.toFixed(2),y:+(x.netIn/1e8).toFixed(2),size:+(Math.sqrt(Math.max(x.amount,0))/1e4).toFixed(2),norm:+(Math.abs(x.netIn)/maxAbs).toFixed(3)}));
}
async function boardHeatmap(){
  const [b,f]=await Promise.all([boards("01","0",60),boardFlowSnapshot(80)]);
  const fm=new Map(f.map(x=>[x.name,x]));
  return b.map(x=>({...x,amount:fm.get(x.name)?.amount||0,netIn:fm.get(x.name)?.netIn||0})).sort((a,b)=>b.amount-a.amount);
}
async function anomalyRadar(){
  const rows=await marketSnapshot();
  const fastUp=rows.filter(x=>x.speed>=1.5&&x.pct>0).sort((a,b)=>b.speed-a.speed).slice(0,12);
  const fastDown=rows.filter(x=>x.speed<=-1.5&&x.pct<0).sort((a,b)=>a.speed-b.speed).slice(0,12);
  const volume=rows.filter(x=>x.amount>=5e8&&x.turnover>=5).sort((a,b)=>b.amount-a.amount).slice(0,12);
  const nearLimit=rows.filter(x=>{const lp=limitPctByCode(x.code,x.name);return x.pct>=lp-2.5&&x.pct<lp-.35}).sort((a,b)=>b.pct-a.pct).slice(0,12);
  const limit=rows.filter(x=>isLimitLike(x)).sort((a,b)=>b.amount-a.amount).slice(0,12);
  return {time:new Date().toISOString(),fastUp,fastDown,volume,nearLimit,limit};
}
const US_GROUPS={
  tech:["usAAPL","usMSFT","usGOOGL","usMETA","usAMZN","usNFLX","usTSLA","usORCL","usCRM","usADBE"],
  semi:["usNVDA","usAMD","usAVGO","usINTC","usMU","usQCOM","usAMAT","usLRCX","usTSM","usASML"],
  ai:["usNVDA","usMSFT","usGOOGL","usMETA","usAMD","usPLTR","usORCL","usCRM","usNOW","usSNOW"],
  china:["usBABA","usJD","usPDD","usBIDU","usNTES","usBILI","usNIO","usXPEV","usLI","usTME"],
  finance:["usJPM","usBAC","usWFC","usC","usGS","usMS","usV","usMA","usAXP","usSCHW"],
  energy:["usXOM","usCVX","usCOP","usSLB","usEOG","usOXY","usMPC","usVLO","usPSX","usHAL"],
  health:["usLLY","usUNH","usJNJ","usABBV","usMRK","usPFE","usTMO","usABT","usAMGN","usGILD"],
  consumer:["usWMT","usCOST","usHD","usMCD","usNKE","usSBUX","usTGT","usLOW","usBKNG","usCMG"],
  software:["usORCL","usCRM","usADBE","usNOW","usINTU","usPANW","usCRWD","usDDOG","usMDB","usTEAM"],
  cloud:["usAMZN","usMSFT","usGOOGL","usORCL","usSNOW","usNET","usDDOG","usMDB","usNOW","usCRWD"],
  cyber:["usPANW","usCRWD","usFTNT","usZS","usOKTA","usCYBR","usTENB","usVRNS","usRPD","usS"],
  ev:["usTSLA","usRIVN","usLCID","usNIO","usXPEV","usLI","usGM","usF","usALB","usCHPT"]
};
async function usMarket(group="tech"){
  group=US_GROUPS[group]?group:"tech";
  const codes=US_GROUPS[group];
  const indices=["usDJI","usIXIC","usINX","usVIX"];
  const q=await quotes([...indices,...codes].join(","));
  const stocks=codes.map(c=>q[c]||{symbol:c,name:c,price:0,pct:0,change:0,amount:0,turnover:0,prev:0,open:0,high:0,low:0}).filter(x=>x.price>0);
  return {
    group,
    indices:Object.fromEntries(indices.map(c=>[c,q[c]||null])),
    stocks,
    gainers:[...stocks].sort((a,b)=>b.pct-a.pct).slice(0,15),
    losers:[...stocks].sort((a,b)=>a.pct-b.pct).slice(0,15),
    active:[...stocks].sort((a,b)=>(b.amount||b.vol||0)-(a.amount||a.vol||0)).slice(0,15)
  };
}
async function usMarketMinutes(group="tech"){
  group=US_GROUPS[group]?group:"tech";
  const codes=US_GROUPS[group];
  return batchMinutes(codes.join(","));
}
const EM_FS="m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048";
async function moneyFlow(cnt=15){
  cnt=clamp(parseInt(cnt)||15,1,60);
  const f="f12,f14,f2,f3,f62,f184,f66,f6,f8";
  const u=`https://push2delay.eastmoney.com/api/qt/clist/get?fid=f62&po=1&pz=${cnt}&pn=1&np=1&fltt=2&invt=2&fs=${encodeURIComponent(EM_FS)}&fields=${f}`;
  try{
    const j=await jget(u,{referer:EM_REF});
    return (j?.data?.diff||[]).filter(s=>s.f14&&n(s.f2)>0).map(s=>({
      symbol:marketCode(s.f12),name:s.f14,price:n(s.f2),pct:n(s.f3),amount:n(s.f6),
      netIn:n(s.f62),netRatio:n(s.f184),r0Net:n(s.f66),turnover:n(s.f8)
    }));
  }catch{
    const u2=`https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_ssggzj?page=1&num=${cnt}&sort=netamount&asc=0`;
    const a=await jget(u2,{referer:"https://finance.sina.com.cn/"});
    return (Array.isArray(a)?a:[]).filter(s=>String(s.name||"").trim()).map(s=>({
      symbol:s.symbol,name:s.name,price:n(s.trade),pct:+(n(s.changeratio)*100).toFixed(2),
      amount:n(s.amount),netIn:n(s.netamount),netRatio:+(n(s.ratioamount)*100).toFixed(2),
      r0Net:n(s.r0_net),turnover:n(s.turnover)
    }));
  }
}
async function boardMoneyFlow(code,cnt=15){
  if(!/^BK\d{4}$/.test(code)) return [];
  cnt=clamp(parseInt(cnt)||15,1,100);
  const f="f12,f14,f2,f3,f62,f184,f66,f6,f8";
  const u=`https://push2delay.eastmoney.com/api/qt/clist/get?fid=f62&po=1&pz=${Math.max(cnt*3,50)}&pn=1&np=1&fltt=2&invt=2&fs=${encodeURIComponent("b:"+code)}&fields=${f}`;
  const j=await jget(u,{referer:EM_REF});
  return (j?.data?.diff||[]).filter(s=>s.f14&&n(s.f2)>0).slice(0,cnt).map(s=>({
    symbol:marketCode(s.f12),name:s.f14,price:n(s.f2),pct:n(s.f3),amount:n(s.f6),
    netIn:n(s.f62),netRatio:n(s.f184),r0Net:n(s.f66),turnover:n(s.f8)
  }));
}
async function boardFlow(cnt=20){
  const half=clamp(Math.floor((parseInt(cnt)||20)/2),3,15);
  const pick=async po=>{
    const u=`https://push2delay.eastmoney.com/api/qt/clist/get?fid=f62&po=${po}&pz=${half}&pn=1&np=1&fltt=2&invt=2&fs=${encodeURIComponent("m:90+t:2")}&fields=f12,f14,f62`;
    const j=await jget(u,{referer:EM_REF});
    return (j?.data?.diff||[]).map(b=>({code:b.f12,name:b.f14,netIn:n(b.f62)}));
  };
  const [up,dn]=await Promise.all([pick(1),pick(0)]);
  const all=[...up,...dn.filter(d=>!up.some(u=>u.code===d.code))];
  const out=[];
  // Limit simultaneous upstream pressure.
  for(let i=0;i<all.length;i+=5){
    const batch=all.slice(i,i+5);
    const rs=await Promise.all(batch.map(async b=>{
      try{
        const u=`https://push2delay.eastmoney.com/api/qt/stock/fflow/kline/get?secid=90.${b.code}&klt=1&lmt=0&fields1=f1,f2,f3,f7&fields2=f51,f52`;
        const j=await jget(u,{referer:EM_REF});
        return {...b,points:(j?.data?.klines||[]).map(s=>{const f=s.split(",");return {t:f[0].slice(11,16),v:n(f[1])}})};
      }catch{return {...b,points:[]}}
    }));
    out.push(...rs);
  }
  return out;
}

/* ---------------- Futures / commodities ---------------- */

function parseFutures(s){
  const out={}, re=/(?:hq_str_|v_)(\w+)="([^"]*)"/g; let m;
  while((m=re.exec(s))){
    const f=m[2].split(","); if(f.length<14||!f[0])continue;
    const price=n(f[0]),prev=n(f[7]);
    out[m[1]]={symbol:m[1],name:f[13],price,high:n(f[4]),low:n(f[5]),open:n(f[8]),prev,
      change:chg(price,prev),pct:pchg(price,prev),time:`${f[12]||""} ${f[6]||""}`.trim()};
  } return out;
}
function parseNF(s){
  const out={},re=/hq_str_(nf_\w+)="([^"]*)"/g;let m;
  while((m=re.exec(s))){
    const f=m[2].split(","); if(f.length<17||!f[0])continue;
    const prev=n(f[10])||n(f[5]);let price=n(f[8]);
    if(!price){const b=n(f[6]),a=n(f[7]);price=b&&a?(b+a)/2:(b||a||prev)}
    out[m[1]]={symbol:m[1],name:f[0],price,high:n(f[3]),low:n(f[4]),open:n(f[2]),
      prev:prev||price,change:chg(price,prev||price),pct:pchg(price,prev||price),time:f[16]};
  }return out;
}
async function futures(list){
  const a=String(list||"hf_GC,hf_SI,hf_HG,hf_CL,hf_CAD,hf_VX,nf_AU0,BTCUSDT").split(",")
    .map(x=>x.trim()).filter(x=>/^(hf|nf)_[A-Za-z0-9]{1,12}$/.test(x)||x==="BTCUSDT").slice(0,60);
  const hf=a.filter(x=>x.startsWith("hf_")), nf=a.filter(x=>x.startsWith("nf_")),out={};
  if(hf.length){
    try{Object.assign(out,parseFutures(await text("https://qt.gtimg.cn/q="+encodeURIComponent(hf.join(",")),{gbk:true})))}
    catch{try{Object.assign(out,parseFutures(await text("https://hq.sinajs.cn/list="+hf.join(","),{gbk:true,referer:"https://finance.sina.com.cn/futures/"})))}catch{}}
  }
  if(nf.length){
    try{Object.assign(out,parseNF(await text("https://hq.sinajs.cn/list="+nf.join(","),{gbk:true,referer:"https://finance.sina.com.cn/futures/"})))}catch{}
  }
  if(a.includes("BTCUSDT")){
    try{
      const q=await jget("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT");
      out.BTCUSDT={symbol:"BTCUSDT",name:"BTC/USDT",price:n(q.lastPrice),prev:n(q.prevClosePrice),
        open:n(q.openPrice),high:n(q.highPrice),low:n(q.lowPrice),change:n(q.priceChange),pct:n(q.priceChangePercent),time:""};
    }catch{}
  }
  return out;
}

function parseJsonpPayload(raw){
  const a=raw.indexOf("("),b=raw.lastIndexOf(")");
  if(a<0||b<=a)throw new Error("bad jsonp");
  return JSON.parse(raw.slice(a+1,b));
}
async function futureMinute(code){
  code=String(code||"").trim();
  if(code==="BTCUSDT"){
    const [kl,ticker]=await Promise.all([
      jget("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=240"),
      jget("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT")
    ]);
    return {code,prec:n(ticker.prevClosePrice),points:(kl||[]).map(k=>({
      t:new Date(k[0]).toISOString().slice(11,16).replace(":",""),p:n(k[4])
    })).filter(x=>x.p>0)};
  }
  if(code.startsWith("hf_")){
    const symbol=code.slice(3);
    const u=`https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/GlobalFuturesService.getGlobalFuturesMinLine?symbol=${encodeURIComponent(symbol)}`;
    const raw=await text(u,{referer:`https://finance.sina.com.cn/futures/quotes/${symbol}.shtml`,timeout:10000});
    const arr=parseJsonpPayload(raw)?.minLine_1d||[];
    let prev=0;
    try{prev=(await futures(code))[code]?.prev||0}catch{}
    return {code,prec:prev,points:arr.filter(f=>String(f[0]||"").includes(":")).map(f=>({t:String(f[0]).replace(":",""),p:n(f[1])})).filter(x=>x.p>0)};
  }
  if(code.startsWith("nf_")){
    const symbol=code.slice(3);
    const u=`https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/InnerFuturesNewService.getMinLine?symbol=${encodeURIComponent(symbol)}`;
    const raw=await text(u,{referer:`https://finance.sina.com.cn/futures/quotes/${symbol}.shtml`,timeout:10000});
    const arr=parseJsonpPayload(raw)||[];
    let prev=0;
    try{prev=(await futures(code))[code]?.prev||0}catch{}
    return {code,prec:prev,points:arr.map(f=>({t:String(f[0]||"").replace(":",""),p:n(f[1])})).filter(x=>x.p>0)};
  }
  throw Object.assign(new Error("bad futures code"),{status:400});
}
async function futureMinutes(codes){
  const list=[...new Set(String(codes||"").split(",").map(x=>x.trim()).filter(x=>/^(hf|nf)_[A-Za-z0-9]{1,12}$/.test(x)||x==="BTCUSDT"))].slice(0,16);
  const out={};
  for(let i=0;i<list.length;i+=4){
    const rs=await Promise.all(list.slice(i,i+4).map(async c=>{
      try{return [c,await futureMinute(c)]}catch{return [c,{code:c,prec:0,points:[],degraded:true}]}
    }));
    for(const [c,v] of rs)out[c]=v;
  }
  return out;
}

/* ---------------- News & search ---------------- */

async function news(size=50){
  size=clamp(parseInt(size)||50,1,50);
  try{
    const u=`https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=${size}&zhibo_id=152&tag_id=0`;
    const j=await jget(u,{referer:"https://finance.sina.com.cn/"});
    const a=j?.result?.data?.feed?.list||[];
    if(a.length)return a.map(it=>{
      const raw=it.rich_text||"",m=raw.match(/^【(.+?)】([\s\S]*)$/);
      return {id:it.id,title:m?m[1]:"",content:m?m[2]:raw,time:it.create_time}
    });
  }catch{}
  const j=await jget(`https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=global-channel&limit=${size}`);
  return (j?.data?.items||[]).filter(x=>x.content_text||x.content).map((x,i)=>({
    id:x.id||`${x.display_time}-${i}`,title:x.title||"",
    content:String(x.content_text||x.content||"").replace(/<[^>]+>/g,""),
    time:x.display_time?new Date(x.display_time*1000).toLocaleString("zh-CN",{hour12:false}):""
  }));
}
async function stockSearch(q){
  q=String(q||"").trim().slice(0,40); if(!q)return [];
  const out=[];
  try{
    const s=await text(`https://suggest3.sinajs.cn/suggest/type=&key=${encodeURIComponent(q)}`,{gbk:true});
    const m=s.match(/suggestvalue="([^"]+)"/);
    if(m)for(const p of m[1].split(";")){
      const f=p.split(","); if(f.length>=4&&/^(sh|sz|bj)\d{6}$/.test(f[3]))
        out.push({code:f[3],name:f[0],pinyin:f[4]||""});
    }
  }catch{}
  try{
    const u=`https://searchadapter.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=8`;
    const j=await jget(u,{referer:"https://www.eastmoney.com/"});
    for(const d of (j?.QuotationCodeTable?.Data||[])){
      if(!/^\d{6}$/.test(d.Code||""))continue;
      const c=d.Classify==="NEEQ"?"bj"+d.Code:marketCode(d.Code);
      if(!out.some(x=>x.code===c))out.push({code:c,name:d.Name||"",pinyin:d.PinYin||""});
    }
  }catch{}
  return out.slice(0,10);
}

/* ---------------- Treasury ---------------- */

const TSYM=["US3M","US6M","US1Y","US2Y","US3Y","US5Y","US7Y","US10Y","US20Y","US30Y"];
async function treasury(){
  const u=`https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${TSYM.join("|")}&requestMethod=quick&noform=1&partnerId=2&fund=1&output=json`;
  const j=await jget(u);
  return (j?.FormattedQuoteResult?.FormattedQuote||[]).filter(q=>q.code===0&&q.last).map(q=>({
    symbol:q.symbol,name:q.shortName||q.name,yield:n(String(q.last).replace("%","")),
    change:n(q.change),time:q.last_time
  }));
}
function csvLine(line){
  // Treasury CSV is simple but quoted; this handles commas inside quotes.
  const out=[];let cur="",quote=false;
  for(const c of line){
    if(c==='"')quote=!quote;
    else if(c===","&&!quote){out.push(cur);cur=""}else cur+=c;
  }out.push(cur);return out;
}
async function treasuryHistory(){
  const year=new Date().getFullYear();
  const u=`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&_format=csv`;
  const s=await text(u,{timeout:20000});
  const lines=s.trim().split(/\r?\n/), head=csvLine(lines[0]).map(x=>x.replaceAll('"',""));
  const names={"US3M":"3 Mo","US6M":"6 Mo","US1Y":"1 Yr","US2Y":"2 Yr","US3Y":"3 Yr","US5Y":"5 Yr","US7Y":"7 Yr","US10Y":"10 Yr","US20Y":"20 Yr","US30Y":"30 Yr"};
  const idx=Object.fromEntries(TSYM.map(k=>[k,head.indexOf(names[k])]));
  const by=new Map();
  for(const line of lines.slice(1)){
    const f=csvLine(line),m=(f[0]||"").match(/(\d{2})\/(\d{2})\/(\d{4})/);if(!m)continue;
    const key=`${m[3]}-${m[1]}`;if(by.has(key))continue;
    const y={};for(const k of TSYM){if(idx[k]>=0)y[k]=n(f[idx[k]])}
    by.set(key,{date:`${m[3]}-${m[1]}-${m[2]}`,yields:y});
  }
  return [...by.values()].sort((a,b)=>a.date.localeCompare(b.date));
}
async function treasuryDaily(days=120){
  days=clamp(parseInt(days)||120,20,260);
  const year=new Date().getFullYear();
  const u=`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&_format=csv`;
  const raw=await text(u,{timeout:20000});
  const lines=raw.trim().split(/\r?\n/), head=csvLine(lines[0]).map(x=>x.replaceAll('"',""));
  const names={"US3M":"3 Mo","US6M":"6 Mo","US1Y":"1 Yr","US2Y":"2 Yr","US3Y":"3 Yr","US5Y":"5 Yr","US7Y":"7 Yr","US10Y":"10 Yr","US20Y":"20 Yr","US30Y":"30 Yr"};
  const idx=Object.fromEntries(TSYM.map(k=>[k,head.indexOf(names[k])]));
  const out=[];
  for(const line of lines.slice(1)){
    const f=csvLine(line), mm=(f[0]||"").match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if(!mm)continue;
    const yields={};
    for(const k of TSYM){
      const ii=idx[k];
      if(ii>=0){
        const v=n(f[ii]);
        if(v>0)yields[k]=v;
      }
    }
    out.push({date:`${mm[3]}-${mm[1]}-${mm[2]}`,yields});
  }
  out.sort((a,b)=>a.date.localeCompare(b.date));
  return out.slice(-days);
}

/* ---------------- Stock metadata / finance summary ---------------- */

async function stockBoards(code){
  const m=String(code||"").toLowerCase().match(/^(sh|sz|bj)(\d{6})$/);
  if(!m) return {code,industry:"",area:"",concepts:[]};
  const market=m[1]==="sh"?1:0;
  const u=`https://push2delay.eastmoney.com/api/qt/stock/get?secid=${market}.${m[2]}&fields=f57,f58,f127,f128,f129`;
  const j=await jget(u,{referer:EM_REF}),d=j?.data||{};
  return {code,industry:d.f127||"",area:d.f128||"",concepts:String(d.f129||"").split(",").filter(Boolean)};
}
function financeSecuCode(raw){
  const m=String(raw||"").trim().toLowerCase().match(/^(sh|sz|bj|nq)?(\d{6})$/);
  if(!m)return null;
  const prefix=m[1],c=m[2];
  let ex;
  if(prefix)ex=prefix.toUpperCase();
  else if(/^(60|68|90)/.test(c))ex="SH";
  else if(/^(00|20|30)/.test(c))ex="SZ";
  else if(/^8/.test(c))ex="NQ";
  else if(/^(4|9)/.test(c))ex="BJ";
  else ex="SZ";
  return `${c}.${ex}`;
}
async function financeMain(code){
  const secu=financeSecuCode(code);
  if(!secu)throw Object.assign(new Error("股票代码格式错误"),{status:400});
  const base="https://datacenter.eastmoney.com/securities/api/data/v1/get";
  const finUrl=base+
    `?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=ALL`+
    `&filter=${encodeURIComponent(`(SECUCODE="${secu}")`)}`+
    `&pageNumber=1&pageSize=12&sortTypes=-1&sortColumns=REPORT_DATE&source=HSF10&client=PC`;
  const orgUrl=base+
    `?reportName=RPT_F10_ORG_BASICINFO&columns=ALL`+
    `&filter=${encodeURIComponent(`(SECUCODE="${secu}")`)}`+
    `&pageNumber=1&pageSize=1&source=HSF10&client=PC`;

  const emData=async url=>{
    const j=await jget(url,{referer:"https://data.eastmoney.com/"});
    return j?.result?.data||[];
  };

  const [rows,orgRows]=await Promise.all([emData(finUrl),emData(orgUrl).catch(()=>[])]);
  if(!rows.length)throw Object.assign(new Error("未获取到财报数据"),{status:404});
  const org=orgRows[0]||{};
  const industry=org.BOARD_NAME_2LEVEL||org.BOARD_NAME_1LEVEL||org.BOARD_NAME_3LEVEL||org.CSRC_INDUSTRY_NAME||"";

  return {
    code,
    name:rows[0]?.SECURITY_NAME_ABBR||"",
    industry,
    reports:rows.map(r=>({
      label:r.REPORT_DATE_NAME||"",
      date:String(r.REPORT_DATE||"").slice(0,10),
      revenue:n(r.TOTALOPERATEREVE),
      netProfit:n(r.PARENTNETPROFIT),
      revenueYoY:n(r.TOTALOPERATEREVETZ),
      profitYoY:n(r.PARENTNETPROFITTZ),
      roe:n(r.ROEJQ),
      grossMargin:n(r.XSMLL),
      netMargin:n(r.XSJLL),
      debtRatio:n(r.ZCFZL),
      roic:n(r.ROIC),
      eps:n(r.EPSJB),
      ocfPerShare:n(r.MGJYXJJE)
    }))
  };
}

/* ---------------- Application HTML ---------------- */

const APP = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>股市市场研究驾驶舱</title>
<style>
:root{--bg:#07101d;--p:#0a1423;--p2:#0d192a;--line:#1b2a3f;--mut:#667a94;--txt:#d9e7f7;--cyan:#29d4ff;--green:#43d6ae;--red:#ff6687;--amber:#ffca4b;--purple:#ad8cff}
*{box-sizing:border-box}html,body{margin:0;background:#050b14;color:var(--txt);font:12px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;height:100%}
body{min-width:1100px}.app{max-width:1760px;margin:auto;background:var(--bg);min-height:100vh}
header{height:54px;border-bottom:1px solid var(--line);display:flex;align-items:center;padding:0 14px;gap:14px;background:#081221;position:sticky;top:0;z-index:20}
.logo{font-size:16px;font-weight:800;white-space:nowrap}.logo small{font-size:8px;color:#39708a;letter-spacing:2px;margin-left:7px}
.nav{color:#5f7187;flex:1}.btn{background:#0c1728;border:1px solid #1b2b42;border-radius:4px;color:#8195ad;padding:5px 9px;cursor:pointer}.btn.active,.btn:hover{color:#dceaff;border-color:#30506c}.live{color:var(--green)}.clock{font-size:14px;color:#85e6ff;font-weight:700}
.tape{display:grid;grid-template-columns:repeat(7,1fr);height:34px;border-bottom:1px solid var(--line);padding:3px 12px;gap:16px}.tick{border:1px solid #17263a;border-radius:3px;display:flex;align-items:center;justify-content:space-around;color:#8293a9}
.grid{display:grid;grid-template-columns:.94fr 1.72fr 1.04fr;grid-template-rows:220px 300px 270px;grid-auto-rows:minmax(300px,auto);gap:5px;padding:5px}
.panel{border:1px solid #172a42;border-radius:6px;background:#071220;overflow:hidden;min-width:0}.ph{height:29px;border-bottom:1px solid #17263b;display:flex;align-items:center;padding:0 8px;gap:7px;font-weight:700}.ph:before{content:"";width:3px;height:14px;border-radius:2px;background:var(--cyan)}.pink .ph:before{background:var(--red)}.yellow .ph:before{background:var(--amber)}.green .ph:before{background:var(--green)}.purple .ph:before{background:var(--purple)}
.ph .grow{flex:1}.mini{font-size:9px;color:#53687f}.tabs{display:flex;align-items:center;gap:1px;white-space:nowrap}.tabs button{font:inherit;border:0;background:transparent;color:#64778d;padding:3px 5px;cursor:pointer}.tabs button.on{color:#54d9fb;background:#102438;border-radius:3px}
.scroll{height:calc(100% - 29px);overflow:auto;scrollbar-width:thin}.rows{padding:2px 7px}.row{height:26px;border-bottom:1px solid #101e30;display:flex;align-items:center;gap:7px}.row:last-child{border:0}.nm{width:68px;color:#aebdd0}.code{font-size:9px;color:#53657b}.val{margin-left:auto}.up{color:var(--red)}.dn{color:var(--green)}.mut{color:var(--mut)}.spark{width:115px;height:22px;flex:1;min-width:55px;overflow:visible}.trend{display:block;width:100%;height:30px;min-width:75px}.trend .base{stroke-dasharray:4 3;opacity:.75}.trend .area{opacity:.22}.trend .line{fill:none;stroke-width:1.35;vector-effect:non-scaling-stroke;stroke-linecap:round;stroke-linejoin:round}.bar{height:4px;background:#162439;border-radius:4px;overflow:hidden;min-width:70px}.bar i{display:block;height:100%;background:var(--red)}.bar.neg i{background:var(--green)}
.indices{padding:2px 8px}.indices .row{height:25px}.indices .nm{width:72px}.indices .spark{width:auto}
.sectorTools{display:flex;align-items:center;gap:4px}.sectorSearch{width:94px;height:22px;background:#091526;border:1px solid #1c3048;border-radius:3px;color:#b9cada;padding:0 7px;font:inherit}.sectorSearch:focus{outline:none;border-color:#315d7d}.tinybtn{height:22px;border:1px solid #1c3048;background:#0a1728;color:#687d95;border-radius:3px;padding:0 6px;font:inherit;cursor:pointer}.tinybtn.on,.tinybtn:hover{color:#69ddfa;border-color:#35617f;background:#0d2033}.sector{display:grid;grid-template-columns:1.18fr 1.22fr;height:calc(100% - 29px);min-width:0}.sectorList{border-right:1px solid #17263b;overflow:auto}.sectorHead{height:22px;display:grid;grid-template-columns:62px minmax(110px,1fr) 58px minmax(88px,.95fr) 56px;align-items:center;padding:0 7px;color:#50647c;font-size:9px;border-bottom:1px solid #16263a}.sectorRow{height:28px;display:grid;grid-template-columns:62px minmax(110px,1fr) 58px minmax(88px,.95fr) 56px;align-items:center;padding:0 7px;border-bottom:1px solid #101e30;cursor:pointer}.sectorRow:hover,.sectorRow.sel{background:#0d1d30}.sectorRow.sel{box-shadow:inset 2px 0 #28d4ff}.sectorRow>*{min-width:0}.sectorRow .sname{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#bccbdb}.sectorRow .lead{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#7f91a7;font-size:10px}.pctbar{height:4px;background:#162439;border-radius:4px;overflow:hidden;margin-right:6px}.pctbar i{display:block;height:100%;background:#ff6687}.pctbar.neg i{background:#43d6ae}.sectorDetail{padding:7px;overflow:auto}.sectorTitle{display:flex;align-items:flex-end;gap:8px;margin-bottom:4px}.sectorTitle h3{font-size:12px;color:#63d8f4;margin:0}.sectorMeta{font-size:9px;color:#52677e}.stockline{display:grid;grid-template-columns:72px minmax(76px,1fr) 52px 46px;gap:4px;align-items:center;height:38px;border-bottom:1px solid #112238}.stockline .spark{height:30px;width:100%}.stocksub{font-size:8px;color:#50657b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.news article{padding:9px;border-bottom:1px solid #132236;line-height:1.5}.news time{display:block;color:#586b83;font-size:10px;margin-bottom:3px}.news b{font-size:11px;color:#cbd8e8}.flowWrap{height:calc(100% - 29px);display:flex}.flowChart{flex:1;position:relative;padding:8px}.legend{width:120px;padding:10px 4px;overflow:hidden}.legend div{font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bigchart{width:100%;height:100%}
.rankgrid{display:grid;grid-template-columns:1fr 1fr;height:calc(100% - 29px)}.rankgrid>div:first-child{border-right:1px solid #17263b}
.rankitem{display:grid;grid-template-columns:72px 1fr 56px;align-items:center;height:51px;padding:2px 8px;border-bottom:1px solid #132236}.rankitem .spark{height:27px}.rankitem strong{font-size:11px}
.comrows .row{height:39px}.treasury{padding:7px;height:calc(100% - 29px);overflow-y:auto;scrollbar-width:thin}.tstat{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.tbox{border:1px solid #17283d;padding:8px;border-radius:4px}.tbox b{font-size:15px;color:#c7dcff}.curve{height:150px;margin-top:5px}
.watch{grid-column:1}.watchList{height:210px;overflow:auto}.watchRow{display:grid;grid-template-columns:100px minmax(105px,1fr) 78px 34px;column-gap:7px;align-items:center;height:42px;padding:2px 7px;border-bottom:1px solid #102035}.watchRow>*{min-width:0}.watchQuote{text-align:right;white-space:nowrap}.watchQuote .price{font-weight:700;color:#d7e5f4}.watchRemove{width:30px;height:28px;padding:0;font-size:15px}.chain{grid-column:2/4}
.industryPanel{grid-column:3}.radarPanel{grid-column:1/4;min-height:300px}.decisionPanel{grid-column:1/4;min-height:340px}.usPanel{grid-column:1/4;height:420px;min-height:420px;max-height:420px}.usBody{height:calc(100% - 29px);min-height:0;overflow:hidden}.usTop{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:7px;border-bottom:1px solid #17283d}.usIndex{border:1px solid #1a3048;border-radius:5px;padding:8px;background:#091626}.usIndex b{font-size:17px}.usMain{display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr;height:calc(100% - 82px);min-height:0;overflow:hidden}.usCol{overflow-y:auto;overflow-x:hidden;min-height:0;border-right:1px solid #17283d}.usCol:last-child{border:0}.usTitle{position:sticky;top:0;background:#081423;padding:7px 9px;border-bottom:1px solid #17283d;font-weight:700;z-index:2}.usStock{display:grid;grid-template-columns:86px minmax(110px,1fr) 72px 66px;gap:6px;align-items:center;height:31px;padding:1px 8px;border-bottom:1px solid #112238}.usStock>*{min-width:0}.usStock .trend{height:22px}.usRank{display:grid;grid-template-columns:28px 1fr 68px;gap:5px;align-items:center;height:31px;padding:0 8px;border-bottom:1px solid #112238}.usRank span:nth-child(2){white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.usTabs{max-width:74%;overflow-x:auto;scrollbar-width:thin;white-space:nowrap}.usTabs button{padding:3px 7px;flex:0 0 auto}.usLoading{padding:18px;text-align:center;color:#5f7892}.usGroupLabel{color:#72d9f2;font-size:10px;margin-left:6px}.decisionBody{height:calc(100% - 29px);overflow:auto}.sentGrid{display:grid;grid-template-columns:260px 1fr 1fr;height:100%}.sentGauge{padding:14px;border-right:1px solid #17283d}.gaugeCircle{width:150px;height:150px;border-radius:50%;margin:10px auto;display:grid;place-items:center;background:conic-gradient(#43d6ae var(--v),#172438 0);position:relative}.gaugeCircle:after{content:"";position:absolute;width:112px;height:112px;border-radius:50%;background:#071220}.gaugeCircle b,.gaugeCircle span{position:relative;z-index:1}.gaugeCircle b{font-size:31px}.gaugeCircle span{font-size:10px;color:#60758d}.sentNums{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}.sentList{overflow:auto;border-right:1px solid #17283d}.sentTitle{position:sticky;top:0;background:#081423;padding:7px 9px;border-bottom:1px solid #17283d;font-weight:700;z-index:2}.miniRank{display:grid;grid-template-columns:34px 1fr 75px 70px;gap:5px;height:29px;align-items:center;padding:0 8px;border-bottom:1px solid #112238}.ladder{display:flex;gap:8px;height:100%;padding:9px;overflow-x:auto}.ladderCol{min-width:190px;flex:1;border:1px solid #19304a;border-radius:5px;overflow:auto;background:#081523}.ladderHead{position:sticky;top:0;padding:8px;background:#0b1b2e;color:#ffca4b;font-weight:800;border-bottom:1px solid #1c3552}.ladderItem{padding:8px;border-bottom:1px solid #13263d}.ladderItem b{display:block}.rotationWrap{height:100%;padding:12px;overflow:auto}.rotationAxis{display:flex;gap:10px;align-items:stretch;min-width:900px}.rotationSlot{flex:1;border-left:1px solid #1c2f47;padding-left:7px}.rotationTime{color:#5a7089;font-size:9px;margin-bottom:6px}.rotationTag{padding:5px 6px;margin:4px 0;border-radius:3px;background:#0d2134;border:1px solid #1d425f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.heatWrap{display:flex;flex-wrap:wrap;gap:4px;padding:8px;align-content:flex-start}.heatTile{border:1px solid #1c3047;border-radius:4px;padding:7px;min-width:92px;min-height:62px;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden}.heatTile b{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.heatTile.upTile{background:linear-gradient(135deg,#351826,#18101b)}.heatTile.dnTile{background:linear-gradient(135deg,#0e302b,#0a1718)}.quad{position:relative;height:100%;min-height:300px;margin:8px;border:1px solid #1b3048;background:linear-gradient(#071423,#07111e)}.quad:before,.quad:after{content:"";position:absolute;background:#29405a}.quad:before{left:50%;top:0;bottom:0;width:1px}.quad:after{top:50%;left:0;right:0;height:1px}.quadLabel{position:absolute;color:#49647e;font-size:10px}.bubble{position:absolute;transform:translate(-50%,-50%);border-radius:999px;display:grid;place-items:center;padding:3px 7px;min-width:30px;min-height:22px;border:1px solid #31506c;font-size:8px;white-space:nowrap;overflow:hidden;max-width:100px;text-overflow:ellipsis}.bubble.pos{background:#3b1c2a;color:#ff9ab0}.bubble.neg{background:#103027;color:#74e0c4}.anomGrid{display:grid;grid-template-columns:repeat(5,1fr);height:100%}.anomCol{border-right:1px solid #17283d;overflow:auto}.anomCol:last-child{border:0}.anomHead{position:sticky;top:0;background:#081423;padding:7px;font-weight:700;border-bottom:1px solid #17283d}.anomItem{padding:7px;border-bottom:1px solid #112238}.anomItem b{display:block}.anomItem .code{margin-top:2px}.radarBody{height:calc(100% - 29px);overflow:hidden}.radarView{height:100%;overflow:auto}.radarHead{display:grid;grid-template-columns:44px minmax(100px,1.2fr) minmax(140px,1.6fr) 78px 78px 90px 90px;gap:6px;align-items:center;height:26px;padding:0 9px;color:#536a83;font-size:9px;border-bottom:1px solid #16273b;position:sticky;top:0;background:#071220;z-index:2}.radarRow{display:grid;grid-template-columns:44px minmax(100px,1.2fr) minmax(140px,1.6fr) 78px 78px 90px 90px;gap:6px;align-items:center;min-height:42px;padding:3px 9px;border-bottom:1px solid #112238}.radarRow>*{min-width:0}.radarName b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.radarScore{font-weight:800}.limitTrack{height:6px;background:#162439;border-radius:6px;overflow:hidden}.limitTrack i{display:block;height:100%;background:#ff5578;border-radius:6px}.statsWrap{display:grid;grid-template-columns:240px 1fr 1fr;height:100%}.statsSummary{padding:12px;border-right:1px solid #17283d}.statsNums{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.statBox{border:1px solid #1a3048;border-radius:5px;padding:10px;background:#091626}.statBox b{font-size:20px}.statsCol{overflow:auto}.statsTitle{height:28px;padding:7px 9px;font-weight:700;border-bottom:1px solid #17283d;position:sticky;top:0;background:#081423}.boardStatRow{display:grid;grid-template-columns:44px 1fr 72px 1fr;gap:7px;align-items:center;height:32px;padding:0 8px;border-bottom:1px solid #112238}.boardStatRow .bar{min-width:90px}.keywordBody{height:calc(100% - 29px);overflow:auto;padding:7px}.keywordTags{display:flex;flex-wrap:wrap;gap:5px;padding-bottom:7px;border-bottom:1px solid #15263b}.kw{border:1px solid #1e655d;color:#55d7bd;background:#0b2929;border-radius:3px;padding:4px 7px;font-size:10px;cursor:pointer}.kw.on,.kw:hover{border-color:#35a68f;color:#9df0dc}.industryNews article{padding:7px 2px;border-bottom:1px solid #14243a;line-height:1.45}.industryNews time{display:block;font-size:9px;color:#53677e;margin-bottom:2px}.industryNews b{font-size:10px;color:#c9d6e5}
.treasuryRows{margin-top:5px;border-top:1px solid #16263a;padding-top:3px}.treasuryRows .trend{height:30px;width:100%;min-width:120px}.treasuryRows .tyRow{grid-template-columns:62px minmax(150px,1fr) 72px}.tyRow{display:grid;grid-template-columns:62px minmax(90px,1fr) 66px;gap:6px;align-items:center;height:34px;border-bottom:1px solid #122238}.tyRow .trend{height:28px}.tyBars{display:flex;align-items:flex-end;gap:2px;height:27px;padding:2px 0}.tyBars i{display:block;flex:1;min-width:2px;border-radius:1px 1px 0 0;opacity:.9}.tyBars i.up{background:#ff5578}.tyBars i.dn{background:#27c7a2}.tyBars i.flat{background:#64748b}.tyBase{position:relative}.tyBase:after{content:"";position:absolute;left:0;right:0;top:50%;border-top:1px dashed #31445d;opacity:.75;pointer-events:none}.tyName{font-size:10px;color:#8ca0b8}.tyVal{text-align:right;font-weight:700}.tySub{font-size:8px;color:#576a80}.treasury .curve{display:none}.chainbody{display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:minmax(0,1fr);height:calc(100% - 29px);overflow:auto}.customChainTools{grid-column:1/5;display:flex;align-items:center;gap:6px;padding:6px;border-bottom:1px solid #14243a;background:#091526;position:sticky;top:0;z-index:2;height:40px;min-height:40px;align-self:start}.customChainTools input{flex:1;min-width:160px;height:28px;background:#07121f;border:1px solid #24415d;color:#d7e5f4;padding:4px 8px;border-radius:3px}.customChainStatus{font-size:10px;min-width:110px;color:#657a91}.customChainStatus.ok{color:#43d6ae}.customChainStatus.err{color:#ff6687}.customEmpty{grid-column:1/5;padding:18px;text-align:center;color:#657a91}.chainRemove{float:right;border:0;background:transparent;color:#667b92;cursor:pointer}.chainRemove:hover{color:#ff6687}.chaincol{border-right:1px solid #14243a;overflow:auto}.chaincol:last-child{border:0}.chainTitle{padding:7px;color:#73d9ee;font-weight:700;border-bottom:1px solid #14243a}.chain .ph{overflow:hidden}.chain #chainTabs{max-width:72%;overflow-x:auto;scrollbar-width:thin;padding-bottom:1px}.chain #chainTabs button{flex:0 0 auto}
.chainitem{padding:6px 8px;border-bottom:1px solid #102035}.chainitem .top{display:flex}.chainitem .top b{flex:1}.tag{font-size:9px;color:#54768d}
.searchbox{display:flex;padding:5px;gap:4px}.searchbox input{flex:1;background:#081422;border:1px solid #1b3047;color:#b9c9db;padding:5px;border-radius:3px}.suggest{position:absolute;background:#0b1828;border:1px solid #29435d;z-index:30;min-width:250px}.suggest div{padding:6px;cursor:pointer}.suggest div:hover{background:#10243a}
.modal{position:fixed;inset:0;background:#03070ddb;z-index:50;display:none;padding:42px}.modal.show{display:block}.modalbox{height:100%;max-width:1500px;margin:auto;background:#07111f;border:1px solid #213650;border-radius:8px;overflow:auto}.mh{position:sticky;top:0;background:#091525;border-bottom:1px solid #213650;padding:12px;display:flex;align-items:center;font-size:15px;font-weight:700;z-index:2}.mh button{margin-left:auto}.modalcontent{padding:12px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.card{border:1px solid #1b2c43;background:#0a1626;padding:10px;border-radius:6px}.card h3{margin:0 0 7px;font-size:12px}.card .big{font-size:20px;font-weight:800}.cardTrend{height:70px;margin:8px 0 5px}.cardTrend .trend{height:68px;width:100%}.toolGrid{display:grid;grid-template-columns:repeat(3,minmax(240px,1fr));gap:10px}.toolCard{border:1px solid #1b2c43;background:#0a1626;padding:12px;border-radius:6px}.toolTop{display:flex;align-items:flex-start;gap:8px}.toolTop h3{margin:0;flex:1}.toolPrice{font-size:20px;font-weight:800}.toolMeta{display:flex;gap:14px;color:#64748b;font-size:10px;margin-top:4px}.finSearch{display:flex;gap:6px;margin-bottom:12px}.finSearch input{width:250px;background:#081422;border:1px solid #26425f;color:white;padding:8px}.table{width:100%;border-collapse:collapse}.table th,.table td{padding:7px;border-bottom:1px solid #15263b;text-align:right}.table th:first-child,.table td:first-child{text-align:left}
.empty{padding:15px;color:#61758d;text-align:center}
@media(max-width:1250px){body{min-width:1080px}.grid{grid-template-columns:.9fr 1.65fr 1fr}.sector{grid-template-columns:1.12fr 1fr}.sectorSearch{width:80px}.sectorTools{gap:2px}}
</style>
</head>
<body><div class="app">
<header>
<div class="logo">⌁ 股市市场研究驾驶舱 <small>MARKET RESEARCH COCKPIT</small></div>
<div class="nav">沪深港美 · 大宗 · 美债 · 板块 · 资金流 · 快讯 · 产业链</div>
<button class="btn" data-modal="commod">商品价格</button><button class="btn" data-modal="gold">黄金观察</button>
<button class="btn" data-modal="ai">AI观察</button><button class="btn" data-modal="fin">财报窗口</button>
<span class="live">● 实时行情</span><span id="date"></span><span class="clock" id="clock"></span>
</header>
<div class="tape" id="tape"></div>

<main class="grid">
<section class="panel" id="indicesP"><div class="ph"><span>◎ 全球关键指数</span><span class="grow"></span><span class="mini">5s</span></div><div class="scroll indices" id="indices"></div></section>

<section class="panel" id="sectorP"><div class="ph"><span>◉ 市场板块实时热点</span><span class="grow"></span>
<div class="sectorTools"><input class="sectorSearch" id="sectorSearch" placeholder="搜索板块"><button class="tinybtn on" id="sectorRotate">轮播</button>
<div class="tabs"><button class="on" data-btype="01">行业</button><button data-btype="02">概念</button></div>
<div class="tabs"><button class="on" data-bdir="0">领涨</button><button data-bdir="1">领跌</button></div></div></div>
<div class="sector"><div class="sectorList" id="sectorList"></div><div class="sectorDetail" id="sectorDetail"><div class="empty">点击板块查看成分股</div></div></div></section>

<section class="panel pink"><div class="ph"><span>◔ 实时热点 · 7×24 快讯</span><span class="grow"></span><span class="mini">15s</span></div><div class="scroll news" id="news"></div></section>

<section class="panel pink"><div class="ph"><span>〽 板块资金流向</span><span class="grow"></span><span class="mini">实时</span></div><div class="flowWrap"><div class="flowChart"><svg class="bigchart" id="flowSvg" viewBox="0 0 500 245" preserveAspectRatio="none"></svg></div><div class="legend" id="flowLegend"></div></div></section>

<section class="panel pink"><div class="ph"><span>↪ 主力净流入排行</span><span class="grow"></span><span class="mini">TOP15</span></div><div class="scroll" id="money"></div></section>

<section class="panel yellow"><div class="ph"><span>☷ 个股榜单</span><span class="grow"></span><div class="tabs" id="rankTabs"><button class="on" data-rank="hot">热门股</button><button data-rank="up">涨幅榜</button><button data-rank="down">跌幅榜</button></div></div><div class="scroll" id="rank"></div></section>

<section class="panel yellow"><div class="ph"><span>◇ 大宗商品</span><span class="grow"></span><span class="mini">10s</span></div><div class="scroll rows comrows" id="commodities"></div></section>

<section class="panel purple"><div class="ph"><span>♜ 美债国债市场</span><span class="grow"></span><span class="mini">CNBC · 60s</span></div><div class="treasury"><div class="tstat" id="tstat"></div><div class="treasuryRows" id="treasuryRows"></div><div id="tvals" class="mini"></div></div></section>

<section class="panel green industryPanel"><div class="ph"><span>⌁ 行业关键词</span><span class="grow"></span><span class="mini">热点</span></div><div class="keywordBody"><div class="keywordTags" id="keywordTags"></div><div class="industryNews" id="industryNews"></div></div></section>

<section class="panel yellow watch"><div class="ph"><span>☆ 自选股</span><span class="grow"></span><span class="mini">5s</span></div>
<div class="searchbox"><input id="search" placeholder="代码/名称/拼音，如 688126 / 茅台 / gzmt"><button class="btn" id="addBtn">加</button></div>
<div style="position:relative"><div id="suggest" class="suggest" style="display:none"></div></div><div class="watchList" id="watch"></div></section>

<section class="panel green chain"><div class="ph"><span>⌁ 产业链上下游全景</span><span class="grow"></span><div class="tabs" id="chainTabs"></div></div><div class="chainbody" id="chain"></div></section>
<section class="panel pink radarPanel"><div class="ph"><span>⚡ 盘中异动雷达</span><span class="grow"></span><div class="tabs" id="radarTabs"><button class="on" data-radar="auction">竞价抢筹</button><button data-radar="limit">冲刺涨停</button><button data-radar="board">板块统计视图</button></div><span class="mini">10s</span></div><div class="radarBody" id="radarBody"></div></section>
<section class="panel green decisionPanel"><div class="ph"><span>◈ 市场决策中心</span><span class="grow"></span><div class="tabs" id="decisionTabs"><button class="on" data-decision="sentiment">市场情绪</button><button data-decision="ladder">涨停梯队</button><button data-decision="rotation">题材轮动</button><button data-decision="heatmap">板块热力图</button><button data-decision="quadrant">资金×涨幅四象限</button><button data-decision="anomaly">实时异动雷达</button></div><span class="mini">10s</span></div><div class="decisionBody" id="decisionBody"></div></section>
<section class="panel purple usPanel"><div class="ph"><span>🇺🇸 美股行情</span><span class="grow"></span><div class="tabs usTabs" id="usTabs"><button class="on" data-us="tech">科技</button><button data-us="semi">半导体</button><button data-us="ai">AI</button><button data-us="china">中概</button><button data-us="finance">金融</button><button data-us="energy">能源</button><button data-us="health">医疗</button><button data-us="consumer">消费</button><button data-us="software">软件</button><button data-us="cloud">云计算</button><button data-us="cyber">网络安全</button><button data-us="ev">电动车</button></div><span class="usGroupLabel" id="usGroupLabel">科技</span><span class="mini">5s</span></div><div class="usBody"><div class="usTop" id="usTop"></div><div class="usMain"><div class="usCol"><div class="usTitle">核心股票 · 实时分时</div><div id="usStocks"></div></div><div class="usCol"><div class="usTitle">涨幅榜</div><div id="usGainers"></div></div><div class="usCol"><div class="usTitle">跌幅榜</div><div id="usLosers"></div></div><div class="usCol"><div class="usTitle">活跃榜</div><div id="usActive"></div></div></div></div></section>
</main>
</div>

<div class="modal" id="modal"><div class="modalbox"><div class="mh"><span id="mtitle"></span><button class="btn" id="mclose">关闭</button></div><div class="modalcontent" id="mcontent"></div></div></div>

<script>
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]));
const cls=v=>Number(v)>=0?"up":"dn";
const sign=v=>(Number(v)>=0?"+":"")+Number(v||0).toFixed(2);
const fmtMoney=x=>{x=Number(x||0);const a=Math.abs(x);if(a>=1e8)return (x/1e8).toFixed(2)+"亿";if(a>=1e4)return (x/1e4).toFixed(0)+"万";return x.toFixed(0)}
async function api(path){const r=await fetch(path);const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||r.status);return j.data}
function clock(){const d=new Date();$("#clock").textContent=d.toLocaleTimeString("zh-CN",{hour12:false,hour:"2-digit",minute:"2-digit"});$("#date").textContent=d.toLocaleDateString("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit",weekday:"short"})}
clock();setInterval(clock,1000);

let TREND_SEQ=0;
function trend(values, baseline, pct, small=false){
  const a=(values||[]).map(Number).filter(Number.isFinite);
  if(a.length<2)return '<div class="mini mut">—</div>';
  baseline=Number(baseline);
  if(!Number.isFinite(baseline)||baseline<=0)baseline=a[0];
  const positive=Number(pct)>=0;
  const color=positive?"#ff5578":"#27c7a2";
  const fill=positive?"#ff5578":"#27c7a2";
  let lo=Math.min(...a,baseline),hi=Math.max(...a,baseline);
  const pad=Math.max((hi-lo)*0.12,Math.abs(baseline)*0.0015,0.01);
  lo-=pad; hi+=pad; if(hi===lo){hi+=1;lo-=1}
  const W=120,H=small?24:32,top=2,bottom=H-2;
  const y=v=>top+(hi-v)/(hi-lo)*(bottom-top);
  const pts=a.map((v,i)=>[(i/(a.length-1))*W,y(v)]);
  const line=pts.map((p,i)=>(i?"L":"M")+p[0].toFixed(2)+" "+p[1].toFixed(2)).join(" ");
  const area=line+" L "+W+" "+bottom+" L 0 "+bottom+" Z";
  const by=y(baseline).toFixed(2);
  const id="tg"+(++TREND_SEQ);
  return '<svg class="trend" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">'+
    '<defs><linearGradient id="'+id+'" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="'+fill+'" stop-opacity=".38"/><stop offset="100%" stop-color="'+fill+'" stop-opacity="0"/></linearGradient></defs>'+
    '<line class="base" x1="0" y1="'+by+'" x2="'+W+'" y2="'+by+'" stroke="'+color+'" stroke-width=".8"/>'+
    '<path class="area" d="'+area+'" fill="url(#'+id+')"/>'+
    '<path class="line" d="'+line+'" stroke="'+color+'"/></svg>';
}
function spark(values,color){
  const pct=(String(color).includes("ff")||String(color).includes("red"))?1:-1;
  return trend(values,values?.[0],pct,true);
}
function trendBars(values, baseline){
  const a=(values||[]).map(Number).filter(Number.isFinite);
  if(a.length<2)return '<div class="mini mut">—</div>';
  baseline=Number(baseline);
  if(!Number.isFinite(baseline))baseline=a[0];
  const diffs=a.map(v=>v-baseline);
  const max=Math.max(...diffs.map(v=>Math.abs(v)),0.0001);
  // Sample down to max 28 bars to keep the mini chart dense and readable.
  const target=28, step=Math.max(1,Math.ceil(diffs.length/target));
  const sampled=[];
  for(let i=0;i<diffs.length;i+=step){
    const chunk=diffs.slice(i,i+step);
    sampled.push(chunk.reduce((x,y)=>x+y,0)/chunk.length);
  }
  return '<div class="tyBase"><div class="tyBars">'+sampled.map(d=>{
    const h=22+Math.abs(d)/max*78;
    const c=d>0?"up":d<0?"dn":"flat";
    return '<i class="'+c+'" style="height:'+h.toFixed(0)+'%"></i>';
  }).join("")+'</div></div>';
}
const INDEX=[
["上证指数","sh000001"],["深证成指","sz399001"],["创业板指","sz399006"],["科创50","sh000688"],
["沪深300","sh000300"],["中证500","sh000905"],["恒生指数","hkHSI"],["纳斯达克","usIXIC"],["标普500","usINX"]
];
const TAPE=["sh000001","sz399001","sz399006","sh000688","sh000300","sh000905","hkHSI"];
let quoteCache={}, minuteCache={};

async function loadQuotes(){
 try{
  quoteCache=await api("/api/quotes?codes="+[...new Set([...INDEX.map(x=>x[1]),"hkHSTECH","usDJI","usIXIC","usINX","whUSDCNY"])].join(","));
  $("#tape").innerHTML=TAPE.map(c=>{const q=quoteCache[c]||{};return '<div class="tick"><span>'+esc(q.name||c)+'</span><b>'+esc(q.price||"—")+'</b><span class="'+cls(q.pct)+'">'+sign(q.pct)+'%</span></div>'}).join("");
  await Promise.all(INDEX.map(async x=>{try{minuteCache[x[1]]=await api("/api/minute?code="+x[1])}catch{}}));
  $("#indices").innerHTML=INDEX.slice(0,7).map(([name,c])=>{const q=quoteCache[c]||{},m=minuteCache[c]?.points?.map(x=>x.p)||[];
    return '<div class="row"><div><div class="nm">'+esc(name)+'</div><div class="code">'+c+'</div></div>'+trend(m,q.prev,q.pct,true)+'<div class="val"><b class="'+cls(q.pct)+'">'+esc(q.price||"—")+'</b><div class="'+cls(q.pct)+'">'+sign(q.pct)+'%</div></div></div>'}).join("");
 }catch(e){$("#indices").innerHTML='<div class="empty">指数行情不可用</div>'}
}
let btype="01", bdir="0", selectedBoard=null, sectorData=[], sectorShown=[], rotateOn=true, rotatePos=0, rotateTimer=null;

function renderSectorList(){
  const q=($("#sectorSearch")?.value||"").trim().toLowerCase();
  sectorShown=sectorData.filter(b=>!q || String(b.name||"").toLowerCase().includes(q) || String(b.code||"").toLowerCase().includes(q));
  const maxAbs=Math.max(1,...sectorShown.map(x=>Math.abs(Number(x.pct||0))));
  $("#sectorList").innerHTML='<div class="sectorHead"><span>代码</span><span>板块 / 强度</span><span>涨跌幅</span><span>领涨股</span><span>涨跌</span></div>'+
    sectorShown.map((b,i)=>{
      const w=Math.min(100,Math.abs(Number(b.pct||0))/maxAbs*100);
      return '<div class="sectorRow '+(b.code===selectedBoard?"sel":"")+'" data-board="'+esc(b.code)+'" data-bname="'+esc(b.name)+'" data-i="'+i+'">'+
       '<span class=code>'+esc(b.code)+'</span><span><div class=sname>'+esc(b.name)+'</div><div class="pctbar '+(b.pct<0?"neg":"")+'"><i style="width:'+w.toFixed(0)+'%"></i></div></span>'+
       '<b class="'+cls(b.pct)+'">'+sign(b.pct)+'%</b><span class=lead>'+esc(b.leadName||"—")+'</span><span class="'+cls(b.leadPct)+'">'+sign(b.leadPct)+'%</span></div>'
    }).join("");
  $$("#sectorList [data-board]").forEach(el=>el.onclick=()=>{
    rotatePos=Number(el.dataset.i)||0;
    loadBoardDetail(el.dataset.board,el.dataset.bname);
  });
}
async function loadBoards(){
 try{
  sectorData=await api("/api/boards?type="+btype+"&dir="+bdir+"&n=80");
  renderSectorList();
  if(!selectedBoard && sectorShown[0]){
    rotatePos=0;
    loadBoardDetail(sectorShown[0].code,sectorShown[0].name);
  } else if(selectedBoard && !sectorShown.some(x=>x.code===selectedBoard) && sectorShown[0]){
    rotatePos=0;
    loadBoardDetail(sectorShown[0].code,sectorShown[0].name);
  }
 }catch{$("#sectorList").innerHTML='<div class="empty">板块不可用</div>'}
}
async function loadBoardDetail(code,name){
 selectedBoard=code; renderSectorList();
 $("#sectorDetail").innerHTML='<div class="sectorTitle"><h3>'+esc(name)+'</h3><span class="sectorMeta">'+esc(code)+' · '+(bdir==="0"?"领涨":"领跌")+'</span></div><div class=empty>加载真实分时走势...</div>';
 try{
  const a=await api("/api/board-stocks?code="+encodeURIComponent(code)+"&n=8&dir="+(bdir==="0"?"down":"up"));
  if(!a.length){$("#sectorDetail").innerHTML='<div class="sectorTitle"><h3>'+esc(name)+'</h3><span class=sectorMeta>'+esc(code)+'</span></div><div class=empty>成分股暂不可用</div>';return}
  const top=a.slice(0,5), codes=top.map(x=>x.code||x.symbol).filter(Boolean);
  const [mins,qmap]=await Promise.all([
    api("/api/minutes?codes="+encodeURIComponent(codes.join(","))).catch(()=>({})),
    api("/api/quotes?codes="+encodeURIComponent(codes.join(","))).catch(()=>({}))
  ]);
  $("#sectorDetail").innerHTML='<div class="sectorTitle"><h3>'+esc(name)+'</h3><span class="sectorMeta">成分股 · 真实分时趋势</span></div>'+
    top.map((x)=>{
      const c=x.code||x.symbol, q=qmap[c]||{}, points=(mins[c]?.points||[]).map(v=>Number(v.p)).filter(Number.isFinite);
      const curve=points.length>2?trend(points,q.prev||points[0],q.pct??x.pct):'<div class="mini mut">分时暂不可用</div>';
      return '<div class="stockline"><div><b>'+esc(x.name)+'</b><div class=code>'+esc(c)+'</div></div>'+curve+
       '<span><b>'+esc(q.price||x.price||"—")+'</b><div class=stocksub>'+(x.turnover?("换手 "+Number(x.turnover).toFixed(1)+"%"):"")+'</div></span>'+
       '<b class="'+cls(q.pct??x.pct)+'">'+sign(q.pct??x.pct)+'%</b></div>';
    }).join("");
 }catch{$("#sectorDetail").innerHTML='<div class="sectorTitle"><h3>'+esc(name)+'</h3><span class=sectorMeta>'+esc(code)+'</span></div><div class=empty>成分股暂不可用</div>'}
}
function restartSectorRotate(){
  clearInterval(rotateTimer);
  if(!rotateOn)return;
  rotateTimer=setInterval(()=>{
    if(!sectorShown.length)return;
    rotatePos=(rotatePos+1)%sectorShown.length;
    const b=sectorShown[rotatePos];
    if(b)loadBoardDetail(b.code,b.name);
  },7000);
}
$$("[data-btype]").forEach(b=>b.onclick=()=>{
  $$("[data-btype]").forEach(x=>x.classList.remove("on"));b.classList.add("on");
  btype=b.dataset.btype;selectedBoard=null;rotatePos=0;loadBoards();
});
$$("[data-bdir]").forEach(b=>b.onclick=()=>{
  $$("[data-bdir]").forEach(x=>x.classList.remove("on"));b.classList.add("on");
  bdir=b.dataset.bdir;selectedBoard=null;rotatePos=0;loadBoards();
});
$("#sectorSearch").oninput=()=>{rotatePos=0;renderSectorList();if(sectorShown[0])loadBoardDetail(sectorShown[0].code,sectorShown[0].name)};
$("#sectorRotate").onclick=()=>{
  rotateOn=!rotateOn;$("#sectorRotate").classList.toggle("on",rotateOn);restartSectorRotate();
};
restartSectorRotate();
async function loadNews(){
 try{const a=await api("/api/news?size=50");$("#news").innerHTML=a.map(x=>'<article><time>'+esc(x.time)+'</time><b>'+esc(x.title)+'</b> '+esc(x.content)+'</article>').join("")}
 catch{$("#news").innerHTML='<div class=empty>快讯不可用</div>'}
}
const INDUSTRY_KEYWORDS=["AI大模型","半导体","机器人","算力","新能源","创新药","消费","黄金"];
let industryKeyword="AI大模型", latestNews=[];
function renderIndustryNews(){
  $("#keywordTags").innerHTML=INDUSTRY_KEYWORDS.map(k=>'<button class="kw '+(k===industryKeyword?"on":"")+'" data-kw="'+esc(k)+'">'+esc(k)+'</button>').join("");
  $$("#keywordTags [data-kw]").forEach(b=>b.onclick=()=>{industryKeyword=b.dataset.kw;renderIndustryNews()});
  const aliases={
    "AI大模型":["AI","人工智能","大模型","算力","芯片"],
    "半导体":["半导体","芯片","集成电路"],
    "机器人":["机器人","具身智能","自动化"],
    "算力":["算力","数据中心","服务器","GPU"],
    "新能源":["新能源","光伏","储能","锂电","风电"],
    "创新药":["创新药","医药","生物","医疗"],
    "消费":["消费","白酒","零售","旅游"],
    "黄金":["黄金","金价","贵金属"]
  };
  const keys=aliases[industryKeyword]||[industryKeyword];
  let rows=latestNews.filter(x=>keys.some(k=>(String(x.title||"")+String(x.content||"")).includes(k))).slice(0,8);
  if(!rows.length)rows=latestNews.slice(0,6);
  $("#industryNews").innerHTML=rows.map(x=>'<article><time>'+esc(x.time)+'</time><b>'+esc(x.title||industryKeyword)+'</b> '+esc(x.content)+'</article>').join("")||'<div class=empty>暂无匹配热点</div>';
}
async function loadIndustryNews(){
  try{latestNews=await api("/api/news?size=50");renderIndustryNews()}catch{$("#industryNews").innerHTML='<div class=empty>行业热点暂不可用</div>'}
}
async function loadMoney(){
 try{const a=await api("/api/money-flow?n=15"),max=Math.max(1,...a.map(x=>Math.abs(Number(x.netIn||0))));$("#money").innerHTML=a.map(x=>'<div class="rankitem"><div><strong>'+esc(x.name)+'</strong><div class=code>'+esc(x.symbol)+'</div></div><div><div class="bar '+(x.netIn<0?"neg":"")+'"><i style="width:'+Math.min(100,Math.abs(x.netIn)/max*100).toFixed(0)+'%"></i></div><div class=stocksub>主力占比 '+Number(x.netRatio||0).toFixed(1)+'%</div></div><div><b class="'+cls(x.netIn)+'">'+fmtMoney(x.netIn)+'</b><div class="'+cls(x.pct)+'">'+sign(x.pct)+'%</div></div></div>').join("")}
 catch{$("#money").innerHTML='<div class=empty>资金流不可用</div>'}
}
async function loadFlow(){
 try{
  const a=await api("/api/board-flow?n=18"), svg=$("#flowSvg"); let all=a.flatMap(x=>x.points.map(p=>p.v)); if(!all.length)throw 0;
  const lo=Math.min(...all,0),hi=Math.max(...all,0),range=hi-lo||1;
  svg.innerHTML='<line x1="0" y1="'+(245-(0-lo)/range*245)+'" x2="500" y2="'+(245-(0-lo)/range*245)+'" stroke="#26344a" stroke-width="1"/>'+
   a.map((x,k)=>{const pts=x.points.map((p,i)=>[(i/Math.max(1,x.points.length-1))*500,245-(p.v-lo)/range*245]);const d=pts.map((p,i)=>(i?"L":"M")+p[0].toFixed(1)+" "+p[1].toFixed(1)).join(" ");const c=x.netIn>=0?("hsl("+(345+k*7)+" 80% 65%)"):("hsl("+(155+k*6)+" 65% 52%)");return '<path d="'+d+'" fill="none" stroke="'+c+'" stroke-width="1.3" vector-effect="non-scaling-stroke"/>'}).join("");
  $("#flowLegend").innerHTML=a.map(x=>'<div class="'+cls(x.netIn)+'">'+esc(x.name)+' '+(x.netIn>=0?"+":"")+fmtMoney(x.netIn)+'</div>').join("");
 }catch{$("#flowLegend").innerHTML='<div class=mut>板块资金曲线不可用</div>'}
}
let rankMode="hot";
async function loadRank(){
 try{
  const path=rankMode==="up"?"/api/rank?sort=changepercent&asc=0&n=16":rankMode==="down"?"/api/rank?sort=changepercent&asc=1&n=16":"/api/rank?sort=amount&asc=0&n=16";
  const a=await api(path), codes=a.slice(0,16).map(x=>x.symbol).filter(Boolean), mins=await api("/api/minutes?codes="+encodeURIComponent(codes.join(","))).catch(()=>({}));
  $("#rank").innerHTML=a.map((x,i)=>{const v=(mins[x.symbol]?.points||[]).map(p=>Number(p.p)).filter(Number.isFinite);return '<div class="rankitem"><div><span class=mut>'+(i+1)+'</span> <strong>'+esc(x.name)+'</strong><div class=code>'+esc(x.symbol)+'</div></div>'+(v.length>2?trend(v,(x.price/(1+x.pct/100)),x.pct,true):'<div class=mini>—</div>')+'<div><b>'+esc(x.price)+'</b><div class="'+cls(x.pct)+'">'+sign(x.pct)+'%</div></div></div>'}).join("")
 }catch{$("#rank").innerHTML='<div class=empty>个股榜不可用</div>'}
}
$$("#rankTabs button").forEach(b=>b.onclick=()=>{$$("#rankTabs button").forEach(x=>x.classList.remove("on"));b.classList.add("on");rankMode=b.dataset.rank;loadRank()});

let commodityCache={},commodityMinutes={};
async function loadCom(){
 try{
  const list="hf_GC,hf_SI,hf_HG,hf_CL,hf_CAD,nf_AU0,BTCUSDT";
  [commodityCache,commodityMinutes]=await Promise.all([
    api("/api/futures?list="+list),
    api("/api/future-minutes?codes="+encodeURIComponent(list)).catch(()=>({}))
  ]);
  $("#commodities").innerHTML=Object.values(commodityCache).map(x=>{
    const v=(commodityMinutes[x.symbol]?.points||[]).map(p=>Number(p.p)).filter(Number.isFinite);
    const chart=v.length>2?trend(v,commodityMinutes[x.symbol]?.prec||x.prev,x.pct,true):'<div class="mini mut">分时暂不可用</div>';
    return '<div class=row><div><div class=nm>'+esc(x.name||x.symbol)+'</div><div class=code>'+esc(x.symbol)+'</div></div>'+chart+'<div class=val><b>'+esc(x.price)+'</b><div class="'+cls(x.pct)+'">'+sign(x.pct)+'%</div></div></div>'
  }).join("")
 }catch{$("#commodities").innerHTML='<div class=empty>商品行情不可用</div>'}
}
let treasuryCache=[],treasuryHistoryCache=[];
async function loadTreasury(){
 try{
  [treasuryCache,treasuryHistoryCache]=await Promise.all([
    api("/api/treasury"),
    api("/api/treasury-daily?days=120").catch(()=>[])
  ]);
  const by=Object.fromEntries(treasuryCache.map(x=>[x.symbol,x]));
  const show=["US10Y","US2Y","US3M"];
  $("#tstat").innerHTML=show.map(k=>{const x=by[k]||{};return '<div class=tbox><div class=mini>'+k+' 收益率</div><b>'+esc(x.yield||"—")+'%</b><div class="'+cls(x.change)+'">'+sign(x.change)+'bp</div></div>'}).join("");
  const tenors=["US3M","US2Y","US5Y","US10Y","US30Y"];
  $("#treasuryRows").innerHTML=tenors.map(k=>{
    const x=by[k]||{};
    const hist=treasuryHistoryCache.map(r=>Number(r.yields?.[k])).filter(v=>Number.isFinite(v)&&v>0);
    const base=hist.length?hist[0]:Number(x.yield||0);
    const direction=hist.length>1?(hist[hist.length-1]-hist[0]):Number(x.change||0);
    const chart=hist.length>2?trend(hist,base,direction,true):'<div class="mini mut">历史趋势暂不可用</div>';
    return '<div class=tyRow><div><div class=tyName>'+k+'</div><div class=tySub>每日收益率趋势</div></div>'+chart+
      '<div class=tyVal>'+esc(x.yield||"—")+'%<div class="'+cls(x.change)+'">'+sign(x.change)+'bp</div></div></div>';
  }).join("");
  $("#tvals").textContent="趋势：美国财政部每日收益率 · 实时值：CNBC";
 }catch{$("#tstat").innerHTML='<div class=empty>美债数据不可用</div>';$("#treasuryRows").innerHTML=""}
}

/* watchlist */
const DEF=["sh688126","sz002463","sz300502","sz600096","sz002475"];
let watch=JSON.parse(localStorage.getItem("mrd-watch")||"null")||DEF, picked=null, searchTimer;
function saveWatch(){localStorage.setItem("mrd-watch",JSON.stringify(watch))}
async function loadWatch(){
 try{
  const [q,mins]=await Promise.all([
    api("/api/quotes?codes="+watch.join(",")),
    api("/api/minutes?codes="+encodeURIComponent(watch.join(","))).catch(()=>({}))
  ]);
  $("#watch").innerHTML=watch.map(c=>{
    const x=q[c]||{},v=(mins[c]?.points||[]).map(p=>Number(p.p)).filter(Number.isFinite);
    return '<div class=watchRow data-w="'+c+'"><div><div class=nm>'+esc(x.name||c)+'</div><div class=code>'+c+'</div></div>'+
      (v.length>2?trend(v,x.prev,x.pct,true):'<div class="mini mut">—</div>')+
      '<div class=watchQuote><div class=price>'+esc(x.price||"—")+'</div><b class="'+cls(x.pct)+'">'+sign(x.pct)+'%</b></div>'+
      '<button class="btn rm watchRemove" title="删除">×</button></div>'
  }).join("");
  $$(".rm").forEach(b=>b.onclick=e=>{const c=e.target.closest("[data-w]").dataset.w;watch=watch.filter(x=>x!==c);saveWatch();loadWatch()})
 } catch{$("#watch").innerHTML='<div class=empty>自选行情不可用</div>'}
}
$("#search").oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(async()=>{const q=$("#search").value.trim();if(!q){$("#suggest").style.display="none";return}try{const a=await api("/api/stock-search?q="+encodeURIComponent(q));$("#suggest").innerHTML=a.map(x=>'<div data-code="'+x.code+'" data-name="'+esc(x.name)+'">'+esc(x.name)+'　<span class=code>'+x.code+'</span></div>').join("");$("#suggest").style.display=a.length?"block":"none";$$("#suggest div").forEach(d=>d.onclick=()=>{picked=d.dataset.code;$("#search").value=d.dataset.name+" "+picked;$("#suggest").style.display="none"})}catch{}},250)};
$("#addBtn").onclick=()=>{let c=picked||($("#search").value.match(/(sh|sz|bj)\d{6}/i)||[])[0];if(c&&!watch.includes(c)){watch.unshift(c);watch=watch.slice(0,20);saveWatch();loadWatch()}$("#search").value="";picked=null};

/* chain */
const CHAINS={
"大模型":[
["上海·算力基座",[["海光信息","sh688041"],["寒武纪","sh688256"],["中科曙光","sh603019"],["工业富联","sh601138"]]],
["中游·模型与平台",[["科大讯飞","sz002230"],["三六零","sh601360"],["昆仑万维","sz300418"],["金山办公","sh688111"]]],
["下游·Agent与应用",[["万兴科技","sz300624"],["中科创达","sz300496"],["虹软科技","sh688088"],["云从科技","sh688327"]]],
["基础设施",[["浪潮信息","sz000977"],["紫光股份","sz000938"],["润泽科技","sz300442"],["数据港","sh603881"]]]
],
"具身智能":[["核心零部件",[["绿的谐波","sh688017"],["汇川技术","sz300124"],["三花智控","sz002050"]]],["本体",[["埃斯顿","sz002747"],["机器人","sz300024"],["拓斯达","sz300607"]]],["视觉/传感",[["奥比中光","sh688322"],["柯力传感","sh603662"]]],["应用",[["鸣志电器","sh603728"],["双环传动","sz002472"]]]],
"半导体":[
["设备",[["北方华创","sz002371"],["中微公司","sh688012"],["拓荆科技","sh688072"],["盛美上海","sh688082"]]],
["材料",[["安集科技","sh688019"],["沪硅产业","sh688126"],["雅克科技","sz002409"],["江丰电子","sz300666"]]],
["设计",[["海光信息","sh688041"],["兆易创新","sh603986"],["澜起科技","sh688008"],["韦尔股份","sh603501"]]],
["制造封测",[["中芯国际","sh688981"],["长电科技","sh600584"],["通富微电","sz002156"],["华天科技","sz002185"]]]
],
"新能源":[
["上游·资源材料",[["天齐锂业","sz002466"],["赣锋锂业","sz002460"],["华友钴业","sh603799"],["恩捷股份","sz002812"]]],
["中游·电池储能",[["宁德时代","sz300750"],["亿纬锂能","sz300014"],["国轩高科","sz002074"],["阳光电源","sz300274"]]],
["下游·整车与应用",[["比亚迪","sz002594"],["赛力斯","sh601127"],["长安汽车","sz000625"],["广汽集团","sh601238"]]],
["电网·光伏风电",[["隆基绿能","sh601012"],["晶澳科技","sz002459"],["金风科技","sz002202"],["特变电工","sh600089"]]]
],
"创新药":[
["上游CXO",[["药明康德","sh603259"],["泰格医药","sz300347"],["康龙化成","sz300759"],["凯莱英","sz002821"]]],
["研发",[["恒瑞医药","sh600276"],["百济神州","sh688235"],["信达生物","hk01801"],["君实生物","sh688180"]]],
["商业化",[["科伦药业","sz002422"],["复星医药","sh600196"],["华东医药","sz000963"],["石药集团","hk01093"]]],
["医疗服务",[["爱尔眼科","sz300015"],["通策医疗","sh600763"],["国际医学","sz000516"],["美年健康","sz002044"]]]
],
"新型工业化":[
["工业母机",[["华中数控","sz300161"],["秦川机床","sz000837"],["海天精工","sh601882"],["科德数控","sh688305"]]],
["工业自动化",[["汇川技术","sz300124"],["中控技术","sh688777"],["埃斯顿","sz002747"],["英威腾","sz002334"]]],
["工业软件",[["宝信软件","sh600845"],["赛意信息","sz300687"],["鼎捷数智","sz300378"],["中望软件","sh688083"]]],
["工业互联网",[["工业富联","sh601138"],["用友网络","sh600588"],["东方国信","sz300166"],["东土科技","sz300353"]]]
],
"数字政府":[
["政务云",[["太极股份","sz002368"],["浪潮信息","sz000977"],["紫光股份","sz000938"],["中国软件","sh600536"]]],
["数据要素",[["易华录","sz300212"],["人民网","sh603000"],["上海钢联","sz300226"],["每日互动","sz300766"]]],
["网络安全",[["深信服","sz300454"],["奇安信","sh688561"],["启明星辰","sz002439"],["绿盟科技","sz300369"]]],
["智慧城市",[["数字政通","sz300075"],["千方科技","sz002373"],["海康威视","sz002415"],["大华股份","sz002236"]]]
],
"智慧医疗":[
["医疗信息化",[["卫宁健康","sz300253"],["创业慧康","sz300451"],["东华软件","sz002065"],["久远银海","sz002777"]]],
["AI医疗",[["科大讯飞","sz002230"],["润达医疗","sh603108"],["迪安诊断","sz300244"],["联影医疗","sh688271"]]],
["医疗器械",[["迈瑞医疗","sz300760"],["联影医疗","sh688271"],["鱼跃医疗","sz002223"],["乐普医疗","sz300003"]]],
["医疗服务",[["爱尔眼科","sz300015"],["通策医疗","sh600763"],["国际医学","sz000516"],["美年健康","sz002044"]]]
]
};
const CUSTOM_CHAIN_KEY="mrd-custom-chain";
let chainName="大模型";
function getCustomChain(){
  try{return JSON.parse(localStorage.getItem(CUSTOM_CHAIN_KEY)||"[]").filter(x=>x&&x.code&&x.name)}catch{return []}
}
function saveCustomChain(a){localStorage.setItem(CUSTOM_CHAIN_KEY,JSON.stringify(a))}
function normalizeStockCode(raw){
  const v=String(raw||"").trim().toLowerCase();
  if(/^(sh|sz|bj)\d{6}$/.test(v))return v;
  if(/^\d{6}$/.test(v)){
    if(/^(60|68|90)/.test(v))return "sh"+v;
    if(/^(00|20|30)/.test(v))return "sz"+v;
    return "bj"+v;
  }
  return "";
}
async function renderChain(){
 const names=["自定义",...Object.keys(CHAINS)];
 $("#chainTabs").innerHTML=names.map(x=>'<button data-chain="'+x+'" class="'+(x===chainName?"on":"")+'">'+x+'</button>').join("");
 $$("#chainTabs button").forEach(b=>b.onclick=()=>{chainName=b.dataset.chain;renderChain()});

 if(chainName==="自定义"){
   const custom=getCustomChain(),codes=custom.map(x=>x.code);
   let q={},mins={};
   if(codes.length)try{[q,mins]=await Promise.all([api("/api/quotes?codes="+codes.join(",")),api("/api/minutes?codes="+encodeURIComponent(codes.join(","))).catch(()=>({}))])}catch{}
   const groups=[[],[],[],[]];custom.forEach((x,i)=>groups[i%4].push(x));
   $("#chain").style.gridTemplateRows="40px minmax(0,1fr)";
   $("#chain").innerHTML='<div class=customChainTools><input id=customChainInput autocomplete=off placeholder="输入股票代码，如 sh600519 / 300750"><button type=button class=btn id=customChainAdd>添加</button><span class=customChainStatus id=customChainStatus></span></div>'+
    (custom.length?groups.map((g,gi)=>'<div class=chaincol><div class=chainTitle>自定义 '+(gi+1)+'</div>'+g.map(item=>{
      const c=item.code,x=q[c]||{},v=(mins[c]?.points||[]).map(p=>Number(p.p)).filter(Number.isFinite);
      return '<div class=chainitem data-cc="'+c+'"><button type=button class=chainRemove title="删除">×</button><div class=top><b>'+esc(x.name||item.name||c)+'</b><span>'+esc(x.price||"—")+'</span></div><div>'+(v.length>2?trend(v,x.prev,x.pct,true):'<span class=mut>行情加载中…</span>')+' <span class="'+cls(x.pct)+'">'+(x.price?sign(x.pct)+"%":"")+'</span></div><div class=tag>'+c+'</div></div>'
    }).join("")+'</div>').join(""):'<div class=customEmpty>暂无自定义股票，在上方输入代码添加</div>');

   const addCustom=()=>{
     const input=$("#customChainInput"),status=$("#customChainStatus");
     const raw=input?.value||"",c=normalizeStockCode(raw);
     if(!c){
       status.textContent="代码格式错误";
       status.className="customChainStatus err";
       return;
     }
     const arr=getCustomChain();
     if(arr.some(x=>x.code===c)){
       status.textContent="已添加";
       status.className="customChainStatus err";
       return;
     }
     // 立即保存，不等待任何行情接口，避免网络慢时按钮像“没反应”
     arr.push({code:c,name:c});
     saveCustomChain(arr);
     if(input) input.value="";
     status.textContent="添加成功";
     status.className="customChainStatus ok";
     renderChain();
     // 异步补股票名称，失败也不影响已经添加的项目
     api("/api/quotes?codes="+c).then(qm=>{
       const realName=qm?.[c]?.name;
       if(!realName)return;
       const latest=getCustomChain();
       const it=latest.find(x=>x.code===c);
       if(it){it.name=realName;saveCustomChain(latest);if(chainName==="自定义")renderChain()}
     }).catch(()=>{});
   };
   $("#customChainAdd").onclick=addCustom;
   $("#customChainInput").onkeydown=e=>{if(e.key==="Enter"){e.preventDefault();addCustom()}};
   $$(".chainRemove").forEach(b=>b.onclick=e=>{const c=e.target.closest("[data-cc]").dataset.cc;saveCustomChain(getCustomChain().filter(x=>x.code!==c));renderChain()});
   return;
 }

 $("#chain").style.gridTemplateRows="";
 const groups=CHAINS[chainName],codes=groups.flatMap(g=>g[1].map(x=>x[1]));let q={},mins={};
 try{[q,mins]=await Promise.all([api("/api/quotes?codes="+codes.join(",")),api("/api/minutes?codes="+encodeURIComponent(codes.join(","))).catch(()=>({}))])}catch{}
 $("#chain").innerHTML=groups.map(g=>'<div class=chaincol><div class=chainTitle>'+esc(g[0])+'</div>'+g[1].map(([name,c])=>{const x=q[c]||{},v=(mins[c]?.points||[]).map(p=>Number(p.p)).filter(Number.isFinite);return '<div class=chainitem><div class=top><b>'+esc(name)+'</b><span>'+esc(x.price||"—")+'</span></div><div>'+(v.length>2?trend(v,x.prev,x.pct,true):'<span class=mut>—</span>')+' <span class="'+cls(x.pct)+'">'+sign(x.pct)+'%</span></div><div class=tag>'+c+'</div></div>'}).join("")+'</div>').join("");
}

/* intraday radar */
let radarMode="auction";
async function loadRadar(){
 const box=$("#radarBody");if(!box)return;
 if(radarMode==="auction"){
   try{
     const a=await api("/api/auction-rush?n=20");
     const codes=a.map(x=>x.symbol).filter(Boolean);
     const mins=await api("/api/minutes?codes="+encodeURIComponent(codes.join(","))).catch(()=>({}));
     box.innerHTML='<div class=radarView><div class=radarHead><span>#</span><span>名称 / 代码</span><span>分时趋势</span><span>开盘涨幅</span><span>现涨幅</span><span>换手率</span><span>抢筹强度</span></div>'+
       a.map((x,i)=>{const v=(mins[x.symbol]?.points||[]).map(p=>Number(p.p)).filter(Number.isFinite);
         return '<div class=radarRow><span class=mut>'+(i+1)+'</span><div class=radarName><b>'+esc(x.name)+'</b><span class=code>'+esc(x.symbol)+'</span></div>'+
           (v.length>2?trend(v,(x.price/(1+x.pct/100)),x.pct,true):'<span class=mut>—</span>')+
           '<b class="'+cls(x.openPct)+'">'+sign(x.openPct)+'%</b><b class="'+cls(x.pct)+'">'+sign(x.pct)+'%</b><span>'+Number(x.turnover||0).toFixed(1)+'%</span><b class="radarScore '+cls(x.score)+'">'+Number(x.score||0).toFixed(1)+'</b></div>'
       }).join("")+'</div>';
   }catch(e){box.innerHTML='<div class=empty>竞价抢筹数据暂不可用</div>'}
   return;
 }
 if(radarMode==="limit"){
   try{
     const a=await api("/api/limit-rush?n=20");
     const codes=a.map(x=>x.symbol).filter(Boolean);
     const mins=await api("/api/minutes?codes="+encodeURIComponent(codes.join(","))).catch(()=>({}));
     box.innerHTML='<div class=radarView><div class=radarHead><span>#</span><span>名称 / 代码</span><span>分时趋势</span><span>现涨幅</span><span>涨停幅度</span><span>距涨停</span><span>冲刺进度</span></div>'+
       a.map((x,i)=>{const v=(mins[x.symbol]?.points||[]).map(p=>Number(p.p)).filter(Number.isFinite);
         return '<div class=radarRow><span class=mut>'+(i+1)+'</span><div class=radarName><b>'+esc(x.name)+'</b><span class=code>'+esc(x.symbol)+'</span></div>'+
           (v.length>2?trend(v,(x.price/(1+x.pct/100)),x.pct,true):'<span class=mut>—</span>')+
           '<b class="'+cls(x.pct)+'">'+sign(x.pct)+'%</b><span>'+Number(x.limitPct).toFixed(0)+'%</span><span>'+Number(x.distance).toFixed(2)+'%</span><div><div class=limitTrack><i style="width:'+Math.min(100,x.progress)+'%"></i></div><span class=mini>'+Number(x.progress).toFixed(0)+'%</span></div></div>'
       }).join("")+'</div>';
   }catch(e){box.innerHTML='<div class=empty>冲刺涨停数据暂不可用</div>'}
   return;
 }
 try{
   const d=await api("/api/board-stats?n=30"),m=Math.max(1,...[...d.strongest,...d.weakest].map(x=>Math.abs(Number(x.pct||0))));
   const rows=(a)=>a.map((x,i)=>'<div class=boardStatRow><span class=mut>'+(i+1)+'</span><span>'+esc(x.name)+' <small class=code>'+esc(x.type)+'</small></span><b class="'+cls(x.pct)+'">'+sign(x.pct)+'%</b><div class="bar '+(x.pct<0?"neg":"")+'"><i style="width:'+Math.min(100,Math.abs(x.pct)/m*100).toFixed(0)+'%"></i></div></div>').join("");
   box.innerHTML='<div class=statsWrap><div class=statsSummary><b>板块统计</b><div class=statsNums>'+
     '<div class=statBox><span class=mut>上涨</span><br><b class=up>'+d.summary.up+'</b></div>'+
     '<div class=statBox><span class=mut>下跌</span><br><b class=dn>'+d.summary.down+'</b></div>'+
     '<div class=statBox><span class=mut>总计</span><br><b>'+d.summary.total+'</b></div>'+
     '<div class=statBox><span class=mut>平均涨跌</span><br><b class="'+cls(d.summary.avgPct)+'">'+sign(d.summary.avgPct)+'%</b></div></div></div>'+
     '<div class=statsCol><div class=statsTitle>最强板块</div>'+rows(d.strongest)+'</div>'+
     '<div class=statsCol><div class=statsTitle>最弱板块</div>'+rows(d.weakest)+'</div></div>';
 }catch(e){box.innerHTML='<div class=empty>板块统计暂不可用</div>'}
}
$$("#radarTabs button").forEach(b=>b.onclick=()=>{$$("#radarTabs button").forEach(x=>x.classList.remove("on"));b.classList.add("on");radarMode=b.dataset.radar;loadRadar()});

/* market decision center */
let decisionMode="sentiment";
const ROTATION_KEY="mrd-rotation-samples";
function rotLoad(){try{return JSON.parse(localStorage.getItem(ROTATION_KEY)||"[]")}catch{return []}}
function rotSave(a){localStorage.setItem(ROTATION_KEY,JSON.stringify(a.slice(-36)))}
function moneyShort(v){v=Number(v||0);if(Math.abs(v)>=1e8)return (v/1e8).toFixed(1)+"亿";if(Math.abs(v)>=1e4)return (v/1e4).toFixed(0)+"万";return v.toFixed(0)}
async function captureRotation(){
 try{
  const a=await api("/api/boards?type=01&dir=0&n=5");
  const now=new Date(),stamp=now.toLocaleTimeString("zh-CN",{hour12:false,hour:"2-digit",minute:"2-digit"});
  const arr=rotLoad(),last=arr[arr.length-1];
  if(!last||last.time!==stamp){arr.push({time:stamp,items:a.slice(0,5).map(x=>({name:x.name,pct:x.pct}))});rotSave(arr)}
 }catch{}
}
function renderRotation(){
 const arr=rotLoad();
 if(!arr.length){$("#decisionBody").innerHTML='<div class=empty>页面打开后会每 10 秒采样板块强弱，形成当天题材轮动时间轴</div>';return}
 $("#decisionBody").innerHTML='<div class=rotationWrap><div class=rotationAxis>'+arr.map(s=>'<div class=rotationSlot><div class=rotationTime>'+esc(s.time)+'</div>'+s.items.slice(0,4).map(x=>'<div class="rotationTag '+cls(x.pct)+'">'+esc(x.name)+' '+sign(x.pct)+'%</div>').join("")+'</div>').join("")+'</div></div>';
}
async function loadDecision(){
 const box=$("#decisionBody");if(!box)return;
 if(decisionMode==="sentiment"){
  try{
   const d=await api("/api/market-sentiment");
   const mood=d.score>=75?"强势":d.score>=60?"偏强":d.score>=40?"震荡":d.score>=25?"偏弱":"退潮";
   const list=(a,title)=>'<div class=sentList><div class=sentTitle>'+title+'</div>'+a.map((x,i)=>'<div class=miniRank><span class=mut>'+(i+1)+'</span><span>'+esc(x.name)+' <small class=code>'+esc(x.code)+'</small></span><b class="'+cls(x.pct)+'">'+sign(x.pct)+'%</b><span>'+moneyShort(x.amount)+'</span></div>').join("")+'</div>';
   box.innerHTML='<div class=sentGrid><div class=sentGauge><b>市场情绪</b><div class=gaugeCircle style="--v:'+d.score+'%"><div style="text-align:center"><b>'+d.score+'</b><br><span>'+mood+'</span></div></div><div class=sentNums>'+
    '<div class=statBox><span class=mut>上涨</span><br><b class=up>'+d.up+'</b></div><div class=statBox><span class=mut>下跌</span><br><b class=dn>'+d.down+'</b></div>'+
    '<div class=statBox><span class=mut>涨停</span><br><b class=up>'+d.limitUp+'</b></div><div class=statBox><span class=mut>跌停</span><br><b class=dn>'+d.limitDown+'</b></div>'+
    '<div class=statBox><span class=mut>冲板</span><br><b>'+d.nearLimit+'</b></div><div class=statBox><span class=mut>红盘率</span><br><b>'+d.redRate+'%</b></div></div></div>'+
    list(d.hottest,"涨幅前列")+list(d.weakest,"跌幅前列")+'</div>';
  }catch(e){box.innerHTML='<div class=empty>市场情绪数据暂不可用</div>'}
  return;
 }
 if(decisionMode==="ladder"){
  try{
   const d=await api("/api/limit-ladder");
   let cols="";
   for(let k=Math.max(d.max,1);k>=1;k--){
     const a=d.groups[String(Math.min(k,6))]||[];
     if(!a.length)continue;
     cols+='<div class=ladderCol><div class=ladderHead>'+(k>=6?"6板+":k+"板")+' · '+a.length+'家</div>'+a.map(x=>'<div class=ladderItem><b>'+esc(x.name)+' <span class=up>'+sign(x.pct)+'%</span></b><span class=code>'+esc(x.symbol)+'</span><div class=mini>成交 '+moneyShort(x.amount)+' · 换手 '+Number(x.turnover||0).toFixed(1)+'%</div></div>').join("")+'</div>';
   }
   box.innerHTML='<div class=ladder>'+(cols||'<div class=empty>当前没有识别到涨停梯队</div>')+'</div>';
  }catch(e){box.innerHTML='<div class=empty>涨停梯队暂不可用</div>'}
  return;
 }
 if(decisionMode==="rotation"){renderRotation();return}
 if(decisionMode==="heatmap"){
  try{
   const a=await api("/api/board-heatmap");
   const maxAmt=Math.max(1,...a.map(x=>Number(x.amount||0)));
   box.innerHTML='<div class=heatWrap>'+a.map(x=>{const ratio=Math.sqrt(Math.max(0,x.amount)/maxAmt),w=Math.round(92+ratio*135),h=Math.round(62+ratio*55);return '<div class="heatTile '+(x.pct>=0?"upTile":"dnTile")+'" style="width:'+w+'px;height:'+h+'px"><b>'+esc(x.name)+'</b><strong class="'+cls(x.pct)+'">'+sign(x.pct)+'%</strong><span class=mini>成交 '+moneyShort(x.amount)+'<br>主力 '+moneyShort(x.netIn)+'</span></div>'}).join("")+'</div>';
  }catch(e){box.innerHTML='<div class=empty>板块热力图暂不可用</div>'}
  return;
 }
 if(decisionMode==="quadrant"){
  try{
   const a=await api("/api/board-quadrant");
   const maxX=Math.max(1,...a.map(x=>Math.abs(Number(x.x||0)))),maxY=Math.max(1,...a.map(x=>Math.abs(Number(x.y||0))));
   box.innerHTML='<div class=quad><span class=quadLabel style="left:8px;top:7px">潜伏区：资金流入 / 涨幅偏低</span><span class=quadLabel style="right:8px;top:7px">强势共振区</span><span class=quadLabel style="left:8px;bottom:7px">弱势区</span><span class=quadLabel style="right:8px;bottom:7px">高位流出区</span>'+
    a.slice(0,55).map(x=>{const left=50+(x.x/maxX)*45,top=50-(x.y/maxY)*45,size=Math.max(24,Math.min(66,22+Math.sqrt(Math.max(x.amount,0))/50000));return '<div title="'+esc(x.name)+' 涨跌 '+sign(x.x)+'% 主力 '+moneyShort(x.netIn)+'" class="bubble '+(x.y>=0?"pos":"neg")+'" style="left:'+left.toFixed(1)+'%;top:'+top.toFixed(1)+'%;width:'+size.toFixed(0)+'px;height:'+Math.max(22,size*.55).toFixed(0)+'px">'+esc(x.name)+'</div>'}).join("")+'</div>';
  }catch(e){box.innerHTML='<div class=empty>四象限数据暂不可用</div>'}
  return;
 }
 try{
  const d=await api("/api/anomaly-radar");
  const col=(title,a,field,unit="")=>'<div class=anomCol><div class=anomHead>'+title+'</div>'+a.map(x=>'<div class=anomItem><b>'+esc(x.name)+' <span class="'+cls(x.pct)+'">'+sign(x.pct)+'%</span></b><div class=code>'+esc(x.symbol)+'</div><span class=mini>'+field+': '+esc(x[field]??"—")+unit+' · 成交 '+moneyShort(x.amount)+'</span></div>').join("")+'</div>';
  box.innerHTML='<div class=anomGrid>'+col("快速拉升",d.fastUp,"speed","%")+col("快速下跌",d.fastDown,"speed","%")+col("放量活跃",d.volume,"turnover","%")+col("冲击涨停",d.nearLimit,"pct","%")+col("涨停/封板",d.limit,"pct","%")+'</div>';
 }catch(e){box.innerHTML='<div class=empty>实时异动雷达暂不可用</div>'}
}
$$("#decisionTabs button").forEach(b=>b.onclick=()=>{$$("#decisionTabs button").forEach(x=>x.classList.remove("on"));b.classList.add("on");decisionMode=b.dataset.decision;if(decisionMode==="rotation")captureRotation().then(renderRotation);else loadDecision()});

/* US market */
let usGroup="tech",usLoadSeq=0;
const US_GROUP_LABELS={
  tech:"科技",semi:"半导体",ai:"AI",china:"中概",
  finance:"金融",energy:"能源",health:"医疗",consumer:"消费",
  software:"软件",cloud:"云计算",cyber:"网络安全",ev:"电动车"
};
async function loadUSMarket(){
 const seq=++usLoadSeq;
 const stockBox=$("#usStocks");
 if(stockBox) stockBox.innerHTML='<div class=usLoading>正在加载 '+esc(US_GROUP_LABELS[usGroup]||usGroup)+' 行情…</div>';
 try{
  const [d,mins]=await Promise.all([
    api("/api/us-market?group="+encodeURIComponent(usGroup)),
    api("/api/us-market-minutes?group="+encodeURIComponent(usGroup)).catch(()=>({}))
  ]);
  // Ignore a slow response from the previously selected tab.
  if(seq!==usLoadSeq)return;

  const idxMap=[["usDJI","道琼斯"],["usIXIC","纳斯达克"],["usINX","标普500"],["usVIX","VIX"]];
  $("#usTop").innerHTML=idxMap.map(([c,nm])=>{const x=d.indices?.[c]||{};return '<div class=usIndex><div class=mini>'+nm+'</div><b>'+esc(x.price||"—")+'</b><div class="'+cls(x.pct)+'">'+sign(x.pct)+'%</div></div>'}).join("");

  $("#usStocks").innerHTML=d.stocks.length?d.stocks.map(x=>{
    const v=(mins[x.symbol]?.points||[]).map(p=>Number(p.p)).filter(Number.isFinite);
    return '<div class=usStock><div><b>'+esc(x.name||x.symbol)+'</b><div class=code>'+esc(x.symbol)+'</div></div>'+
      (v.length>2?trend(v,x.prev||v[0],x.pct,true):'<div class="mini mut">分时暂不可用</div>')+
      '<b>'+esc(x.price||"—")+'</b><b class="'+cls(x.pct)+'">'+sign(x.pct)+'%</b></div>'
  }).join(""):'<div class=empty>该板块当前没有可用行情</div>';

  const rank=(a)=>a.length?a.map((x,i)=>'<div class=usRank><span class=mut>'+(i+1)+'</span><span>'+esc(x.name||x.symbol)+' <small class=code>'+esc(x.symbol)+'</small></span><b class="'+cls(x.pct)+'">'+sign(x.pct)+'%</b></div>').join(""):'<div class=empty>暂无数据</div>';
  $("#usGainers").innerHTML=rank(d.gainers);
  $("#usLosers").innerHTML=rank(d.losers);
  $("#usActive").innerHTML=rank(d.active);
  $("#usGroupLabel").textContent=US_GROUP_LABELS[usGroup]||usGroup;
 }catch(e){
  if(seq!==usLoadSeq)return;
  $("#usStocks").innerHTML='<div class=empty>美股行情暂不可用：'+esc(e.message)+'</div>';
  $("#usGainers").innerHTML="";
  $("#usLosers").innerHTML="";
  $("#usActive").innerHTML="";
 }
}
// Use event delegation so the tab switch remains reliable even after re-rendering.
document.addEventListener("click",e=>{
  const b=e.target.closest("#usTabs [data-us]");
  if(!b)return;
  e.preventDefault();
  const next=b.dataset.us;
  if(!next||!US_GROUP_LABELS[next])return;
  usGroup=next;
  $$("#usTabs [data-us]").forEach(x=>x.classList.toggle("on",x===b));
  $("#usGroupLabel").textContent=US_GROUP_LABELS[next];
  loadUSMarket();
});
/* modal tools */
function openModal(title,html){$("#mtitle").textContent=title;$("#mcontent").innerHTML=html;$("#modal").classList.add("show")}
$("#mclose").onclick=()=>$("#modal").classList.remove("show");$("#modal").onclick=e=>{if(e.target===$("#modal"))$("#modal").classList.remove("show")};
$$("[data-modal]").forEach(b=>b.onclick=()=>showTool(b.dataset.modal));
async function showTool(kind){
 const renderToolCards=(items,minuteMap={})=>'<div class=toolGrid>'+items.map(x=>{
   const code=x.symbol||x.code||"",v=(minuteMap[code]?.points||[]).map(p=>Number(p.p)).filter(Number.isFinite);
   const base=minuteMap[code]?.prec||x.prev||v[0]||x.price;
   const chart=v.length>2?trend(v,base,x.pct):'<div class="empty cardTrend">趋势暂不可用</div>';
   return '<div class=toolCard><div class=toolTop><h3>'+esc(x.name||code)+'</h3><div><div class=toolPrice>'+esc(x.price||"—")+'</div><div class="'+cls(x.pct)+'">'+sign(x.pct)+'%</div></div></div>'+
     '<div class=cardTrend>'+chart+'</div><div class=toolMeta><span>高 '+esc(x.high??"—")+'</span><span>低 '+esc(x.low??"—")+'</span><span>开 '+esc(x.open??"—")+'</span></div><div class=code>'+esc(code)+'</div></div>'
 }).join("")+'</div>';

 if(kind==="commod"){
  const items=Object.values(commodityCache);
  openModal("商品价格",renderToolCards(items,commodityMinutes));return
 }
 if(kind==="gold"){
  const list="hf_GC,hf_XAU,hf_SI,hf_CAD,nf_AU0";
  openModal("黄金观察",'<div class=empty>加载中...</div>');
  try{
    const [q,mins]=await Promise.all([
      api("/api/futures?list="+list),
      api("/api/future-minutes?codes="+encodeURIComponent(list)).catch(()=>({}))
    ]);
    $("#mcontent").innerHTML=renderToolCards(Object.values(q),mins);
  }catch(e){$("#mcontent").innerHTML='<div class=empty>黄金趋势暂不可用：'+esc(e.message)+'</div>'}
  return
 }
 if(kind==="ai"){
  const list=["usNVDA","usAMD","usAVGO","usMSFT","usGOOGL","usMETA","sh688041","sh688256","sz002230"];
  openModal("AI观察",'<div class=empty>加载中...</div>');
  try{
    const [q,mins]=await Promise.all([
      api("/api/quotes?codes="+list.join(",")),
      api("/api/minutes?codes="+encodeURIComponent(list.join(","))).catch(()=>({}))
    ]);
    const items=list.map(c=>q[c]||{symbol:c,name:c,price:0,pct:0,prev:0});
    $("#mcontent").innerHTML=renderToolCards(items,mins);
  }catch(e){$("#mcontent").innerHTML='<div class=empty>AI行情趋势暂不可用：'+esc(e.message)+'</div>'}
  return
 }
 if(kind==="fin"){
  openModal("财报窗口",'<div class=finSearch><input id=finCode placeholder="输入 sh600519 / sz000506 / 600519"><button class=btn id=finGo>查询</button></div><div id=finOut class=empty>输入股票代码查询主要财务指标</div>');
  $("#finGo").onclick=async()=>{
    const c=$("#finCode").value.trim();$("#finOut").innerHTML="加载中...";
    try{
      const d=await api("/api/finance-main?code="+encodeURIComponent(c));
      $("#finOut").innerHTML='<div style="margin-bottom:10px"><b>'+esc(d.name||c)+'</b>　<span class=mut>'+esc(d.industry||"")+'</span></div>'+
      '<table class=table><thead><tr><th>报告期</th><th>营收</th><th>营收同比</th><th>净利润</th><th>净利同比</th><th>ROE</th><th>毛利率</th><th>EPS</th></tr></thead><tbody>'+
      d.reports.map(r=>'<tr><td>'+esc(r.label||r.date)+'</td><td>'+fmtMoney(r.revenue)+'</td><td class="'+cls(r.revenueYoY)+'">'+sign(r.revenueYoY)+'%</td><td>'+fmtMoney(r.netProfit)+'</td><td class="'+cls(r.profitYoY)+'">'+sign(r.profitYoY)+'%</td><td>'+Number(r.roe||0).toFixed(2)+'%</td><td>'+Number(r.grossMargin||0).toFixed(2)+'%</td><td>'+Number(r.eps||0).toFixed(3)+'</td></tr>').join("")+'</tbody></table>'
    }catch(e){$("#finOut").innerHTML='<div class=empty>财报数据获取失败：'+esc(e.message)+'</div>'}
  }
 }
}

loadQuotes();loadBoards();loadNews();loadIndustryNews();loadMoney();loadFlow();loadRank();loadCom();loadTreasury();loadWatch();renderChain();loadRadar();captureRotation();loadDecision();loadUSMarket();
setInterval(loadQuotes,5000);setInterval(loadWatch,5000);setInterval(loadBoards,8000);setInterval(loadMoney,10000);
setInterval(loadFlow,20000);setInterval(loadRank,10000);setInterval(loadCom,10000);setInterval(loadNews,15000);setInterval(loadIndustryNews,30000);setInterval(loadTreasury,60000);setInterval(loadRadar,10000);setInterval(()=>{captureRotation();if(decisionMode==="rotation")renderRotation();else loadDecision()},10000);setInterval(loadUSMarket,5000);
</script>
</body></html>`;

/* ---------------- Routing ---------------- */

async function router(req,env){
  const u=new URL(req.url),p=u.pathname;
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:{
    "access-control-allow-origin":"*","access-control-allow-methods":"GET,OPTIONS","access-control-allow-headers":"content-type"
  }});
  if(p==="/"||p==="/index.html")return page(APP);
  if(p==="/api/health")return ok({runtime:"cloudflare-workers",version:"2.0-full",time:new Date().toISOString()});
  try{
    if(p==="/api/quotes"){const c=u.searchParams.get("codes")||"sh000001,sz399001,sz399006";return ok(await cached("q:"+c,TTL.quote,()=>quotes(c),env))}
    if(p==="/api/minute"){const c=u.searchParams.get("code")||"sh000001";return ok(await cached("m:"+c,c.startsWith("wh")?120:TTL.minute,()=>minute(c),env))}
    if(p==="/api/minutes"){const c=u.searchParams.get("codes")||"";return ok(await cached("ms:"+c,TTL.minute,()=>batchMinutes(c),env))}
    if(p==="/api/boards"){const t=u.searchParams.get("type")||"01",d=u.searchParams.get("dir")||"0",n0=u.searchParams.get("n")||"30";return ok(await cached(`b:${t}:${d}:${n0}`,TTL.boards,()=>boards(t,d,n0),env))}
    if(p==="/api/board-stocks"){const c=u.searchParams.get("code")||"",nn=u.searchParams.get("n")||"18",d=u.searchParams.get("dir")||"down";return ok(await cached(`bs:${c}:${nn}:${d}`,TTL.boardStocks,()=>boardStocks(c,nn,d),env))}
    if(p==="/api/rank"){const s=u.searchParams.get("sort")||"changepercent",a=u.searchParams.get("asc")||"0",nn=u.searchParams.get("n")||"15";return ok(await cached(`r:${s}:${a}:${nn}`,TTL.rank,()=>stockRank(s,a,nn),env))}
    if(p==="/api/auction-rush"){const nn=u.searchParams.get("n")||"20";return ok(await cached("ar:"+nn,8,()=>auctionRush(nn),env))}
    if(p==="/api/limit-rush"){const nn=u.searchParams.get("n")||"20";return ok(await cached("lr:"+nn,8,()=>limitRush(nn),env))}
    if(p==="/api/board-stats"){const nn=u.searchParams.get("n")||"30";return ok(await cached("bst:"+nn,10,()=>boardStats(nn),env))}
    if(p==="/api/market-sentiment")return ok(await cached("sentiment",8,marketSentiment,env));
    if(p==="/api/limit-ladder")return ok(await cached("ladder",15,limitLadder,env));
    if(p==="/api/board-heatmap")return ok(await cached("heatmap",10,boardHeatmap,env));
    if(p==="/api/board-quadrant")return ok(await cached("quadrant",10,boardQuadrant,env));
    if(p==="/api/anomaly-radar")return ok(await cached("anomaly",8,anomalyRadar,env));
    if(p==="/api/us-market"){const g=u.searchParams.get("group")||"tech";return ok(await cached("usm:"+g,5,()=>usMarket(g),env))}
    if(p==="/api/us-market-minutes"){const g=u.searchParams.get("group")||"tech";return ok(await cached("usmm:"+g,5,()=>usMarketMinutes(g),env))}
    if(p==="/api/money-flow"){const nn=u.searchParams.get("n")||"15";return ok(await cached("mf:"+nn,TTL.flow,()=>moneyFlow(nn),env))}
    if(p==="/api/board-money-flow"){const c=u.searchParams.get("code")||"",nn=u.searchParams.get("n")||"15";return ok(await cached(`bmf:${c}:${nn}`,TTL.flow,()=>boardMoneyFlow(c,nn),env))}
    if(p==="/api/board-flow"){const nn=u.searchParams.get("n")||"20";return ok(await cached("bf:"+nn,TTL.boardFlow,()=>boardFlow(nn),env))}
    if(p==="/api/futures"){const l=u.searchParams.get("list")||"";return ok(await cached("fu:"+l,TTL.futures,()=>futures(l),env))}
    if(p==="/api/future-minute"){const c=u.searchParams.get("code")||"";return ok(await cached("fum:"+c,TTL.minute,()=>futureMinute(c),env))}
    if(p==="/api/future-minutes"){const c=u.searchParams.get("codes")||"";return ok(await cached("fums:"+c,TTL.minute,()=>futureMinutes(c),env))}
    if(p==="/api/news"){const z=u.searchParams.get("size")||"50";return ok(await cached("news:"+z,TTL.news,()=>news(z),env))}
    if(p==="/api/stock-search"){const q=u.searchParams.get("q")||"";return ok(await cached("ss:"+q,TTL.search,()=>stockSearch(q),env))}
    if(p==="/api/treasury")return ok(await cached("treasury",TTL.treasury,treasury,env));
    if(p==="/api/treasury-history")return ok(await cached("th",3600,treasuryHistory,env));
    if(p==="/api/treasury-daily"){const d=u.searchParams.get("days")||"120";return ok(await cached("td:"+d,3600,()=>treasuryDaily(d),env));}
    if(p==="/api/stock-boards"){const c=u.searchParams.get("code")||"";return ok(await cached("sb:"+c,300,()=>stockBoards(c),env))}
    if(p==="/api/finance-main"){const c=u.searchParams.get("code")||"";return ok(await cached("fin:"+c,TTL.finance,()=>financeMain(c),env))}
    return fail("not found",404);
  }catch(e){return fail(e,e?.status||502)}
}
export default {fetch(request,env,ctx){return router(request,env)}};
