// profitpulse-v2/mobile-entry.js
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import pg from "pg";

// profitpulse-v2/kalshi.js
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
  const accounts = [.../* @__PURE__ */ new Set([0, ...fills.map((f) => f.subaccount_number ?? f.subaccount ?? 0), ...settlements.map((s) => s.subaccount_number ?? s.subaccount ?? 0)])];
  const positions = (await Promise.all(accounts.map(
    async (subaccount) => (await positionPages(subaccount, keyId, key)).map((p) => ({ ...p, subaccount_number: subaccount }))
  ))).flat();
  return { fills, settlements, positions };
}
async function positionPages(subaccount, keyId, key) {
  let cursor = "", out = [];
  do {
    const data = await request("/trade-api/v2/portfolio/positions", { limit: 1e3, cursor, count_filter: "position", subaccount }, keyId, key);
    if (!Array.isArray(data.market_positions)) throw Error("Kalshi no devolvi\xF3 market_positions");
    out.push(...data.market_positions);
    cursor = data.cursor || "";
    if (out.length > 1e5) throw Error("Demasiadas posiciones");
  } while (cursor);
  return out;
}

// profitpulse-v2/ledger.js
var num = (x) => Number(x ?? 0);
var money = (x) => Math.round(x * 1e4) / 1e4;
var day = (ts, zone) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
function buildLedger(fills, settlements, zone = "America/Chicago", positions = null) {
  const inv = /* @__PURE__ */ new Map(), events = [], issues = [], unresolved = [];
  const problem = (reason, e, ticker) => {
    issues.push(`${reason}: ${ticker || e.id}`);
    unresolved.push({ id: `${e.type}:${e.id}`, ticker: ticker || "Sin mercado", date: day(e.date, zone), reason });
  };
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
        problem("Tipo no reconocido", e, ticker);
        continue;
      }
      const qty = num(x.count_fp ?? x.count), price = num(x[`${side}_price_dollars`] ?? num(x[`${side}_price`]) / 100), fee = num(x.fee_cost ?? x.fee_cost_dollars);
      if (!(qty > 0) || !Number.isFinite(price)) {
        problem("Cantidad o precio inv\xE1lido", e, ticker);
        continue;
      }
      if (action === "buy") {
        pos[side].push({ qty, cost: qty * price + fee });
        continue;
      }
      if (pos[side].reduce((sum, lot) => sum + lot.qty, 0) + 1e-6 < qty) {
        problem("Venta sin compra completa", e, ticker);
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
        problem("Venta sin compra completa", e, ticker);
        continue;
      }
      events.push({ id: `fill:${e.id}`, date: day(e.date, zone), time: e.date, ticker, kind: "Venta", side, profit: money(qty * price - fee - basis), stake: money(basis), account });
    } else {
      const yes = num(x.yes_count_fp ?? x.yes_count), no = num(x.no_count_fp ?? x.no_count);
      if (pos.yes.reduce((sum, lot) => sum + lot.qty, 0) + 1e-6 < yes || pos.no.reduce((sum, lot) => sum + lot.qty, 0) + 1e-6 < no) {
        problem("Liquidaci\xF3n sin compras completas", e, ticker);
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
        problem("Liquidaci\xF3n sin compras completas", e, ticker);
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
  const open = positions === null ? [] : positions.map((p) => {
    const signed = num(p.position_fp ?? p.position);
    return { key: `${p.subaccount_number ?? 0}:${p.ticker}`, side: signed >= 0 ? "yes" : "no", qty: money(Math.abs(signed)), cost: money(num(p.market_exposure_dollars ?? num(p.market_exposure) / 100)), account: p.subaccount_number ?? 0 };
  }).filter((p) => p.qty > 0);
  const daily = [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
  const issueStats = unresolved.reduce((a, p) => (a[p.reason] = (a[p.reason] || 0) + 1, a), {});
  return { events: events.sort((a, b) => new Date(b.time) - new Date(a.time)), daily, open, issues, unresolved, issueStats, excludedCount: unresolved.length, partial: unresolved.length > 0, total: money(events.reduce((a, e) => a + e.profit, 0)) };
}

// profitpulse-v2/mobile-entry.js
var ASSETS = { "app.js": "const $=id=>document.getElementById(id);\nconst cash=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(n)||0);\nconst labelDate=d=>new Intl.DateTimeFormat('es-US',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(d+'T12:00:00Z'));\nconst shortDate=d=>new Intl.DateTimeFormat('es-US',{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(d+'T12:00:00Z'));\nconst signed=n=>`${n>=0?'+':''}${cash(n)}`;\nconst el=(tag,cls='',text)=>{const x=document.createElement(tag);if(cls)x.className=cls;if(text!==undefined)x.textContent=text;return x};\nlet state=null,range=7,filter='all',query='',dayLimit=10,closedLimit=10;\nasync function api(url,opts){const r=await fetch(url,{credentials:'same-origin',...opts}),j=await r.json();if(!r.ok)throw Error(j.error||'No se pudo completar');return j}\nfunction show(which){$('login').classList.toggle('hidden',which!=='login');$('shell').classList.toggle('hidden',which!=='shell')}\nfunction notice(message){$('notice').textContent=message;$('notice').classList.toggle('hidden',!message)}\nfunction set(id,value){$(id).textContent=value}\nfunction row(item){const node=el('div','entry'),left=el('div');left.append(el('strong','',item.ticker||'Mercado sin nombre'),el('small','',`${item.kind} \xB7 ${item.side?.toUpperCase()||''} \xB7 ${shortDate(item.date)}`));node.append(left,el('div','invest',`Invertido ${cash(item.stake)}`),el('div',`value ${item.profit<0?'down':'up'}`,signed(item.profit)));return node}\nfunction chart(daily){const holder=$('chart');holder.replaceChildren();if(!daily.length){holder.append(el('div','chart-empty','La gr\xE1fica aparecer\xE1 cuando Kalshi registre un resultado cerrado.'));return}\n  const chronological=[...daily].reverse(),today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());const cutoff=new Date(today+'T12:00:00Z');cutoff.setUTCDate(cutoff.getUTCDate()-(range-1));const key=cutoff.toISOString().slice(0,10);\n  let running=chronological.filter(x=>x.date<key).reduce((a,x)=>a+x.profit,0);const visible=chronological.filter(x=>x.date>=key);if(!visible.length){holder.append(el('div','chart-empty',`Sin cierres en los \xFAltimos ${range} d\xEDas.`));return}const points=visible.map(x=>({date:x.date,value:(running+=x.profit)})),vals=points.map(x=>x.value),lo=Math.min(0,...vals),hi=Math.max(0,...vals),W=600,H=200,pad=20;\n  const x=i=>pad+(points.length===1?(W-2*pad)/2:i*(W-2*pad)/(points.length-1)),y=v=>H-pad-(v-lo)/((hi-lo)||1)*(H-2*pad);const path=points.map((p,i)=>`${i?'L':'M'}${x(i)},${y(p.value)}`).join(' ');const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 600 228');svg.setAttribute('role','img');svg.setAttribute('aria-label','Balance acumulado por d\xEDa');function node(tag,props){const n=document.createElementNS('http://www.w3.org/2000/svg',tag);Object.entries(props).forEach(([k,v])=>n.setAttribute(k,v));svg.append(n);return n}\n  for(let i=0;i<4;i++){let yy=pad+i*(H-2*pad)/3;node('line',{x1:pad,x2:W-pad,y1:yy,y2:yy,stroke:'#e7edee','stroke-dasharray':'4 5'})}node('path',{d:`${path} L${x(points.length-1)},${H-pad} L${x(0)},${H-pad} Z`,fill:'#d7f2e8'});node('path',{d:path,fill:'none',stroke:'#22a783','stroke-width':3,'stroke-linejoin':'round'});node('circle',{cx:x(points.length-1),cy:y(points.at(-1).value),r:5,fill:'#22a783',stroke:'#fff','stroke-width':3});[0,Math.floor((points.length-1)/2),points.length-1].filter((v,i,a)=>a.indexOf(v)===i).forEach(i=>{const t=node('text',{x:x(i),y:222,fill:'#8399a1','font-size':11,'text-anchor':i===0?'start':i===points.length-1?'end':'middle'});t.textContent=shortDate(points[i].date)});holder.append(svg)\n}\nfunction days(d){const host=$('dailyList');host.replaceChildren();if(!d.daily?.length){host.append(el('div','card empty','A\xFAn no hay cierres con fecha para mostrar.'));return}const grouped=Map.groupBy?Map.groupBy(d.events,e=>e.date):d.events.reduce((m,e)=>(m.set(e.date,[...(m.get(e.date)||[]),e]),m),new Map());d.daily.slice(0,dayLimit).forEach(v=>{const detail=el('details','day-card'),head=el('summary','day-summary'),icon=el('span',`day-icon ${v.profit<0?'loss':''}`,v.profit<0?'\u2198':'\u2197'),info=el('div','day-info');info.append(el('strong','',labelDate(v.date)),el('small','',`${v.trades} cierre${v.trades===1?'':'s'} \xB7 ${v.wins} positivo${v.wins===1?'':'s'} \xB7 ${v.losses} negativo${v.losses===1?'':'s'}`));head.append(icon,info,el('b',`day-amount ${v.profit<0?'down':'up'}`,signed(v.profit)),el('span','chevron','\u2304'));const entries=el('div','day-entries');(grouped.get(v.date)||[]).forEach(e=>entries.append(row(e)));detail.append(head,entries);host.append(detail)});$('moreDays').classList.toggle('hidden',dayLimit>=d.daily.length)}\nfunction closed(d){const host=$('closedList');host.replaceChildren();let records=d.events||[];if(filter==='win')records=records.filter(e=>e.profit>0);if(filter==='loss')records=records.filter(e=>e.profit<0);if(query)records=records.filter(e=>String(e.ticker||'').toLowerCase().includes(query));if(!records.length){host.append(el('div','card empty','No hay cierres con este filtro.'));$('moreClosed').classList.add('hidden');return}const byDay=new Map();records.forEach(e=>byDay.set(e.date,[...(byDay.get(e.date)||[]),e]));[...byDay].slice(0,closedLimit).forEach(([date,items])=>{const card=el('article','closed-day'),head=el('header'),name=el('div');name.append(el('strong','',labelDate(date)),el('small','',`${items.length} resultado${items.length===1?'':'s'} cerrado${items.length===1?'':'s'}`));const sum=items.reduce((a,e)=>a+e.profit,0);head.append(name,el('b',sum<0?'down':'up',signed(sum)));card.append(head);items.forEach(e=>card.append(row(e)));host.append(card)});$('moreClosed').classList.toggle('hidden',closedLimit>=byDay.size)}\nfunction open(d){const host=$('openList');host.replaceChildren();const positions=d.open||[];set('openCount',String(positions.length));set('openBadge',`${positions.length} abierta${positions.length===1?'':'s'}`);if(!positions.length){host.append(el('div','card empty','Kalshi no informa posiciones abiertas en este momento.'));return}positions.forEach(p=>{const card=el('article','open-card');card.append(el('span','status','\u25CF EN CURSO'),el('h3','',p.key.split(':').slice(1).join(':')));const meta=el('div','open-meta');meta.append(el('span','',`${p.side.toUpperCase()} \xB7 ${p.qty} contrato${p.qty===1?'':'s'}`),el('b','',cash(p.cost)));card.append(meta);host.append(card)})}\nfunction review(d){const list=d.unresolved||[],host=$('reviewList');set('reviewCount',String(list.length));$('review').classList.toggle('hidden',!list.length);if(!list.length)return;set('reviewBadge',`${list.length} registro${list.length===1?'':'s'}`);$('reviewSummary').replaceChildren();Object.entries(d.issueStats||{}).forEach(([why,n])=>$('reviewSummary').append(el('span','review-chip',`${why}: ${n}`)));host.replaceChildren();list.slice(0,100).forEach(v=>{const line=el('div','review-line');line.append(el('strong','',v.ticker),el('span','',`${shortDate(v.date)} \xB7 ${v.reason}`));host.append(line)});if(list.length>100)host.append(el('p','tiny',`Se muestran 100 de ${list.length} registros pendientes.`))}\nfunction render(d){state=d;show('shell');const events=d.events||[],wins=events.filter(e=>e.profit>0),losses=events.filter(e=>e.profit<0);set('total',cash(d.total));set('wins',cash(wins.reduce((a,e)=>a+e.profit,0)));set('losses',cash(losses.reduce((a,e)=>a+e.profit,0)));set('closedCount',String(events.length));set('dayCount',String(d.daily?.length||0));set('closedBadge',`${events.length} cierre${events.length===1?'':'s'}`);$('partialTag').classList.toggle('hidden',!d.partial);set('totalCaption',d.partial?'C\xE1lculo parcial \xB7 registros sin conciliar fuera del total':'Resultado realizado \xB7 posiciones cerradas');$('connectionDot').classList.toggle('on',d.connected);set('connectionText',d.connected?'Kalshi conectado':'Sin conectar');set('lastSync',d.lastSync?`\xDAltima actualizaci\xF3n: ${new Intl.DateTimeFormat('es-US',{timeZone:'America/Chicago',dateStyle:'short',timeStyle:'short'}).format(new Date(d.lastSync))}`:'Sin sincronizar');notice(d.lastError?`Error de sincronizaci\xF3n: ${d.lastError}`:d.partial?`${d.excludedCount} registros no se pudieron conciliar. El balance mostrado es parcial; revisa la secci\xF3n \u201CPor conciliar\u201D.`:!d.connected?'Falta configurar Kalshi para importar tus operaciones.':'');chart(d.daily||[]);days(d);closed(d);open(d);review(d)}\nasync function load(){try{render(await api('/api/dashboard'))}catch(e){if(e.message==='Inicia sesi\xF3n')show('login');else{show('login');set('loginError',e.message)}}}\n$('loginForm').addEventListener('submit',async e=>{e.preventDefault();set('loginError','');try{await api('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('password').value})});$('password').value='';await load()}catch(err){set('loginError',err.message)}});\n$('sync').addEventListener('click',async()=>{const b=$('sync');b.disabled=true;b.textContent='Sincronizando\u2026';try{await api('/api/sync',{method:'POST'});await load()}catch(e){notice(`No se pudo sincronizar: ${e.message}`)}finally{b.disabled=false;b.textContent='\u21BB   Sincronizar Kalshi'}});\n$('logout').addEventListener('click',async()=>{await api('/api/logout',{method:'POST'});show('login')});$('moreDays').addEventListener('click',()=>{dayLimit+=10;days(state)});$('moreClosed').addEventListener('click',()=>{closedLimit+=10;closed(state)});$('search').addEventListener('input',e=>{query=e.target.value.trim().toLowerCase();closedLimit=10;closed(state)});document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{filter=b.dataset.filter;closedLimit=10;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('selected',x===b));closed(state)}));document.querySelectorAll('[data-range]').forEach(b=>b.addEventListener('click',()=>{range=Number(b.dataset.range);document.querySelectorAll('[data-range]').forEach(x=>x.classList.toggle('selected',x===b));if(state)chart(state.daily||[])}));document.querySelectorAll('[data-nav]').forEach(a=>a.addEventListener('click',()=>{document.querySelectorAll('[data-nav]').forEach(x=>x.classList.toggle('current',x.dataset.nav===a.dataset.nav))}));load();\n", "index.html": '<!doctype html>\n<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0b1824"><title>ProfitPulse \xB7 Registro Kalshi</title><link rel="stylesheet" href="/styles.css"></head>\n<body>\n<div id="login" class="login-view hidden"><div class="login-box"><div class="brand"><span class="mark">\u2197</span><span>Profit<span class="mint">Pulse</span></span></div><span class="eyebrow">TU REGISTRO PERSONAL</span><h1>Tu rendimiento,<br>con claridad.</h1><p>Un espacio privado para seguir tus ganancias, p\xE9rdidas y posiciones de Kalshi.</p><form id="loginForm"><label for="password">Contrase\xF1a</label><input id="password" type="password" autocomplete="current-password" placeholder="Tu contrase\xF1a" required><button class="primary" type="submit">Entrar al panel <span>\u2192</span></button><div id="loginError" class="error" role="alert"></div></form></div></div>\n<div id="shell" class="shell hidden">\n<header class="topbar"><div class="top-inner"><a class="brand" href="#inicio"><span class="mark">\u2197</span><span>Profit<span class="mint">Pulse</span></span></a><nav class="desktop-nav" aria-label="Secciones"><a href="#inicio" data-nav="inicio" class="current">Resumen</a><a href="#dias" data-nav="dias">Por d\xEDa</a><a href="#cerradas" data-nav="cerradas">Cerradas</a><a href="#abiertas" data-nav="abiertas">Abiertas</a></nav><div class="top-right"><span class="connection"><i id="connectionDot"></i><span id="connectionText">Kalshi</span></span><button id="logout" class="quiet" type="button" title="Cerrar sesi\xF3n">Salir</button></div></div></header>\n<main>\n<section id="inicio" class="welcome"><div><div class="eyebrow"><span class="rule"></span> TU PANEL DE RENDIMIENTO</div><h1>Cada resultado<br><em>en su lugar.</em></h1><p>Ve lo que cerraste, lo que sigue abierto y c\xF3mo cambi\xF3 tu balance cada d\xEDa.</p></div><div class="welcome-action"><button id="sync" class="sync" type="button">\u21BB &nbsp; Sincronizar Kalshi</button><span id="lastSync">Sin sincronizar</span></div></section>\n<div id="notice" class="notice hidden" role="status"></div>\n<section class="stat-grid" aria-label="Resumen"><article class="stat stat-main"><div class="stat-label">RESULTADO REALIZADO <span id="partialTag" class="partial hidden">PARCIAL</span></div><strong id="total">$0.00</strong><p id="totalCaption">Suma de apuestas cerradas con datos completos</p><div class="stat-accent"></div></article><article class="stat"><span class="stat-label">GANANCIAS</span><strong id="wins" class="up">$0.00</strong><small>Resultados positivos cerrados</small></article><article class="stat"><span class="stat-label">P\xC9RDIDAS</span><strong id="losses" class="down">$0.00</strong><small>Resultados negativos cerrados</small></article><article class="stat"><span class="stat-label">EN JUEGO</span><strong id="openCount">0</strong><small>Posiciones abiertas en Kalshi</small></article></section>\n<section class="two-col"><article class="card chart-card"><div class="card-header"><div><span class="kicker">EVOLUCI\xD3N</span><h2>Tu balance en el tiempo</h2></div><div class="segmented" aria-label="Rango de gr\xE1fica"><button type="button" data-range="7" class="selected">7 d\xEDas</button><button type="button" data-range="30">30 d\xEDas</button></div></div><div id="chart" class="chart"></div><div class="card-foot">\u25CF &nbsp; Resultado realizado acumulado <span>Hora de Houston</span></div></article><article class="card today-card"><span class="kicker">EN PERSPECTIVA</span><h2>Tu actividad</h2><div class="today-row"><div>Operaciones cerradas <small>Con resultado conciliado</small></div><b id="closedCount">0</b></div><div class="today-row"><div>D\xEDas con resultados <small>Ganancias y p\xE9rdidas por fecha</small></div><b id="dayCount">0</b></div><div class="today-row"><div>Por revisar <small>No incluidos en el balance</small></div><b id="reviewCount">0</b></div><p class="tiny">Una compra abierta no es una p\xE9rdida realizada. El resultado se registra al cerrar o liquidar la posici\xF3n.</p></article></section>\n<section id="dias" class="section"><div class="section-head"><div><span class="kicker">DIARIO</span><h2>Resultados d\xEDa por d\xEDa</h2><p>Cada fecha muestra su balance y las operaciones cerradas ese d\xEDa.</p></div><span class="timezone">AMERICA / CHICAGO</span></div><div id="dailyList" class="daily-list"></div><button id="moreDays" class="more hidden" type="button">Ver m\xE1s d\xEDas \u2193</button></section>\n<section id="cerradas" class="section"><div class="section-head"><div><span class="kicker">HISTORIAL</span><h2>Apuestas cerradas</h2><p>Separadas por d\xEDa. La inversi\xF3n y el resultado se muestran por cierre.</p></div><span id="closedBadge" class="count-badge">0 cierres</span></div><div class="filters"><div class="filter-tabs" aria-label="Filtrar resultados"><button class="selected" data-filter="all" type="button">Todas</button><button data-filter="win" type="button">Ganadas</button><button data-filter="loss" type="button">Perdidas</button></div><input id="search" type="search" placeholder="Buscar mercado" aria-label="Buscar mercado"></div><div id="closedList" class="closed-list"></div><button id="moreClosed" class="more hidden" type="button">Ver m\xE1s cierres \u2193</button></section>\n<section id="abiertas" class="section"><div class="section-head"><div><span class="kicker">EN CURSO</span><h2>Apuestas abiertas</h2><p>Posiciones activas consultadas directamente a Kalshi. No cuentan en el resultado realizado.</p></div><span id="openBadge" class="count-badge">0 abiertas</span></div><div id="openList" class="open-grid"></div></section>\n<section id="review" class="section hidden"><div class="section-head"><div><span class="kicker amber">PENDIENTES</span><h2>Resultados por conciliar</h2><p>Falta informaci\xF3n de compras para calcularlos con confianza. Se mantienen fuera del total.</p></div><span id="reviewBadge" class="count-badge amber">0 registros</span></div><div id="reviewSummary" class="review-summary"></div><details class="review-details"><summary>Ver mercados pendientes</summary><div id="reviewList"></div></details></section>\n<footer class="footer"><span>PROFITPULSE \xB7 REGISTRO PRIVADO</span><span>Datos de Kalshi \xB7 Los importes parciales pueden variar al conciliar el historial.</span></footer>\n</main>\n<nav class="mobile-nav" aria-label="Secciones"><a href="#inicio" data-nav="inicio" class="current"><span>\u25C8</span>Resumen</a><a href="#dias" data-nav="dias"><span>\u25A6</span>Por d\xEDa</a><a href="#cerradas" data-nav="cerradas"><span>\u2713</span>Cerradas</a><a href="#abiertas" data-nav="abiertas"><span>\u25CE</span>Abiertas</a></nav>\n</div><script src="/app.js" defer></script></body></html>\n', "styles.css": ":root{font-family:DM Sans,system-ui,sans-serif;color:#172634;background:#f4f7f8;font-synthesis:none}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0}button,input{font:inherit}button{cursor:pointer}button:focus-visible,a:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid #27ac90;outline-offset:3px}.hidden{display:none!important}.shell{min-height:100vh}.topbar{background:#0b1927;color:#e8f4f2;position:sticky;top:0;z-index:5;box-shadow:0 5px 25px #0b19271c}.top-inner{max-width:1240px;margin:auto;height:74px;padding:0 28px;display:flex;align-items:center;gap:40px}.brand{display:flex;align-items:center;gap:10px;color:#fff;text-decoration:none;font-family:Manrope,sans-serif;font-weight:800;font-size:19px;letter-spacing:-.7px;white-space:nowrap}.mint{color:#67ddbe}.mark{height:34px;width:34px;border-radius:10px;background:#78e2c7;color:#0e2f37;display:grid;place-items:center;font-size:22px}.desktop-nav{display:flex;align-items:center;gap:7px;margin:auto}.desktop-nav a{color:#92aab8;text-decoration:none;font-size:12px;font-weight:700;padding:10px 14px;border-radius:8px}.desktop-nav a:hover,.desktop-nav a.current{color:#e8fff6;background:#203a46}.top-right{display:flex;align-items:center;gap:18px;margin-left:auto}.connection{font-size:11px;white-space:nowrap;color:#a9c2bf}.connection i{display:inline-block;width:7px;height:7px;background:#e4a477;border-radius:50%;margin-right:7px}.connection i.on{background:#53d7ae}.quiet{background:none;border:1px solid #385061;border-radius:7px;color:#b4cfcc;padding:8px 12px;font-size:11px}.quiet:hover{background:#233e4b}main{max-width:1240px;padding:0 28px 60px;margin:auto}.eyebrow,.kicker,.stat-label{font-size:10px;font-weight:800;letter-spacing:1.7px}.eyebrow,.kicker{color:#258c78}.rule{display:inline-block;width:24px;height:2px;background:#33b595;vertical-align:middle;margin-right:8px}.welcome{padding:51px 0 31px;display:flex;justify-content:space-between;align-items:end;gap:24px}.welcome h1{font-family:Manrope,sans-serif;font-weight:800;font-size:clamp(32px,4vw,48px);letter-spacing:-2.1px;line-height:1.13;margin:14px 0 11px}.welcome h1 em{font-style:normal;color:#2baa8b}.welcome p,.section-head p{color:#758695;font-size:13px;margin:0;line-height:1.6}.welcome-action{display:flex;align-items:flex-end;flex-direction:column;gap:9px}.sync,.primary{border:0;border-radius:9px;background:#0e3141;color:#fff;font-weight:800;font-size:12px;padding:14px 21px;white-space:nowrap;box-shadow:0 8px 20px #12323f1b}.sync:hover,.primary:hover{background:#165261}.sync:disabled{opacity:.6}.welcome-action span{color:#8798a6;font-size:10px}.notice{border:1px solid #eed8bb;background:#fff8ed;color:#855b29;border-radius:11px;padding:14px 17px;margin:0 0 20px;font-size:12px;line-height:1.5}.stat-grid{display:grid;grid-template-columns:1.7fr repeat(3,1fr);gap:13px}.stat{border-radius:15px;border:1px solid #e3eaee;background:#fff;padding:24px 22px;display:flex;flex-direction:column;min-height:157px;box-shadow:0 5px 25px #16313a05}.stat-label{color:#82949f}.stat strong{font-family:Manrope,sans-serif;font-size:27px;letter-spacing:-1.4px;margin:auto 0 0;white-space:nowrap}.stat small{color:#91a0a8;font-size:10px;margin-top:5px}.stat-main{background:#103345;color:#fff;border:0;position:relative;overflow:hidden}.stat-main:after{content:'';position:absolute;right:-60px;bottom:-170px;width:310px;height:310px;border-radius:50%;border:1px solid #fff2;box-shadow:0 0 0 60px #ffffff08,0 0 0 120px #ffffff05}.stat-main .stat-label{color:#a2d4cb;z-index:1}.stat-main strong{font-size:clamp(30px,3.3vw,46px);z-index:1;letter-spacing:-2px}.stat-main p{font-size:10px;color:#b5d9d0;z-index:1;margin:0}.partial{border:1px solid #f2cb7e;color:#ffe6a9;border-radius:4px;padding:3px 5px;margin-left:4px;font-size:9px;letter-spacing:1px}.up{color:#188e72}.down{color:#d4646a}.two-col{display:grid;grid-template-columns:1.6fr 1fr;gap:15px;margin:16px 0 48px}.card{border:1px solid #e3eaee;background:#fff;border-radius:15px;box-shadow:0 5px 25px #16313a05}.card-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:24px 25px 0}.card h2,.section-head h2{font-family:Manrope,sans-serif;font-size:18px;letter-spacing:-.65px;margin:5px 0 0}.segmented,.filter-tabs{display:flex;border-radius:8px;background:#edf2f3;padding:3px}.segmented button,.filter-tabs button{border:0;background:transparent;color:#788995;font-size:11px;font-weight:700;padding:7px 10px;border-radius:6px}.segmented .selected,.filter-tabs .selected{color:#143f46;background:#fff;box-shadow:0 1px 5px #152b3a16}.chart{height:235px;padding:8px 25px}.chart svg{height:100%;width:100%;overflow:visible}.chart-empty,.empty{color:#8da0a9;font-size:12px;text-align:center;padding:34px 15px;line-height:1.6}.chart-empty{display:grid;place-items:center;height:100%}.card-foot{border-top:1px solid #edf1f2;padding:14px 25px;color:#59b899;font-size:10px}.card-foot span{float:right;color:#9aabb3}.today-card{padding:24px 25px}.today-card h2{margin-bottom:20px}.today-row{border-top:1px solid #edf1f2;padding:14px 0;display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:700}.today-row small{display:block;color:#93a1a9;font-size:10px;font-weight:400;margin-top:3px}.today-row b{font-family:Manrope,sans-serif;font-size:22px;color:#163d45}.tiny{background:#f4f9f8;color:#708e8c;padding:12px;border-radius:8px;font-size:10px;line-height:1.5;margin:5px 0 0}.section{margin:44px 0;scroll-margin-top:93px}.section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;margin-bottom:19px}.section-head h2{font-size:24px;margin:6px 0}.timezone,.count-badge{font-size:10px;color:#718b93;font-weight:800;letter-spacing:1px}.count-badge{border:1px solid #d8e5e5;border-radius:7px;padding:8px 10px;background:#fff;white-space:nowrap}.daily-list,.closed-list{display:grid;gap:12px}.day-card,.closed-day{border-radius:13px;border:1px solid #e3eaee;background:#fff;box-shadow:0 5px 22px #16313a04;overflow:hidden}.day-summary{width:100%;display:flex;align-items:center;gap:13px;background:none;border:0;padding:19px 22px;text-align:left}.day-icon{width:38px;height:38px;border-radius:9px;background:#eaf8f1;color:#1a9c77;display:grid;place-items:center;flex:none;font-size:18px}.day-icon.loss{background:#fff0ef;color:#d56b6c}.day-info strong{display:block;font-size:13px;color:#203a46}.day-info small{display:block;color:#8b9ba5;font-size:10px;margin-top:4px}.day-amount{margin-left:auto;font-family:Manrope,sans-serif;font-size:17px;font-weight:800;white-space:nowrap}.chevron{color:#90a4a9;margin-left:13px;transition:transform .2s}.day-card[open] .chevron{transform:rotate(180deg)}.day-entries{border-top:1px solid #edf1f2;padding:4px 22px 14px}.entry{display:grid;grid-template-columns:minmax(0,1fr) 100px 110px;gap:10px;align-items:center;border-bottom:1px solid #eff2f3;padding:14px 0}.entry:last-child{border:0}.entry strong{font-size:12px;color:#203847;display:block;overflow-wrap:anywhere}.entry small{font-size:10px;color:#91a0aa;display:block;margin-top:4px}.entry .invest{font-size:11px;color:#758894;text-align:right}.entry .value{font-size:12px;font-weight:800;text-align:right;white-space:nowrap}.filters{display:flex;justify-content:space-between;gap:12px;margin-bottom:14px}.filters input{border:1px solid #dbe5e9;border-radius:8px;padding:9px 12px;width:min(230px,100%);background:#fff;font-size:12px;outline:none}.closed-day header{display:flex;justify-content:space-between;align-items:center;padding:16px 21px;background:#f9fbfb;border-bottom:1px solid #ecf0f1}.closed-day header strong{font-size:12px}.closed-day header small{display:block;margin-top:3px;color:#8a9da5;font-size:10px}.closed-day header b{font-size:13px}.closed-day .entry{margin:0 21px}.open-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.open-card{background:#fff;border:1px solid #e3eaee;border-radius:12px;padding:19px 20px;min-width:0}.open-card .status{display:inline-block;background:#e8f7ee;color:#178b6c;padding:5px 8px;border-radius:6px;font-size:9px;font-weight:800;letter-spacing:1px}.open-card h3{font-size:13px;overflow-wrap:anywhere;margin:16px 0}.open-card .open-meta{display:flex;justify-content:space-between;border-top:1px solid #edf1f2;padding-top:12px;color:#8195a0;font-size:10px}.open-card .open-meta b{color:#263c48;font-size:12px}.review-summary{display:flex;flex-wrap:wrap;gap:9px;margin-bottom:12px}.review-chip{padding:9px 12px;background:#fff8ed;border:1px solid #f0dfc8;border-radius:8px;color:#8b672c;font-size:11px}.amber{color:#b67b2e}.review-details{background:#fff;border:1px solid #e3eaee;border-radius:11px;padding:16px 19px}.review-details summary{cursor:pointer;font-size:12px;font-weight:700}.review-line{border-top:1px solid #ecf0f1;padding:11px 0;font-size:11px;display:flex;justify-content:space-between;gap:10px;color:#768791}.review-line:first-child{margin-top:13px}.review-line strong{color:#30434e;overflow-wrap:anywhere}.more{display:block;margin:18px auto;background:white;border:1px solid #dce5e8;border-radius:8px;color:#37555e;font-weight:700;font-size:11px;padding:10px 17px}.footer{display:flex;justify-content:space-between;gap:20px;border-top:1px solid #dde7ea;color:#93a2a9;padding:20px 0;font-size:9px;letter-spacing:.6px}.mobile-nav{display:none}.login-view{min-height:100vh;background:radial-gradient(circle at 70% 15%,#226260,#123a48 35%,#091725 90%);display:grid;place-items:center;padding:20px}.login-box{background:white;width:min(430px,100%);padding:40px;border-radius:20px;box-shadow:0 25px 90px #06151f55}.login-box .brand{color:#153840;margin-bottom:45px}.login-box h1{font-family:Manrope,sans-serif;font-size:34px;line-height:1.16;letter-spacing:-1.7px;margin:13px 0}.login-box p{font-size:12px;color:#768995;line-height:1.6;margin:0 0 28px}.login-box label{display:block;font-size:11px;font-weight:800;margin-bottom:8px}.login-box input{width:100%;border:1px solid #d8e3e7;border-radius:8px;padding:13px}.login-box .primary{display:flex;justify-content:space-between;width:100%;margin-top:14px}.error{color:#d35b62;font-size:11px;margin-top:12px;min-height:15px}\n@media(max-width:1040px){.stat-grid{grid-template-columns:repeat(3,1fr)}.stat-main{grid-column:1/-1}.open-grid{grid-template-columns:repeat(2,1fr)}}\n@media(max-width:750px){.desktop-nav{display:none}.top-inner{height:62px;padding:0 18px}.top-right{gap:8px}.brand{font-size:17px}main{padding:0 16px 86px}.welcome{padding:33px 0 23px;display:block}.welcome h1{font-size:35px}.welcome p{font-size:12px}.welcome-action{align-items:stretch;margin-top:24px}.sync{width:100%}.stat-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.stat-main{grid-column:1/-1;min-height:175px}.stat{padding:17px 16px;min-height:122px}.stat strong{font-size:22px}.stat-main strong{font-size:40px}.two-col{grid-template-columns:1fr;margin-bottom:38px}.section{margin:36px 0;scroll-margin-top:75px}.section-head h2{font-size:21px}.section-head p{font-size:11px}.timezone{display:none}.open-grid{grid-template-columns:1fr}.mobile-nav{display:flex;position:fixed;bottom:0;left:0;right:0;z-index:8;height:calc(65px + env(safe-area-inset-bottom));padding:5px 8px env(safe-area-inset-bottom);background:#fff;border-top:1px solid #e0e8eb;box-shadow:0 -4px 18px #182d3812}.mobile-nav a{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:3px;text-decoration:none;color:#80959e;font-weight:700;font-size:9px;border-radius:8px}.mobile-nav a span{font-size:19px}.mobile-nav a.current{color:#167f69;background:#edf9f4}.footer{display:block}.footer span{display:block;margin-bottom:6px}}\n@media(max-width:460px){.top-right .connection span{display:none}.filters{flex-direction:column}.filters input{width:100%}.entry{grid-template-columns:minmax(0,1fr) 80px}.entry .invest{display:none}.day-summary{padding:15px 14px;gap:9px}.day-amount{font-size:14px}.day-entries{padding:4px 14px 12px}.closed-day .entry{margin:0 14px}.login-box{padding:30px 25px}.stat-main strong{font-size:37px}}\n" };
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
    const { fills, settlements, positions } = await fetchHistory(KALSHI_KEY_ID, KALSHI_PRIVATE_KEY);
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      for (const f of fills) if (f.fill_id) await db.query("INSERT INTO kalshi_records VALUES ($1,$2,$3) ON CONFLICT(kind,record_id) DO UPDATE SET data=excluded.data", ["fill", f.fill_id, f]);
      for (const s of settlements) {
        const id = `${s.ticker}:${s.subaccount_number ?? s.subaccount ?? 0}:${s.settled_time}`;
        await db.query("INSERT INTO kalshi_records VALUES ($1,$2,$3) ON CONFLICT(kind,record_id) DO UPDATE SET data=excluded.data", ["settlement", id, s]);
      }
      await db.query("DELETE FROM kalshi_records WHERE kind='position'");
      for (const p of positions) {
        const id = `${p.subaccount_number ?? 0}:${p.exchange_index ?? 0}:${p.ticker}`;
        await db.query("INSERT INTO kalshi_records VALUES ($1,$2,$3) ON CONFLICT(kind,record_id) DO UPDATE SET data=excluded.data", ["position", id, p]);
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
    return { fills: fills.length, settlements: settlements.length, positions: positions.length };
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
        const fills = rows.rows.filter((r) => r.kind === "fill").map((r) => r.data), settlements = rows.rows.filter((r) => r.kind === "settlement").map((r) => r.data), positions = rows.rows.filter((r) => r.kind === "position").map((r) => r.data);
        const last = await pool.query("SELECT value FROM app_state WHERE key='last_sync'");
        return json(res, 200, { ...buildLedger(fills, settlements, process.env.TZ_DISPLAY || "America/Chicago", positions), lastSync: last.rows[0]?.value || null, connected: !!(KALSHI_KEY_ID && KALSHI_PRIVATE_KEY), syncing, lastError });
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
