'use strict';

const $ = id => document.getElementById(id);
const CACHE_KEY = 'betsify_compact_cache_v4';
const OLD_CACHE_KEYS = ['betsify_free_cache_v1','betsify_free_cache_v2','betsify_compact_cache_v3'];
const MAX_CACHED_MATCHES = 300;
const INTERNATIONAL_GOAL_PRIOR = 1.25;
const INTERNATIONAL_CARD_PRIOR = 1.85;

for (const key of OLD_CACHE_KEYS) { try { localStorage.removeItem(key); } catch (_) {} }

function loadCache(){
  try{
    const parsed=JSON.parse(localStorage.getItem(CACHE_KEY)||'{}');
    return{matches:parsed.matches&&typeof parsed.matches==='object'?parsed.matches:{}};
  }catch(_){return{matches:{}}}
}
const cache=loadCache(),scheduleMemory=new Map(),summaryMemory=new Map();
const state={events:[],fixture:null,model:null,markets:[],selected:new Set(),homeName:'',awayName:''};

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
    rows.push({...compact,weight:Math.pow(.9,index)*(compact.friendly?.55:1)});
  }
  if(added)saveCache();return rows;
}

function weighted(rows,field){let sum=0,weights=0,count=0;for(const row of rows)if(row[field]!=null){sum+=row[field]*row.weight;weights+=row.weight;count++}return{value:weights?sum/weights:null,count}}
function aggregate(rows){const result={matches:rows.length};for(const field of ['gf','ga','shots','shotsAgainst','sot','sotAgainst','corners','cornersAgainst','yellow','red','possession']){const item=weighted(rows,field);result[field]=item.value;result[field+'Count']=item.count}return result}
function shrink(value,count,prior,strength=4){if(value==null||count===0)return prior;return(value*count+prior*strength)/(count+strength)}
function factorial(value){let result=1;for(let i=2;i<=value;i++)result*=i;return result}
const poisson=(goals,lambda)=>Math.exp(-lambda)*Math.pow(lambda,goals)/factorial(goals);
function matrix(lambdaA,lambdaB,max=10){const rows=[];for(let a=0;a<=max;a++)for(let b=0;b<=max;b++)rows.push({a,b,p:poisson(a,lambdaA)*poisson(b,lambdaB)});return rows}
function probability(rows,predicate){return rows.reduce((sum,row)=>sum+(predicate(row)?row.p:0),0)}

function createModel(home,away){
  const homeGF=shrink(home.gf,home.matches,INTERNATIONAL_GOAL_PRIOR),homeGA=shrink(home.ga,home.matches,INTERNATIONAL_GOAL_PRIOR),awayGF=shrink(away.gf,away.matches,INTERNATIONAL_GOAL_PRIOR),awayGA=shrink(away.ga,away.matches,INTERNATIONAL_GOAL_PRIOR);
  let homeGoals=Math.sqrt(homeGF*awayGA),awayGoals=Math.sqrt(awayGF*homeGA);
  if(home.sotCount>=5&&away.sotAgainstCount>=5)homeGoals*=clamp(((home.sot+away.sotAgainst)/2)/4.2,.85,1.15);
  if(away.sotCount>=5&&home.sotAgainstCount>=5)awayGoals*=clamp(((away.sot+home.sotAgainst)/2)/4.2,.85,1.15);
  homeGoals=clamp(homeGoals,.2,3.5);awayGoals=clamp(awayGoals,.2,3.5);
  const scoreMatrix=matrix(homeGoals,awayGoals,9),firstHalfMatrix=matrix(homeGoals*.45,awayGoals*.45,6);
  const homeCards=shrink(home.yellow,home.yellowCount,INTERNATIONAL_CARD_PRIOR,5),awayCards=shrink(away.yellow,away.yellowCount,INTERNATIONAL_CARD_PRIOR,5),cardMatrix=matrix(homeCards,awayCards,10);
  const scoreCoverage=Math.min(home.matches,away.matches)/10,shotCoverage=Math.min(home.sotCount,away.sotCount,home.sotAgainstCount,away.sotAgainstCount)/10,cardCoverage=Math.min(home.yellowCount,away.yellowCount)/10;
  const confidence=scoreCoverage>=1&&shotCoverage>=.5?'Media':scoreCoverage>=.8?'Media-baja':'Baja';
  return{homeGoals,awayGoals,homeCards,awayCards,scoreMatrix,firstHalfMatrix,cardMatrix,confidence,scoreCoverage,shotCoverage,cardCoverage};
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

function renderTeam(id,data){const card=(label,value,digits=2)=>`<div class="stat"><span class="muted">${label}</span><b>${value==null?'—':Number(value).toFixed(digits)}</b></div>`;$(id).innerHTML=card('Goles a favor',data.gf)+card('Goles en contra',data.ga)+card('Tiros',data.shots)+card('A puerta',data.sot)+card('Córners',data.corners)+card('Amarillas',data.yellow)+card('Posesión %',data.possession)+card('Partidos',data.matches,0)}
function topScores(model){return [...model.scoreMatrix].sort((a,b)=>b.p-a.p).slice(0,6).map(row=>`<div class="topscore"><span>${state.homeName} ${row.a}-${row.b} ${state.awayName}</span><b>${pct(row.p)}</b></div>`).join('')}

$('analyze').onclick=async()=>{if(!state.fixture)return;try{const teams=competitors(state.fixture);state.homeName=teamName(teams.home);state.awayName=teamName(teams.away);$('analysisStatus').textContent='Buscando historiales…';const[homeRows,awayRows]=await Promise.all([teamData(teamId(teams.home),state.homeName),teamData(teamId(teams.away),state.awayName)]),homeAggregate=aggregate(homeRows),awayAggregate=aggregate(awayRows);state.model=createModel(homeAggregate,awayAggregate);state.markets=createMarkets(state.model,state.homeName,state.awayName);state.selected.clear();$('homeName').textContent=state.homeName;$('awayName').textContent=state.awayName;renderTeam('homeStats',homeAggregate);renderTeam('awayStats',awayAggregate);$('homeCoverage').textContent=`Cobertura: ${homeAggregate.shotsCount}/${homeAggregate.matches} con tiros; ${homeAggregate.cornersCount}/${homeAggregate.matches} con córners; ${homeAggregate.yellowCount}/${homeAggregate.matches} con tarjetas.`;$('awayCoverage').textContent=`Cobertura: ${awayAggregate.shotsCount}/${awayAggregate.matches} con tiros; ${awayAggregate.cornersCount}/${awayAggregate.matches} con córners; ${awayAggregate.yellowCount}/${awayAggregate.matches} con tarjetas.`;$('matches').innerHTML=[...homeRows,...awayRows].map(row=>`<tr><td>${row.date||'—'}</td><td>${row.team}</td><td>${row.opponent}</td><td>${row.gf??'—'}-${row.ga??'—'}</td><td>${row.shots??'—'}</td><td>${row.sot??'—'}</td><td>${row.corners??'—'}</td><td>${row.yellow??'—'}</td></tr>`).join('');$('confidence').textContent=state.model.confidence;$('confidence').className=state.model.confidence==='Media'?'good':state.model.confidence==='Baja'?'bad':'warn';$('xgTotal').textContent=(state.model.homeGoals+state.model.awayGoals).toFixed(2);$('cardsTotal').textContent=(state.model.homeCards+state.model.awayCards).toFixed(2);$('sampleSize').textContent=`${homeRows.length}+${awayRows.length}`;$('modelWarning').textContent=`El ajuste por tiros solo se usa con cobertura suficiente. Aún no existe ajuste completo por fuerza del rival. Tarjetas y primera parte son modelos de menor confianza.`;$('topScores').innerHTML=topScores(state.model);renderMarkets();renderSelectedCombo();$('comboSuggestions').innerHTML='';$('analysisArea').classList.remove('hidden');$('analysisStatus').textContent=`Listo: ${homeRows.length} partidos de ${state.homeName} y ${awayRows.length} de ${state.awayName}.`}catch(error){$('analysisStatus').textContent='No se pudo completar: '+error.message}};

$('clear').onclick=()=>{for(const key of[CACHE_KEY,...OLD_CACHE_KEYS])try{localStorage.removeItem(key)}catch(_){}location.reload()};
$('load').click();
