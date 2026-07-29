"use strict";

/* Die Datenberechnung bleibt in app.js. Dieses Modul organisiert die
   App-Navigation, gespeicherte Spots, die Stationskarte und das Trip-Logbuch. */

function newId(prefix){
  try{return prefix+"-"+crypto.randomUUID();}
  catch(_){return prefix+"-"+Date.now()+"-"+Math.random().toString(16).slice(2);}
}
function readArray(key){
  try{const value=JSON.parse(localStorage.getItem(key));return Array.isArray(value)?value:[];}
  catch(_){return [];}
}
function writeArray(key,value){
  try{localStorage.setItem(key,JSON.stringify(value));return true;}
  catch(_){alert("Speichern fehlgeschlagen. Der lokale Browserspeicher ist möglicherweise voll.");return false;}
}
function dateInputValue(date){
  const d=new Date(date),pad=v=>String(v).padStart(2,"0");
  return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
}
function timeInputValue(date){
  const d=new Date(date),pad=v=>String(v).padStart(2,"0");
  return pad(d.getHours())+":"+pad(d.getMinutes());
}
function localDateTime(dateValue,timeValue){
  const d=new Date(String(dateValue||"")+"T"+String(timeValue||"00:00"));
  return Number.isNaN(d.getTime())?null:d;
}
function formatDateTime(iso){
  const d=new Date(iso);
  return Number.isNaN(d.getTime())?"–":d.toLocaleString("de-DE",{dateStyle:"medium",timeStyle:"short"})+" Uhr";
}

/* ===================== Angelplätze ===================== */
function normalizeSpotRecord(raw){
  if(!raw||num(raw.lat)==null||num(raw.lon)==null)return null;
  return {
    id:String(raw.id||newId("spot")),
    name:String(raw.name||raw.label||"Angelplatz").slice(0,80),
    riverId:"rhein",riverName:"Rhein",
    lat:num(raw.lat),lon:num(raw.lon),km:num(raw.km),distanceToRhineKm:num(raw.distanceToRhineKm),
    gaugeId:String(raw.gaugeId||""),qualityId:String(raw.qualityId||""),
    manualGauge:!!raw.manualGauge,manualQuality:!!raw.manualQuality,
    createdAt:raw.createdAt||new Date().toISOString(),updatedAt:raw.updatedAt||new Date().toISOString()
  };
}
function getLegacyFavorites(){
  return readArray(FAVORITES_KEY).map(f=>normalizeSpotRecord({
    id:f.id,name:String(f.label||"Angelplatz").replace(/\s·\skm\s.+$/,""),lat:f.lat,lon:f.lon,
    gaugeId:f.gaugeId,qualityId:f.qualityId,manualGauge:!!f.gaugeId,manualQuality:!!f.qualityId
  })).filter(Boolean);
}
function loadSpots(){
  SPOTS=readArray(SPOTS_KEY).map(normalizeSpotRecord).filter(Boolean);
  if(!SPOTS.length&&localStorage.getItem(SPOTS_KEY)==null){
    const legacy=loadLegacySelection(),migrated=[];
    if(legacy){
      migrated.push(normalizeSpotRecord({
        name:legacy.spot.label||"Mein Angelplatz",lat:legacy.spot.lat,lon:legacy.spot.lon,
        km:legacy.spot.km,distanceToRhineKm:legacy.spot.distanceToRhineKm,
        gaugeId:legacy.gaugeId,qualityId:legacy.qualityId,
        manualGauge:legacy.manualGauge,manualQuality:legacy.manualQuality
      }));
    }
    getLegacyFavorites().forEach(f=>{
      if(!migrated.some(s=>s&&haversineKm(s,f)<.08))migrated.push(f);
    });
    SPOTS=migrated.filter(Boolean);
    saveSpots();
  }
  CURRENT_SPOT_ID=localStorage.getItem(CURRENT_SPOT_KEY)||"";
  if(!SPOTS.some(s=>s.id===CURRENT_SPOT_ID))CURRENT_SPOT_ID=SPOTS[0]?.id||"";
}
function saveSpots(){
  writeArray(SPOTS_KEY,SPOTS);
  try{
    if(CURRENT_SPOT_ID)localStorage.setItem(CURRENT_SPOT_KEY,CURRENT_SPOT_ID);
    else localStorage.removeItem(CURRENT_SPOT_KEY);
  }catch(_){}
}
function getActiveSpot(){return SPOTS.find(s=>s.id===CURRENT_SPOT_ID)||null;}
function syncSelectionFromActive(){
  const spot=getActiveSpot();if(!spot)return false;
  const automatic=resolveSelection(spot.lat,spot.lon,{label:spot.name,source:"saved"});
  if(spot.manualGauge&&byId(CATALOG.gauges,spot.gaugeId))automatic.gaugeId=spot.gaugeId;
  if(spot.manualQuality&&byId(CATALOG.qualityStations,spot.qualityId))automatic.qualityId=spot.qualityId;
  automatic.manualGauge=!!(spot.manualGauge&&byId(CATALOG.gauges,spot.gaugeId));
  automatic.manualQuality=!!(spot.manualQuality&&byId(CATALOG.qualityStations,spot.qualityId));
  APP_SELECTION=automatic;
  Object.assign(spot,{
    km:automatic.spot.km,distanceToRhineKm:automatic.spot.distanceToRhineKm,
    gaugeId:automatic.gaugeId,qualityId:automatic.qualityId,
    manualGauge:automatic.manualGauge,manualQuality:automatic.manualQuality
  });
  persistSelection();saveSpots();
  return true;
}
function activateSpot(id){
  if(!SPOTS.some(s=>s.id===id))return;
  CURRENT_SPOT_ID=id;saveSpots();syncSelectionFromActive();
  SELECTION_VERSION++;clearHistoryCache();resetLiveTiles();renderSpotsPage();renderExplorerMarkers();loadAll();
}
function stationRelation(station,spotKm){
  if(!station||station.riverKm==null||spotKm==null)return "";
  const distance=Math.abs(station.riverKm-spotKm);
  if(distance<.15)return "am Angelplatz";
  return fmt(distance,1)+" Rhein-km "+(station.riverKm<spotKm?"oberhalb":"unterhalb");
}
function gaugeOptions(){
  return CATALOG.gauges.map(g=>{
    const series=seriesNames(g).join(" + ")||"W";
    return '<option value="'+esc(g.id)+'">'+(g.riverKm!=null?"km "+fmt(g.riverKm,1)+" · ":"")+
      esc(stationLabel(g.name))+" · "+esc(series)+'</option>';
  }).join("");
}
function qualityOptions(){
  return CATALOG.qualityStations.slice().sort((a,b)=>(a.riverKm??9999)-(b.riverKm??9999)).map(q=>
    '<option value="'+esc(q.id)+'">'+(q.riverKm!=null?"km "+fmt(q.riverKm,1)+" · ":"")+esc(stationLabel(q.name))+
    " · "+esc(q.provider)+(q.fetchState==="unavailable"?" · derzeit ohne Werte":"")+'</option>'
  ).join("");
}
function fillStationControls(){
  const active=getActiveSpot(),g=currentGauge(),q=currentQuality();
  if($("gaugeSelect")){
    $("gaugeSelect").innerHTML='<option value="">Automatisch · '+esc(stationLabel(g.name))+'</option>'+gaugeOptions();
    $("gaugeSelect").value=active&&active.manualGauge?active.gaugeId:"";
  }
  if($("qualitySelect")){
    $("qualitySelect").innerHTML='<option value="">Automatisch · '+esc(stationLabel(q.name))+'</option>'+qualityOptions();
    $("qualitySelect").value=active&&active.manualQuality?active.qualityId:"";
  }
  if($("spotGaugeInput"))$("spotGaugeInput").innerHTML='<option value="">Automatisch entlang des Rheins</option>'+gaugeOptions();
  if($("spotQualityInput"))$("spotQualityInput").innerHTML='<option value="">Automatisch entlang des Rheins</option>'+qualityOptions();
}
function updateSelectionUI(){
  const active=getActiveSpot();if(!active)return;
  const s=APP_SELECTION.spot,g=currentGauge(),q=currentQuality(),parts=[];
  if(s.km!=null)parts.push("Rhein-km "+fmt(s.km,1));
  parts.push("Pegel "+stationLabel(g.name)+(stationRelation(g,s.km)?" ("+stationRelation(g,s.km)+")":""));
  parts.push("Güte "+stationLabel(q.name)+(stationRelation(q,s.km)?" ("+stationRelation(q,s.km)+")":""));
  $("spotTitle").textContent=active.name;$("spotDetail").textContent=parts.join(" · ");
  $("riverHeading").textContent="Wasser · Pegel "+stationLabel(g.name)+" (PEGELONLINE)";
  $("weatherHeading").textContent="Wetter am Angelplatz (Open-Meteo / DWD)";
  $("qualityHeading").textContent="Wasserqualität · Messstation "+stationLabel(q.name);
  $("spotOsmLink").href="https://www.openstreetmap.org/?mlat="+s.lat+"&mlon="+s.lon+"#map=14/"+s.lat+"/"+s.lon;
  $("spotGoogleLink").href="https://www.google.com/maps/search/?api=1&query="+s.lat+","+s.lon;
  const warning=s.distanceToRhineKm!=null&&s.distanceToRhineKm>15;
  $("selectionNote").classList.toggle("warn",warning);
  $("selectionNote").textContent=warning
    ?"Der Kartenpunkt liegt etwa "+fmt(s.distanceToRhineKm,0)+" km von der erkannten Rheinlinie entfernt. Prüfe den Spot bitte noch einmal."
    :"Zuordnung ausschließlich entlang des Rheins · "+CATALOG.gauges.length+" Pegel und "+CATALOG.qualityStations.length+
      " Gütestationen verfügbar."+(APP_SELECTION.manualGauge||APP_SELECTION.manualQuality?" Manuelle Datenquelle aktiv.":"");
  document.title="Rhein-Check · "+active.name;
  fillStationControls();
}
function renderSpotsPage(){
  const active=getActiveSpot(),select=$("spotSelect");
  $("spotsEmpty").hidden=!!active;$("spotContent").hidden=!active;
  if(!active){
    $("headerSub").textContent="Deine Angelplätze am deutschen Rhein";
    $("updated").textContent=CATALOG.gauges.length+" Pegel · "+CATALOG.qualityStations.length+" Gütestationen";
    return;
  }
  select.innerHTML=SPOTS.map(s=>'<option value="'+esc(s.id)+'">'+esc(s.name)+(s.km!=null?" · km "+fmt(s.km,1):"")+'</option>').join("");
  select.value=active.id;
  $("headerSub").textContent=(active.km!=null?"Rhein-km "+fmt(active.km,1)+" · ":"")+"Live-Bedingungen für "+active.name;
  updateSelectionUI();
}

/* ===================== Angelplatz-Editor ===================== */
let UI_SPOT_MAP=null,UI_SPOT_LAYER=null,UI_SPOT_ROUTE=null,UI_SPOT_MARKER=null;
let UI_SPOT_EDITOR_ID="",UI_SPOT_CANDIDATE=null;
function closeDialog(id){const dialog=$(id);if(dialog&&dialog.open)dialog.close();}
function openSpotEditor(seed){
  UI_SPOT_EDITOR_ID="";UI_SPOT_CANDIDATE=null;
  $("spotDialogTitle").textContent="Angelplatz hinzufügen";$("spotNameInput").value="";
  $("spotEditorNote").textContent="Wähle einen Punkt auf der Karte.";$("spotEditorNote").classList.remove("warn");
  $("mapCoords").textContent="Noch keinen Punkt gewählt";
  fillStationControls();$("spotGaugeInput").value="";$("spotQualityInput").value="";
  $("spotDialog").showModal();
  setTimeout(()=>{
    initSpotEditorMap();
    if(seed&&num(seed.lat)!=null&&num(seed.lon)!=null)setEditorCandidate(seed.lat,seed.lon,true,seed.name||"");
    else{
      if(UI_SPOT_MARKER){UI_SPOT_LAYER.removeLayer(UI_SPOT_MARKER);UI_SPOT_MARKER=null;}
      UI_SPOT_MAP.setView([50.25,8.1],7);UI_SPOT_MAP.invalidateSize();
    }
  },40);
}
function editActiveSpot(){
  const spot=getActiveSpot();if(!spot)return;
  UI_SPOT_EDITOR_ID=spot.id;UI_SPOT_CANDIDATE=Object.assign({},spot);
  $("spotDialogTitle").textContent="Angelplatz bearbeiten";$("spotNameInput").value=spot.name;
  fillStationControls();$("spotGaugeInput").value=spot.manualGauge?spot.gaugeId:"";$("spotQualityInput").value=spot.manualQuality?spot.qualityId:"";
  $("spotDialog").showModal();
  setTimeout(()=>{initSpotEditorMap();setEditorCandidate(spot.lat,spot.lon,true,spot.name,true);},40);
}
function initSpotEditorMap(){
  if(!window.L)return;
  if(!UI_SPOT_MAP){
    UI_SPOT_MAP=L.map("spotEditorMap",{scrollWheelZoom:false}).setView([50.25,8.1],7);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap"}).addTo(UI_SPOT_MAP);
    UI_SPOT_ROUTE=L.layerGroup().addTo(UI_SPOT_MAP);UI_SPOT_LAYER=L.layerGroup().addTo(UI_SPOT_MAP);
    UI_SPOT_MAP.on("click",event=>setEditorCandidate(event.latlng.lat,event.latlng.lng,false));
    renderEditorStations();
  }
  UI_SPOT_MAP.invalidateSize();
}
function renderEditorStations(){
  if(!UI_SPOT_MAP||!UI_SPOT_LAYER)return;
  UI_SPOT_LAYER.clearLayers();UI_SPOT_ROUTE.clearLayers();
  const route=CATALOG.gauges.filter(g=>g.riverKm!=null).sort((a,b)=>a.riverKm-b.riverKm);
  if(route.length>1)L.polyline(route.map(g=>[g.latitude,g.longitude]),{color:"#38bdf8",weight:3,opacity:.3,interactive:false}).addTo(UI_SPOT_ROUTE);
  CATALOG.gauges.forEach(g=>{
    const marker=L.circleMarker([g.latitude,g.longitude],{radius:5,color:"#38bdf8",weight:1.5,fillColor:"#38bdf8",fillOpacity:.75,bubblingMouseEvents:false}).addTo(UI_SPOT_LAYER);
    marker.bindTooltip("Pegel "+stationLabel(g.name));marker.on("click",()=>setEditorCandidate(g.latitude,g.longitude,true,"Bei "+stationLabel(g.name)));
  });
  CATALOG.qualityStations.forEach(q=>{
    const color=q.fetchState==="unavailable"?"#8ea2be":"#2dd4bf";
    const marker=L.circleMarker([q.latitude,q.longitude],{radius:5,color,weight:1.5,fillColor:color,fillOpacity:.7,bubblingMouseEvents:false}).addTo(UI_SPOT_LAYER);
    marker.bindTooltip("Güte "+stationLabel(q.name));marker.on("click",()=>setEditorCandidate(q.latitude,q.longitude,true,"Bei "+stationLabel(q.name)));
  });
}
function setEditorCandidate(lat,lon,pan,suggestedName,preserveOverrides){
  const resolved=resolveSelection(lat,lon,{label:suggestedName||"Angelplatz",source:"map"});
  UI_SPOT_CANDIDATE=Object.assign({},resolved.spot,{gaugeId:resolved.gaugeId,qualityId:resolved.qualityId});
  if(!UI_SPOT_MARKER){
    UI_SPOT_MARKER=L.circleMarker([lat,lon],{radius:9,color:"#fbbf24",weight:3,fillColor:"#fbbf24",fillOpacity:.68,bubblingMouseEvents:false}).addTo(UI_SPOT_LAYER);
  }else UI_SPOT_MARKER.setLatLng([lat,lon]);
  if(pan)UI_SPOT_MAP.setView([lat,lon],Math.max(UI_SPOT_MAP.getZoom()||12,13));
  if(suggestedName&&!$("spotNameInput").value)$("spotNameInput").value=suggestedName;
  if(!preserveOverrides){$("spotGaugeInput").value="";$("spotQualityInput").value="";}
  $("mapCoords").textContent="📍 "+Number(lat).toFixed(4)+"° N, "+Number(lon).toFixed(4)+"° O";
  const warning=resolved.spot.distanceToRhineKm!=null&&resolved.spot.distanceToRhineKm>15;
  $("spotEditorNote").classList.toggle("warn",warning);
  $("spotEditorNote").textContent=warning
    ?"Dieser Punkt liegt etwa "+fmt(resolved.spot.distanceToRhineKm,0)+" km von der Rheinlinie entfernt."
    :"Rhein-km "+fmt(resolved.spot.km,1)+" · automatisch: Pegel "+stationLabel(byId(CATALOG.gauges,resolved.gaugeId)?.name)+
      " · Güte "+stationLabel(byId(CATALOG.qualityStations,resolved.qualityId)?.name);
}
function saveSpotFromEditor(){
  const name=$("spotNameInput").value.trim();
  if(!UI_SPOT_CANDIDATE){$("spotEditorNote").textContent="Bitte wähle zuerst einen Punkt auf der Karte.";return;}
  if(!name){$("spotNameInput").focus();$("spotEditorNote").textContent="Bitte gib deinem Angelplatz einen Namen.";return;}
  const gaugeOverride=$("spotGaugeInput").value,qualityOverride=$("spotQualityInput").value;
  const automatic=resolveSelection(UI_SPOT_CANDIDATE.lat,UI_SPOT_CANDIDATE.lon,{label:name,source:"saved"});
  const previous=SPOTS.find(s=>s.id===UI_SPOT_EDITOR_ID);
  const spot=normalizeSpotRecord({
    id:previous?.id||newId("spot"),name,lat:automatic.spot.lat,lon:automatic.spot.lon,
    km:automatic.spot.km,distanceToRhineKm:automatic.spot.distanceToRhineKm,
    gaugeId:gaugeOverride||automatic.gaugeId,qualityId:qualityOverride||automatic.qualityId,
    manualGauge:!!gaugeOverride,manualQuality:!!qualityOverride,
    createdAt:previous?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()
  });
  if(previous)SPOTS[SPOTS.findIndex(s=>s.id===previous.id)]=spot;else SPOTS.push(spot);
  CURRENT_SPOT_ID=spot.id;saveSpots();syncSelectionFromActive();closeDialog("spotDialog");
  SELECTION_VERSION++;clearHistoryCache();resetLiveTiles();renderSpotsPage();renderExplorerMarkers();renderLogbook();navigateTo("spots");loadAll();
}
function deleteActiveSpot(){
  const active=getActiveSpot();
  if(!active||!confirm('Angelplatz „'+active.name+'“ löschen? Bereits gespeicherte Trips behalten Name und Koordinaten.'))return;
  SPOTS=SPOTS.filter(s=>s.id!==active.id);CURRENT_SPOT_ID=SPOTS[0]?.id||"";saveSpots();
  if(CURRENT_SPOT_ID)syncSelectionFromActive();
  SELECTION_VERSION++;clearHistoryCache();renderSpotsPage();renderExplorerMarkers();renderLogbook();
  if(CURRENT_SPOT_ID){resetLiveTiles();loadAll();}
}

/* ===================== Navigation ===================== */
function setPage(tab){
  const allowed=["spots","map","logbook"],next=allowed.includes(tab)?tab:"spots";
  document.querySelectorAll(".app-page").forEach(page=>{
    const active=page.dataset.page===next;page.hidden=!active;page.classList.toggle("active",active);
  });
  document.querySelectorAll(".nav-item").forEach(item=>item.classList.toggle("active",item.dataset.tab===next));
  if(next==="map")setTimeout(()=>{initExplorerMap();if(UI_EXPLORER_MAP)UI_EXPLORER_MAP.invalidateSize();},30);
  if(next==="logbook")renderLogbook();
  window.scrollTo({top:0,behavior:"instant"});
}
function navigateTo(tab){
  const hash="#/"+tab;
  if(location.hash!==hash)location.hash=hash;else setPage(tab);
}
function pageFromHash(){return(location.hash.match(/^#\/(spots|map|logbook)$/)||[])[1]||"spots";}

/* ===================== Messstellenkarte ===================== */
let UI_EXPLORER_MAP=null,UI_EXPLORER_STATIONS=null,UI_EXPLORER_ROUTE=null,UI_EXPLORER_SPOTS=null;
let UI_STATION_DETAIL_TOKEN=0;
function initExplorerMap(){
  if(!window.L||!$("stationMap"))return;
  if(!UI_EXPLORER_MAP){
    UI_EXPLORER_MAP=L.map("stationMap",{scrollWheelZoom:true}).setView([50.25,8.1],7);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap"}).addTo(UI_EXPLORER_MAP);
    UI_EXPLORER_ROUTE=L.layerGroup().addTo(UI_EXPLORER_MAP);
    UI_EXPLORER_STATIONS=L.layerGroup().addTo(UI_EXPLORER_MAP);
    UI_EXPLORER_SPOTS=L.layerGroup().addTo(UI_EXPLORER_MAP);
  }
  renderExplorerMarkers();
}
function renderExplorerMarkers(){
  if(!UI_EXPLORER_MAP||!UI_EXPLORER_STATIONS)return;
  UI_EXPLORER_STATIONS.clearLayers();UI_EXPLORER_ROUTE.clearLayers();UI_EXPLORER_SPOTS.clearLayers();
  const route=CATALOG.gauges.filter(g=>g.riverKm!=null).sort((a,b)=>a.riverKm-b.riverKm);
  if(route.length>1)L.polyline(route.map(g=>[g.latitude,g.longitude]),{color:"#38bdf8",weight:3,opacity:.34,interactive:false}).addTo(UI_EXPLORER_ROUTE);
  if($("filterGauges")?.checked!==false)CATALOG.gauges.forEach(g=>{
    const marker=L.circleMarker([g.latitude,g.longitude],{radius:7,color:"#38bdf8",weight:2,fillColor:"#38bdf8",fillOpacity:.76,bubblingMouseEvents:false}).addTo(UI_EXPLORER_STATIONS);
    marker.bindTooltip("Pegel "+stationLabel(g.name)+(g.riverKm!=null?" · km "+fmt(g.riverKm,1):""));
    marker.on("click",()=>openStationDetail("gauge",g.id));
  });
  if($("filterQuality")?.checked!==false)CATALOG.qualityStations.forEach(q=>{
    const available=q.fetchState!=="unavailable",color=available?"#2dd4bf":"#8ea2be";
    const marker=L.circleMarker([q.latitude,q.longitude],{radius:7,color,weight:2,fillColor:color,fillOpacity:available?.76:.38,bubblingMouseEvents:false}).addTo(UI_EXPLORER_STATIONS);
    marker.bindTooltip("Güte "+stationLabel(q.name)+(q.riverKm!=null?" · km "+fmt(q.riverKm,1):"")+(available?"":" · derzeit ohne Werte"));
    marker.on("click",()=>openStationDetail("quality",q.id));
  });
  if($("filterSpots")?.checked!==false)SPOTS.forEach(s=>{
    const marker=L.circleMarker([s.lat,s.lon],{radius:s.id===CURRENT_SPOT_ID?9:7,color:"#fbbf24",weight:s.id===CURRENT_SPOT_ID?3:2,fillColor:"#fbbf24",fillOpacity:.7,bubblingMouseEvents:false}).addTo(UI_EXPLORER_SPOTS);
    marker.bindTooltip(s.name+(s.id===CURRENT_SPOT_ID?" · aktiv":""));
    marker.on("click",()=>{activateSpot(s.id);navigateTo("spots");});
  });
}
function gaugeMeasurement(gauge,key){
  const series=gauge&&gauge.series;
  if(series&&!Array.isArray(series)&&series[key])return series[key].currentMeasurement||series[key].measurement||null;
  if(Array.isArray(series)){
    const item=series.find(x=>String(x.shortname||x.name||x.type).toUpperCase()===key);
    return item&&(item.currentMeasurement||item.measurement)||null;
  }
  return null;
}
function stationActionButtons(type,id,station){
  const active=getActiveSpot();
  return '<div class="station-actions">'+
    (active?'<button class="primary" type="button" onclick="useStationForActiveSpot(\''+type+'\',\''+esc(id)+'\')">Für „'+esc(active.name)+'“ verwenden</button>':"")+
    '<button class="secondary" type="button" onclick="openSpotEditorAtStation(\''+type+'\',\''+esc(id)+'\')">Angelplatz hier hinzufügen</button>'+
    (safeHttpUrl(station.sourceUrl)?'<a class="secondary" target="_blank" rel="noopener" href="'+esc(safeHttpUrl(station.sourceUrl))+'">Amtliche Quelle öffnen ↗</a>':"")+
    '</div>';
}
async function openStationDetail(type,id){
  const token=++UI_STATION_DETAIL_TOKEN;
  const station=type==="gauge"?byId(CATALOG.gauges,id):byId(CATALOG.qualityStations,id);
  if(!station)return;
  let values="";
  if(type==="gauge"){
    const w=gaugeMeasurement(station,"W"),q=gaugeMeasurement(station,"Q");
    values='<div class="station-values">'+
      '<div class="station-value"><span>Pegelstand</span><strong>'+(w?fmt(w.value)+" cm":"kein aktueller Wert")+'</strong></div>'+
      '<div class="station-value"><span>Durchfluss</span><strong>'+(q?fmt(q.value)+" m³/s":"nicht gemessen")+'</strong></div>'+
      (w&&w.timestamp?'<div class="station-value"><span>Stand</span><strong>'+esc(formatDateTime(w.timestamp))+'</strong></div>':"")+'</div>';
  }else values='<div class="station-values"><div class="station-value"><span>Messwerte</span><strong>werden geladen …</strong></div></div>';
  $("stationDetail").innerHTML='<div class="station-kicker">'+(type==="gauge"?"Pegelstation":"Gütestation")+'</div><h3>'+esc(stationLabel(station.name))+'</h3>'+
    '<div class="station-facts"><div class="station-fact"><span>Gewässer</span><strong>Rhein</strong></div>'+
    '<div class="station-fact"><span>Rhein-km</span><strong>'+fmt(station.riverKm,1)+'</strong></div>'+
    '<div class="station-fact"><span>Netz</span><strong>'+esc(type==="gauge"?"WSV / PEGELONLINE":station.provider)+'</strong></div>'+
    '<div class="station-fact"><span>Status</span><strong>'+(station.fetchState==="unavailable"?"ohne aktuellen Wert":"verfügbar")+'</strong></div></div>'+
    '<div id="stationDetailValues">'+values+'</div>'+stationActionButtons(type,id,station);
  if(type==="quality"){
    try{
      const data=await getJSON(station.dataUrl+"?t="+Math.floor(Date.now()/300000));
      if(token!==UI_STATION_DETAIL_TOKEN)return;
      const items=Array.isArray(data.items)?data.items:[];
      $("stationDetailValues").innerHTML=items.length?'<div class="station-values">'+items.map(item=>
        '<div class="station-value"><span>'+esc((item.icon||"")+" "+item.label)+'</span><strong>'+esc(item.value)+" "+esc(item.unit||"")+'</strong></div>'
      ).join("")+'</div>':'<div class="muted-note">Für diese Station liegen derzeit keine nutzbaren Messwerte vor.</div>';
    }catch(_){
      if(token===UI_STATION_DETAIL_TOKEN)$("stationDetailValues").innerHTML='<div class="muted-note">Messwerte konnten gerade nicht geladen werden.</div>';
    }
  }
}
function useStationForActiveSpot(type,id){
  if(!getActiveSpot())return;
  changeStationOverride(type==="gauge"?"gauge":"quality",id);navigateTo("spots");
}
function openSpotEditorAtStation(type,id){
  const station=type==="gauge"?byId(CATALOG.gauges,id):byId(CATALOG.qualityStations,id);
  if(station)openSpotEditor({lat:station.latitude,lon:station.longitude,name:"Bei "+stationLabel(station.name)});
}

/* ===================== Trip-Logbuch ===================== */
let UI_TRIPS=[],UI_TRIP_CLOCK_TIMER=null;
function loadTrips(){
  UI_TRIPS=readArray(TRIPS_KEY).filter(t=>t&&t.id&&t.startAt).map(t=>
    Object.assign({status:t.endAt?"completed":"active",catches:[]},t,{catches:Array.isArray(t.catches)?t.catches:[]})
  );
  migrateLegacyCatches();
}
function saveTrips(){writeArray(TRIPS_KEY,UI_TRIPS);}
function legacyCatchDate(c){
  const date=localDateTime(c.datum,c.uhrzeit||"12:00");
  if(date)return date;
  const fallback=new Date(c.erfasst_iso||Date.now());
  return Number.isNaN(fallback.getTime())?new Date():fallback;
}
function migrateLegacyCatches(){
  if(localStorage.getItem(TRIP_MIGRATION_KEY))return;
  readArray(CATCH_KEY).forEach(c=>{
    const when=legacyCatchDate(c),spotData=c.angelbereich||{};
    const matching=SPOTS.find(s=>num(spotData.lat)!=null&&num(spotData.lon)!=null&&haversineKm(s,{lat:num(spotData.lat),lon:num(spotData.lon)})<.15);
    const snapshot={id:matching?.id||"",name:matching?.name||spotData.label||c.gewaesser||"Importierter Angelplatz",riverName:"Rhein",
      lat:num(spotData.lat),lon:num(spotData.lon),km:num(spotData.km)};
    UI_TRIPS.push({
      id:newId("trip"),spotId:matching?.id||"",spotSnapshot:snapshot,startAt:when.toISOString(),endAt:when.toISOString(),
      status:"completed",notes:"Aus dem bisherigen Fangbuch übernommen.",method:c.methode||"",
      createdAt:new Date().toISOString(),migrated:true,conditionsStart:{weather:c.wetter||null,water:c.wasser||null,station:c.station||null},
      catches:[{id:newId("catch"),timeAt:when.toISOString(),species:c.fischart||"Fang",bait:c.koeder||"",method:c.methode||"",
        lengthCm:num(c.groesse_cm),weightG:num(c.gewicht_g),disposition:"",notes:c.notiz||"",
        conditions:{weather:c.wetter||null,water:c.wasser||null},migrated:true}]
    });
  });
  saveTrips();
  try{localStorage.setItem(TRIP_MIGRATION_KEY,new Date().toISOString());}catch(_){}
}
function getActiveTrip(){return UI_TRIPS.find(t=>t.status==="active"&&!t.endAt)||null;}
function conditionsSnapshot(){
  return {
    capturedAt:new Date().toISOString(),weather:snap.weather?Object.assign({},snap.weather):null,
    water:Object.assign({pegelstand_cm:snap.pegel?.pegelstand_cm??null,pegel_stufe:snap.pegel?.stufe??null,durchfluss_m3s:snap.q},waterQualitySnap()),
    station:{gaugeId:currentGauge().id,gaugeName:currentGauge().name,qualityId:currentQuality().id,qualityName:currentQuality().name}
  };
}
function renderTimeWheel(id,value){
  const [hour,minute]=String(value||"00:00").split(":").map(Number);
  const items=(count,type)=>Array.from({length:count},(_,i)=>
    '<div class="wheel-item" data-value="'+i+'" onclick="selectWheelItem(\''+id+'\',\''+type+'\','+i+')">'+String(i).padStart(2,"0")+'</div>'
  ).join("");
  return '<div class="time-wheel" id="'+id+'" data-time="'+String(hour).padStart(2,"0")+':'+String(minute).padStart(2,"0")+'">'+
    '<div class="wheel-col" data-part="hour">'+items(24,"hour")+'</div><div class="wheel-sep">:</div>'+
    '<div class="wheel-col" data-part="minute">'+items(60,"minute")+'</div></div>';
}
function initTimeWheel(id,value){
  const root=$(id);if(!root)return;
  const [hour,minute]=String(value||"00:00").split(":").map(Number);
  root.querySelectorAll(".wheel-col").forEach(col=>{
    const initial=col.dataset.part==="hour"?hour:minute;
    requestAnimationFrame(()=>{col.scrollTop=(initial||0)*44;});
    let timer;
    col.addEventListener("scroll",()=>{
      clearTimeout(timer);
      timer=setTimeout(()=>{
        const selected=Math.max(0,Math.min(col.children.length-1,Math.round(col.scrollTop/44)));
        col.scrollTo({top:selected*44,behavior:"smooth"});updateWheelValue(root);
      },80);
    },{passive:true});
  });
}
function updateWheelValue(root){
  const values=["hour","minute"].map(part=>{
    const col=root.querySelector('[data-part="'+part+'"]');
    const selected=Math.max(0,Math.min(col.children.length-1,Math.round(col.scrollTop/44)));
    return String(selected).padStart(2,"0");
  });
  root.dataset.time=values.join(":");
}
function selectWheelItem(id,part,value){
  const root=$(id),col=root?.querySelector('[data-part="'+part+'"]');if(!col)return;
  col.scrollTo({top:Number(value)*44,behavior:"smooth"});setTimeout(()=>updateWheelValue(root),260);
}
function wheelValue(id){const root=$(id);if(root)updateWheelValue(root);return root?.dataset.time||"00:00";}
function openStartTripDialog(){
  if(getActiveTrip()){navigateTo("logbook");return;}
  if(!SPOTS.length){alert("Lege zuerst einen Angelplatz an.");navigateTo("spots");return;}
  const now=new Date(),options=SPOTS.map(s=>
    '<option value="'+esc(s.id)+'" '+(s.id===CURRENT_SPOT_ID?"selected":"")+'>'+esc(s.name)+'</option>'
  ).join("");
  $("tripDialogTitle").textContent="Trip starten";
  $("tripDialogBody").innerHTML='<div class="form-grid"><label class="field wide"><span>Angelplatz</span><select id="tripSpotInput">'+options+'</select></label>'+
    '<label class="field wide"><span>Datum</span><input id="tripDateInput" type="date" value="'+dateInputValue(now)+'"></label>'+
    '<label class="field"><span>Methode, optional</span><input id="tripMethodInput" list="methodeliste" placeholder="z. B. Spinnfischen"></label>'+
    '<label class="field"><span>Zielfisch, optional</span><input id="tripTargetInput" list="artliste" placeholder="z. B. Zander"></label>'+
    '<label class="field wide"><span>Notiz, optional</span><textarea id="tripNotesInput" placeholder="Vorhaben, Platzbeschreibung …"></textarea></label></div>'+
    '<div class="wheel-label">Startzeit</div>'+renderTimeWheel("tripTimeWheel",timeInputValue(now))+
    '<div class="form-error" id="tripFormError"></div><div class="dialog-actions"><button class="secondary" type="button" onclick="closeDialog(\'tripDialog\')">Abbrechen</button>'+
    '<button class="primary" type="button" onclick="saveNewTrip()">Trip starten</button></div>';
  $("tripDialog").showModal();initTimeWheel("tripTimeWheel",timeInputValue(now));
}
function saveNewTrip(){
  const spot=SPOTS.find(s=>s.id===$("tripSpotInput").value);
  const start=localDateTime($("tripDateInput").value,wheelValue("tripTimeWheel"));
  if(!spot||!start){$("tripFormError").textContent="Bitte wähle Spot, Datum und Startzeit.";return;}
  if(start.getTime()>Date.now()+5*60000){$("tripFormError").textContent="Die Startzeit darf nicht in der Zukunft liegen.";return;}
  const conditionsReady=spot.id===CURRENT_SPOT_ID;
  UI_TRIPS.push({
    id:newId("trip"),spotId:spot.id,spotSnapshot:{id:spot.id,name:spot.name,riverName:"Rhein",lat:spot.lat,lon:spot.lon,km:spot.km},
    startAt:start.toISOString(),endAt:null,status:"active",method:$("tripMethodInput").value.trim(),
    targetSpecies:$("tripTargetInput").value.trim(),notes:$("tripNotesInput").value.trim(),catches:[],
    createdAt:new Date().toISOString(),conditionsStart:conditionsReady?conditionsSnapshot():null
  });
  if(!conditionsReady){
    CURRENT_SPOT_ID=spot.id;saveSpots();syncSelectionFromActive();resetLiveTiles();renderSpotsPage();renderExplorerMarkers();loadAll();
  }
  saveTrips();closeDialog("tripDialog");renderLogbook();navigateTo("logbook");
}
function openEndTripDialog(){
  const trip=getActiveTrip();if(!trip)return;
  const now=new Date();$("tripDialogTitle").textContent="Trip beenden";
  $("tripDialogBody").innerHTML='<p class="sheet-intro">Start: '+esc(formatDateTime(trip.startAt))+' · '+esc(trip.spotSnapshot.name)+'</p>'+
    '<label class="field"><span>Enddatum</span><input id="tripEndDateInput" type="date" value="'+dateInputValue(now)+'"></label>'+
    '<div class="wheel-label">Endzeit</div>'+renderTimeWheel("tripEndTimeWheel",timeInputValue(now))+
    '<label class="field"><span>Abschlussnotiz, optional</span><textarea id="tripEndNotesInput" placeholder="Fazit, Beobachtungen …"></textarea></label>'+
    '<div class="form-error" id="tripFormError"></div><div class="dialog-actions"><button class="secondary" type="button" onclick="closeDialog(\'tripDialog\')">Abbrechen</button>'+
    '<button class="primary" type="button" onclick="finishTrip()">Trip beenden</button></div>';
  $("tripDialog").showModal();initTimeWheel("tripEndTimeWheel",timeInputValue(now));
}
function finishTrip(){
  const trip=getActiveTrip(),end=localDateTime($("tripEndDateInput").value,wheelValue("tripEndTimeWheel"));
  if(!trip||!end)return;
  if(end.getTime()<new Date(trip.startAt).getTime()){$("tripFormError").textContent="Die Endzeit muss nach der Startzeit liegen.";return;}
  if(end.getTime()>Date.now()+5*60000){$("tripFormError").textContent="Die Endzeit darf nicht in der Zukunft liegen.";return;}
  trip.endAt=end.toISOString();trip.status="completed";trip.endNotes=$("tripEndNotesInput").value.trim();
  trip.conditionsEnd=trip.spotId===CURRENT_SPOT_ID?conditionsSnapshot():null;
  saveTrips();closeDialog("tripDialog");renderLogbook();
}
function openCatchDialog(){
  const trip=getActiveTrip();if(!trip)return;
  const now=new Date();
  $("catchDialogBody").innerHTML='<div class="form-grid">'+
    '<label class="field wide"><span>Fischart</span><input id="catchSpeciesInput" list="artliste" placeholder="z. B. Zander" autocomplete="off"></label>'+
    '<label class="field"><span>Größe (cm)</span><input id="catchLengthInput" type="number" min="0" step="1" inputmode="decimal"></label>'+
    '<label class="field"><span>Gewicht (g), optional</span><input id="catchWeightInput" type="number" min="0" step="10" inputmode="decimal"></label>'+
    '<label class="field"><span>Köder</span><input id="catchBaitInput" placeholder="z. B. Gummifisch 12 cm"></label>'+
    '<label class="field"><span>Methode</span><input id="catchMethodInput" list="methodeliste" value="'+esc(trip.method||"")+'"></label>'+
    '<label class="field"><span>Verbleib</span><select id="catchDispositionInput"><option value="">Nicht angegeben</option><option value="released">Zurückgesetzt</option><option value="kept">Entnommen</option></select></label>'+
    '<label class="field wide"><span>Datum</span><input id="catchDateInput" type="date" value="'+dateInputValue(now)+'"></label>'+
    '<label class="field wide"><span>Notiz, optional</span><textarea id="catchNotesInput" placeholder="Biss, Tiefe, Besonderheiten …"></textarea></label></div>'+
    '<div class="wheel-label">Fangzeit</div>'+renderTimeWheel("catchTimeWheel",timeInputValue(now))+
    '<div class="form-error" id="catchFormError"></div><div class="dialog-actions"><button class="secondary" type="button" onclick="closeDialog(\'catchDialog\')">Abbrechen</button>'+
    '<button class="primary" type="button" onclick="saveTripCatch()">Fang speichern</button></div>';
  $("catchDialog").showModal();initTimeWheel("catchTimeWheel",timeInputValue(now));
  setTimeout(()=>$("catchSpeciesInput")?.focus(),100);
}
function saveTripCatch(){
  const trip=getActiveTrip(),species=$("catchSpeciesInput").value.trim();
  const when=localDateTime($("catchDateInput").value,wheelValue("catchTimeWheel"));
  if(!trip||!species||!when){$("catchFormError").textContent="Bitte Fischart, Datum und Fangzeit eintragen.";return;}
  if(when.getTime()<new Date(trip.startAt).getTime()){$("catchFormError").textContent="Die Fangzeit liegt vor dem Start des Trips.";return;}
  if(when.getTime()>Date.now()+5*60000){$("catchFormError").textContent="Die Fangzeit darf nicht in der Zukunft liegen.";return;}
  const moon=moonPhase(when);
  trip.catches.push({
    id:newId("catch"),timeAt:when.toISOString(),species,lengthCm:num($("catchLengthInput").value),
    weightG:num($("catchWeightInput").value),bait:$("catchBaitInput").value.trim(),
    method:$("catchMethodInput").value.trim(),disposition:$("catchDispositionInput").value,
    notes:$("catchNotesInput").value.trim(),moon:{name:moon.name,ageDays:moon.age,illuminationPct:moon.illum},
    conditions:trip.spotId===CURRENT_SPOT_ID?conditionsSnapshot():null
  });
  saveTrips();closeDialog("catchDialog");renderLogbook();
}
function deleteTrip(id){
  const trip=UI_TRIPS.find(t=>t.id===id);
  if(!trip||trip.status==="active"||!confirm("Diesen abgeschlossenen Trip löschen?"))return;
  UI_TRIPS=UI_TRIPS.filter(t=>t.id!==id);saveTrips();renderLogbook();
}
function deleteTripCatch(tripId,catchId){
  const trip=UI_TRIPS.find(t=>t.id===tripId);
  if(!trip||!confirm("Diesen Fang aus dem Trip löschen?"))return;
  trip.catches=trip.catches.filter(c=>c.id!==catchId);saveTrips();renderLogbook();
}
function formatDuration(start,end){
  const minutes=Math.max(0,Math.floor((new Date(end||Date.now())-new Date(start))/60000));
  const hours=Math.floor(minutes/60),rest=minutes%60;
  return hours?hours+" Std "+rest+" Min":rest+" Min";
}
function dispositionLabel(value){return value==="released"?"zurückgesetzt":value==="kept"?"entnommen":"";}
function renderCatchRows(trip){
  if(!trip.catches.length)return '<div class="trip-notes">Keine Fänge dokumentiert.</div>';
  return trip.catches.slice().sort((a,b)=>new Date(a.timeAt)-new Date(b.timeAt)).map(c=>
    '<div class="catch-row"><strong>'+esc(c.species)+(c.lengthCm!=null?" · "+fmt(c.lengthCm,0)+" cm":"")+
    (c.weightG!=null?" · "+fmt(c.weightG,0)+" g":"")+'</strong><div class="catch-meta">'+
    esc(new Date(c.timeAt).toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit"}))+" Uhr"+
    (c.bait?" · "+esc(c.bait):"")+(c.method?" · "+esc(c.method):"")+
    (c.disposition?" · "+esc(dispositionLabel(c.disposition)):"")+'</div>'+
    (c.notes?'<div class="catch-meta">„'+esc(c.notes)+'“</div>':"")+
    '<button class="danger-quiet" type="button" onclick="deleteTripCatch(\''+esc(trip.id)+'\',\''+esc(c.id)+'\')">Fang löschen</button></div>'
  ).join("");
}
function toggleTripDetails(id){
  const body=$("trip-body-"+id);if(body)body.hidden=!body.hidden;
}
function renderLogbook(){
  const active=getActiveTrip();
  const history=UI_TRIPS.filter(t=>t.status!=="active"||t.endAt).sort((a,b)=>new Date(b.startAt)-new Date(a.startAt));
  $("newTripButton").hidden=!!active;$("logbookEmpty").hidden=!!active||history.length>0;$("logbookTools").hidden=!UI_TRIPS.length;
  $("activeTripCard").innerHTML=active?
    '<article class="trip-card"><div class="trip-top"><div><div class="trip-live">● Trip läuft</div><h3>'+esc(active.spotSnapshot.name)+'</h3>'+
    '<div class="trip-meta">Gestartet '+esc(formatDateTime(active.startAt))+(active.method?" · "+esc(active.method):"")+
    (active.targetSpecies?" · Zielfisch "+esc(active.targetSpecies):"")+'</div></div><div class="trip-duration">'+esc(formatDuration(active.startAt))+'</div></div>'+
    (active.notes?'<div class="trip-notes">„'+esc(active.notes)+'“</div>':"")+
    '<div class="trip-actions"><button class="primary" type="button" onclick="openCatchDialog()">＋ Fang hinzufügen</button>'+
    '<button class="secondary" type="button" onclick="openEndTripDialog()">Trip beenden</button></div>'+
    '<div class="section-title">Fänge in diesem Trip · '+active.catches.length+'</div>'+renderCatchRows(active)+'</article>':"";
  $("tripHistory").innerHTML=history.length?'<div class="section-title">Abgeschlossene Trips</div>'+history.map(trip=>
    '<article class="trip-history-item"><button class="trip-history-head" type="button" onclick="toggleTripDetails(\''+esc(trip.id)+'\')"><div><strong>'+
    esc(trip.spotSnapshot?.name||"Angeltrip")+'</strong><div class="trip-meta">'+esc(formatDateTime(trip.startAt))+
    ' · '+esc(formatDuration(trip.startAt,trip.endAt))+'</div></div><span class="trip-count">'+trip.catches.length+" Fang"+
    (trip.catches.length===1?"":"e")+' ▾</span></button><div class="trip-history-body" id="trip-body-'+esc(trip.id)+'" hidden>'+
    renderCatchRows(trip)+(trip.notes?'<div class="trip-notes">Startnotiz: „'+esc(trip.notes)+'“</div>':"")+
    (trip.endNotes?'<div class="trip-notes">Fazit: „'+esc(trip.endNotes)+'“</div>':"")+
    '<div class="trip-actions"><button class="danger-quiet" type="button" onclick="deleteTrip(\''+esc(trip.id)+'\')">Trip löschen</button></div></div></article>'
  ).join(""):"";
  const dock=$("activeTripDock");dock.hidden=!active;
  dock.innerHTML=active?'<span><strong>Trip läuft</strong> · '+esc(active.spotSnapshot.name)+' · '+esc(formatDuration(active.startAt))+'</span>'+
    '<button class="secondary" type="button" onclick="navigateTo(\'logbook\')">Öffnen</button>':"";
  clearInterval(UI_TRIP_CLOCK_TIMER);
  if(active)UI_TRIP_CLOCK_TIMER=setInterval(renderLogbook,60000);
}
function exportTrips(){download("rheincheck-logbuch.json",JSON.stringify(UI_TRIPS,null,2),"application/json");}

/* ===================== Angepasste Daten-UI ===================== */
function toggleBite(){
  const box=$("biteBox"),button=$("biteBtn"),show=box.hidden;
  if(show){renderBite();box.hidden=false;button.textContent="🎯 Einschätzung nach Fischart ausblenden";}
  else{box.hidden=true;button.textContent="🎯 Einschätzung nach Fischart anzeigen";}
}
async function loadAll(){
  if(!getActiveSpot()){
    $("updated").textContent=CATALOG.gauges.length+" Pegel · "+CATALOG.qualityStations.length+" Gütestationen";
    return;
  }
  const token=++SELECTION_VERSION;
  $("updated").textContent="aktualisiere …";$("refreshButton").disabled=true;
  await Promise.allSettled([loadPegel(token),loadWeather(token),loadQuality(token)]);
  if(token!==SELECTION_VERSION)return;
  updateAmpel();
  if(!$("biteBox").hidden)renderBite();
  $("updated").textContent="Stand: "+new Date().toLocaleString("de-DE",{dateStyle:"short",timeStyle:"short"})+" Uhr";
  $("refreshButton").disabled=false;
}
function openChart(key){
  if(!getActiveSpot())return;
  CHART_KEY=key;CHART_RANGE="24h";
  const def=defFor(key);if(!def)return;
  $("cmTitle").textContent=def.title;$("chartModal").hidden=false;
  setChartRange("24h");
}
function closeChart(){
  $("chartModal").hidden=true;
  if(CHART){CHART.destroy();CHART=null;}
}

async function bootstrapApp(){
  CATALOG=normalizeCatalog(FALLBACK_CATALOG);
  loadSpots();
  await loadStationCatalog();
  if(CURRENT_SPOT_ID)syncSelectionFromActive();
  loadTrips();
  fillStationControls();renderSpotsPage();renderLogbook();setPage(pageFromHash());
  window.addEventListener("hashchange",()=>setPage(pageFromHash()));
  if(getActiveSpot()){resetLiveTiles();await loadAll();}
  else $("updated").textContent=CATALOG.gauges.length+" Pegel · "+CATALOG.qualityStations.length+" Gütestationen";
  clearInterval(DATA_REFRESH_TIMER);DATA_REFRESH_TIMER=setInterval(loadAll,10*60*1000);
}

bootstrapApp();
