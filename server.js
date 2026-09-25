// mobile-entry.js
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import pg from "pg";

// kalshi.js
import { createPrivateKey, sign, constants } from "node:crypto";
var BASE = "https://external-api.kalshi.com";
function signature(key, timestamp, path2) {
  const privateKey = createPrivateKey(key.replace(/\\n/g, "\n"));
  const data = Buffer.from(`${timestamp}GET${path2}`);
  const opts = privateKey.asymmetricKeyType === "rsa" ? { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : privateKey;
  return sign(privateKey.asymmetricKeyType === "rsa" ? "sha256" : null, data, opts).toString("base64");
}
async function request(path2, params, keyId, key) {
  const timestamp = String(Date.now()), url = new URL(path2, BASE);
  for (const [k, v] of Object.entries(params)) if (v !== void 0 && v !== "") url.searchParams.set(k, String(v));
  const response = await fetch(url, { headers: { "KALSHI-ACCESS-KEY": keyId, "KALSHI-ACCESS-TIMESTAMP": timestamp, "KALSHI-ACCESS-SIGNATURE": signature(key, timestamp, path2) }, signal: AbortSignal.timeout(2e4) });
  if (!response.ok) throw new Error(`Kalshi respondi\xF3 ${response.status} en ${path2}`);
  return response.json();
}
async function pages(path2, field, keyId, key) {
  let cursor = "", out = [];
  do {
    const data = await request(path2, { limit: 1e3, cursor }, keyId, key);
    if (!Array.isArray(data[field])) throw new Error(`Kalshi no devolvi\xF3 ${field}`);
    out.push(...data[field]);
    cursor = data.cursor || "";
    if (out.length > 1e5) throw new Error("Historial demasiado grande: sincronizaci\xF3n detenida");
  } while (cursor);
  return out;
}
async function fetchHistory(keyId, key) {
  const [current, archived, settlements] = await Promise.all([
    pages("/trade-api/v2/portfolio/fills", "fills", keyId, key),
    pages("/trade-api/v2/historical/fills", "fills", keyId, key),
    pages("/trade-api/v2/portfolio/settlements", "settlements", keyId, key)
  ]);
  const fills = [...new Map([...archived, ...current].map((f) => [f.fill_id, f])).values()];
  return { fills, settlements };
}

// ledger.js
var num = (x) => Number(x ?? 0);
var money = (x) => Math.round(x * 1e4) / 1e4;
var day = (ts, zone) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
function buildLedger(fills, settlements, zone = "America/Chicago") {
  const inv = /* @__PURE__ */ new Map(), events = [], issues = [];
  const history = [
    ...fills.map((f) => ({ type: "fill", date: f.created_time || new Date(num(f.ts) * 1e3).toISOString(), raw: f, id: f.fill_id })),
    ...settlements.map((s) => ({ type: "settlement", date: s.settled_time, raw: s, id: `${s.ticker}:${s.subaccount_number ?? s.subaccount ?? 0}:${s.settled_time}` }))
  ].filter((e) => e.date).sort((a, b) => new Date(a.date) - new Date(b.date) || (a.type === "fill" ? -1 : 1));
  function position(key) {
    if (!inv.has(key)) inv.set(key, { yes: [], no: [] });
    return inv.get(key);
  }
  for (const e of history) {
    const x = e.raw, ticker = x.ticker || x.market_ticker, account = x.subaccount_number ?? x.subaccount ?? 0;
    const key = `${account}:${ticker}`;
    const pos = position(key);
    if (e.type === "fill") {
      const side = x.side || x.outcome_side, action = x.action;
      if (!["yes", "no"].includes(side) || !["buy", "sell"].includes(action)) {
        issues.push(`Operaci\xF3n sin tipo reconocible: ${e.id}`);
        continue;
      }
      const qty = num(x.count_fp ?? x.count), price = num(x[`${side}_price_dollars`] ?? num(x[`${side}_price`]) / 100), fee = num(x.fee_cost ?? x.fee_cost_dollars);
      if (!(qty > 0) || !Number.isFinite(price)) {
        issues.push(`Cantidad o precio inv\xE1lido: ${e.id}`);
        continue;
      }
      if (action === "buy") {
        pos[side].push({ qty, cost: qty * price + fee });
        continue;
      }
      if (pos[side].reduce((sum, lot) => sum + lot.qty, 0) + 1e-6 < qty) {
        issues.push(`Venta sin compra completa en el historial: ${ticker}`);
        continue;
      }
      let left = qty, basis = 0;
      for (const lot of pos[side]) {
        if (left <= 0) break;
        const used = Math.min(left, lot.qty);
        basis += used * (lot.cost / lot.qty);
        lot.qty -= used;
        lot.cost -= used * (lot.cost / (lot.qty + used));
        left -= used;
      }
      pos[side] = pos[side].filter((l) => l.qty > 1e-8);
      if (left > 1e-6) {
        issues.push(`Venta sin compra completa en el historial: ${ticker}`);
        continue;
      }
      events.push({ id: `fill:${e.id}`, date: day(e.date, zone), time: e.date, ticker, kind: "Venta", side, profit: money(qty * price - fee - basis), stake: money(basis), account });
    } else {
      const yes = num(x.yes_count_fp ?? x.yes_count), no = num(x.no_count_fp ?? x.no_count);
      if (pos.yes.reduce((sum, lot) => sum + lot.qty, 0) + 1e-6 < yes || pos.no.reduce((sum, lot) => sum + lot.qty, 0) + 1e-6 < no) {
        issues.push(`Liquidaci\xF3n sin historial completo de compras: ${ticker}`);
        continue;
      }
      let basis = 0, missing = false;
      for (const [side, qty] of [["yes", yes], ["no", no]]) {
        let left = qty;
        for (const lot of pos[side]) {
          if (left <= 0) break;
          const used = Math.min(left, lot.qty);
          const unit = lot.cost / lot.qty;
          basis += used * unit;
          lot.qty -= used;
          lot.cost -= used * unit;
          left -= used;
        }
        pos[side] = pos[side].filter((l) => l.qty > 1e-8);
        if (left > 1e-6) missing = true;
      }
      if (missing) {
        issues.push(`Liquidaci\xF3n sin historial completo de compras: ${ticker}`);
        continue;
      }
      const revenue = num(x.revenue) / 100, fee = num(x.fee_cost ?? x.fee_cost_dollars);
      events.push({ id: `settlement:${e.id}`, date: day(e.date, zone), time: e.date, ticker, kind: "Liquidaci\xF3n", side: x.market_result, profit: money(revenue - fee - basis), stake: money(basis), account });
    }
  }
  const days = /* @__PURE__ */ new Map();
  for (const e of events) {
    const d = days.get(e.date) || { date: e.date, profit: 0, wins: 0, losses: 0, trades: 0 };
    d.profit = money(d.profit + e.profit);
    d.trades++;
    if (e.profit >= 0) d.wins++;
    else d.losses++;
    days.set(e.date, d);
  }
  const open = [...inv.entries()].flatMap(([key, p]) => ["yes", "no"].map((side) => ({ key, side, qty: money(p[side].reduce((a, l) => a + l.qty, 0)), cost: money(p[side].reduce((a, l) => a + l.cost, 0)) }))).filter((p) => p.qty > 0);
  const daily = [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
  return { events: events.sort((a, b) => new Date(b.time) - new Date(a.time)), daily, open, issues: [...new Set(issues)], total: money(events.reduce((a, e) => a + e.profit, 0)) };
}

// mobile-entry.js
var ASSETS = { "app.js": "const $=id=>document.getElementById(id);\nconst money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(n||0);\nconst date=d=>new Intl.DateTimeFormat('es-US',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(d+'T12:00:00Z'));\nlet dashboard, range=7;\nasync function api(url,opts){const r=await fetch(url,{credentials:'same-origin',...opts});const j=await r.json();if(!r.ok)throw Error(j.error||'Ocurri\xF3 un error');return j;}\nconst show=(id)=>{$('login').classList.toggle('hidden',id!=='login');$('shell').classList.toggle('hidden',id!=='shell')};\nconst set=(id,value)=>$(id).textContent=value;\nfunction notice(message){$('notice').textContent=message;$('notice').classList.toggle('hidden',!message)};\nfunction el(tag,className,text){const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=text;return n;}\nfunction chart(data){const holder=$('chart');holder.replaceChildren();if(!data.length){holder.append(el('div','chart-empty','Tu gr\xE1fica aparecer\xE1 cuando sincronices tus primeras operaciones.'));return;}\n  const sorted=[...data].reverse(),start=new Date();start.setDate(start.getDate()-(range-1));const cutoff=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(start);let running=sorted.filter(d=>d.date<cutoff).reduce((a,d)=>a+d.profit,0);const series=sorted.filter(d=>d.date>=cutoff);const points=series.map(d=>({label:d.date,value:(running+=d.profit)}));if(!points.length){holder.append(el('div','chart-empty',`Sin operaciones cerradas en los \xFAltimos ${range} d\xEDas.`));return;}const vals=points.map(p=>p.value);const lo=Math.min(0,...vals),hi=Math.max(0,...vals);const W=600,H=185,pad=18;\n  const x=i=>pad+(points.length===1?0:i*(W-2*pad)/(points.length-1));const y=v=>H-pad-(v-lo)/((hi-lo)||1)*(H-2*pad);const line=points.map((p,i)=>`${i?'L':'M'}${x(i)},${y(p.value)}`).join(' ');const area=`${line} L${x(points.length-1)},${H-pad} L${pad},${H-pad} Z`;\n  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox',`0 0 ${W} 225`);svg.setAttribute('role','img');svg.setAttribute('aria-label','Gr\xE1fico de profit acumulado');\n  function node(name,props){const e=document.createElementNS(ns,name);for(const[k,v]of Object.entries(props))e.setAttribute(k,v);svg.append(e);return e;}\n  for(let i=0;i<4;i++){let gy=pad+i*(H-2*pad)/3;node('line',{x1:pad,x2:W-pad,y1:gy,y2:gy,stroke:'#ebeff2','stroke-dasharray':'4 5'});}\n  node('path',{d:area,fill:'#d5f4e9',opacity:'.65'});node('path',{d:line,fill:'none',stroke:'#38b591','stroke-width':'3','stroke-linejoin':'round','stroke-linecap':'round'});\n  points.forEach((p,i)=>{if(i===points.length-1)node('circle',{cx:x(i),cy:y(p.value),r:5,fill:'#38b591',stroke:'white','stroke-width':3});if(i===0||i===points.length-1||i===Math.floor(points.length/2)){let t=node('text',{x:x(i),y:216,fill:'#9aa7b6','font-size':11,'text-anchor':i===0?'start':i===points.length-1?'end':'middle'});t.textContent=p.label.slice(5);}});holder.append(svg);\n}\nfunction render(d){dashboard=d;show('shell');const events=d.events||[], positive=events.filter(x=>x.profit>=0),negative=events.filter(x=>x.profit<0),profit=d.total||0;\n  set('total',money(profit));set('wins',money(positive.reduce((a,x)=>a+x.profit,0)));set('losses',money(negative.reduce((a,x)=>a+x.profit,0)));set('count',String(events.length));set('winrate',events.length?`${Math.round(100*positive.length/events.length)}%`:'\u2014');set('trendPill',profit>=0?'\u2197 EN POSITIVO':'\u2198 EN NEGATIVO');$('trendPill').classList.toggle('down',profit<0);\n  $('sideDot').classList.toggle('on',d.connected);set('sideStatus',d.connected?'API configurada':'Sin conectar');set('lastSync',d.lastSync?`Actualizado: ${new Intl.DateTimeFormat('es-US',{dateStyle:'short',timeStyle:'short',timeZone:'America/Chicago'}).format(new Date(d.lastSync))}`:'Sin sincronizar');\n  notice(d.lastError?`Error de sincronizaci\xF3n: ${d.lastError}`:d.issues?.length?`Atenci\xF3n: ${d.issues.length} operaci\xF3n(es) necesitan historial adicional. Sus resultados no se incluyen en el total.`:!d.connected?'Falta configurar la conexi\xF3n de Kalshi. Los n\xFAmeros se mostrar\xE1n aqu\xED tras sincronizar.':'');\n  chart(d.daily||[]);const days=$('days');days.replaceChildren();if(!d.daily?.length)days.append(el('div','list-empty','Todav\xEDa no hay d\xEDas con operaciones cerradas.'));else d.daily.slice(0,30).forEach(v=>{const row=el('div','day-row'),icon=el('span','day-square'+(v.profit<0?' negative':''),v.profit<0?'\u2198':'\u2197'),detail=el('div');detail.append(el('strong','',date(v.date)),el('small','',`${v.trades} operaci\xF3n${v.trades===1?'':'es'} \xB7 ${v.wins} positiva${v.wins===1?'':'s'}`));row.append(icon,detail,el('b',v.profit<0?'negative':'',`${v.profit>=0?'+':''}${money(v.profit)}`));days.append(row)});\n  const rows=$('rows');rows.replaceChildren();if(!events.length){const tr=el('tr'),td=el('td','table-empty','Conecta Kalshi para mostrar tus operaciones reales.');td.colSpan=5;tr.append(td);rows.append(tr)}else events.slice(0,100).forEach(v=>{const tr=el('tr');[v.ticker,date(v.date),v.kind,money(v.stake),`${v.profit>=0?'+':''}${money(v.profit)}`].forEach((t,i)=>{const td=el('td',i===4?(v.profit>=0?'positive':'negative'):'',t);if(i===2)td.className='type-tag';tr.append(td)});rows.append(tr)});\n  set('openCount',String(d.open?.length||0));const open=$('openList');open.replaceChildren();if(!d.open?.length)open.textContent='Sin posiciones abiertas registradas.';else d.open.forEach(p=>open.append(el('div','',`${p.key.split(':').slice(1).join(':')} \xB7 ${p.side.toUpperCase()} \xB7 ${p.qty} contratos \xB7 costo ${money(p.cost)}`)));\n}\nasync function load(){try{render(await api('/api/dashboard'))}catch(e){if(e.message==='Inicia sesi\xF3n')show('login');else{show('login');set('loginError',e.message)}}}\n$('loginForm').addEventListener('submit',async e=>{e.preventDefault();set('loginError','');try{await api('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('password').value})});$('password').value='';await load()}catch(err){set('loginError',err.message)}});\n$('sync').addEventListener('click',async()=>{const btn=$('sync');btn.disabled=true;btn.textContent='Sincronizando\u2026';try{await api('/api/sync',{method:'POST'});await load()}catch(e){notice(`No se pudo sincronizar: ${e.message}`)}finally{btn.disabled=false;btn.innerHTML='<span class=\"spin-icon\">\u21BB</span> Sincronizar ahora'}});\n$('logout').addEventListener('click',async()=>{await api('/api/logout',{method:'POST'});show('login')});\ndocument.querySelectorAll('[data-range]').forEach(b=>b.addEventListener('click',()=>{range=Number(b.dataset.range);document.querySelectorAll('[data-range]').forEach(x=>x.classList.toggle('active',x===b));if(dashboard)chart(dashboard.daily||[])}));\nload();\n", "index.html": '<!doctype html>\n<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0a1021"><title>ProfitPulse \u2014 Tu rendimiento real</title><link rel="stylesheet" href="/styles.css"></head>\n<body>\n<div id="login" class="login-wrap hidden"><div class="login-card"><div class="brandmark">\u2197</div><div class="eyebrow">TU PANEL PRIVADO</div><h1>Bienvenido a<br><em>ProfitPulse.</em></h1><p>Un lugar claro para ver lo que realmente ganas y pierdes.</p><form id="loginForm"><label for="password">Contrase\xF1a</label><input id="password" type="password" autocomplete="current-password" placeholder="Introduce tu contrase\xF1a" required><button class="primary" type="submit">Entrar al panel <span>\u2192</span></button><div class="form-error" id="loginError"></div></form><small>Solo t\xFA tienes acceso a este historial.</small></div></div>\n<div id="shell" class="shell hidden">\n  <aside class="sidebar"><a class="logo" href="/"><span class="brandmark">\u2197</span><span>Profit<span class="accent">Pulse</span><small>PERFORMANCE TRACKER</small></span></a><div class="side-label">ESPACIO DE TRABAJO</div><nav><a class="active" href="#overview">\u25EB <span>Resumen</span></a><a href="#history">\u25F7 <span>Historial</span></a><a href="#positions">\u25A5 <span>Posiciones abiertas</span></a></nav><div class="side-bottom"><div class="kalshi-chip"><span class="k-logo">K</span><div><strong>Kalshi</strong><small id="sideStatus">Sin conectar</small></div><span class="dot" id="sideDot"></span></div><button id="logout" class="logout">\u21AA <span>Cerrar sesi\xF3n</span></button></div></aside>\n  <main class="main"><div class="topline"><div class="crumb">MI ESPACIO <span>/</span> RESUMEN</div><div class="top-actions"><span class="live"><i></i> RESULTADOS REALES</span><div class="avatar">JM</div></div></div>\n    <section class="intro" id="overview"><div><div class="section-kicker"><span class="shortline"></span> PANORAMA DE TUS OPERACIONES</div><h1>Tus n\xFAmeros, <em>sin ruido.</em></h1><p>Ganancias, p\xE9rdidas y cada operaci\xF3n en un solo lugar.</p></div><button id="sync" class="sync-button"><span class="spin-icon">\u21BB</span> Sincronizar ahora</button></section>\n    <div class="notice hidden" id="notice"></div>\n    <section class="hero-grid"><article class="hero-card"><div class="card-top"><span>RENDIMIENTO TOTAL</span><span class="hero-icon">\u2197</span></div><div class="hero-value" id="total">$0.00</div><div class="hero-foot"><span id="trendPill" class="trend-pill">\u2014</span><span>profit realizado \xB7 hist\xF3rico</span></div><div class="hero-orbit"></div></article><div class="mini-grid"><article class="mini-card"><div class="mini-icon green">\u2197</div><span>GANANCIAS</span><strong id="wins">$0.00</strong><small>Operaciones positivas</small></article><article class="mini-card"><div class="mini-icon red">\u2198</div><span>P\xC9RDIDAS</span><strong id="losses">$0.00</strong><small>Operaciones negativas</small></article><article class="mini-card"><div class="mini-icon blue">\u25EB</div><span>OPERACIONES CERRADAS</span><strong id="count">0</strong><small>Ventas y liquidaciones</small></article><article class="mini-card"><div class="mini-icon gold">\u25CE</div><span>EFECTIVIDAD</span><strong id="winrate">\u2014</strong><small>Con resultado positivo</small></article></div></section>\n    <section class="lower-grid"><article class="panel chart-panel"><header><div><div class="panel-kicker">EVOLUCI\xD3N</div><h2>Balance en el tiempo</h2></div><div class="segmented"><button class="active" data-range="7">7 d\xEDas</button><button data-range="30">30 d\xEDas</button></div></header><div class="chart-wrap" id="chart"><div class="chart-empty">Tu gr\xE1fica aparecer\xE1 cuando sincronices tus primeras operaciones.</div></div><footer><span class="legend-dot"></span> Profit acumulado <span class="chart-note">Se cuentan posiciones cerradas</span></footer></article><article class="panel activity-panel"><header><div><div class="panel-kicker">ACTIVIDAD</div><h2>\xDAltimos d\xEDas</h2></div><span class="subtle">HORA DE HOUSTON</span></header><div id="days" class="days"><div class="list-empty">Todav\xEDa no hay d\xEDas con operaciones cerradas.</div></div><footer>Los d\xEDas sin operaciones no cuentan como p\xE9rdidas.</footer></article></section>\n    <section class="panel table-panel" id="history"><header><div><div class="panel-kicker">HISTORIAL DETALLADO</div><h2>Cada resultado cuenta.</h2></div><span class="subtle" id="lastSync">Sin sincronizar</span></header><div class="table-scroll"><table><thead><tr><th>MERCADO</th><th>FECHA</th><th>TIPO</th><th>INVERSI\xD3N CERRADA</th><th>RESULTADO NETO</th></tr></thead><tbody id="rows"><tr><td colspan="5" class="table-empty">Conecta Kalshi para mostrar tus operaciones reales.</td></tr></tbody></table></div></section>\n    <section class="positions" id="positions"><div><div class="panel-kicker">EN CURSO</div><h2>Posiciones abiertas <span id="openCount">0</span></h2><p>Las compras abiertas a\xFAn no se incluyen como ganancia o p\xE9rdida realizada.</p></div><div id="openList" class="open-list">Sin posiciones abiertas registradas.</div></section>\n    <footer class="page-footer"><span>PROFITPULSE \xA9 2026</span><span>Los resultados reflejan operaciones cerradas registradas en Kalshi.</span></footer>\n  </main>\n</div><script src="/app.js" defer></script></body></html>\n', "styles.css": ":root{font-family:Manrope,DM Sans,system-ui,sans-serif;color:#172338;background:#f5f7fb;font-synthesis:none}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0}button,input{font:inherit}button{cursor:pointer}.hidden{display:none!important}.accent{color:#7ce4c9}.shell{min-height:100vh;display:flex}.sidebar{background:#0b1428;color:#dae4ee;width:254px;position:sticky;top:0;height:100vh;flex:none;display:flex;flex-direction:column;padding:34px 20px 24px}.logo{text-decoration:none;color:#fff;font-size:18px;font-weight:800;display:flex;gap:11px;align-items:center;margin:0 9px 59px;letter-spacing:-.8px}.logo small{display:block;font-size:9px;letter-spacing:2px;color:#788aa4;margin-top:2px}.brandmark{display:grid;place-items:center;width:38px;height:38px;flex:none;border-radius:11px;background:#73dfc7;color:#09243a;font-weight:800;font-size:27px}.side-label{font-size:9px;font-weight:800;letter-spacing:2.2px;color:#71839f;margin:0 13px 17px}.sidebar nav{display:grid;gap:5px}.sidebar nav a{display:flex;align-items:center;gap:17px;padding:13px 15px;color:#91a2bc;border-radius:10px;font-size:17px;text-decoration:none}.sidebar nav a span{font-size:12px;font-weight:700}.sidebar nav a.active,.sidebar nav a:hover{background:#1a2d46;color:#9eedd7}.side-bottom{margin-top:auto}.kalshi-chip{background:#17263d;border:1px solid #283b55;border-radius:13px;padding:13px;display:flex;gap:10px;align-items:center}.kalshi-chip strong,.kalshi-chip small{display:block}.kalshi-chip strong{font-size:12px;color:#fff}.kalshi-chip small{font-size:10px;color:#a4b5c9;margin-top:2px}.k-logo{background:#ebf5f1;color:#0c5f47;border-radius:8px;width:28px;height:28px;display:grid;place-items:center;font-size:19px;font-weight:800}.dot{width:7px;height:7px;border-radius:50%;background:#e79760;margin-left:auto}.dot.on{background:#6fe0b9}.logout{border:0;background:none;color:#8fa3be;margin:25px 15px 0;text-align:left}.logout span{font-size:12px;margin-left:10px}.main{width:calc(100% - 254px);max-width:1600px;padding:0 46px;margin:auto}.topline{height:82px;border-bottom:1px solid #e9edf2;display:flex;align-items:center;justify-content:space-between}.crumb{font-size:10px;font-weight:800;letter-spacing:1.7px;color:#8591a5}.crumb span{padding:0 11px;color:#c3cbd7}.top-actions{display:flex;align-items:center;gap:24px}.live{color:#548776;font-size:9px;letter-spacing:1.4px;font-weight:800}.live i{display:inline-block;width:6px;height:6px;background:#58ceae;border-radius:50%;margin-right:5px}.avatar{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:#d9e7e3;color:#387461;font-size:11px;font-weight:800}.intro{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin:47px 0 30px}.section-kicker,.panel-kicker{font-size:10px;font-weight:800;color:#2d9e80;letter-spacing:1.6px}.shortline{display:inline-block;width:23px;height:2px;background:#40bc9b;vertical-align:middle;margin-right:7px}.intro h1{font-size:clamp(27px,3vw,38px);letter-spacing:-2.2px;margin:12px 0 8px;color:#14243c}.intro h1 em,.login-card h1 em{font-style:normal;color:#2caf8b}.intro p{color:#8491a4;font-size:12px;margin:0}.sync-button,.primary{border:0;background:#162943;color:white;border-radius:9px;padding:13px 18px;font-size:11px;font-weight:800;white-space:nowrap;box-shadow:0 8px 22px #17294319}.sync-button:hover,.primary:hover{background:#234a60}.spin-icon{font-size:18px;margin-right:8px;vertical-align:-1px}.sync-button:disabled{opacity:.6;cursor:wait}.notice{margin:-12px 0 22px;padding:13px 17px;border-radius:10px;background:#fff2e8;color:#a45329;font-size:11px;border:1px solid #f3dbc7}.hero-grid{display:grid;grid-template-columns:minmax(260px,1fr) minmax(360px,1.15fr);gap:16px}.hero-card{min-height:260px;border-radius:16px;background:linear-gradient(125deg,#10263d,#113c4c 60%,#1e6b67);position:relative;overflow:hidden;color:white;padding:27px 31px;display:flex;flex-direction:column;justify-content:space-between}.hero-card:after{content:'';position:absolute;width:345px;height:345px;border:1px solid #ffffff1b;border-radius:50%;right:-107px;bottom:-239px;box-shadow:0 0 0 65px #ffffff07,0 0 0 128px #ffffff05}.card-top{display:flex;justify-content:space-between;align-items:start;font-size:10px;letter-spacing:1.7px;font-weight:800;color:#a6d7d5;position:relative;z-index:1}.hero-icon{background:#ffffff20;color:#b5f2e4;border-radius:10px;display:grid;place-items:center;width:30px;height:30px;font-size:19px}.hero-value{font-size:clamp(42px,5vw,64px);letter-spacing:-4px;font-weight:800;position:relative;z-index:1}.hero-foot{display:flex;align-items:center;gap:10px;color:#bad4d4;font-size:10px;position:relative;z-index:1}.trend-pill{background:#2c947c;color:#d9fff4;border-radius:5px;padding:6px 8px;font-weight:800}.trend-pill.down{background:#83495a;color:#ffe1e5}.mini-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.mini-card{background:#fff;border:1px solid #ecf0f4;border-radius:14px;padding:19px 21px;box-shadow:0 4px 20px #182b3905;display:flex;flex-direction:column;min-width:0}.mini-icon{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;font-size:17px;margin-bottom:10px}.green{color:#33ae87;background:#e5f8f0}.red{color:#e77776;background:#fff0ef}.blue{color:#5e8bdb;background:#ebf2ff}.gold{color:#d4a45c;background:#fff6e6}.mini-card>span{font-size:9px;letter-spacing:1.1px;color:#8190a2;font-weight:800}.mini-card strong{font-size:25px;letter-spacing:-1.3px;color:#192944;margin-top:5px}.mini-card small{font-size:10px;color:#a2adbb;margin-top:4px}.lower-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(260px,1fr);gap:16px;margin:17px 0}.panel{background:white;border:1px solid #ecf0f4;border-radius:15px;box-shadow:0 5px 24px #182b3905}.panel header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:23px 25px 12px}.panel h2,.positions h2{font-size:16px;letter-spacing:-.5px;margin:6px 0 0;color:#192943}.segmented{display:flex;background:#f4f6f9;padding:3px;border-radius:7px}.segmented button{background:transparent;color:#8694a7;border:0;padding:6px 9px;font-size:9px;font-weight:800;border-radius:5px}.segmented button.active{background:white;color:#2f4a60;box-shadow:0 1px 4px #15283d20}.chart-wrap{height:227px;padding:5px 25px 0}.chart-wrap svg{width:100%;height:100%;overflow:visible}.chart-empty{height:100%;display:grid;place-items:center;text-align:center;color:#a1acb9;font-size:11px;padding:20px}.panel footer{border-top:1px solid #f2f4f6;padding:15px 25px;color:#8793a4;font-size:10px}.legend-dot{display:inline-block;height:7px;width:7px;border-radius:50%;background:#39b795;margin-right:5px}.chart-note{float:right;color:#aeb7c2}.subtle{font-size:9px;letter-spacing:1px;color:#a0acba;font-weight:800}.days{min-height:227px;max-height:227px;overflow:auto;padding:4px 24px}.day-row{display:flex;align-items:center;gap:11px;padding:13px 1px;border-bottom:1px solid #f1f3f6}.day-row:last-child{border:0}.day-square{background:#e9f8f2;color:#33aa83;width:30px;height:30px;display:grid;place-items:center;border-radius:8px;font-size:15px}.day-square.negative{background:#fff0f0;color:#de7479}.day-row strong{display:block;font-size:11px;color:#283a51}.day-row small{font-size:9px;color:#9daabd}.day-row b{margin-left:auto;color:#27a37d;font-size:12px}.day-row b.negative{color:#e56a70}.list-empty{height:210px;display:grid;place-items:center;text-align:center;color:#a1acb9;font-size:11px}.table-panel{margin-bottom:18px}.table-panel header{padding-bottom:22px}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;white-space:nowrap}th{background:#f8fafc;color:#8e9cac;text-align:left;font-size:9px;letter-spacing:1.3px;padding:13px 24px}td{padding:16px 24px;border-top:1px solid #f0f2f5;font-size:11px;color:#657387}td:first-child{font-weight:800;color:#304055}td:last-child{font-weight:800}.positive{color:#27a37d!important}.negative{color:#e56a70!important}.table-empty{text-align:center;color:#a1acb9!important;font-weight:500!important;padding:35px}.type-tag{background:#eef4f8;padding:5px 8px;border-radius:5px;color:#638198;font-size:9px}.positions{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding:25px 4px 35px;border-top:1px solid #e8edf3}.positions h2 span{background:#e8eef2;border-radius:6px;padding:3px 7px;color:#7e91a4;font-size:10px;vertical-align:2px}.positions p{font-size:10px;color:#9ba7b4}.open-list{text-align:right;font-size:11px;color:#9aa7b5;max-height:110px;overflow:auto}.open-list div{padding:4px 0}.page-footer{display:flex;justify-content:space-between;gap:20px;color:#acb6c2;letter-spacing:1px;font-size:9px;padding:18px 0 25px;border-top:1px solid #e8edf3}.login-wrap{min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 70% 20%,#155e65,#0d2338 40%,#0a1427 80%);padding:20px}.login-card{width:min(440px,100%);border-radius:20px;background:#fff;padding:38px;box-shadow:0 20px 90px #0005}.login-card .brandmark{margin-bottom:32px}.eyebrow{font-size:10px;font-weight:800;letter-spacing:2px;color:#39a889}.login-card h1{font-size:35px;letter-spacing:-1.8px;line-height:1.15;margin:15px 0}.login-card p{font-size:12px;color:#8b98a9;margin:0 0 30px}.login-card label{display:block;color:#52627a;font-size:11px;font-weight:800;margin-bottom:9px}.login-card input{border:1px solid #d8e0e9;border-radius:8px;width:100%;padding:13px;outline:none}.login-card input:focus{border-color:#52bd9c}.login-card .primary{margin-top:15px;width:100%;display:flex;justify-content:space-between}.login-card small{display:block;text-align:center;color:#a3aebc;font-size:10px;margin-top:28px}.form-error{color:#d95f65;font-size:11px;margin-top:10px;min-height:15px}@media(max-width:1050px){.main{padding:0 25px}.sidebar{width:210px}.shell .main{width:calc(100% - 210px)}.hero-grid,.lower-grid{grid-template-columns:1fr}.hero-card{min-height:215px}}@media(max-width:690px){.sidebar{width:64px;padding:20px 9px}.sidebar .logo{margin:0 4px 35px}.sidebar .logo>span:last-child,.side-label,.sidebar nav a span,.side-bottom,.logout span{display:none}.sidebar nav a{justify-content:center;padding:11px}.shell .main{width:calc(100% - 64px);padding:0 16px}.topline{height:61px}.top-actions{gap:9px}.live{font-size:8px}.intro{align-items:start;flex-direction:column;margin:31px 0 22px}.intro h1{letter-spacing:-1.3px}.sync-button{width:100%}.mini-grid{gap:8px}.mini-card{padding:13px}.mini-card strong{font-size:19px}.mini-card>span{font-size:8px}.hero-card{min-height:205px;padding:21px}.hero-value{font-size:43px}.panel header{padding:19px 17px 12px}.chart-wrap{padding:5px 16px 0}.days{padding:4px 17px}.positions{flex-direction:column}.open-list{text-align:left}.page-footer{font-size:8px}.page-footer span:last-child{display:none}}\n" };
var root = path.dirname(fileURLToPath(import.meta.url));
var { APP_PASSWORD, SESSION_SECRET, DATABASE_URL, KALSHI_KEY_ID, KALSHI_PRIVATE_KEY } = process.env;
if (!APP_PASSWORD || !SESSION_SECRET || !DATABASE_URL || SESSION_SECRET.length < 32) throw new Error("Configura APP_PASSWORD, SESSION_SECRET (32 caracteres m\xEDnimo) y DATABASE_URL");
var pool = new pg.Pool({ connectionString: DATABASE_URL });
await pool.query(`CREATE TABLE IF NOT EXISTS kalshi_records (kind text NOT NULL, record_id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(kind,record_id))`);
await pool.query(`CREATE TABLE IF NOT EXISTS app_state (key text PRIMARY KEY, value text NOT NULL)`);
var MAC = (value) => createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
var equal = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
var auth = (req) => {
  const token = (req.headers.cookie || "").match(/(?:^|;\s*)session=([^;]+)/)?.[1];
  if (!token) return false;
  const [expiry, sig] = token.split(".");
  return Number(expiry) > Date.now() && equal(sig || "", MAC(expiry));
};
var json = (res, code, value) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
};
var body = async (req) => {
  let s = "";
  for await (const b of req) {
    s += b;
    if (s.length > 1e4) throw Error("Solicitud demasiado grande");
  }
  return JSON.parse(s || "{}");
};
var syncing = false;
var lastError = "";
var attempts = /* @__PURE__ */ new Map();
async function sync() {
  if (syncing) return { busy: true };
  if (!KALSHI_KEY_ID || !KALSHI_PRIVATE_KEY) throw Error("Faltan KALSHI_KEY_ID y KALSHI_PRIVATE_KEY");
  syncing = true;
  try {
    const { fills, settlements } = await fetchHistory(KALSHI_KEY_ID, KALSHI_PRIVATE_KEY);
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      for (const f of fills) if (f.fill_id) await db.query("INSERT INTO kalshi_records VALUES ($1,$2,$3) ON CONFLICT(kind,record_id) DO UPDATE SET data=excluded.data", ["fill", f.fill_id, f]);
      for (const s of settlements) {
        const id = `${s.ticker}:${s.subaccount_number ?? s.subaccount ?? 0}:${s.settled_time}`;
        await db.query("INSERT INTO kalshi_records VALUES ($1,$2,$3) ON CONFLICT(kind,record_id) DO UPDATE SET data=excluded.data", ["settlement", id, s]);
      }
      await db.query("INSERT INTO app_state VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", ["last_sync", (/* @__PURE__ */ new Date()).toISOString()]);
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
    lastError = "";
    return { fills: fills.length, settlements: settlements.length };
  } catch (e) {
    lastError = e.message;
    throw e;
  } finally {
    syncing = false;
  }
}
var server = http.createServer(async (req, res) => {
  try {
    const route = new URL(req.url, "http://localhost").pathname;
    res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (route === "/health") return json(res, 200, { ok: true });
    if (route === "/api/login" && req.method === "POST") {
      const ip = req.socket.remoteAddress || "unknown", a = attempts.get(ip) || { count: 0, until: 0 };
      if (a.until > Date.now()) return json(res, 429, { error: "Demasiados intentos. Int\xE9ntalo m\xE1s tarde." });
      const { password } = await body(req);
      if (!equal(String(password || ""), APP_PASSWORD)) {
        a.count++;
        if (a.count >= 5) {
          a.count = 0;
          a.until = Date.now() + 15 * 6e4;
        }
        attempts.set(ip, a);
        return json(res, 401, { error: "Contrase\xF1a incorrecta" });
      }
      attempts.delete(ip);
      const expiry = String(Date.now() + 7 * 864e5);
      res.setHeader("Set-Cookie", `session=${expiry}.${MAC(expiry)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
      return json(res, 200, { ok: true });
    }
    if (route === "/api/logout" && req.method === "POST") {
      res.setHeader("Set-Cookie", "session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
      return json(res, 200, { ok: true });
    }
    if (route.startsWith("/api/")) {
      if (!auth(req)) return json(res, 401, { error: "Inicia sesi\xF3n" });
      if (req.method === "POST" && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { error: "Origen inv\xE1lido" });
      if (route === "/api/sync" && req.method === "POST") return json(res, 200, await sync());
      if (route === "/api/dashboard" && req.method === "GET") {
        const rows = await pool.query("SELECT kind,data FROM kalshi_records");
        const fills = rows.rows.filter((r) => r.kind === "fill").map((r) => r.data), settlements = rows.rows.filter((r) => r.kind === "settlement").map((r) => r.data);
        const last = await pool.query("SELECT value FROM app_state WHERE key='last_sync'");
        return json(res, 200, { ...buildLedger(fills, settlements, process.env.TZ_DISPLAY || "America/Chicago"), lastSync: last.rows[0]?.value || null, connected: !!(KALSHI_KEY_ID && KALSHI_PRIVATE_KEY), syncing, lastError });
      }
      return json(res, 404, { error: "No encontrado" });
    }
    if (req.method !== "GET") return json(res, 405, { error: "M\xE9todo inv\xE1lido" });
    const files = { "/": "index.html", "/styles.css": "styles.css", "/app.js": "app.js" };
    const name = files[route];
    if (!name) return json(res, 404, { error: "No encontrado" });
    const data = Buffer.from(ASSETS[name]);
    res.writeHead(200, { "Content-Type": name.endsWith(".css") ? "text/css; charset=utf-8" : name.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(data);
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});
server.listen(Number(process.env.PORT) || 3e3, "0.0.0.0");
if (KALSHI_KEY_ID && KALSHI_PRIVATE_KEY) {
  setTimeout(() => sync().catch((e) => console.error("Sync:", e.message)), 2e3);
  setInterval(() => sync().catch((e) => console.error("Sync:", e.message)), 4 * 60 * 60 * 1e3).unref();
}
