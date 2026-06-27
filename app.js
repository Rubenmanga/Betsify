'use strict';

const $ = id => document.getElementById(id);
const CACHE_KEY = 'betsify_compact_cache_v4';
const OLD_CACHE_KEYS = ['betsify_free_cache_v1','betsify_free_cache_v2','betsify_compact_cache_v3'];
const MAX_CACHED_MATCHES = 300;
const INTERNATIONAL_GOAL_PRIOR = 1.25;
const INTERNATIONAL_CARD_PRIOR = 1.85;
// Dixon-Coles (1997): factor de correlación negativa para scores bajos.
// Valor empírico para fútbol internacional: −0.13.
const DC_RHO = -0.13;

// ClubElo: ponderar partidos según calidad del rival (Elo histórico).
// Un rival con Elo muy alto añade peso; uno muy bajo lo reduce.
const ELO_BASELINE = 1500;
const ELO_CLAMP_MIN = 0.6;
const ELO_CLAMP_MAX = 1.4;

async function ceapi(team){
  try{
    const resp=await fetch(`/api/clubelo?team=${encodeURIComponent(team)}`);
    if(!resp.ok)return null;
    return resp.json();
  }catch(_){return null}
}
async function ceCached(team){
  if(state.clubelo[team])return state.clubelo[team];
  const data=await ceapi(team);
  if(data&&data.length){state.clubelo[team]=data}
  return data||null;
}
function eloOnDate(records,date){
  if(!records||!records.length)return null;
  if(date){const rec=records.find(r=>r.From<=date&&date<=r.To);if(rec)return parseFloat(rec.Elo)}
  return parseFloat(records[records.length-1].Elo)||null;
}
function rivalEloFactor(elo){
  if(!elo||isNaN(elo))return 1;
  return Math.min(ELO_CLAMP_MAX,Math.max(ELO_CLAMP_MIN,elo/ELO_BASELINE));
}
async function enrichRowsWithElo(rows){
  const opponents=[...new Set(rows.map(r=>r.opponent))];
  let enriched=0;
  await Promise.all(opponents.map(async opp=>{
    const records=await ceCached(opp);
    if(!records)return;
    for(const row of rows){
      if(row.opponent!==opp)continue;
      const elo=eloOnDate(records,row.date);
      if(!elo)continue;
      row.rivalElo=elo;
      row.weight=Math.pow(0.9,row.rowIndex)*(row.friendly?0.55:1)*rivalEloFactor(elo);
      enriched++;
    }
  }));
  return enriched;
}

for (const key of OLD_CACHE_KEYS) { try { localStorage.removeItem(key); } catch (_) {} }

function loadCache(){
  try{
    const parsed=JSON.parse(localStorage.getItem(CACHE_KEY)||'{}');
    return{matches:parsed.matches&&typeof parsed.matches==='object'?parsed.matches:{}};
  }catch(_){return{matches:{}}}
}
const cache=loadCache(),scheduleMemory=new Map(),summaryMemory=new Map(),sfMemory=new Map();
const state={events:[],fixture:null,model:null,markets:[],selected:new Set(),homeName:'',awayName:'',homeRows:[],awayRows:[],clubelo:{}};

function saveCache(){
  const entries=Object.entries(cache.matches).sort((a,b)=>(b[1].cachedAt||0)-(a[1].cachedAt||0)).slice(0,MAX_CACHED_MATCHES);
  cache.matches=Object.fromEntries(entries);
  try{localStorage.setItem(CACHE_KEY,JSON.stringify(cache));return true}catch(_){
    cache.matches=Object.fromEntries(entries.slice(0,100));
    try{localStorage.setItem(CACHE_KEY,JSON.stringify(cache));return true}catch(_){try{localStorage.removeItem(CACHE_KEY)}catch(__){}return false}
  }
}

const num=value=>{const parsed=parseFloat(String(value??'').replace('%',''));return Number.isFinite(parsed)?parsed:null};
const pct=value=>Number.isFinite(value)?`${(value*100).toFixed(1)}%`:'—';
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
$('date').value=new Date().toISOString().slice(0,10);

async function api(params){const response=await fetch('/api/espn?'+new URLSearchParams(params));const payload=await response.json();if(!response.ok||!payload.ok)throw new Error(payload.error||`HTTP ${response.status}`);return payload.data}
function competitors(event){const list=event.competitions?.[0]?.competitors||[];return{home:list.find(item=>item.homeAway==='home')||list[0],away:list.find(item=>item.homeAway==='away')||list[1]}}
const teamName=competitor=>competitor?.team?.displayName||competitor?.team?.name||'Equipo';
const teamId=competitor=>competitor?.team?.id||competitor?.id;
const score=competitor=>num(competitor?.score?.value??competitor?.score);

// ── Sofascore xG ─────────────────────────────────────────────────────────────
async function sfapi(params){const res=await fetch('/api/sofascore?'+new URLSearchParams(params));const p=await res.json();if(!res.ok||!p.ok)throw new Error(p.error||`Sofascore ${res.status}`);return p.data}
async function sfCached(params){const k=JSON.stringify(params);if(sfMemory.has(k))return sfMemory.get(k);const d=await sfapi(params);sfMemory.set(k,d);return d}

function normName(n){return(n||'').toLowerCase().replace(/\b(republic|ir|of|the|korea)\b/g,'').replace(/\s+/g,' ').trim()}
function fuzzyTeam(a,b){if(!a||!b)return false;const na=normName(a),nb=normName(b);return na===nb||na.includes(nb.slice(0,5))||nb.includes(na.slice(0,5))}

function findSfTeamId(data,teamName){
  const list=[...(data.results||[]).map(r=>r.entity||r),...(data.teams||[])].filter(t=>t?.id);
  for(const t of list){const type=String(t.type?.name||t.type||'').toLowerCase();if(fuzzyTeam(t.name,teamName)&&type.includes('national'))return t.id}
  for(const t of list){if(fuzzyTeam(t.name,teamName))return t.id}
  return null;
}
function findSfEvent(events,date,opponent){
  for(const ev of events||[]){
    const evDate=new Date((ev.startTimestamp||0)*1000).toISOString().slice(0,10);
    if(evDate!==date)continue;
    if(fuzzyTeam(ev.homeTeam?.name,opponent)||fuzzyTeam(ev.awayTeam?.name,opponent))return ev;
  }
  return null;
}
function extractXG(statsData,isHome){
  for(const period of statsData?.statistics||[]){
    if(period.period!=='ALL')continue;
    for(const group of period.groups||[])for(const item of group.statisticsItems||[]){
      if(/expected.goals|xg/i.test(item.name||'')){
        const v=num(isHome?(item.homeValue??item.home):(item.awayValue??item.away));
        if(v!=null)return v;
      }
    }
  }
  return null;
}

function updateXGCells(){
  document.querySelectorAll('#matches tr[data-match]').forEach(tr=>{
    const[date,team]=(tr.dataset.match||'').split('||');
    const m=Object.values(cache.matches).find(x=>x.date===date&&x.team===team);
    if(!m)return;
    const xc=tr.querySelector('.xg-cell'),xac=tr.querySelector('.xga-cell');
    if(xc)xc.textContent=m.xg!=null?m.xg.toFixed(2):'—';
    if(xac)xac.textContent=m.xgAgainst!=null?m.xgAgainst.toFixed(2):'—';
  });
}

async function enrichTeam(rows,teamName,statusEl){
  statusEl.textContent=`Buscando ${teamName} en Sofascore…`;
  const sd=await sfCached({mode:'search',q:teamName});
  const sfId=findSfTeamId(sd,teamName);
  if(!sfId)throw new Error(`${teamName} no encontrado en Sofascore`);
  statusEl.textContent=`Cargando partidos de ${teamName}…`;
  const ed=await sfCached({mode:'events',team_id:String(sfId)});
  const sfEvents=ed.events||[];
  let hits=0;
  for(let i=0;i<rows.length;i++){
    const row=rows[i];
    if(row.xg!=null){hits++;continue}
    const sfEv=findSfEvent(sfEvents,row.date,row.opponent);
    if(!sfEv)continue;
    statusEl.textContent=`${teamName}: xG partido ${i+1}/${rows.length}…`;
    try{
      const st=await sfCached({mode:'stats',event_id:String(sfEv.id)});
      const isHome=fuzzyTeam(sfEv.homeTeam?.name,teamName);
      const xg=extractXG(st,isHome),xga=extractXG(st,!isHome);
      if(xg!=null){
        const ck=Object.keys(cache.matches).find(k=>{const m=cache.matches[k];return m.date===row.date&&m.team===row.team});
        if(ck){cache.matches[ck].xg=xg;cache.matches[ck].xgAgainst=xga;cache.matches[ck].cachedAt=Date.now()}
        hits++;
      }
    }catch(_){}
  }
  return hits;
}
// ─────────────────────────────────────────────────────────────────────────────

$('load').onclick=async()=>{try{$('fixtureStatus').textContent='Cargando partidos…';const data=await api({mode:'scoreboard',league:'fifa.world',date:$('date').value.replaceAll('-','')});state.events=data.events||[];$('fixture').innerHTML=state.events.map((event,index)=>{const teams=competitors(event);return`<option value="${index}">${teamName(teams.home)} — ${teamName(teams.away)}</option>`}).join('')||'<option>Sin partidos</option>';state.fixture=state.events[0]||null;$('analyze').disabled=!state.fixture;$('fixtureStatus').textContent=state.fixture?`${state.events.length} partidos encontrados.`:'No hay partidos en esa fecha.'}catch(error){$('fixtureStatus').textContent='Error: '+error.message}};
$('fixture').onchange=()=>{state.fixture=state.events[Number($('fixture').value)]||null;$('analyze').disabled=!state.fixture};

async function schedule(id){const key=String(id);if(scheduleMemory.has(key))return scheduleMemory.get(key);const data=await api({mode:'schedule',team:id,season:new Date().getUTCFullYear()});scheduleMemory.set(key,data);return data}
async function summary(event){const key=String(event.id);if(summaryMemory.has(key))return summaryMemory.get(key);const data=await api({mode:'summary',event:event.id,league:event.league?.slug||''});summaryMemory.set(key,data);return data}
function statMap(box){const result={};for(const stat of box?.statistics||[])result[stat.name]=num(stat.value??stat.displayValue);return result}
function pick(map,names){for(const name of names)if(map[name]!=null)return map[name];return null}

function sanitizeStats(raw,oppRaw,gf,ga){
  let{shots,sot,corners,yellow,red,possession}=raw;
  const bothEmpty=(shots===0&&sot===0&&corners===0&&oppRaw.shots===0&&oppRaw.sot===0&&oppRaw.corners===0);
  const impossible=(gf>0&&shots===0)||(sot!=null&&shots!=null&&sot>shots);
  if(bothEmpty||impossible){shots=null;sot=null;corners=null;possession=null}
  if(yellow===0&&red===0&&raw.hasAny===false){yellow=null;red=null}
  return{shots,sot,corners,yellow,red,possession};
}

function parseCompactMatch(event,data,id){
  const list=event.competitions?.[0]?.competitors||[],own=list.find(item=>String(teamId(item))===String(id)),opponent=list.find(item=>item!==own),boxes=data.boxscore?.teams||[],ownBox=boxes.find(box=>String(box.team?.id)===String(id)),opponentBox=boxes.find(box=>String(box.team?.id)===String(teamId(opponent))),stats=statMap(ownBox),opponentStats=statMap(opponentBox),gf=score(own),ga=score(opponent),leagueSlug=event.league?.slug||'';
  const raw={shots:pick(stats,['totalShots','shots']),sot:pick(stats,['shotsOnTarget']),corners:pick(stats,['wonCorners','cornerKicks']),yellow:pick(stats,['yellowCards']),red:pick(stats,['redCards']),possession:pick(stats,['possessionPct']),hasAny:Object.keys(stats).length>0};
  const oppRaw={shots:pick(opponentStats,['totalShots','shots']),sot:pick(opponentStats,['shotsOnTarget']),corners:pick(opponentStats,['wonCorners','cornerKicks']),yellow:pick(opponentStats,['yellowCards']),red:pick(opponentStats,['redCards']),possession:pick(opponentStats,['possessionPct']),hasAny:Object.keys(opponentStats).length>0};
  const clean=sanitizeStats(raw,oppRaw,gf,ga),oppClean=sanitizeStats(oppRaw,raw,ga,gf);
  return{id:String(event.id),date:event.date?.slice(0,10)||null,team:teamName(own),opponent:teamName(opponent),gf,ga,shots:clean.shots,shotsAgainst:oppClean.shots,sot:clean.sot,sotAgainst:oppClean.sot,corners:clean.corners,cornersAgainst:oppClean.corners,yellow:clean.yellow,red:clean.red,possession:clean.possession,friendly:leagueSlug.includes('friendly'),cachedAt:Date.now()};
}

async function teamData(id,label){
  const data=await schedule(id),events=(data.events||[]).filter(event=>event.competitions?.[0]?.status?.type?.completed||event.status?.type?.completed).sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,10),rows=[];let added=false;
  for(let index=0;index<events.length;index++){
    const event=events[index],cacheKey=`${event.id}:${id}`;$('analysisStatus').textContent=`${label}: procesando ${index+1}/${events.length}…`;let compact=cache.matches[cacheKey];
    if(!compact){try{compact=parseCompactMatch(event,await summary(event),id)}catch(_){compact=parseCompactMatch(event,{},id)}cache.matches[cacheKey]=compact;added=true}
    rows.push({...compact,rowIndex:index,weight:Math.pow(0.9,index)*(compact.friendly?0.55:1)});
  }
  if(added)saveCache();return rows;
}

function weighted(rows,field){let sum=0,weights=0,count=0;for(const row of rows)if(row[field]!=null){sum+=row[field]*row.weight;weights+=row.weight;count++}return{value:weights?sum/weights:null,count}}
function aggregate(rows){const result={matches:rows.length};for(const field of ['gf','ga','shots','shotsAgainst','sot','sotAgainst','corners','cornersAgainst','yellow','red','possession','xg','xgAgainst']){const item=weighted(rows,field);result[field]=item.value;result[field+'Count']=item.count}return result}
function shrink(value,count,prior,strength=4){if(value==null||count===0)return prior;return(value*count+prior*strength)/(count+strength)}
function factorial(value){let result=1;for(let i=2;i<=value;i++)result*=i;return result}
const poisson=(goals,lambda)=>Math.exp(-lambda)*Math.pow(lambda,goals)/factorial(goals);
// Corrección Dixon-Coles: ajusta la probabilidad conjunta para scores bajos.
// Para (i+j) > 2, tau = 1 (sin corrección). DC_RHO < 0 sube P(0-0) y P(1-1).
function tau(a,b,lA,lB,rho){
  if(a===0&&b===0)return 1-lA*lB*rho;
  if(a===1&&b===0)return 1+lB*rho;
  if(a===0&&b===1)return 1+lA*rho;
  if(a===1&&b===1)return 1-rho;
  return 1;
}
function matrix(lambdaA,lambdaB,max=10,rho=0){
  const rows=[];
  for(let a=0;a<=max;a++)for(let b=0;b<=max;b++)rows.push({a,b,p:poisson(a,lambdaA)*poisson(b,lambdaB)*tau(a,b,lambdaA,lambdaB,rho)});
  // Normalizar: la truncación a max goles hace que la suma sea <1 sin esto.
  const total=rows.reduce((s,r)=>s+r.p,0);
  if(total>0)rows.forEach(r=>r.p/=total);
  return rows;
}
function probability(rows,predicate){return rows.reduce((sum,row)=>sum+(predicate(row)?row.p:0),0)}

function createModel(home,away){
  // Preferir xG sobre goles reales cuando hay ≥5 partidos con datos (menos ruido)
  const useHomeXG=home.xgCount>=5&&away.xgAgainstCount>=5;
  const useAwayXG=away.xgCount>=5&&home.xgAgainstCount>=5;
  const hGF=useHomeXG?home.xg:home.gf,   hGFn=useHomeXG?home.xgCount:home.matches;
  const hGA=useHomeXG?home.xgAgainst:home.ga, hGAn=useHomeXG?home.xgAgainstCount:home.matches;
  const aGF=useAwayXG?away.xg:away.gf,   aGFn=useAwayXG?away.xgCount:away.matches;
  const aGA=useAwayXG?away.xgAgainst:away.ga, aGAn=useAwayXG?away.xgAgainstCount:away.matches;
  const homeGF=shrink(hGF,hGFn,INTERNATIONAL_GOAL_PRIOR),homeGA=shrink(hGA,hGAn,INTERNATIONAL_GOAL_PRIOR);
  const awayGF=shrink(aGF,aGFn,INTERNATIONAL_GOAL_PRIOR),awayGA=shrink(aGA,aGAn,INTERNATIONAL_GOAL_PRIOR);
  let homeGoals=Math.sqrt(homeGF*awayGA),awayGoals=Math.sqrt(awayGF*homeGA);
  // SOT solo cuando no hay xG: xG ya incorpora calidad de tiro
  if(!useHomeXG&&home.sotCount>=5&&away.sotAgainstCount>=5)homeGoals*=clamp(((home.sot+away.sotAgainst)/2)/4.2,.85,1.15);
  if(!useAwayXG&&away.sotCount>=5&&home.sotAgainstCount>=5)awayGoals*=clamp(((away.sot+home.sotAgainst)/2)/4.2,.85,1.15);
  homeGoals=clamp(homeGoals,.2,3.5);awayGoals=clamp(awayGoals,.2,3.5);
  const scoreMatrix=matrix(homeGoals,awayGoals,9,DC_RHO),firstHalfMatrix=matrix(homeGoals*.45,awayGoals*.45,6,DC_RHO);
  const homeCards=shrink(home.yellow,home.yellowCount,INTERNATIONAL_CARD_PRIOR,5),awayCards=shrink(away.yellow,away.yellowCount,INTERNATIONAL_CARD_PRIOR,5),cardMatrix=matrix(homeCards,awayCards,10);
  const scoreCoverage=Math.min(home.matches,away.matches)/10,shotCoverage=Math.min(home.sotCount,away.sotCount,home.sotAgainstCount,away.sotAgainstCount)/10,cardCoverage=Math.min(home.yellowCount,away.yellowCount)/10;
  const xgCoverage=Math.min(home.xgCount||0,away.xgCount||0)/10;
  const confidence=scoreCoverage>=1&&(xgCoverage>=.5||shotCoverage>=.5)?'Media':scoreCoverage>=.8?'Media-baja':'Baja';
  return{homeGoals,awayGoals,homeCards,awayCards,scoreMatrix,firstHalfMatrix,cardMatrix,confidence,scoreCoverage,shotCoverage,cardCoverage,xgCoverage,useHomeXG,useAwayXG};
}

function addMarket(list,market){
  const fair=market.pushProb!=null?(1-market.pushProb)/market.probability:1/market.probability;
  list.push({...market,fairOdds:fair,odds:null,ev:null});
}
function createMarkets(model,homeName,awayName){
  const list=[],S=model.scoreMatrix,H=model.firstHalfMatrix,C=model.cardMatrix;
  const score=(id,label,group,condition,confidence=model.confidence,combo=true)=>addMarket(list,{id,label,group,domain:'score',condition,probability:probability(S,condition),confidence,comboEligible:combo});
  const half=(id,label,condition)=>addMarket(list,{id,label,group:'Primera parte',domain:'half',condition,probability:probability(H,condition),confidence:'Baja',comboEligible:true});
  const cards=(id,label,condition)=>addMarket(list,{id,label,group:'Tarjetas',domain:'cards',condition,probability:probability(C,condition),confidence:model.cardCoverage>=.7?'Media':model.cardCoverage>=.4?'Baja':'Insuficiente',comboEligible:model.cardCoverage>=.4});
  score('home_win',`Gana ${homeName}`,'Resultado',r=>r.a>r.b);
  score('draw','Empate','Resultado',r=>r.a===r.b);
  score('away_win',`Gana ${awayName}`,'Resultado',r=>r.a<r.b);
  score('dc_1x',`${homeName} o empate (1X)`,'Doble oportunidad',r=>r.a>=r.b);
  score('dc_x2',`${awayName} o empate (X2)`,'Doble oportunidad',r=>r.a<=r.b);
  score('dc_12','No hay empate (12)','Doble oportunidad',r=>r.a!==r.b);
  const drawProb=probability(S,r=>r.a===r.b),homeProb=probability(S,r=>r.a>r.b),awayProb=probability(S,r=>r.a<r.b);
  addMarket(list,{id:'dnb_home',label:`${homeName} empate no válido`,group:'Empate no válido',domain:'score',probability:homeProb,pushProb:drawProb,lossProb:awayProb,confidence:model.confidence,comboEligible:false});
  addMarket(list,{id:'dnb_away',label:`${awayName} empate no válido`,group:'Empate no válido',domain:'score',probability:awayProb,pushProb:drawProb,lossProb:homeProb,confidence:model.confidence,comboEligible:false});
  for(const line of [.5,1.5,2.5,3.5,4.5]){score(`over_${line}`,`Más de ${line} goles`,'Total goles',r=>r.a+r.b>line);score(`under_${line}`,`Menos de ${line} goles`,'Total goles',r=>r.a+r.b<line)}
  for(const line of [.5,1.5,2.5]){score(`home_over_${line}`,`${homeName} más de ${line} goles`,'Goles por equipo',r=>r.a>line);score(`away_over_${line}`,`${awayName} más de ${line} goles`,'Goles por equipo',r=>r.b>line)}
  score('btts_yes','Ambos marcan — Sí','Ambos marcan',r=>r.a>0&&r.b>0);
  score('btts_no','Ambos marcan — No','Ambos marcan',r=>r.a===0||r.b===0);
  score('home_clean',`${homeName} portería a cero`,'Porterías a cero',r=>r.b===0);
  score('away_clean',`${awayName} portería a cero`,'Porterías a cero',r=>r.a===0);
  half('fh_over_05','1ª parte: más de 0.5 goles',r=>r.a+r.b>.5);
  half('fh_over_15','1ª parte: más de 1.5 goles',r=>r.a+r.b>1.5);
  for(const line of [2.5,3.5,4.5,5.5])cards(`cards_over_${line}`,`Más de ${line} tarjetas totales`,r=>r.a+r.b>line);
  for(const line of [.5,1.5,2.5]){cards(`home_cards_${line}`,`${homeName} más de ${line} tarjetas`,r=>r.a>line);cards(`away_cards_${line}`,`${awayName} más de ${line} tarjetas`,r=>r.b>line)}
  return list;
}

function marketEV(market,odds){if(!odds)return null;if(market.pushProb!=null)return market.probability*odds+market.pushProb-1;return market.probability*odds-1}
function confidenceClass(confidence){return confidence==='Media'?'pill':confidence==='Media-baja'||confidence==='Baja'?'pill low':'pill bad'}
function renderMarkets(){
  let current='';$('marketRows').innerHTML=state.markets.map(market=>{let section='';if(market.group!==current){current=market.group;section=`<tr class="section-row"><td colspan="7">${current}</td></tr>`}const ev=market.ev,positive=ev!=null&&ev>.03&&market.confidence!=='Baja'&&market.confidence!=='Insuficiente';return section+`<tr><td><input class="combo-select" type="checkbox" data-id="${market.id}" ${state.selected.has(market.id)?'checked':''} ${market.comboEligible?'':'disabled'}></td><td>${market.label}</td><td>${pct(market.probability)}</td><td>${market.fairOdds.toFixed(2)}</td><td><input class="market-odds" data-id="${market.id}" type="number" min="1.01" step=".01" value="${market.odds??''}"></td><td class="${positive?'good':ev!=null&&ev<0?'bad':''}">${ev==null?'—':pct(ev)}</td><td><span class="${confidenceClass(market.confidence)}">${market.confidence}</span></td></tr>`}).join('');
  document.querySelectorAll('.market-odds').forEach(input=>input.addEventListener('input',event=>{const market=state.markets.find(item=>item.id===event.target.dataset.id);market.odds=num(event.target.value);market.ev=marketEV(market,market.odds);renderMarkets();renderSelectedCombo()}));
  document.querySelectorAll('.combo-select').forEach(input=>input.addEventListener('change',event=>{event.target.checked?state.selected.add(event.target.dataset.id):state.selected.delete(event.target.dataset.id);renderSelectedCombo()}));
}

function jointProbability(markets){
  const byDomain={score:markets.filter(m=>m.domain==='score'),half:markets.filter(m=>m.domain==='half'),cards:markets.filter(m=>m.domain==='cards')};
  let joint=1,approx=false;
  for(const[domain,items]of Object.entries(byDomain))if(items.length){const rows=domain==='score'?state.model.scoreMatrix:domain==='half'?state.model.firstHalfMatrix:state.model.cardMatrix;joint*=probability(rows,row=>items.every(item=>item.condition(row)));}
  const activeDomains=Object.values(byDomain).filter(items=>items.length).length;if(activeDomains>1)approx=true;
  return{probability:joint,approx};
}
function comboResult(markets){if(markets.length<2||markets.some(m=>!m.odds))return null;const joint=jointProbability(markets),combinedOdds=markets.reduce((product,m)=>product*m.odds,1),ev=joint.probability*combinedOdds-1;return{...joint,combinedOdds,ev}}
function renderSelectedCombo(){const markets=[...state.selected].map(id=>state.markets.find(m=>m.id===id)).filter(Boolean),result=comboResult(markets);if(markets.length<2){$('selectedCombo').textContent='Marca dos o más mercados.';return}if(markets.some(m=>!m.odds)){$('selectedCombo').innerHTML=`${markets.map(m=>m.label).join(' + ')}<br><span class="warn">Faltan cuotas.</span>`;return}if(!result){$('selectedCombo').textContent='No se puede calcular esta combinación.';return}$('selectedCombo').innerHTML=`<b>${markets.map(m=>m.label).join(' + ')}</b><br>Probabilidad conjunta: ${pct(result.probability)} · Cuota combinada: ${result.combinedOdds.toFixed(2)} · EV: <span class="${result.ev>0?'good':'bad'}">${pct(result.ev)}</span>${result.approx?'<br><span class="warn small">Aproximación: combina dominios distintos.</span>':''}`}

function combinations(items,size){const result=[];function walk(start,current){if(current.length===size){result.push([...current]);return}for(let i=start;i<items.length;i++){current.push(items[i]);walk(i+1,current);current.pop()}}walk(0,[]);return result}
$('findCombos').onclick=()=>{const eligible=state.markets.filter(m=>m.comboEligible&&m.odds&&m.confidence!=='Insuficiente'),results=[];for(const size of[2,3])for(const combo of combinations(eligible,size)){const result=comboResult(combo);if(result&&result.probability>.02&&result.ev>.02)results.push({combo,...result})}results.sort((a,b)=>b.ev-a.ev);$('comboSuggestions').innerHTML=results.slice(0,10).map(item=>`<div class="combo-card"><b>${item.combo.map(m=>m.label).join(' + ')}</b><br><span class="muted">Prob. ${pct(item.probability)} · Cuota ${item.combinedOdds.toFixed(2)} · </span><span class="good">EV ${pct(item.ev)}</span>${item.approx?'<br><span class="warn small">Aproximación por independencia entre goles/tarjetas.</span>':''}</div>`).join('')||'<div class="status">No hay combinadas con EV positivo entre las cuotas introducidas, o faltan cuotas suficientes.</div>'};

function renderTeam(id,data){const card=(label,value,digits=2)=>`<div class="stat"><span class="muted">${label}</span><b>${value==null?'—':Number(value).toFixed(digits)}</b></div>`;$(id).innerHTML=card('Goles a favor',data.gf)+card('Goles en contra',data.ga)+card('xG a favor',data.xg)+card('xGA en contra',data.xgAgainst)+card('Tiros',data.shots)+card('A puerta',data.sot)+card('Córners',data.corners)+card('Amarillas',data.yellow)+card('Posesión %',data.possession)+card('Partidos',data.matches,0)}
function topScores(model){return [...model.scoreMatrix].sort((a,b)=>b.p-a.p).slice(0,6).map(row=>`<div class="topscore"><span>${state.homeName} ${row.a}-${row.b} ${state.awayName}</span><b>${pct(row.p)}</b></div>`).join('')}

$('analyze').onclick=async()=>{if(!state.fixture)return;try{const teams=competitors(state.fixture);state.homeName=teamName(teams.home);state.awayName=teamName(teams.away);$('analysisStatus').textContent='Buscando historiales…';const[homeRows,awayRows]=await Promise.all([teamData(teamId(teams.home),state.homeName),teamData(teamId(teams.away),state.awayName)]);$('analysisStatus').textContent='Enriqueciendo pesos con ClubElo…';const[homeEloCount,awayEloCount]=await Promise.all([enrichRowsWithElo(homeRows),enrichRowsWithElo(awayRows)]);const homeAggregate=aggregate(homeRows),awayAggregate=aggregate(awayRows);state.homeRows=homeRows;state.awayRows=awayRows;state.model=createModel(homeAggregate,awayAggregate);state.markets=createMarkets(state.model,state.homeName,state.awayName);state.selected.clear();$('homeName').textContent=state.homeName;$('awayName').textContent=state.awayName;renderTeam('homeStats',homeAggregate);renderTeam('awayStats',awayAggregate);$('homeCoverage').textContent=`Cobertura: ${homeAggregate.shotsCount}/${homeAggregate.matches} con tiros; ${homeAggregate.cornersCount}/${homeAggregate.matches} con córners; ${homeAggregate.yellowCount}/${homeAggregate.matches} con tarjetas.`;$('awayCoverage').textContent=`Cobertura: ${awayAggregate.shotsCount}/${awayAggregate.matches} con tiros; ${awayAggregate.cornersCount}/${awayAggregate.matches} con córners; ${awayAggregate.yellowCount}/${awayAggregate.matches} con tarjetas.`;$('matches').innerHTML=[...homeRows,...awayRows].map(row=>`<tr data-match="${row.date||''}||${row.team}"><td>${row.date||'—'}</td><td>${row.team}</td><td>${row.opponent}</td><td>${row.gf??'—'}-${row.ga??'—'}</td><td>${row.shots??'—'}</td><td>${row.sot??'—'}</td><td>${row.corners??'—'}</td><td>${row.yellow??'—'}</td><td class="xg-cell">${row.xg!=null?row.xg.toFixed(2):'—'}</td><td class="xga-cell">${row.xgAgainst!=null?row.xgAgainst.toFixed(2):'—'}</td><td class="elo-cell">${row.rivalElo!=null?Math.round(row.rivalElo):'—'}</td></tr>`).join('');$('confidence').textContent=state.model.confidence;$('confidence').className=state.model.confidence==='Media'?'good':state.model.confidence==='Baja'?'bad':'warn';$('xgTotal').textContent=(state.model.homeGoals+state.model.awayGoals).toFixed(2);$('cardsTotal').textContent=(state.model.homeCards+state.model.awayCards).toFixed(2);$('sampleSize').textContent=`${homeRows.length}+${awayRows.length}`;$('modelWarning').textContent=state.model.useHomeXG&&state.model.useAwayXG?'Modelo usando xG de Sofascore como base del λ. Ajuste por tiros omitido (xG ya incorpora calidad del tiro). Tarjetas y primera parte son aproximaciones.':state.model.useHomeXG||state.model.useAwayXG?'xG disponible para un equipo; modelo mixto. Añade xG al otro para mayor precisión.':'Sin xG: modelo basado en goles reales. Usa "Añadir xG" para mejorar el modelo. Ajuste por tiros solo con cobertura ≥5 partidos.';$('topScores').innerHTML=topScores(state.model);renderMarkets();renderSelectedCombo();$('comboSuggestions').innerHTML='';$('analysisArea').classList.remove('hidden');const eloTotal=homeEloCount+awayEloCount,eloNote=eloTotal>0?` Elo activo: ${eloTotal}/${homeRows.length+awayRows.length} partidos ponderados.`:' (ClubElo no disponible, pesos sin ajuste de rival.)';$('analysisStatus').textContent=`Listo: ${homeRows.length} partidos de ${state.homeName} y ${awayRows.length} de ${state.awayName}.${eloNote}`}catch(error){$('analysisStatus').textContent='No se pudo completar: '+error.message}};

$('enrichXG').onclick=async()=>{
  if(!state.homeName||!state.awayName){$('xgStatus').textContent='Primero analiza un partido.';return}
  $('enrichXG').disabled=true;
  const statusEl=$('xgStatus');
  try{
    const homeHits=await enrichTeam(state.homeRows,state.homeName,statusEl);
    const awayHits=await enrichTeam(state.awayRows,state.awayName,statusEl);
    saveCache();
    updateXGCells();
    // Sincronizar rows en state con xG recién cacheado
    const sync=rows=>rows.map(row=>{const m=Object.values(cache.matches).find(x=>x.date===row.date&&x.team===row.team);return{...row,xg:m?.xg??null,xgAgainst:m?.xgAgainst??null}});
    state.homeRows=sync(state.homeRows);state.awayRows=sync(state.awayRows);
    const prevOdds=Object.fromEntries(state.markets.map(m=>[m.id,m.odds]));
    const homeAgg=aggregate(state.homeRows),awayAgg=aggregate(state.awayRows);
    state.model=createModel(homeAgg,awayAgg);
    state.markets=createMarkets(state.model,state.homeName,state.awayName);
    state.markets.forEach(m=>{const o=prevOdds[m.id];if(o!=null){m.odds=o;m.ev=marketEV(m,o)}});
    state.selected=new Set([...state.selected].filter(id=>state.markets.some(m=>m.id===id)));
    renderTeam('homeStats',homeAgg);renderTeam('awayStats',awayAgg);
    $('confidence').textContent=state.model.confidence;
    $('confidence').className=state.model.confidence==='Media'?'good':state.model.confidence==='Baja'?'bad':'warn';
    $('xgTotal').textContent=(state.model.homeGoals+state.model.awayGoals).toFixed(2);
    $('cardsTotal').textContent=(state.model.homeCards+state.model.awayCards).toFixed(2);
    $('topScores').innerHTML=topScores(state.model);
    renderMarkets();renderSelectedCombo();$('comboSuggestions').innerHTML='';
    $('modelWarning').textContent=state.model.useHomeXG&&state.model.useAwayXG?'Modelo usando xG de Sofascore como base del λ. Ajuste por tiros omitido (xG ya incorpora calidad del tiro). Tarjetas y primera parte son aproximaciones.':state.model.useHomeXG||state.model.useAwayXG?'xG disponible para un equipo; modelo mixto.':'xG obtenido pero cobertura insuficiente (<5 partidos). Modelo sigue usando goles reales.';
    statusEl.textContent=`xG obtenido: ${homeHits}/${state.homeRows.length} de ${state.homeName}, ${awayHits}/${state.awayRows.length} de ${state.awayName}. Modelo recalculado.`;
  }catch(err){statusEl.textContent='Error: '+err.message}
  finally{$('enrichXG').disabled=false}
};

$('clear').onclick=()=>{for(const key of[CACHE_KEY,...OLD_CACHE_KEYS])try{localStorage.removeItem(key)}catch(_){}location.reload()};
$('load').click();
