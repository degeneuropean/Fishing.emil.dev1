"use strict";

/* Die GitHub-Action erzeugt einen Stationskatalog und je Gütestation eine
   eigene JSON-Datei. Dieser Startwert hält die Oberfläche auch offline stabil. */
window.WQ_DATA = { "updated": "", "items": [] };

const PEGELONLINE_BASE = "https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/";
const SELECTION_KEY = "rheincheck_auswahl_v2";
const FAVORITES_KEY = "rheincheck_favoriten_v1";
const SPOTS_KEY = "rheincheck_spots_v1";
const CURRENT_SPOT_KEY = "rheincheck_aktiver_spot_v1";
const TRIPS_KEY = "rheincheck_trips_v1";
const TRIP_MIGRATION_KEY = "rheincheck_trip_migration_v1";
const CATCH_KEY = "rheincheck_faenge_v1";
const MAINZ_GAUGE_ID = "a37a9aa3-45e9-4d90-9df6-109f3a28a5af";
const DEFAULT_SPOT = {lat:50.004, lon:8.271, km:498.27, label:"Mainz / Wiesbaden", distanceToRhineKm:0};
const FALLBACK_CATALOG = {
  gauges:[{
    id:MAINZ_GAUGE_ID, name:"MAINZ", latitude:50.003995, longitude:8.275319,
    riverKm:498.27, series:["W","Q"], characteristicValues:{MNW:159,MW:288,MHW:547}
  }],
  qualityStations:[{
    id:"quality-rlp-2511510500", slug:"mainz-wiesbaden", name:"Mainz-Wiesbaden",
    latitude:50.0068, longitude:8.2795, riverKm:498.5, provider:"LfU RLP / HLNUG",
    dataUrl:"wasserwerte.json",
    sourceUrl:"https://geodaten-wasser.rlp-umwelt.de/gus/2511510500/messwerte"
  }]
};

let CATALOG = {gauges:[], qualityStations:[]};
let SPOTS = [];
let CURRENT_SPOT_ID = "";
let APP_SELECTION = {
  spot:Object.assign({},DEFAULT_SPOT),
  gaugeId:MAINZ_GAUGE_ID,
  qualityId:"quality-rlp-2511510500",
  spotSource:"default",
  spotStationId:"",
  manualGauge:false,
  manualQuality:false
};
let SELECTION_VERSION = 0;
let DATA_REFRESH_TIMER = null;

const $ = id => document.getElementById(id);
const fmt = (n,d=0) => (n==null||isNaN(n)) ? "–" : Number(n).toLocaleString("de-DE",{minimumFractionDigits:d,maximumFractionDigits:d});
const num = v => {
  if(v==null || v==="") return null;
  if(typeof v==="number") return Number.isFinite(v) ? v : null;
  const s=String(v).trim().replace(/\s/g,"");
  const normalized=s.includes(",") ? s.replace(/\./g,"").replace(",",".") : s;
  const n=Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
};
function safeHttpUrl(value){
  try{
    const u=new URL(String(value||""),location.href);
    return u.protocol==="https:"||u.protocol==="http:"?u.href:"";
  }catch(_){ return ""; }
}
const coord = (o, a, b) => num(o && (o[a] != null ? o[a] : o[b]));
const byId = (arr,id) => arr.find(x=>String(x.id)===String(id));
const currentGauge = () => byId(CATALOG.gauges,APP_SELECTION.gaugeId) || CATALOG.gauges[0] || FALLBACK_CATALOG.gauges[0];
const currentQuality = () => byId(CATALOG.qualityStations,APP_SELECTION.qualityId) || CATALOG.qualityStations[0] || FALLBACK_CATALOG.qualityStations[0];

function seriesNames(g){
  if(!g) return [];
  if(Array.isArray(g.series)) return g.series.map(x=>typeof x==="string"?x:(x.shortname||x.name||x.type)).filter(Boolean);
  if(g.series && typeof g.series==="object") return Object.entries(g.series).filter(([,v])=>v!=null&&v!==false).map(([k])=>k);
  if(Array.isArray(g.timeseries)) return g.timeseries.map(x=>x.shortname||x.name||x.type).filter(Boolean);
  return [];
}
function supportsSeries(g,name){ return seriesNames(g).map(String).map(x=>x.toUpperCase()).includes(name); }
function normalizeGauge(g){
  const id=g.id||g.uuid, latitude=coord(g,"latitude","lat"), longitude=coord(g,"longitude","lon");
  const riverKm=num(g.riverKm!=null?g.riverKm:(g.km!=null?g.km:g.km));
  return Object.assign({},g,{
    id:String(id||""), name:g.name||g.shortname||"Rheinpegel",
    latitude, longitude, riverKm,
    series:g.series||g.timeseries||[]
  });
}
function normalizeQuality(q){
  const meta=q.stationMeta||{};
  const id=q.id||q.slug||meta.id||meta.providerStationId;
  const slug=q.slug||String(id||"station").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
  return Object.assign({},q,{
    id:String(id||slug), slug,
    name:q.name||q.station||meta.name||"Gütestation",
    latitude:coord(q,"latitude","lat") ?? coord(meta,"latitude","lat"),
    longitude:coord(q,"longitude","lon") ?? coord(meta,"longitude","lon"),
    riverKm:num(q.riverKm!=null?q.riverKm:(q.km!=null?q.km:meta.riverKm)),
    provider:q.provider||meta.provider||"amtliches Messnetz",
    dataUrl:q.dataUrl||q.data||("data/quality/"+slug+".json"),
    sourceUrl:q.sourceUrl||q.url||""
  });
}
function normalizeCatalog(raw){
  const all=raw||{};
  let gauges=(all.gauges||all.pegelStations||all.stations||[]).filter(Boolean);
  if(gauges.some(x=>x.type)) gauges=gauges.filter(x=>!x.type||x.type==="gauge"||x.type==="pegel");
  let quality=(all.qualityStations||all.quality||all.gueteStations||[]).filter(Boolean);
  if(!quality.length && Array.isArray(all.stations)) quality=all.stations.filter(x=>x.type==="quality"||x.type==="guete");
  gauges=gauges.map(normalizeGauge).filter(x=>x.id&&x.latitude!=null&&x.longitude!=null).sort((a,b)=>(a.riverKm??9999)-(b.riverKm??9999));
  quality=quality.map(normalizeQuality).filter(x=>x.id&&x.latitude!=null&&x.longitude!=null);
  return {
    gauges:gauges.length?gauges:FALLBACK_CATALOG.gauges.map(normalizeGauge),
    qualityStations:quality.length?quality:FALLBACK_CATALOG.qualityStations.map(normalizeQuality),
    updated:all.updated||all.generatedAt||""
  };
}

function loadLegacySelection(){
  try{
    const saved=JSON.parse(localStorage.getItem(SELECTION_KEY));
    if(saved&&saved.spot&&num(saved.spot.lat)!=null&&num(saved.spot.lon)!=null) return saved;
  }catch(_){}
  return null;
}
function persistSelection(){
  try{ localStorage.setItem(SELECTION_KEY,JSON.stringify(APP_SELECTION)); }catch(_){}
}
function haversineKm(a,b){
  const rad=x=>x*Math.PI/180, dLat=rad(b.lat-a.lat), dLon=rad(b.lon-a.lon);
  const s=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;
  return 6371*2*Math.atan2(Math.sqrt(s),Math.sqrt(1-s));
}
function nearestByDistance(list,spot){
  return list.reduce((best,x)=>{
    const d=haversineKm(spot,{lat:x.latitude,lon:x.longitude});
    return !best||d<best.d?{item:x,d}:best;
  },null);
}
function nearestByRiverKm(list,km,spot){
  const usable=list.filter(x=>x.fetchState!=="unavailable");
  const candidates=usable.length?usable:list;
  if(km!=null){
    const withKm=candidates.filter(x=>x.riverKm!=null);
    if(withKm.length) return withKm.reduce((best,x)=>{
      const d=Math.abs(x.riverKm-km);
      const tiedUpstream=best&&Math.abs(d-best.d)<0.0001&&x.riverKm<=km&&best.item.riverKm>km;
      return !best||d<best.d||tiedUpstream?{item:x,d}:best;
    },null);
  }
  return nearestByDistance(candidates,spot);
}
function projectPointToSegment(point,a,b){
  const lat0=point.lat*Math.PI/180, sx=111.32*Math.cos(lat0), sy=110.57;
  const px=point.lon*sx, py=point.lat*sy, ax=a.lon*sx, ay=a.lat*sy, bx=b.lon*sx, by=b.lat*sy;
  const dx=bx-ax, dy=by-ay, den=dx*dx+dy*dy;
  const t=den?Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/den)):0;
  const lon=(ax+t*dx)/sx, lat=(ay+t*dy)/sy;
  return {lat,lon,t,distanceKm:Math.hypot(px-(ax+t*dx),py-(ay+t*dy))};
}
function projectToRhine(lat,lon){
  const route=CATALOG.gauges.filter(g=>g.riverKm!=null).sort((a,b)=>a.riverKm-b.riverKm);
  const p={lat:+lat,lon:+lon};
  if(route.length<2){
    const n=nearestByDistance(CATALOG.gauges,p);
    return {km:n&&n.item.riverKm, distanceKm:n?n.d:null, lat:p.lat, lon:p.lon};
  }
  let best=null;
  for(let i=0;i<route.length-1;i++){
    const a=route[i],b=route[i+1];
    const x=projectPointToSegment(p,{lat:a.latitude,lon:a.longitude},{lat:b.latitude,lon:b.longitude});
    if(!best||x.distanceKm<best.distanceKm){
      best=Object.assign(x,{km:a.riverKm+x.t*(b.riverKm-a.riverKm)});
    }
  }
  return best;
}
function stationLabel(name){
  return String(name||"Rhein").toLowerCase().replace(/(^|[\s-])([a-zäöü])/g,(_,p,c)=>p+c.toUpperCase());
}
function resolveSelection(lat,lon,options){
  const opt=options||{}, projected=projectToRhine(lat,lon), spot={lat:+lat,lon:+lon};
  spot.km=projected&&projected.km!=null?+projected.km.toFixed(2):null;
  spot.distanceToRhineKm=projected&&projected.distanceKm!=null?+projected.distanceKm.toFixed(1):null;
  const nearestGauge=nearestByRiverKm(CATALOG.gauges,spot.km,spot);
  const nearestQuality=nearestByRiverKm(CATALOG.qualityStations,spot.km,spot);
  const labelSource=nearestGauge&&nearestGauge.item;
  spot.label=opt.label||("Nähe "+stationLabel(labelSource&&labelSource.name));
  return {
    spot,
    gaugeId:opt.gaugeId||(nearestGauge&&nearestGauge.item.id)||APP_SELECTION.gaugeId,
    qualityId:opt.qualityId||(nearestQuality&&nearestQuality.item.id)||APP_SELECTION.qualityId,
    spotSource:opt.source||"map",
    spotStationId:opt.spotStationId||"",
    manualGauge:!!opt.gaugeId,
    manualQuality:!!opt.qualityId
  };
}
function clearHistoryCache(){
  Object.keys(HIST).forEach(k=>delete HIST[k]);
  if(CHART_KEY) closeChart();
}
function resetLiveTiles(){
  [["pegelVal","–"],["qVal","–"],["pegelMeta","lädt …"],["qMeta","lädt …"],
   ["airVal","–"],["airMeta","lädt …"],["windVal","–"],["windMeta","lädt …"],
   ["rainVal","–"],["rainMeta","lädt …"],["pressVal","–"],["pressMeta","lädt …"],
   ["skyVal","–"],["skyMeta","lädt …"],["sunVal","–"],["sunMeta","lädt …"]]
    .forEach(([id,text])=>{ if($(id)) $(id).textContent=text; });
  if($("quality")) $("quality").innerHTML='<div class="qtile"><div class="lbl"><i class="bi bi-droplet"></i> Wasserqualität</div><div class="hint">Werte der gewählten Station werden geladen …</div></div>';
}
function setFishingSpot(lat,lon,options){
  APP_SELECTION=resolveSelection(lat,lon,options);
  SELECTION_VERSION++;
  persistSelection();
  clearHistoryCache();
  updateSelectionUI();
  resetLiveTiles();
  loadAll();
}
function changeStationOverride(kind,id){
  const active=getActiveSpot();
  if(!active) return;
  const spot=APP_SELECTION.spot;
  const list=kind==="gauge"?CATALOG.gauges:CATALOG.qualityStations;
  const nearest=nearestByRiverKm(list,spot.km,spot);
  if(id&&!byId(list,id)) return;
  if(kind==="gauge"){
    APP_SELECTION.gaugeId=id||(nearest&&nearest.item.id)||APP_SELECTION.gaugeId;
    APP_SELECTION.manualGauge=!!id;
    active.gaugeId=APP_SELECTION.gaugeId;
    active.manualGauge=!!id;
  }else{
    APP_SELECTION.qualityId=id||(nearest&&nearest.item.id)||APP_SELECTION.qualityId;
    APP_SELECTION.manualQuality=!!id;
    active.qualityId=APP_SELECTION.qualityId;
    active.manualQuality=!!id;
  }
  active.updatedAt=new Date().toISOString();
  saveSpots();
  SELECTION_VERSION++;
  persistSelection(); clearHistoryCache(); updateSelectionUI(); renderExplorerMarkers(); resetLiveTiles(); loadAll();
}
function overrideGauge(id){ changeStationOverride("gauge",id); }
function overrideQuality(id){ changeStationOverride("quality",id); }
function resetToAutomaticStations(){
  const active=getActiveSpot();
  if(!active) return;
  const s=APP_SELECTION.spot;
  const resolved=resolveSelection(s.lat,s.lon,{label:active.name,source:"saved"});
  APP_SELECTION=resolved;
  active.gaugeId=resolved.gaugeId;
  active.qualityId=resolved.qualityId;
  active.manualGauge=false;
  active.manualQuality=false;
  active.updatedAt=new Date().toISOString();
  saveSpots();
  SELECTION_VERSION++;
  persistSelection(); clearHistoryCache(); updateSelectionUI(); renderExplorerMarkers(); resetLiveTiles(); loadAll();
}

// Klassifizierungs-Farbe -> CSS-Farbe für den Kachelstreifen
function stripeColor(c){
  return c==="pg-green" ? "var(--green)"
       : c==="pg-amber" ? "var(--amber)"
       : c==="pg-red"   ? "var(--red)"
       : "var(--water)"; // ohne Gut/Schlecht-Einstufung: blau
}

function trendBadge(series){
  if(!series || series.length<8) return "";
  const last = series[series.length-1].value;
  const ref  = series[Math.max(0,series.length-13)].value; // ~3 h zurück (15-min-Werte)
  const diff = last-ref;
  const th = Math.max(1, Math.abs(ref)*0.004);
  if(diff> th) return '<span class="trend t-up">▲ steigt</span>';
  if(diff<-th) return '<span class="trend t-dn">▼ fällt</span>';
  return '<span class="trend t-fl">▬ stabil</span>';
}
function sparkline(svgEl,series,color){
  if(!svgEl) return;
  if(!series || series.length<2){ svgEl.innerHTML=""; return; }
  const vals = series.map(p=>p.value);
  const min=Math.min(...vals), max=Math.max(...vals), rng=(max-min)||1, n=vals.length;
  const pts = vals.map((v,i)=>{
    const x=(i/(n-1))*100, y=32-((v-min)/rng)*28-2;
    return x.toFixed(1)+","+y.toFixed(1);
  }).join(" ");
  svgEl.innerHTML =
    '<polyline fill="none" stroke="'+color+'" stroke-width="1.6" points="'+pts+'"/>'+
    '<polygon fill="'+color+'" opacity="0.18" points="0,34 '+pts+' 100,34"/>';
}
function relTime(iso){
  const t=new Date(iso), m=Math.round((new Date()-t)/60000);
  if(m<1) return "gerade eben";
  if(m<60) return "vor "+m+" Min";
  return "vor "+Math.floor(m/60)+" Std "+(m%60)+" Min";
}
function hhmm(iso){ return new Date(iso).toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit"}); }

const WMO = {
  0:["Klar","bi-sun"],1:["Überwiegend klar","bi-sun"],2:["Teils bewölkt","bi-cloud-sun"],3:["Bedeckt","bi-cloud"],
  45:["Nebel","bi-cloud-fog"],48:["Reifnebel","bi-cloud-fog"],
  51:["Leichter Niesel","bi-cloud-drizzle"],53:["Niesel","bi-cloud-drizzle"],55:["Starker Niesel","bi-cloud-rain"],
  61:["Leichter Regen","bi-cloud-drizzle"],63:["Regen","bi-cloud-rain"],65:["Starker Regen","bi-cloud-rain-heavy"],
  66:["Gefrierender Regen","bi-cloud-sleet"],67:["Gefrierender Regen","bi-cloud-sleet"],
  71:["Leichter Schnee","bi-cloud-snow"],73:["Schnee","bi-cloud-snow"],75:["Starker Schnee","bi-snow"],77:["Schneegriesel","bi-cloud-snow"],
  80:["Schauer","bi-cloud-drizzle"],81:["Schauer","bi-cloud-rain"],82:["Heftige Schauer","bi-cloud-rain-heavy"],
  85:["Schneeschauer","bi-cloud-snow"],86:["Schneeschauer","bi-cloud-snow"],
  95:["Gewitter","bi-cloud-lightning-rain"],96:["Gewitter mit Hagel","bi-cloud-lightning-rain"],99:["Gewitter mit Hagel","bi-cloud-lightning-rain"]
};
function windDir(deg){
  const d=["N","NNO","NO","ONO","O","OSO","SO","SSO","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return d[Math.round(deg/22.5)%16];
}
async function getJSON(url){
  const r = await fetch(url,{cache:"no-store"});
  if(!r.ok) throw new Error(url+" → "+r.status);
  return r.json();
}
const state = {pegelTrend:null, gust:null, rainNow:null, wcode:null, pressTrend:null};
const snap = { weather:null, pegel:null, q:null };  // Momentaufnahme für Fänge
let CURRENT_GPS = null;

function characteristicValues(gauge){
  const direct=gauge&&gauge.characteristicValues;
  const w=gauge&&gauge.series&&!Array.isArray(gauge.series)&&gauge.series.W;
  const wa=gauge&&Array.isArray(gauge.series)&&gauge.series.find(x=>x&&typeof x==="object"&&String(x.shortname||x.name||x.type).toUpperCase()==="W");
  const source=direct||(w&&w.characteristicValues)||(wa&&wa.characteristicValues)||[];
  if(!Array.isArray(source)) return {MNW:num(source.MNW),MW:num(source.MW),MHW:num(source.MHW)};
  const out={};
  source.forEach(x=>{ const k=String(x.shortname||x.name||"").toUpperCase(); if(["MNW","MW","MHW"].includes(k)) out[k]=num(x.value); });
  return out;
}
function classifyPegel(w,gauge){
  const {MNW,MW,MHW}=characteristicValues(gauge);
  if([MNW,MW,MHW].some(v=>v==null)) return {t:"ohne Einordnung",c:"pg-blue",refs:null};
  const loMid=(MNW+MW)/2, hiMid=(MW+MHW)/2;
  let out;
  if(w<MNW)   out={t:"sehr niedrig", c:"pg-red"};
  else if(w<loMid) out={t:"niedrig", c:"pg-amber"};
  else if(w<hiMid) out={t:"normal", c:"pg-green"};
  else if(w<MHW) out={t:"hoch", c:"pg-amber"};
  else out={t:"sehr hoch", c:"pg-red"};
  out.refs={MNW,MW,MHW}; return out;
}

async function loadPegel(token){
  const gauge=currentGauge(), po=PEGELONLINE_BASE+encodeURIComponent(gauge.id);
  state.pegelTrend=null; snap.pegel=null; snap.q=null;
  try{
    const w = await getJSON(po+"/W/measurements.json?start=P2D");
    if(token!==SELECTION_VERSION) return;
    const last = w[w.length-1];
    $("pegelVal").innerHTML = fmt(last.value)+' <small>cm</small>';
    const pc = classifyPegel(last.value,gauge);
    const title=pc.refs?('Einordnung nach Hauptwerten: MNW '+fmt(pc.refs.MNW)+' · MW '+fmt(pc.refs.MW)+' · MHW '+fmt(pc.refs.MHW)+' cm'):"Für diese Station liegen keine vollständigen Hauptwerte vor";
    $("pegelMeta").innerHTML = '<span class="pgbadge '+pc.c+'" title="'+title+'">'+pc.t+'</span>'+trendBadge(w)+' · '+relTime(last.timestamp);
    sparkline($("pegelSpark"), w.slice(-96), "#021359");
    const pt=$("tilePegel"); if(pt) pt.style.borderTopColor = stripeColor(pc.c);
    state.pegelTrend = w;
    snap.pegel = { pegelstand_cm: last.value, stufe: pc.t, station:gauge.name, station_id:gauge.id };
  }catch(e){
    if(token!==SELECTION_VERSION) return;
    $("pegelVal").innerHTML='<span class="err">n/v</span>'; $("pegelMeta").textContent="Pegel nicht erreichbar";
    sparkline($("pegelSpark"),[],"#021359");
  }
  if(!supportsSeries(gauge,"Q")){
    if(token!==SELECTION_VERSION) return;
    $("qVal").innerHTML='<span class="err">n/v</span>';
    $("qMeta").textContent="Diese Pegelstation misst keinen Durchfluss";
    sparkline($("qSpark"),[],"#32ade6");
    return;
  }
  try{
    const q = await getJSON(po+"/Q/measurements.json?start=P2D");
    if(token!==SELECTION_VERSION) return;
    const last = q[q.length-1];
    $("qVal").innerHTML = fmt(last.value)+' <small>m³/s</small>';
    $("qMeta").innerHTML = trendBadge(q)+' · '+relTime(last.timestamp);
    sparkline($("qSpark"), q.slice(-96), "#32ade6");
    snap.q = last.value;
  }catch(e){
    if(token!==SELECTION_VERSION) return;
    $("qVal").innerHTML='<span class="err">n/v</span>'; $("qMeta").textContent="Durchfluss nicht erreichbar";
    sparkline($("qSpark"),[],"#32ade6");
  }
}

async function loadWeather(token){
  const spot=Object.assign({},APP_SELECTION.spot);
  state.pressTrend=null; state.gust=null; state.rainNow=null; state.wcode=null; snap.weather=null;
  const url = "https://api.open-meteo.com/v1/forecast?latitude="+spot.lat+"&longitude="+spot.lon+
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m"+
    "&hourly=pressure_msl&daily=sunrise,sunset,precipitation_sum"+
    "&timezone=Europe%2FBerlin&forecast_days=1&wind_speed_unit=kmh";
  try{
    const d = await getJSON(url), c = d.current;
    if(token!==SELECTION_VERSION) return;
    $("airVal").innerHTML = fmt(c.temperature_2m,1)+' <small>°C</small>';
    $("airMeta").textContent = "gefühlt "+fmt(c.apparent_temperature,1)+" °C";
    $("windVal").innerHTML = fmt(c.wind_speed_10m)+' <small>km/h '+windDir(c.wind_direction_10m)+'</small>';
    $("windMeta").textContent = "Böen "+fmt(c.wind_gusts_10m)+" km/h";
    $("rainVal").innerHTML = fmt(c.precipitation,1)+' <small>mm/h</small>';
    $("rainMeta").textContent = "heute "+fmt(d.daily.precipitation_sum[0],1)+" mm";
    const wc = WMO[c.weather_code] || ["Unbekannt","bi-cloud"];
    $("skyVal").innerHTML = '<i class="bi '+wc[1]+'" aria-hidden="true"></i> '+wc[0];
    $("skyMeta").textContent = "Bewölkung "+fmt(c.cloud_cover)+" % · Feuchte "+fmt(c.relative_humidity_2m)+" %";
    $("sunVal").innerHTML = '<i class="bi bi-sun" aria-hidden="true"></i> '+hhmm(d.daily.sunrise[0])+" – "+hhmm(d.daily.sunset[0]);
    $("sunMeta").textContent = "Sonnenauf- / -untergang";

    let pt=null;
    try{
      const now=new Date(c.time), times=d.hourly.time.map(t=>new Date(t));
      let i=times.findIndex(t=>t>=now); if(i<1) i=times.length-1;
      pt = d.hourly.pressure_msl[i] - d.hourly.pressure_msl[Math.max(0,i-3)];
    }catch(_){}
    let arrow="▬", ptxt="stabil";
    if(pt!=null){ if(pt>0.8){arrow="▲";ptxt="steigend";} else if(pt<-0.8){arrow="▼";ptxt="fallend";} }
    $("pressVal").innerHTML = fmt(c.pressure_msl)+' <small>hPa</small> '+arrow;
    $("pressMeta").textContent = "Tendenz "+ptxt+" (3 h)";
    state.pressTrend=pt; state.gust=c.wind_gusts_10m; state.rainNow=c.precipitation; state.wcode=c.weather_code;
    snap.weather = {
      lufttemperatur_c: c.temperature_2m, gefuehlt_c: c.apparent_temperature,
      luftfeuchte_pct: c.relative_humidity_2m, niederschlag_mm_h: c.precipitation,
      wettercode: c.weather_code, wetterlage: (WMO[c.weather_code]||["",""])[0],
      bewoelkung_pct: c.cloud_cover, luftdruck_hpa: c.pressure_msl,
      luftdruck_tendenz_3h_hpa: (pt==null? null : Math.round(pt*10)/10),
      wind_kmh: c.wind_speed_10m, windrichtung: windDir(c.wind_direction_10m),
      windrichtung_grad: c.wind_direction_10m, boen_kmh: c.wind_gusts_10m,
      ort: {lat:spot.lat,lon:spot.lon,rhein_km:spot.km}
    };
  }catch(e){ if(token===SELECTION_VERSION) $("skyVal").innerHTML='<span class="err">Wetter n/v</span>'; }
}

function updateAmpel(){
  let score=0; const reasons=[];
  if(state.pressTrend!=null){
    if(state.pressTrend<-3){ score-=1; reasons.push("Luftdruck fällt stark (Wetterumschwung)"); }
    else if(state.pressTrend<=0.8){ score+=1; reasons.push("Luftdruck stabil/leicht fallend – oft gute Beißzeit"); }
    else if(state.pressTrend>3){ score-=1; reasons.push("Luftdruck steigt stark – Fische oft träge"); }
  }
  if(state.gust!=null){
    if(state.gust>=45){ score-=1; reasons.push("kräftige Böen ("+fmt(state.gust)+" km/h)"); }
    else if(state.gust>=12 && state.gust<35){ score+=1; reasons.push("leichte Kräuselung durch Wind"); }
  }
  if(state.rainNow>=2 || [82,95,96,99].includes(state.wcode)){ score-=1; reasons.push("Starkregen/Gewitter"); }
  if(state.pegelTrend && state.pegelTrend.length>13){
    const s=state.pegelTrend, diff=s[s.length-1].value-s[s.length-13].value;
    if(diff>6){ score-=1; reasons.push("Pegel steigt schnell (+"+fmt(diff)+" cm/3h) – Wasser wird trüb"); }
    else if(Math.abs(diff)<=4){ reasons.push("Pegel stabil"); }
  }
  let cls,txt,ico;
  if(score>=2){ cls="lg-green"; txt="Gute Bedingungen"; ico="bi-check-lg"; }
  else if(score<=-1){ cls="lg-red"; txt="Schwierige Bedingungen"; ico="bi-exclamation-lg"; }
  else { cls="lg-amber"; txt="Mittelmäßige Bedingungen"; ico="bi-dash-lg"; }
  $("condDot").className="dot "+cls; $("condDot").innerHTML='<i class="bi '+ico+'" aria-hidden="true"></i>';
  $("condLvl").textContent=txt;
  $("condWhy").textContent = reasons.length ? reasons.join(" · ") : "Keine auffälligen Faktoren.";
}

function copyCoords(){
  const s=APP_SELECTION.spot, t = s.lat+", "+s.lon;
  navigator.clipboard?.writeText(t).then(()=>{
    const b=$("copyBtn"), o=b.textContent; b.textContent="Kopiert"; setTimeout(()=>b.textContent=o,1500);
  }).catch(()=>{});
}

// Einstufung Wasserwerte in 5 Stufen (Faustregel für Angler)
function classifyWQ(label, num){
  if(num==null || isNaN(num)) return null;
  const labels=["sehr niedrig","niedrig","normal","hoch","sehr hoch"];
  let bands, colors;
  if(label==="Wassertemperatur"){ bands=[4,10,20,25];  colors=["pg-red","pg-amber","pg-green","pg-amber","pg-red"]; }
  else if(label==="O₂-Sättigung"){ bands=[60,80,110,130]; colors=["pg-red","pg-amber","pg-green","pg-amber","pg-red"]; }
  else if(label==="Trübung"){       bands=[2,5,15,40];    colors=["pg-green","pg-green","pg-amber","pg-amber","pg-red"]; }
  else return null;
  let i=0; while(i<bands.length && num>=bands[i]) i++;
  return { t:labels[i], c:colors[i] };
}
function qualityIcon(label){
  const icons={
    "Wassertemperatur":"bi-thermometer-half","Sauerstoff":"bi-wind","O₂-Sättigung":"bi-percent",
    "Trübung":"bi-eye","pH-Wert":"bi-beaker","Leitfähigkeit":"bi-lightning-charge"
  };
  return icons[label]||"bi-droplet";
}
function renderQuality(station){
  const box=$("quality"); if(!box) return;
  const d=window.WQ_DATA||{items:[]};
  const items=d.items||[];
  const sourceUrl=station&&safeHttpUrl(station.sourceUrl);
  if(!items.length){
    box.innerHTML='<div class="qtile"><div class="lbl"><i class="bi bi-droplet"></i> Wasserqualität</div>'+
      '<div class="hint">Für diese Station sind gerade keine nutzbaren Werte im Datenbestand.</div>'+
      (sourceUrl?'<a class="go" target="_blank" rel="noopener" href="'+esc(sourceUrl)+'">Amtliche Quelle öffnen <i class="bi bi-arrow-up-right"></i></a>':"")+'</div>';
    const st=$("qStamp");
    if(st) st.textContent="Keine aktuellen Qualitätswerte verfügbar.";
    return;
  }
  const CHARTABLE={"Wassertemperatur":1,"Sauerstoff":1,"O₂-Sättigung":1,"Trübung":1,"pH-Wert":1,"Leitfähigkeit":1};
  box.innerHTML = items.map(it=>{
    const value=it.numericValue!=null?it.numericValue:deNum(it.value);
    const cls=classifyWQ(it.label, value);
    const badge = cls ? '<span class="pgbadge '+cls.c+'">'+cls.t+'</span>' : '';
    const stripe = cls ? stripeColor(cls.c) : "var(--water)";
    const clk = CHARTABLE[it.label] ? ' clickable" onclick="openChart(\'wq:'+it.label+'\')' : '';
    return '<div class="tile'+clk+'" style="border-top-color:'+stripe+'"><div class="lbl"><i class="bi '+qualityIcon(it.label)+'"></i> '+esc(it.label)+'</div>'+
      '<div class="val">'+esc(it.value!=null?it.value:fmt(value,1))+' <small>'+esc(it.unit||"")+'</small></div>'+
      '<div class="meta">'+badge+'Stand: '+esc(it.time||"–")+'</div></div>';
  }).join("");
  const st=$("qStamp");
  if(st){
    const meta=d.stationMeta||{}, provider=station&&station.provider||meta.provider||"amtlicher Quelle";
    const updated=d.updated||d.generatedAt||"unbekannt";
    const stateText=d.fetch&&d.fetch.state==="fallback"?" · letzter verfügbarer Datenstand":"";
    st.innerHTML='Importiert am '+esc(updated)+' · '+esc(provider)+stateText+
      (sourceUrl?' · <a href="'+esc(sourceUrl)+'" target="_blank" rel="noopener">Amtliche Quelle <i class="bi bi-arrow-up-right"></i></a>':"");
  }
}

async function loadQuality(token){
  const station=currentQuality();
  window.WQ_DATA={updated:"",items:[]};
  try{
    const r = await fetch(station.dataUrl+"?t="+Math.floor(Date.now()/300000), {cache:"no-store"});
    if(r.ok){
      const j = await r.json();
      if(token!==SELECTION_VERSION) return;
      if(j && Array.isArray(j.items)) window.WQ_DATA = j;
    }
  }catch(e){ /* z.B. lokal ohne Server geöffnet – dann Startwert/Hinweis */ }
  if(token===SELECTION_VERSION) renderQuality(station);
}

/* ===================== Fangbuch ===================== */
function loadCatches(){ try{ return JSON.parse(localStorage.getItem(CATCH_KEY)) || []; }catch(e){ return []; } }
function saveCatches(a){ try{ localStorage.setItem(CATCH_KEY, JSON.stringify(a)); }catch(e){ alert("Speichern fehlgeschlagen (Speicher voll?)."); } }
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function deNum(s){ const n=num(s); return n==null ? (s==null?null:String(s)) : n; }

function moonPhase(date){
  const syn=29.530588853, ref=Date.UTC(2000,0,6,18,14,0);
  let age=(((date.getTime()-ref)/86400000) % syn + syn) % syn;
  const illum=Math.round((1-Math.cos(2*Math.PI*age/syn))/2*100);
  const N=[[1.85,"Neumond"],[5.54,"zunehmende Sichel"],[9.23,"zunehmender Halbmond"],
    [12.91,"zunehmender Mond"],[16.61,"Vollmond"],[20.30,"abnehmender Mond"],
    [23.99,"abnehmender Halbmond"],[27.68,"abnehmende Sichel"]];
  let name="Neumond"; for(const [lim,nm] of N){ if(age<lim){ name=nm; break; } }
  return { name, age:Math.round(age*10)/10, illum };
}

function waterQualitySnap(){
  const M={ "Wassertemperatur":"wassertemperatur_c","Sauerstoff":"sauerstoff_mgl",
    "O₂-Sättigung":"o2_saettigung_pct","Trübung":"truebung","pH-Wert":"ph","Leitfähigkeit":"leitfaehigkeit_uScm" };
  const out={ stand: (window.WQ_DATA&&window.WQ_DATA.updated)||"" };
  ((window.WQ_DATA&&window.WQ_DATA.items)||[]).forEach(it=>{ const k=M[it.label]; if(k) out[k]=deNum(it.value); });
  return out;
}

function captureGps(){
  if(!navigator.geolocation){ $("gpsInfo").textContent="Ortung auf diesem Gerät nicht verfügbar."; return; }
  $("gpsBtn").textContent="… wird geortet";
  navigator.geolocation.getCurrentPosition(p=>{
    setSelectedLocation(p.coords.latitude, p.coords.longitude, p.coords.accuracy, true);
    $("gpsBtn").textContent="Standort aktualisieren";
  }, ()=>{
    $("gpsInfo").textContent="Ortung abgelehnt/fehlgeschlagen – Fang wird ohne Standort gespeichert.";
    $("gpsBtn").textContent="Handy-Standort";
  }, {enableHighAccuracy:true, timeout:10000, maximumAge:0});
}

function saveCatch(){
  const art=$("f_art").value.trim();
  if(!art){ alert("Bitte eine Fischart eintragen."); $("f_art").focus(); return; }
  const datum=$("f_datum").value, zeit=$("f_zeit").value;
  const dObj = datum ? new Date(datum+"T"+(zeit||"12:00")) : new Date();
  const mp=moonPhase(dObj);
  const rec={
    id: Date.now(),
    erfasst_iso: new Date().toISOString(),
    gewaesser: $("f_gewaesser").value.trim() || "Rhein",
    datum, uhrzeit: zeit,
    fischart: art,
    groesse_cm: $("f_groesse").value ? +$("f_groesse").value : null,
    gewicht_g: $("f_gewicht").value ? +$("f_gewicht").value : null,
    koeder: $("f_koeder").value.trim(),
    methode: $("f_methode").value.trim(),
    notiz: $("f_notiz").value.trim(),
    gps: CURRENT_GPS,
    mondphase: { name:mp.name, alter_tage:mp.age, illumination_pct:mp.illum },
    wetter: snap.weather,
    wasser: Object.assign({
      pegelstand_cm: snap.pegel? snap.pegel.pegelstand_cm : null,
      pegel_stufe: snap.pegel? snap.pegel.stufe : null,
      durchfluss_m3s: snap.q
    }, waterQualitySnap()),
    angelbereich: Object.assign({},APP_SELECTION.spot),
    station: {
      pegel:currentGauge().name, pegel_id:currentGauge().id,
      guete:currentQuality().name, guete_id:currentQuality().id
    }
  };
  const arr=loadCatches(); arr.push(rec); saveCatches(arr);
  $("f_art").value=""; $("f_groesse").value=""; $("f_gewicht").value=""; $("f_koeder").value=""; $("f_notiz").value="";
  const now=new Date(), pad=n=>String(n).padStart(2,'0');
  $("f_zeit").value=pad(now.getHours())+':'+pad(now.getMinutes());
  clearSelectedLocation();
  refreshFangbuch();
}

function deleteCatch(id){
  if(!confirm("Diesen Fang löschen?")) return;
  saveCatches(loadCatches().filter(c=>Number(c.id)!==Number(id)));
  refreshFangbuch();
}

function renderCatches(){
  const arr=loadCatches().sort((a,b)=>((b.datum||"")+(b.uhrzeit||"")).localeCompare((a.datum||"")+(a.uhrzeit||"")));
  $("fbCount").textContent = arr.length+" Fang"+(arr.length===1?"":"e")+" gespeichert";
  const box=$("fbList");
  if(!arr.length){ box.innerHTML='<div class="fbnote" style="padding:8px 4px">Noch keine Fänge – trag deinen ersten Fang oben ein.</div>'; return; }
  box.innerHTML = arr.map(c=>{
    const w=c.wetter||{}, wa=c.wasser||{}, cond=[];
    if(wa.wassertemperatur_c!=null) cond.push("Wasser "+wa.wassertemperatur_c+" °C");
    if(wa.pegelstand_cm!=null) cond.push("Pegel "+wa.pegelstand_cm+" cm"+(wa.pegel_stufe?" ("+wa.pegel_stufe+")":""));
    if(wa.sauerstoff_mgl!=null) cond.push("O₂ "+wa.sauerstoff_mgl+" mg/l");
    if(w.lufttemperatur_c!=null) cond.push("Luft "+w.lufttemperatur_c+" °C");
    if(w.luftdruck_hpa!=null) cond.push(Math.round(w.luftdruck_hpa)+" hPa");
    if(w.wetterlage) cond.push(w.wetterlage);
    if(c.mondphase&&c.mondphase.name) cond.push(c.mondphase.name);
    return '<div class="fbitem"><div class="h"><span class="fish">'+esc(c.fischart)+
      (c.groesse_cm?' · '+esc(c.groesse_cm)+' cm':'')+(c.gewicht_g?' · '+esc(c.gewicht_g)+' g':'')+'</span>'+
      '<button class="del" onclick="deleteCatch('+Number(c.id)+')">Löschen</button></div>'+
      '<div class="when">'+esc(c.datum||"")+' '+esc(c.uhrzeit||"")+' · '+esc(c.gewaesser||"")+
      (c.koeder?' · '+esc(c.koeder):'')+(c.methode?' · '+esc(c.methode):'')+(c.gps?' · Standort gespeichert':'')+'</div>'+
      (cond.length?'<div class="fbcond">'+esc(cond.join(" · "))+'</div>':'')+
      (c.notiz?'<div class="fbcond">„'+esc(c.notiz)+'"</div>':'')+'</div>';
  }).join("");
}

/* ---- Export / Import ---- */
function download(name,text,type){
  const b=new Blob([text],{type:type||"text/plain;charset=utf-8"}), u=URL.createObjectURL(b);
  const a=document.createElement("a"); a.href=u; a.download=name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(u),1500);
}
function exportJSON(){ download("faenge_rheincheck.json", JSON.stringify(loadCatches(),null,2), "application/json"); }
function W_(c,k){ return c.wetter&&c.wetter[k]!=null? c.wetter[k] : ""; }
function A_(c,k){ return c.wasser&&c.wasser[k]!=null? c.wasser[k] : ""; }
function exportCSV(){
  const arr=loadCatches();
  const cols=[
    ["id",c=>c.id],["datum",c=>c.datum],["uhrzeit",c=>c.uhrzeit],["gewaesser",c=>c.gewaesser],["fischart",c=>c.fischart],
    ["groesse_cm",c=>c.groesse_cm],["gewicht_g",c=>c.gewicht_g],["koeder",c=>c.koeder],["methode",c=>c.methode],["notiz",c=>c.notiz],
    ["gps_lat",c=>c.gps?c.gps.lat:""],["gps_lon",c=>c.gps?c.gps.lon:""],["gps_genauigkeit_m",c=>c.gps?c.gps.genauigkeit_m:""],
    ["mondphase",c=>c.mondphase?c.mondphase.name:""],["mond_illum_pct",c=>c.mondphase?c.mondphase.illumination_pct:""],
    ["lufttemp_c",c=>W_(c,"lufttemperatur_c")],["gefuehlt_c",c=>W_(c,"gefuehlt_c")],["wind_kmh",c=>W_(c,"wind_kmh")],
    ["windrichtung",c=>W_(c,"windrichtung")],["boen_kmh",c=>W_(c,"boen_kmh")],["luftdruck_hpa",c=>W_(c,"luftdruck_hpa")],
    ["luftdruck_tendenz_3h_hpa",c=>W_(c,"luftdruck_tendenz_3h_hpa")],["bewoelkung_pct",c=>W_(c,"bewoelkung_pct")],
    ["luftfeuchte_pct",c=>W_(c,"luftfeuchte_pct")],["niederschlag_mm_h",c=>W_(c,"niederschlag_mm_h")],["wetterlage",c=>W_(c,"wetterlage")],
    ["pegel_cm",c=>A_(c,"pegelstand_cm")],["pegel_stufe",c=>A_(c,"pegel_stufe")],["durchfluss_m3s",c=>A_(c,"durchfluss_m3s")],
    ["wassertemp_c",c=>A_(c,"wassertemperatur_c")],["sauerstoff_mgl",c=>A_(c,"sauerstoff_mgl")],["o2_saettigung_pct",c=>A_(c,"o2_saettigung_pct")],
    ["truebung",c=>A_(c,"truebung")],["ph",c=>A_(c,"ph")],["leitfaehigkeit_uScm",c=>A_(c,"leitfaehigkeit_uScm")]
  ];
  const cell=v=>{ if(v==null)v=""; v=String(v).replace(/"/g,'""'); return /[";\n]/.test(v)?'"'+v+'"':v; };
  const head=cols.map(c=>c[0]).join(";");
  const body=arr.map(c=>cols.map(col=>cell(col[1](c))).join(";")).join("\n");
  download("faenge_rheincheck.csv", "﻿"+head+"\n"+body, "text/csv;charset=utf-8");
}
function importJSON(ev){
  const f=ev.target.files[0]; if(!f) return;
  const rd=new FileReader();
  rd.onload=()=>{
    try{
      const data=JSON.parse(rd.result); if(!Array.isArray(data)) throw 0;
      const cur=loadCatches(), ids=new Set(cur.map(x=>num(x.id)??x.id)); let added=0;
      data.forEach((r,i)=>{
        if(!r||typeof r!=="object") return;
        let id=num(r.id); if(id==null) id=Date.now()+i;
        if(ids.has(id)) return;
        const clean=Object.assign({},r,{
          id,
          fischart:String(r.fischart||"").slice(0,120),
          groesse_cm:num(r.groesse_cm), gewicht_g:num(r.gewicht_g)
        });
        if(clean.gps){
          const lat=num(clean.gps.lat),lon=num(clean.gps.lon);
          clean.gps=lat!=null&&lon!=null?Object.assign({},clean.gps,{lat,lon}):null;
        }
        cur.push(clean); ids.add(id); added++;
      });
      saveCatches(cur); refreshFangbuch(); alert(added+" Fänge importiert.");
    }catch(e){ alert("Import fehlgeschlagen: keine gültige Fangbuch-JSON."); }
    ev.target.value="";
  };
  rd.readAsText(f);
}

/* ---- Stationswahl, Favoriten & Leaflet-Karte ---- */
let MAP=null, CATCH_LAYER=null, STATION_LAYER=null, ROUTE_LAYER=null;
let SPOT_MARKER=null, CATCH_SELECT_MARKER=null;

function getFavorites(){
  try{
    const a=JSON.parse(localStorage.getItem(FAVORITES_KEY));
    return Array.isArray(a)?a.filter(f=>f&&num(f.lat)!=null&&num(f.lon)!=null).map(f=>Object.assign({},f,{lat:num(f.lat),lon:num(f.lon)})):[];
  }catch(_){ return []; }
}
function saveFavorites(a){
  try{ localStorage.setItem(FAVORITES_KEY,JSON.stringify(a)); }catch(_){}
}
function matchingFavorite(){
  const s=APP_SELECTION.spot;
  const gaugeId=APP_SELECTION.manualGauge?APP_SELECTION.gaugeId:"";
  const qualityId=APP_SELECTION.manualQuality?APP_SELECTION.qualityId:"";
  return getFavorites().find(f=>haversineKm(s,{lat:f.lat,lon:f.lon})<0.08&&
    String(f.gaugeId||"")===String(gaugeId)&&String(f.qualityId||"")===String(qualityId));
}
function toggleFavorite(){
  const list=getFavorites(), found=matchingFavorite();
  if(found) saveFavorites(list.filter(f=>f.id!==found.id));
  else{
    const s=APP_SELECTION.spot;
    list.push({
      id:String(Date.now()),label:s.label+(s.km!=null?" · km "+fmt(s.km,1):""),lat:s.lat,lon:s.lon,
      gaugeId:APP_SELECTION.manualGauge?APP_SELECTION.gaugeId:"",
      qualityId:APP_SELECTION.manualQuality?APP_SELECTION.qualityId:""
    });
    saveFavorites(list);
  }
  renderFavorites();
}
function selectFavorite(id){
  const f=getFavorites().find(x=>x.id===id); if(!f) return;
  setFishingSpot(f.lat,f.lon,{
    label:f.label.replace(/\s·\skm\s.+$/,""),pan:true,source:"favorite",
    gaugeId:byId(CATALOG.gauges,f.gaugeId)?f.gaugeId:"",
    qualityId:byId(CATALOG.qualityStations,f.qualityId)?f.qualityId:""
  });
}
function renderFavorites(){
  const select=$("favoriteSelect"), list=getFavorites(), found=matchingFavorite();
  if(select){
    select.innerHTML='<option value="">'+(list.length?"Favorit wählen …":"Noch keine Favoriten")+'</option>'+
      list.map(f=>'<option value="'+esc(f.id)+'">'+esc(f.label)+'</option>').join("");
    if(found) select.value=found.id;
  }
  const b=$("favoriteBtn");
  if(b) b.textContent=found?"Favorit entfernen":"Als Favorit speichern";
}
function fillStationControls(){
  const area=$("areaStationSelect"),gs=$("gaugeSelect"),qs=$("qualitySelect");
  const gaugeOptions=CATALOG.gauges.map(g=>{
    const series=seriesNames(g).join(" + ")||"W";
    return '<option value="'+esc(g.id)+'">'+(g.riverKm!=null?"km "+fmt(g.riverKm,1)+" · ":"")+esc(stationLabel(g.name))+" · "+esc(series)+'</option>';
  }).join("");
  if(area) area.innerHTML='<option value="">Karte oder Station wählen …</option>'+gaugeOptions;
  if(gs){
    gs.innerHTML='<option value="">Automatisch · nächste Pegelstation</option>'+gaugeOptions;
  }
  if(qs){
    qs.innerHTML='<option value="">Automatisch · nächste Gütestation</option>'+CATALOG.qualityStations.sort((a,b)=>(a.riverKm??9999)-(b.riverKm??9999)).map(q=>
      '<option value="'+esc(q.id)+'">'+(q.riverKm!=null?"km "+fmt(q.riverKm,1)+" · ":"")+esc(stationLabel(q.name))+" · "+esc(q.provider)+
      (q.fetchState==="unavailable"?" · derzeit ohne Werte":"")+'</option>'
    ).join("");
  }
}
function stationRelation(station,spotKm){
  if(!station||station.riverKm==null||spotKm==null) return "";
  const d=Math.abs(station.riverKm-spotKm);
  if(d<0.15) return "am Angelbereich";
  return fmt(d,1)+" Rhein-km "+(station.riverKm<spotKm?"oberhalb":"unterhalb");
}
function updateSelectionUI(pan){
  const s=APP_SELECTION.spot,g=currentGauge(),q=currentQuality();
  if($("spotTitle")) $("spotTitle").textContent=s.label||"Angelbereich am Rhein";
  const parts=[];
  if(s.km!=null) parts.push("Rhein-km "+fmt(s.km,1));
  parts.push("Pegel "+stationLabel(g.name)+(stationRelation(g,s.km)?" ("+stationRelation(g,s.km)+")":""));
  parts.push("Güte "+stationLabel(q.name)+(stationRelation(q,s.km)?" ("+stationRelation(q,s.km)+")":""));
  if($("spotDetail")) $("spotDetail").textContent=parts.join(" · ");
  if($("headerSub")) $("headerSub").textContent=(s.km!=null?"Rhein-km "+fmt(s.km,1)+" · ":"")+"Live-Bedingungen für deinen Angelbereich";
  document.title="Rhein-Check · "+(s.label||stationLabel(g.name));
  if($("riverHeading")) $("riverHeading").textContent="Fluss · Pegel "+stationLabel(g.name)+" (PEGELONLINE)";
  if($("weatherHeading")) $("weatherHeading").textContent="Wetter am Angelbereich (Open-Meteo / DWD)";
  if($("qualityHeading")) $("qualityHeading").textContent="Wasserqualität · Messstation "+stationLabel(q.name);
  if($("areaStationSelect")) $("areaStationSelect").value=APP_SELECTION.spotSource==="station"&&APP_SELECTION.spotStationId?APP_SELECTION.spotStationId:"";
  if($("gaugeSelect")) $("gaugeSelect").value=APP_SELECTION.manualGauge?g.id:"";
  if($("qualitySelect")) $("qualitySelect").value=APP_SELECTION.manualQuality?q.id:"";
  const warning=s.distanceToRhineKm!=null&&s.distanceToRhineKm>15;
  if($("selectionNote")){
    $("selectionNote").classList.toggle("warn",warning);
    $("selectionNote").textContent=warning
      ?"Der gewählte Punkt liegt etwa "+fmt(s.distanceToRhineKm,0)+" km von der erkannten Rheinlinie entfernt. Bitte prüfe den Kartenpunkt."
      :CATALOG.gauges.length+" Pegel und "+CATALOG.qualityStations.length+" Gütestationen verfügbar · Zuordnung anhand des Rhein-km (Näherung)."+
        (APP_SELECTION.manualGauge||APP_SELECTION.manualQuality?" Manuelle Datenquelle aktiv.":"");
  }
  if($("mapCoords")) $("mapCoords").textContent=s.lat.toFixed(4)+"° N, "+s.lon.toFixed(4)+"° O";
  if($("spotOsmLink")) $("spotOsmLink").href="https://www.openstreetmap.org/?mlat="+s.lat+"&mlon="+s.lon+"#map=14/"+s.lat+"/"+s.lon;
  if($("spotGoogleLink")) $("spotGoogleLink").href="https://www.google.com/maps/search/?api=1&query="+s.lat+","+s.lon;
  const water=$("f_gewaesser");
  if(water && (!water.dataset.userEdited||water.dataset.userEdited==="0")){
    water.value="Rhein bei "+(s.label||stationLabel(g.name)).replace(/^Nähe\s|^Bei\s/,"");
  }
  renderSelectionMarker(pan);
  renderStationMarkers();
  renderFavorites();
}
function initMap(){
  if(MAP || !window.L || !document.getElementById("map")) return;
  const s=APP_SELECTION.spot;
  MAP = L.map("map",{scrollWheelZoom:false}).setView([s.lat,s.lon], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap"}).addTo(MAP);
  ROUTE_LAYER=L.layerGroup().addTo(MAP);
  STATION_LAYER=L.layerGroup().addTo(MAP);
  CATCH_LAYER=L.layerGroup().addTo(MAP);
  MAP.on("click", e=>{
    if(MARKING){
      setSelectedLocation(e.latlng.lat,e.latlng.lng,null,false);
      MARKING=false;
      const hb=$("markHint");
      if(hb){ hb.innerHTML='Fangort markiert. <a href="#" onclick="scrollToSave();return false;">Zum Speichern</a>'; hb.style.display="block"; }
    }else{
      setFishingSpot(e.latlng.lat,e.latlng.lng,{pan:false});
    }
  });
  renderSelectionMarker(false);
  renderStationMarkers();
  renderMarkers();
}
function renderSelectionMarker(pan){
  if(!MAP||!window.L) return;
  const s=APP_SELECTION.spot;
  if(!SPOT_MARKER){
    SPOT_MARKER=L.circleMarker([s.lat,s.lon],{radius:9,color:"#ff9500",weight:3,fillColor:"#ff9500",fillOpacity:.6,bubblingMouseEvents:false})
      .addTo(MAP).bindTooltip("Dein Angelbereich");
  }else SPOT_MARKER.setLatLng([s.lat,s.lon]);
  if(pan){ try{ MAP.setView([s.lat,s.lon],Math.max(MAP.getZoom()||12,13)); }catch(_){} }
}
function renderStationMarkers(){
  if(!MAP||!STATION_LAYER||!ROUTE_LAYER||!window.L) return;
  STATION_LAYER.clearLayers(); ROUTE_LAYER.clearLayers();
  const route=CATALOG.gauges.filter(g=>g.riverKm!=null).sort((a,b)=>a.riverKm-b.riverKm);
  if(route.length>1){
    L.polyline(route.map(g=>[g.latitude,g.longitude]),{color:"#021359",weight:3,opacity:.38,interactive:false}).addTo(ROUTE_LAYER);
  }
  CATALOG.gauges.forEach(g=>{
    const chosen=g.id===APP_SELECTION.gaugeId;
    const marker=L.circleMarker([g.latitude,g.longitude],{
      radius:chosen?9:7,color:"#021359",weight:chosen?3:1.5,fillColor:"#021359",fillOpacity:chosen?.95:.65,bubblingMouseEvents:false
    }).addTo(STATION_LAYER);
    marker.bindTooltip(esc("Pegel "+stationLabel(g.name)+(g.riverKm!=null?" · km "+fmt(g.riverKm,1):"")));
    marker.on("click",()=>selectAreaStation(g.id));
  });
  CATALOG.qualityStations.forEach(q=>{
    const chosen=q.id===APP_SELECTION.qualityId;
    const available=q.fetchState!=="unavailable",color=available?"#32ade6":"#8e8e93";
    const marker=L.circleMarker([q.latitude,q.longitude],{
      radius:chosen?9:7,color,weight:chosen?3:1.5,fillColor:color,fillOpacity:chosen?.95:(available?.7:.35),bubblingMouseEvents:false
    }).addTo(STATION_LAYER);
    marker.bindTooltip(esc("Güte "+stationLabel(q.name)+(q.riverKm!=null?" · km "+fmt(q.riverKm,1):"")+
      (available?"":" · derzeit ohne Werte")));
    marker.on("click",()=>useQualityAsSpot(q.id));
  });
}
function setSelectedLocation(lat, lon, acc, pan){
  CURRENT_GPS={ lat:+(+lat).toFixed(6), lon:+(+lon).toFixed(6), genauigkeit_m: (acc==null? null : Math.round(acc)) };
  if(MAP && window.L){
    if(!CATCH_SELECT_MARKER){
      CATCH_SELECT_MARKER=L.circleMarker([lat,lon],{radius:8,color:"#fb923c",weight:3,fillColor:"#fb923c",fillOpacity:.65}).addTo(MAP);
      CATCH_SELECT_MARKER.bindPopup("Gewählter Fangort");
    } else CATCH_SELECT_MARKER.setLatLng([lat,lon]);
    if(pan){ try{ MAP.setView([lat,lon], Math.max(MAP.getZoom()||13, 15)); }catch(e){} }
  }
  const extra = CURRENT_GPS.genauigkeit_m!=null ? " (Handy, ±"+CURRENT_GPS.genauigkeit_m+" m)" : " (auf Karte gewählt)";
  const gi=$("gpsInfo");
  if(gi) gi.innerHTML='Fangort: '+CURRENT_GPS.lat+', '+CURRENT_GPS.lon+extra+
    ' · <a href="#" onclick="clearSelectedLocation();return false;">entfernen</a>';
}
function clearSelectedLocation(){
  CURRENT_GPS=null; MARKING=false;
  if(CATCH_SELECT_MARKER && MAP){ MAP.removeLayer(CATCH_SELECT_MARKER); CATCH_SELECT_MARKER=null; }
  const gi=$("gpsInfo"); if(gi) gi.textContent="Kein Standort gewählt – nutze die Handy-Ortung oder „Auf Karte markieren\".";
  const b=$("gpsBtn"); if(b) b.textContent="Handy-Standort";
  const hb=$("markHint"); if(hb) hb.style.display="none";
}
function renderMarkers(){
  if(!CATCH_LAYER) return;
  CATCH_LAYER.clearLayers();
  const cs=loadCatches().filter(c=>c&&c.gps&&num(c.gps.lat)!=null&&num(c.gps.lon)!=null);
  cs.forEach(c=>{
    const wa=c.wasser||{};
    const html='<b>'+esc(c.fischart||"Fang")+'</b>'+(c.groesse_cm?' · '+esc(c.groesse_cm)+' cm':'')+
      '<br>'+esc(c.datum||"")+' '+esc(c.uhrzeit||"")+(c.koeder?'<br>Köder: '+esc(c.koeder):'')+
      (wa.pegelstand_cm!=null?'<br>Pegel: '+esc(wa.pegelstand_cm)+' cm':'')+
      (wa.wassertemperatur_c!=null?'<br>Wasser: '+esc(wa.wassertemperatur_c)+' °C':'');
    L.circleMarker([num(c.gps.lat),num(c.gps.lon)],{radius:6,color:"#34c759",weight:2,fillColor:"#34c759",fillOpacity:.85})
      .bindPopup(html).addTo(CATCH_LAYER);
  });
}

let MARKING=false;
function cancelMarking(){
  if(!MARKING) return;
  MARKING=false;
  const hb=$("markHint"); if(hb) hb.style.display="none";
}
function markOnMap(){
  MARKING=true;
  if(!MAP) initMap();
  const hb=$("markHint"); if(hb){ hb.innerHTML="Tippe auf der Karte auf die Stelle deines Fangs."; hb.style.display="block"; }
  const m=document.getElementById("map"); if(m) m.scrollIntoView({behavior:"smooth", block:"center"});
}
function scrollToSave(){ const b=document.getElementById("fbSaveBtn"); if(b) b.scrollIntoView({behavior:"smooth", block:"center"}); }
function renderTable(){
  const box=$("fbTable"); if(!box) return;
  const arr=loadCatches().sort((a,b)=>((b.datum||"")+(b.uhrzeit||"")).localeCompare((a.datum||"")+(a.uhrzeit||"")));
  if(!arr.length){ box.innerHTML='<div class="fbnote" style="padding:8px 4px">Noch keine Fänge.</div>'; return; }
  const rows=arr.map(c=>{
    const ort = c.gps ? esc(c.gps.lat+', '+c.gps.lon) : esc(c.gewaesser||"");
    return '<tr><td>'+esc(c.datum||"")+'</td><td>'+esc(c.uhrzeit||"")+'</td><td>'+esc(c.fischart||"")+'</td>'+
      '<td>'+esc(c.groesse_cm!=null?c.groesse_cm:"")+'</td><td>'+esc(c.gewicht_g!=null?c.gewicht_g:"")+'</td>'+
      '<td>'+esc(c.koeder||"")+'</td><td>'+ort+'</td></tr>';
  }).join("");
  box.innerHTML='<div class="fbwrap"><table class="fbtable"><thead><tr>'+
    '<th>Datum</th><th>Zeit</th><th>Fischart</th><th>cm</th><th>g</th><th>Köder</th><th>Ort</th></tr></thead>'+
    '<tbody>'+rows+'</tbody></table></div>';
}
function toggleTable(){
  const box=$("fbTable"), b=$("tblBtn"); if(!box) return;
  const show=(box.style.display==="none" || !box.style.display);
  if(show){ renderTable(); box.style.display="block"; if(b) b.textContent="Tabelle ausblenden"; }
  else { box.style.display="none"; if(b) b.textContent="Tabelle anzeigen"; }
}
function toggleList(){
  const box=$("fbList"), b=$("listBtn"); if(!box) return;
  const show=(box.style.display==="none" || !box.style.display);
  box.style.display = show ? "block" : "none";
  if(b) b.textContent = show ? "Fänge ausblenden" : "Fänge anzeigen";
}
function refreshFangbuch(){
  renderCatches(); renderMarkers();
  if($("fbTable") && $("fbTable").style.display==="block") renderTable();
}

function initFangbuch(){
  const now=new Date(), pad=n=>String(n).padStart(2,'0');
  if($("f_datum")) $("f_datum").value = now.getFullYear()+'-'+pad(now.getMonth()+1)+'-'+pad(now.getDate());
  if($("f_zeit")) $("f_zeit").value = pad(now.getHours())+':'+pad(now.getMinutes());
  if($("f_gewaesser")){
    $("f_gewaesser").dataset.userEdited="0";
    $("f_gewaesser").addEventListener("input",()=>{$("f_gewaesser").dataset.userEdited="1";},{once:true});
  }
  refreshFangbuch();
  initMap();
}

/* ===================== Verlaufs-Grafen (Chart.js) ===================== */
let CHART=null, CHART_KEY=null, CHART_RANGE="24h";
const HIST={};
const CHART_DEFS={
  pegel:      {title:"Pegelstand",     unit:"cm",   color:"#021359", src:"pegel"},
  durchfluss: {title:"Durchfluss",     unit:"m³/s", color:"#32ade6", src:"durchfluss"},
  airTemp:    {title:"Lufttemperatur", unit:"°C",   color:"#ff9500", src:"wx:temperature_2m"},
  wind:       {title:"Wind",           unit:"km/h", color:"#32ade6", src:"wx:wind_speed_10m"},
  rain:       {title:"Niederschlag",   unit:"mm/h", color:"#021359", src:"wx:precipitation"},
  press:      {title:"Luftdruck",      unit:"hPa",  color:"#ff9500", src:"wx:pressure_msl"},
  cloud:      {title:"Bewölkung",      unit:"%",    color:"#8e8e93", src:"wx:cloud_cover"}
};
const WQ_UNIT={"Wassertemperatur":"°C","Sauerstoff":"mg/l","O₂-Sättigung":"%","Trübung":"FNU","pH-Wert":"","Leitfähigkeit":"µS/cm"};
const WQ_COLOR={"Wassertemperatur":"#ff9500","Sauerstoff":"#34c759","O₂-Sättigung":"#34c759","Trübung":"#8e8e93","pH-Wert":"#af52de","Leitfähigkeit":"#32ade6"};
function defFor(key){
  if(CHART_DEFS[key]) return CHART_DEFS[key];
  if(key.indexOf("wq:")===0){ const l=key.slice(3); return {title:l, unit:WQ_UNIT[l]||"", color:WQ_COLOR[l]||"#021359", src:key}; }
  return null;
}
function toHourly(pts){
  const m=new Map();
  for(const p of pts){ if(p.v==null||isNaN(p.v)) continue; const k=Math.floor(p.t.getTime()/3600000); m.set(k,{t:new Date(k*3600000), v:p.v}); }
  return [...m.values()].sort((a,b)=>a.t-b.t);
}
async function histPegel(param){
  const gauge=currentGauge();
  if(param==="Q"&&!supportsSeries(gauge,"Q")) return [];
  const key="gauge:"+gauge.id+":"+param;
  if(HIST[key]) return HIST[key];
  const a=await getJSON(PEGELONLINE_BASE+encodeURIComponent(gauge.id)+"/"+param+"/measurements.json?start=P8D");
  HIST[key]=a.map(p=>({t:new Date(p.timestamp), v:p.value}));
  return HIST[key];
}
async function histWx(){
  const s=APP_SELECTION.spot, key="wx:"+s.lat.toFixed(4)+":"+s.lon.toFixed(4);
  if(HIST[key]) return HIST[key];
  const url="https://api.open-meteo.com/v1/forecast?latitude="+s.lat+"&longitude="+s.lon+
    "&hourly=temperature_2m,wind_speed_10m,pressure_msl,precipitation,cloud_cover"+
    "&past_days=7&forecast_days=1&timezone=Europe%2FBerlin&wind_speed_unit=kmh";
  const d=await getJSON(url);
  HIST[key]={times:d.hourly.time.map(t=>new Date(t)), h:d.hourly};
  return HIST[key];
}
async function getSeries(def, range){
  const cutoff=Date.now()-(range==="24h"?24*3600e3:7*24*3600e3);
  let pts=null;
  if(def.src==="pegel"||def.src==="durchfluss") pts=await histPegel(def.src==="pegel"?"W":"Q");
  else if(def.src.indexOf("wx:")===0){ const v=def.src.slice(3), wx=await histWx(); pts=wx.times.map((t,i)=>({t, v:wx.h[v]?wx.h[v][i]:null})); }
  else if(def.src.indexOf("wq:")===0){ const l=def.src.slice(3), hi=window.WQ_DATA&&window.WQ_DATA.history&&window.WQ_DATA.history[l]; if(!hi) return null; pts=hi.map(p=>({t:new Date(p.t), v:p.v})); }
  if(!pts) return null;
  return toHourly(pts).filter(p=>p.t.getTime()>=cutoff);
}
function openChart(key){
  const def=defFor(key); if(!def) return;
  CHART_KEY=key; $("cmTitle").textContent=def.title+" – Verlauf";
  $("chartModal").style.display="flex";
  setChartRange("24h");
}
function closeChart(){ $("chartModal").style.display="none"; if(CHART){ CHART.destroy(); CHART=null; } }
async function setChartRange(range){
  CHART_RANGE=range;
  $("cmt24").classList.toggle("active", range==="24h");
  $("cmt7").classList.toggle("active", range==="7d");
  const def=defFor(CHART_KEY), meta=$("cmMeta");
  meta.textContent="lädt …";
  let pts=null; try{ pts=await getSeries(def, range); }catch(e){ pts=null; }
  if(!pts || !pts.length){
    meta.textContent = (def.src.indexOf("wq:")===0) ? "Für diesen Wert liegt noch kein Verlauf vor (kommt nach dem nächsten Datenimport)." : "Keine Verlaufsdaten verfügbar.";
    if(CHART){ CHART.destroy(); CHART=null; }
    return;
  }
  const labels=pts.map(p=> range==="24h" ? hhmm(p.t) : (p.t.getDate()+"."+(p.t.getMonth()+1)+". "+hhmm(p.t)));
  const values=pts.map(p=>p.v);
  const mn=Math.min(...values), mx=Math.max(...values), last=values[values.length-1];
  meta.innerHTML="Aktuell <b>"+fmt(last,1)+" "+def.unit+"</b> · Min "+fmt(mn,1)+" · Max "+fmt(mx,1)+" · Auflösung 1 h";
  drawChart(labels, values, def);
}
function drawChart(labels, values, def){
  const cv=$("cmChart"); if(!cv || !window.Chart) return;
  if(CHART) CHART.destroy();
  const css=getComputedStyle(document.documentElement);
  const muted=css.getPropertyValue("--muted").trim()||"#8e8e93";
  const line=css.getPropertyValue("--line").trim()||"rgba(60,60,67,.18)";
  CHART=new Chart(cv.getContext("2d"),{
    type:"line",
    data:{labels, datasets:[{data:values, borderColor:def.color, backgroundColor:def.color+"22", borderWidth:2, pointRadius:0, fill:true, tension:.25}]},
    options:{responsive:true, maintainAspectRatio:false, animation:false,
      plugins:{legend:{display:false}, tooltip:{callbacks:{label:c=>fmt(c.parsed.y,1)+" "+def.unit}}},
      scales:{x:{ticks:{color:muted, maxTicksLimit:7, maxRotation:0, autoSkip:true}, grid:{color:line}},
              y:{ticks:{color:muted}, grid:{color:line}}}}
  });
}

/* ===================== Beißwetter ===================== */
/* Grobe Heuristik je Fischart aus Angler-Wissen & Fachbeiträgen (Luftdruck, Wassertemperatur,
   Licht, Trübung). Keine exakte Wissenschaft – als Faustregel gedacht. */
const BITE = [
  {name:"Zander",  temp:[12,22], tol:[8,26],  light:"low",  turbid:"like"},
  {name:"Hecht",   temp:[8,18],  tol:[3,22],  light:"low",  turbid:"neutral", wind:true},
  {name:"Barsch",  temp:[10,21], tol:[5,25],  light:"day",  turbid:"neutral"},
  {name:"Rapfen",  temp:[16,27], tol:[12,30], light:"day",  turbid:"clear", sun:true},
  {name:"Wels",    temp:[20,28], tol:[16,31], light:"low",  turbid:"like", risewater:true},
  {name:"Aal",     temp:[16,26], tol:[12,31], light:"night",turbid:"like", risewater:true, dark:true},
  {name:"Karpfen", temp:[15,25], tol:[10,29], light:"twi",  turbid:"neutral"},
  {name:"Brasse",  temp:[14,25], tol:[8,29],  light:"twi",  turbid:"slightlike"}
];
function qNum(label){
  const it=((window.WQ_DATA&&window.WQ_DATA.items)||[]).find(x=>x.label===label);
  if(!it) return null; const n=deNum(it.value); return (typeof n==="number")? n : null;
}
function biteContext(){
  const w=snap.weather||{}, now=new Date(), hour=now.getHours();
  const cloud=w.bewoelkung_pct;
  let lowLight;
  if(hour<=5 || hour>=22) lowLight="night";
  else if(hour<=8 || hour>=19) lowLight="twilight";
  else if(cloud!=null && cloud>=70) lowLight="overcast";
  else lowLight="day";
  let pegelUp=null;
  if(state.pegelTrend && state.pegelTrend.length>13){
    const s=state.pegelTrend; pegelUp=s[s.length-1].value - s[s.length-13].value;
  }
  return { wt:qNum("Wassertemperatur"), turb:qNum("Trübung"), hour, cloud, lowLight,
    ptrend:w.luftdruck_tendenz_3h_hpa, wind:w.wind_kmh, gust:w.boen_kmh, wcode:w.wettercode,
    pegelUp, moon:moonPhase(now) };
}
function evalBite(sp, ctx){
  let score=0; const pros=[], cons=[];
  if(ctx.wt!=null){
    const [lo,hi]=sp.temp,[tlo,thi]=sp.tol;
    if(ctx.wt>=lo && ctx.wt<=hi){ score+=2; pros.push("die Wassertemperatur ("+ctx.wt+" °C) im idealen Bereich liegt"); }
    else if(ctx.wt<tlo || ctx.wt>thi){ score-=2; cons.push("die Wassertemperatur ("+ctx.wt+" °C) ungünstig ist"); }
    else { score-=1; cons.push("die Wassertemperatur ("+ctx.wt+" °C) nicht optimal ist"); }
  }
  const ll=ctx.lowLight;
  if(sp.light==="low"){
    if(ll==="night"||ll==="twilight"){ score+=1; pros.push("wenig Licht herrscht (Dämmerung/Nacht)"); }
    else if(ll==="overcast"){ score+=1; pros.push("der bedeckte Himmel das Licht dämpft"); }
    else { score-=1; cons.push("es am hellen Tag zu grell ist"); }
  } else if(sp.light==="day"){
    if(ll==="day"){ score+=1; pros.push("heller Tag herrscht"); }
    else if(ll==="night"){ score-=1; cons.push("nachts kaum Aktivität herrscht"); }
  } else if(sp.light==="night"){
    if(ll==="night"){ score+=2; pros.push("es dunkel ist (Nacht)"); }
    else if(ll==="twilight"){ score+=1; pros.push("Dämmerung herrscht"); }
    else { score-=2; cons.push("es tagsüber kaum Bisse gibt"); }
  } else if(sp.light==="twi"){
    if(ll==="twilight"){ score+=1; pros.push("Dämmerung herrscht – die beste Zeit"); }
  }
  if(ctx.turb!=null){
    if(sp.turbid==="like"){ if(ctx.turb>=5){ score+=1; pros.push("das Wasser leicht angetrübt ist"); } else if(ctx.turb<2){ score-=1; cons.push("das Wasser sehr klar ist"); } }
    else if(sp.turbid==="clear"){ if(ctx.turb<5){ score+=1; pros.push("das Wasser schön klar ist"); } else if(ctx.turb>=15){ score-=1; cons.push("das Wasser zu trüb ist"); } }
    else if(sp.turbid==="slightlike"){ if(ctx.turb>=3 && ctx.turb<20){ score+=1; pros.push("das Wasser leicht angetrübt ist"); } }
  }
  if(sp.risewater && ctx.pegelUp!=null && ctx.pegelUp>4){ score+=1; pros.push("der Pegel steigt (mehr Strömung und Trübung)"); }
  if(ctx.ptrend!=null){
    if(ctx.ptrend<=-1.5){ score+=1; pros.push("der Luftdruck fällt (kurbelt das Fressen an)"); }
    else if(ctx.ptrend<=0.8){ score+=1; pros.push("der Luftdruck stabil ist"); }
    else if(ctx.ptrend>=2.5){ score-=1; cons.push("der Luftdruck stark steigt"); }
  }
  if(sp.sun && ctx.cloud!=null && ctx.cloud<40 && ctx.wt!=null && ctx.wt>=16){ score+=1; pros.push("es warm und sonnig ist"); }
  if(sp.wind && ctx.wind!=null && ctx.wind>=12 && (ctx.gust==null||ctx.gust<45)){ score+=1; pros.push("leichter Wind das Wasser kräuselt"); }
  if([82,95,96,99].includes(ctx.wcode) && sp.name!=="Wels"){ score-=1; cons.push("ein Gewitter/Starkregen aufzieht"); }
  if(sp.dark && ctx.moon && ctx.moon.illum<=25){ score+=1; pros.push("die Nacht dunkel ist (wenig Mond)"); }

  let color, frag;
  if(score>=2){ color="green"; frag=pros[0]||"die Bedingungen gut passen"; }
  else if(score<=-1){ color="red"; frag=cons[0]||"die Bedingungen ungünstig sind"; }
  else { color="amber"; frag=cons[0]||pros[0]||"die Bedingungen durchwachsen sind"; }
  const lead = color==="green"?"Gut, weil ":color==="red"?"Schwierig, weil ":"Mittel – weil ";
  return { color, reason: lead+frag+"." };
}
function renderBite(){
  const box=$("biteBox"); if(!box) return;
  const ctx=biteContext();
  const tag={green:"beißt gut",amber:"mittel",red:"eher nicht"};
  const col={green:"--green",amber:"--amber",red:"--red"};
  const rows=BITE.map(sp=>{
    const r=evalBite(sp,ctx);
    return '<div class="biteitem"><button class="bitehead" onclick="var e=this.nextElementSibling;e.style.display=(e.style.display===\'block\'?\'none\':\'block\')">'+
      '<span class="bitedot bd-'+r.color+'"></span>'+sp.name+
      '<span class="bitetag" style="color:var('+col[r.color]+')">'+tag[r.color]+' ▾</span></button>'+
      '<div class="bitereason">'+esc(r.reason)+'</div></div>';
  }).join("");
  const warn = ctx.wt==null ? '<div class="fbnote" style="margin:0 4px 10px">Wassertemperatur noch nicht geladen – Einstufung vorläufig.</div>' : '';
  box.innerHTML = warn + rows +
    '<div class="fbnote" style="margin-top:8px">Grobe Faustregeln aus Angler-Wissen &amp; Fachbeiträgen – keine Garantie. Tippe einen Fisch für die Begründung an.</div>';
}
function toggleBite(){
  const box=$("biteBox"), b=$("biteBtn"); if(!box) return;
  const show=(box.style.display==="none"||!box.style.display);
  if(show){ renderBite(); box.style.display="block"; if(b) b.textContent="Einschätzung ausblenden"; }
  else { box.style.display="none"; if(b) b.textContent="Einschätzung anzeigen"; }
}
function toggleFangbuch(){
  const box=$("fangbuchBox"), b=$("fangbuchBtn"); if(!box) return;
  const show=(box.style.display==="none"||!box.style.display);
  box.style.display = show?"block":"none";
  if(b) b.textContent = show?"Fangbuch ausblenden":"Fangbuch anzeigen";
}

async function loadAll(){
  const token=++SELECTION_VERSION;
  $("updated").textContent = "aktualisiere …";
  await Promise.allSettled([loadPegel(token), loadWeather(token), loadQuality(token)]);
  if(token!==SELECTION_VERSION) return;
  updateAmpel();
  if($("biteBox") && $("biteBox").style.display==="block") renderBite();
  $("updated").textContent = "Stand: " + new Date().toLocaleString("de-DE",{dateStyle:"short",timeStyle:"short"}) + " Uhr";
}
async function loadStationCatalog(){
  let raw=FALLBACK_CATALOG;
  try{ raw=await getJSON("data/stations.json?t="+Math.floor(Date.now()/300000)); }catch(_){}
  CATALOG=normalizeCatalog(raw);
  CATALOG.qualityStations.forEach(q=>{
    if(q.riverKm==null){
      const p=projectToRhine(q.latitude,q.longitude);
      if(p&&p.km!=null) q.riverKm=+p.km.toFixed(2);
    }
  });
  const old=APP_SELECTION, fixed={label:old.spot.label,source:old.spotSource,spotStationId:old.spotStationId};
  if(old.manualGauge&&byId(CATALOG.gauges,old.gaugeId)) fixed.gaugeId=old.gaugeId;
  if(old.manualQuality&&byId(CATALOG.qualityStations,old.qualityId)) fixed.qualityId=old.qualityId;
  APP_SELECTION=resolveSelection(old.spot.lat,old.spot.lon,fixed);
  APP_SELECTION.manualGauge=!!fixed.gaugeId;
  APP_SELECTION.manualQuality=!!fixed.qualityId;
  persistSelection();
}
async function bootstrap(){
  loadStoredSelection();
  CATALOG=normalizeCatalog(FALLBACK_CATALOG);
  initFangbuch();
  await loadStationCatalog();
  fillStationControls();
  SELECTION_VERSION++;
  updateSelectionUI(false);
  resetLiveTiles();
  await loadAll();
  setInterval(loadAll,10*60*1000);
}
// Der App-Start erfolgt in ui.js, nachdem Spots, Navigation und Logbuch geladen sind.
