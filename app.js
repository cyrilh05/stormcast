
'use strict';
const KINDS=['categorical','tornado','hail','wind'];
const STORE='stormcast.public.readonly';
const COLORS={'TSTM':'#b7e4a1','MRGL':'#4ea94b','SLGT':'#e6d448','ENH':'#e39b41','MDT':'#e3484b','HIGH':'#ed72d8','2%':'#71a66b','5%':'#9ac37e','10%':'#d2c954','15%':'#d8a64d','30%':'#d75c54','45%':'#c34c9a','60%':'#9956b5'};
let geoRenderer=null;let forecasts=[],current=null,kind='categorical',incoming=[],mapScale=1,mapOffset=[0,0];
let liveMap=null, liveLayer=null, lastForecastId=null, baseLayer=null;
let mapTheme=localStorage.getItem("stormcast.map.theme")||"classic";
const $=id=>document.getElementById(id);
const text=(id,value)=>{$(id).textContent=value??'—'};
function typeOf(f){return String(f?.properties?.type||f?.properties?.category||f?.properties?.risk||'').trim()}
function family(f){let x=String(f?.properties?.outlook||f?.properties?.family||'').toLowerCase();if(KINDS.includes(x))return x;let t=typeOf(f).toLowerCase();if(t.startsWith('tornado'))return 'tornado';if(t.startsWith('hail'))return 'hail';if(t.startsWith('wind'))return 'wind';if(t.startsWith('surface')||t.startsWith('front'))return 'surface';return 'categorical'}
function labelOf(f){return typeOf(f).replace(/^(tornado|hail|wind)\s*/i,'')||'Area'}
function isValidFeature(f){return f&&f.type==='Feature'&&f.geometry&&['Polygon','MultiPolygon','LineString','Point'].includes(f.geometry.type)&&Array.isArray(f.geometry.coordinates)}
function parseInput(raw){
 let fs=raw?.features||raw?.geojson?.features||raw?.project?.features;
 if(!Array.isArray(fs)&&raw?.type==='Feature')fs=[raw];
 if(!Array.isArray(fs))throw Error('No GeoJSON features found. Use Save Project JSON or Export GeoJSON from StormCast Graphics Studio.');
 fs=fs.filter(isValidFeature).map(f=>({type:'Feature',geometry:f.geometry,properties:{...(f.properties||{})}}));
 if(fs.length>1500)throw Error('Too many features (maximum 1500).');
 return fs;
}
// SPC-inspired reference legends. These are explanatory scales, not automatic forecast categories.
const LEGENDS={
 categorical:[['TSTM','General thunderstorms','#b7e4a1'],['MRGL','Marginal (1/5)','#4ea94b'],['SLGT','Slight (2/5)','#f6e75b'],['ENH','Enhanced (3/5)','#e39b41'],['MDT','Moderate (4/5)','#e3484b'],['HIGH','High (5/5)','#ed72d8']],
 tornado:[['2%','2%','#71a66b'],['5%','5%','#8bcf77'],['10%','10%','#d2c954'],['15%','15%','#d8a64d'],['30%','30%','#d75c54'],['45%','45%','#c34c9a'],['60%','60%','#9956b5']],
 hail:[['5%','5%','#8bcf77'],['15%','15%','#d8a64d'],['30%','30%','#d75c54'],['45%','45%','#c34c9a'],['60%','60%','#9956b5']],
 wind:[['5%','5%','#8bcf77'],['15%','15%','#d8a64d'],['30%','30%','#d75c54'],['45%','45%','#c34c9a'],['60%','60%','#9956b5']]
};
function significant(f){const p=f?.properties||{};return p.significant===true||p.significantSevere===true||p.sigSevere===true||p.hatched===true||/\b(sig|significant)\b/i.test(typeOf(f))}
function riskCode(f){const t=typeOf(f).toUpperCase();if(family(f)==='categorical'){for(const [name,regex] of [['HIGH',/HIGH/],['MDT',/MODERATE|\bMDT\b/],['ENH',/ENHANCED|\bENH\b/],['SLGT',/SLIGHT|\bSLGT\b/],['MRGL',/MARGINAL|\bMRGL\b/],['TSTM',/THUNDERSTORM|\bTSTM\b/]])if(regex.test(t))return name;}const m=t.match(/(60|45|30|15|10|5|2)\s*%/);return m?m[1]+'%':null}
function riskColor(f){const code=riskCode(f);return code&&LEGENDS[family(f)]?.find(x=>x[0]===code)?.[2]||f.properties?.color||'#7da5c8'}
function updateLegend(fs){const entries=LEGENDS[kind]||[];text('legend-heading',kind[0].toUpperCase()+kind.slice(1)+' outlook · risk scale');const present=new Set(fs.map(riskCode));$('legend-scale').innerHTML=entries.map(([code,name,color])=>`<span class="legend-scale-item ${present.has(code)?'present':''}" title="${present.has(code)?'Present in this forecast':'Reference only'}"><i style="background:${color}"></i><b>${escapeHtml(code)}</b><small>${escapeHtml(name)}</small></span>`).join('');const sig=fs.filter(significant).length;let note=kind==='categorical'?'Categorical risk levels are not interchangeable with hazard probabilities.':`Probability contours refer to severe ${kind} occurring within 25 miles of a point. Significant-severe hatching is a separate forecast designation.`;text('legend-note',note+(sig?` ${sig} hatched area${sig===1?'':'s'} in this outlook.`:''));let key=$('sig-severe-key');if(key)key.hidden=!sig;}
function updateHatchEditor(){const box=$('hatch-feature-list');if(!box)return;box.replaceChildren();if(!incoming.length){box.textContent='Import a forecast to configure hatching.';return}incoming.forEach((f,i)=>{if(!['Polygon','MultiPolygon'].includes(f.geometry.type))return;const row=document.createElement('label');row.className='hatch-feature';const input=document.createElement('input');input.type='checkbox';input.checked=significant(f);input.onchange=()=>{f.properties.significant=input.checked;f.properties.significantSevere=input.checked};const caption=document.createElement('span');caption.textContent=`${family(f).toUpperCase()} · ${typeOf(f)||'Unnamed polygon'}`;row.append(input,caption);box.append(row)})}
// Fixed-count hatch: stripe spacing scales with the projected polygon size.
// Each polygon gets its own pattern so zoom never increases stripe density.
let hatchSerial=0;
function applyHatch(layer){
 const path=layer._path;
 if(!path||!path.ownerSVGElement||!liveMap||!layer.getBounds)return;
 const svg=path.ownerSVGElement,ns='http://www.w3.org/2000/svg';
 let defs=svg.querySelector('defs');
 if(!defs){defs=document.createElementNS(ns,'defs');svg.insertBefore(defs,svg.firstChild)}
 if(!layer._stormcastHatchId)layer._stormcastHatchId='sc-hatch-fixed-'+(++hatchSerial);
 const id=layer._stormcastHatchId;
 let pat=Array.from(defs.querySelectorAll('pattern')).find(p=>p.id===id);
 if(!pat){pat=document.createElementNS(ns,'pattern');pat.id=id;defs.append(pat)}
 const bounds=layer.getBounds();
 if(!bounds.isValid())return;
 const a=liveMap.latLngToLayerPoint(bounds.getNorthWest());
 const b=liveMap.latLngToLayerPoint(bounds.getSouthEast());
 const width=Math.abs(b.x-a.x),height=Math.abs(b.y-a.y);
 // A 45-degree hatch crosses roughly (width + height) / sqrt(2) pixels.
 // Twelve stripes across the projected extent at every zoom level.
 const spacing=Math.max(1,(width+height)/(Math.SQRT2*12));
 const dark=mapTheme!=='classic';
 pat.setAttribute('patternUnits','userSpaceOnUse');
 pat.setAttribute('patternContentUnits','userSpaceOnUse');
 pat.setAttribute('width',String(spacing));pat.setAttribute('height',String(spacing));
 pat.setAttribute('patternTransform','rotate(45)');
 pat.replaceChildren();
 const bg=document.createElementNS(ns,'rect');
 bg.setAttribute('width',String(spacing));bg.setAttribute('height',String(spacing));
 bg.setAttribute('fill',dark?'#51264f':'#f7d7f0');pat.append(bg);
 const line=document.createElementNS(ns,'path');
 line.setAttribute('d',`M 0 0 V ${spacing}`);
 line.setAttribute('stroke',dark?'#ffe56c':'#7b1e67');
 line.setAttribute('stroke-width',String(Math.min(3.2,Math.max(1.6,spacing*.12))));
 line.setAttribute('stroke-linecap','butt');pat.append(line);
 path.setAttribute('fill',`url(#${id})`);path.setAttribute('fill-opacity','1');
 path.setAttribute('stroke',dark?'#ffe56c':'#7b1e67');path.setAttribute('stroke-width','2.4');
}
function refreshHatches(){
 if(!liveLayer)return;
 liveLayer.eachLayer(group=>group.eachLayer?.(layer=>{
  if(layer._stormcastSignificant)applyHatch(layer);
 }));
}
function countByKind(fs,k){return fs.filter(f=>family(f)===k&&f.properties?.visible!==false).length}
function page(name){
 document.querySelectorAll('.page').forEach(x=>x.classList.toggle('hidden',x.id!=='page-'+name));
 document.querySelectorAll('.nav').forEach(x=>x.classList.toggle('active',x.dataset.page===name));
 text('page-title',({outlook:'Severe Weather Outlooks',archive:'Outlook Archive',publish:'Public Outlooks',education:'Understand the Risks',about:'About HomanWX'})[name]);
 if(name==='archive')renderArchive();if(name==='outlook'&&liveMap)setTimeout(()=>liveMap.invalidateSize(),90);
}
function safeDate(v){if(!v)return 'Not specified';let d=new Date(v);return isNaN(d)?String(v):d.toLocaleString('en-US',{timeZone:'UTC',dateStyle:'medium',timeStyle:'short'})+' UTC'}
function showForecast(f){
 current=f||null;kind='categorical';document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.kind===kind));
 text('forecast-title',f?.title||'No public outlook available');
 text('forecast-issued',f?'FORECAST ISSUED':'NO FORECAST PUBLISHED');
 text('forecast-valid',f?.valid||'No public forecast is available yet.');
 text('forecast-status',f?'PUBLISHED':'EMPTY');
 text('summary-head',f?'Forecast Overview':'No active outlook');
 text('forecast-summary',f?.summary||'Your published forecast summary will appear here.');
 text('forecast-author',f?.author||'—');text('forecast-period',f?.valid||'—');text('forecast-issue-time',safeDate(f?.issued));
 text('discussion-content',f?.discussion||'No discussion has been published yet.');
 $('discussion-content').classList.remove('expanded');
 renderMap();
 page('outlook');
}
function coordsWalk(coords,fn){if(!Array.isArray(coords))return;if(typeof coords[0]==='number'&&typeof coords[1]==='number'){fn(coords);return}coords.forEach(c=>coordsWalk(c,fn))}
function xy(coord){let lon=Number(coord[0]),lat=Number(coord[1]);return [(lon+125)*12.1,(51-lat)*14.5]}
function pathFor(f){const g=f.geometry;
 function ring(points,close){return points.map((c,i)=>{let [x,y]=xy(c);return (i?'L':'M')+x.toFixed(1)+' '+y.toFixed(1)}).join(' ')+(close?' Z':'')}
 if(g.type==='Polygon')return g.coordinates.map(c=>ring(c,true)).join(' ');
 if(g.type==='MultiPolygon')return g.coordinates.map(p=>p.map(c=>ring(c,true)).join(' ')).join(' ');
 if(g.type==='LineString')return ring(g.coordinates,false);
 if(g.type==='Point'){let [x,y]=xy(g.coordinates);return `M${x-3} ${y} a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0`}
 return '';
}
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
const MAP_THEMES={
 classic:{water:'#dcebf3',land:'#fbf9ef',coast:'#738996',state:'#8b9696',label:'#364e5e'},
 dark:{water:'#10263b',land:'#1c3346',coast:'#57778b',state:'#5b788b',label:'#c6e3f2'}
};
function applyMapTheme(){
 const c=MAP_THEMES[mapTheme];
 if(!liveMap)return;
 if(baseLayer){baseLayer.remove();baseLayer=null}
 baseLayer=L.layerGroup().addTo(liveMap);
 const md=window.STORMCAST_MAP_DATA;
 if(!md)return;
 const latlngs=arr=>arr.map(p=>[p[1],p[0]]);
 // Local vector geography: no tile-server dependency or API key.
 // Water is the map pane background; no oversized rectangle to obscure land or outlook layers.
 // Authoritative 2025 U.S. Census cartographic state polygons (Lower 48 only).
 // Render rings together so inland-water holes remain transparent.
 md.polygons.forEach(rings=>L.polygon(rings.map(latlngs),{
   pane:'stormcastGeography',color:c.state,weight:.8,opacity:.9,
   fillColor:c.land,fillOpacity:1,interactive:false,
   smoothFactor:0,noClip:true,renderer:geoRenderer
 }).addTo(baseLayer));
 if(liveLayer)liveLayer.bringToFront();
 $('map').style.background=c.water;
 $('map-theme').value=mapTheme;
}

// HomanWX 4.0.2 — geographically constrained navigation and offline city labels.
const HWX_VIEW_BOUNDS=[[16,-137],[59,-55]]; // generous margin around the contiguous U.S.
const HWX_CITIES=[["Washington, DC",38.907,-77.037,"major"],["New York",40.713,-74.006,"major"],["Los Angeles",34.052,-118.244,"major"],["Chicago",41.878,-87.63,"major"],["Houston",29.76,-95.37,"major"],["Phoenix",33.448,-112.074,"capital"],["Philadelphia",39.953,-75.164,"major"],["San Antonio",29.424,-98.494,"major"],["San Diego",32.716,-117.161,"major"],["Dallas",32.777,-96.797,"major"],["Jacksonville",30.333,-81.656,"major"],["Fort Worth",32.755,-97.331,"major"],["Columbus",39.961,-82.999,"capital"],["Indianapolis",39.768,-86.158,"capital"],["Charlotte",35.227,-80.843,"major"],["San Francisco",37.775,-122.419,"major"],["Seattle",47.606,-122.332,"major"],["Denver",39.739,-104.99,"capital"],["Nashville",36.163,-86.782,"capital"],["Oklahoma City",35.468,-97.516,"capital"],["El Paso",31.762,-106.485,"major"],["Detroit",42.331,-83.046,"major"],["Memphis",35.15,-90.049,"major"],["Boston",42.36,-71.059,"capital"],["Portland",45.515,-122.678,"major"],["Las Vegas",36.17,-115.14,"major"],["Kansas City",39.099,-94.579,"major"],["Atlanta",33.749,-84.388,"capital"],["Miami",25.762,-80.192,"major"],["Minneapolis",44.978,-93.265,"major"],["St. Louis",38.627,-90.199,"major"],["New Orleans",29.951,-90.072,"major"],["Salt Lake City",40.761,-111.891,"capital"],["Tampa",27.951,-82.457,"major"],["Cleveland",41.499,-81.694,"major"],["Pittsburgh",40.441,-79.996,"major"],["Cincinnati",39.103,-84.512,"major"],["Tulsa",36.154,-95.993,"major"],["Wichita",37.687,-97.33,"major"],["Omaha",41.256,-95.934,"major"],["Albuquerque",35.084,-106.65,"major"],["Raleigh",35.78,-78.639,"capital"],["Virginia Beach",36.852,-75.978,"major"],["Louisville",38.253,-85.759,"major"],["Sacramento",38.582,-121.494,"capital"],["Montgomery",32.377,-86.301,"capital"],["Little Rock",34.746,-92.29,"capital"],["Hartford",41.765,-72.673,"capital"],["Dover",39.158,-75.524,"capital"],["Tallahassee",30.438,-84.281,"capital"],["Boise",43.615,-116.202,"capital"],["Springfield, IL",39.782,-89.65,"capital"],["Des Moines",41.587,-93.625,"capital"],["Topeka",39.047,-95.676,"capital"],["Frankfort",38.201,-84.873,"capital"],["Baton Rouge",30.451,-91.187,"capital"],["Augusta",44.31,-69.78,"capital"],["Annapolis",38.978,-76.492,"capital"],["Lansing",42.733,-84.556,"capital"],["St. Paul",44.953,-93.09,"capital"],["Jackson, MS",32.299,-90.185,"capital"],["Jefferson City",38.577,-92.174,"capital"],["Helena",46.589,-112.04,"capital"],["Lincoln",40.814,-96.703,"capital"],["Carson City",39.164,-119.767,"capital"],["Concord",43.208,-71.538,"capital"],["Trenton",40.217,-74.743,"capital"],["Santa Fe",35.687,-105.938,"capital"],["Albany",42.652,-73.757,"capital"],["Bismarck",46.808,-100.784,"capital"],["Salem",44.943,-123.035,"capital"],["Harrisburg",40.273,-76.886,"capital"],["Providence",41.824,-71.412,"capital"],["Columbia, SC",34.001,-81.035,"capital"],["Pierre",44.368,-100.351,"capital"],["Austin",30.267,-97.743,"capital"],["Montpelier",44.26,-72.575,"capital"],["Richmond",37.541,-77.436,"capital"],["Olympia",47.038,-122.901,"capital"],["Charleston, WV",38.35,-81.633,"capital"],["Madison",43.073,-89.401,"capital"],["Cheyenne",41.14,-104.82,"capital"]];
let hwxCityLayer=null,hwxShowCities=true;
function hwxDrawCities(){
 if(!liveMap||!hwxCityLayer)return;
 hwxCityLayer.clearLayers();
 if(!hwxShowCities)return;
 const z=liveMap.getZoom();
 if(z<4.25)return;
 const viewport=liveMap.getBounds().pad(.10);
 const shown=new Set();
 HWX_CITIES.forEach(([name,lat,lng,type])=>{
   const capital=type==='capital';
   if(z<5.5&&!capital)return;
   if(z<6.25&&capital&&!['Washington, DC','Denver','Phoenix','Atlanta','Austin','Oklahoma City','Sacramento','Nashville','Salt Lake City','Boston','Columbus','Indianapolis','Raleigh'].includes(name))return;
   if(!viewport.contains([lat,lng]))return;
   const key=lat.toFixed(2)+','+lng.toFixed(2);
   if(shown.has(key))return;
   shown.add(key);
   L.marker([lat,lng],{pane:'hwxCityLabels',interactive:false,keyboard:false,
      icon:L.divIcon({className:'hwx-city-marker',html:'<span class="hwx-city-dot '+(capital?'is-capital':'')+'"></span><span class="hwx-city-name">'+name.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</span>',iconSize:[0,0],iconAnchor:[0,0]})
   }).addTo(hwxCityLayer);
 });
}
function hwxAddMapControls(){
 const tools=document.querySelector('.map-tools');
 if(!tools||document.getElementById('hwx-cities-toggle'))return;
 const button=document.createElement('button');button.type='button';button.id='hwx-cities-toggle';
 button.className='hwx-cities-toggle';button.setAttribute('aria-pressed','true');
 button.textContent='Cities: On';button.title='Show or hide major cities and state capitals';
 button.onclick=()=>{hwxShowCities=!hwxShowCities;button.textContent=hwxShowCities?'Cities: On':'Cities: Off';button.setAttribute('aria-pressed',String(hwxShowCities));hwxDrawCities()};
 tools.append(button);
}

function initRealMap(){
 if(liveMap||typeof L==='undefined')return !!liveMap;
 try{
  liveMap=L.map('map',{zoomControl:false,preferCanvas:false,attributionControl:false,zoomSnap:.25,minZoom:3,maxZoom:11,zoomAnimation:false,fadeAnimation:false,markerZoomAnimation:false,transform3DLimit:1e7,maxBounds:HWX_VIEW_BOUNDS,maxBoundsViscosity:1.0}).setView([38.3,-97],4);
  liveMap.on('zoomend moveend',()=>{requestAnimationFrame(refreshHatches);hwxDrawCities()});
  geoRenderer=L.svg({padding:0.75});
  liveMap.createPane('stormcastGeography');liveMap.getPane('stormcastGeography').style.zIndex='250';
  liveMap.createPane('stormcastForecast');liveMap.getPane('stormcastForecast').style.zIndex='450';
  liveMap.createPane('hwxCityLabels');liveMap.getPane('hwxCityLabels').style.zIndex='490';liveMap.getPane('hwxCityLabels').style.pointerEvents='none';
  hwxCityLayer=L.layerGroup().addTo(liveMap);hwxAddMapControls();
  liveLayer=L.featureGroup().addTo(liveMap);
  applyMapTheme();hwxDrawCities();
  $('map-fallback').style.display='none';
  setTimeout(()=>{liveMap.invalidateSize();liveMap.fitBounds([[24.1,-125],[49.6,-66.2]],{padding:[24,24],animate:false});},120);
  return true;
 }catch(err){console.warn('Leaflet unavailable, using fallback',err);return false}
}
function riskOrder(f){
 const t=typeOf(f).toUpperCase();
 const match=t.match(/(60|45|30|15|10|5|2)%/);
 if(match)return Number(match[1]);
 if(t.includes('HIGH'))return 90;if(t.includes('MODERATE'))return 70;
 if(t.includes('ENHANCED'))return 50;if(t.includes('SLIGHT'))return 30;
 if(t.includes('MARGINAL'))return 10;return 0;
}
function fitToForecast(){
 if(!initRealMap())return;
 const points=[];
 (current?.features||[]).filter(f=>f.properties?.visible!==false).forEach(f=>coordsWalk(f.geometry?.coordinates,c=>{
  if(Number.isFinite(+c[0])&&Number.isFinite(+c[1]))points.push([+c[1],+c[0]])
 }));
 if(points.length)liveMap.fitBounds(L.latLngBounds(points).pad(.32),{maxZoom:7,animate:false});
 else liveMap.fitBounds([[24.1,-125],[49.6,-66.2]],{animate:false,padding:[24,24]});
}
function renderRealMap(fs){
 if(!initRealMap())return false;
 liveLayer.clearLayers();
 [...fs].sort((a,b)=>riskOrder(a)-riskOrder(b)).forEach(f=>{
  try{
   const color=riskColor(f);
   const geo=L.geoJSON(f,{pane:'stormcastForecast',style:{pane:'stormcastForecast',color,fillColor:color,weight:2.25,opacity:1,fillOpacity:mapTheme==='classic'?.52:.60,smoothFactor:.5}});
   geo.eachLayer(layer=>{
    if(significant(f)){layer._stormcastSignificant=true;layer.on('add',()=>{requestAnimationFrame(()=>applyHatch(layer))});}
    layer.on('click',()=>{$('feature-details').hidden=false;$('feature-details').textContent=`${kind.toUpperCase()} · ${typeOf(f)}${f.properties?.label?' · '+f.properties.label:''}`});
    layer.bindPopup(`<b>${escapeHtml(typeOf(f))}</b>${f.properties?.label?'<p>'+escapeHtml(f.properties.label)+'</p>':''}`);
   });
   liveLayer.addLayer(geo);
  }catch(err){console.warn('Could not draw feature',err)}
 });
 liveLayer.bringToFront();
 setTimeout(()=>liveMap.invalidateSize(),40);
 if(current?.id!==lastForecastId){lastForecastId=current?.id;setTimeout(fitToForecast,90)}
 return true;
}
function renderMap(){
 let fs=(current?.features||[]).filter(f=>family(f)===kind&&f.properties?.visible!==false);
 text('map-count',fs.length+' forecast polygon'+(fs.length===1?'':'s'));
 text('map-layer-name',kind.toUpperCase());
 const seen=[...new Set(fs.map(labelOf))];
 updateLegend(fs);
 $('map-legend').innerHTML=seen.map(t=>`<span class="legend-item"><span class="swatch" style="background:${riskColor(fs.find(f=>labelOf(f)===t))}"></span>${escapeHtml(t)}</span>`).join('')||'<span class="muted mini">No outlook polygons in this layer</span>';
 $('feature-details').hidden=true;
 if(renderRealMap(fs))return;
 let grid='';
 for(let x=0;x<=720;x+=120)grid+=`<path d="M${x} 0V390" stroke="#46647b" stroke-width=".65" opacity=".5"/>`;
 for(let y=0;y<=390;y+=78)grid+=`<path d="M0 ${y}H720" stroke="#46647b" stroke-width=".65" opacity=".5"/>`;
 let outline='<path d="M30 30 L82 25 95 44 138 38 170 60 224 55 280 77 330 55 398 66 447 41 511 69 590 60 674 95 697 135 675 185 649 191 630 242 601 270 555 262 520 285 460 298 409 320 359 294 300 340 237 323 200 287 141 310 112 274 70 259 47 209 25 156Z" fill="#203a4a" stroke="#7193a6" stroke-width="1.8"/>';
 let shapes=fs.map((f,i)=>{let t=labelOf(f),color=f.properties?.color||COLORS[t]||'#78b4dd';return `<path data-i="${i}" d="${escapeHtml(pathFor(f))}" fill="${escapeHtml(color)}" fill-opacity=".52" stroke="${escapeHtml(color)}" stroke-width="2.2" fill-rule="evenodd" style="cursor:pointer"/>`}).join('');
 $('map-fallback').innerHTML=`<svg viewBox="0 0 720 390" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Forecast polygon map on geographic grid"><rect width="720" height="390" fill="#132739"/>${grid}${outline}<g transform="translate(${mapOffset[0]} ${mapOffset[1]}) scale(${mapScale})">${shapes}</g><text x="15" y="376" fill="#88a9bf" font-size="11">Geographic schematic · coordinates plotted from GeoJSON · no basemap tiles</text></svg>`;
 $('map-fallback').querySelectorAll('[data-i]').forEach(el=>el.addEventListener('click',()=>{
 let f=fs[Number(el.dataset.i)],t=labelOf(f);
 $('feature-details').hidden=false;$('feature-details').textContent=`${kind.toUpperCase()} · ${t}${f.properties?.label?' · '+f.properties.label:''}`;
 }));
}

function renderArchive(){
 const target=$('archive-list');target.replaceChildren();
 if(!forecasts.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No public forecasts have been released yet.';target.append(empty);return}
 forecasts.forEach(f=>{const item=document.createElement('div');item.className='archive-item';const left=document.createElement('div');const title=document.createElement('h3');title.textContent=f.title;const desc=document.createElement('p');desc.textContent=`${safeDate(f.issued)} · ${f.author||'Independent forecaster'} · ${(f.features||[]).length} features`;left.append(title,desc);const actions=document.createElement('div');actions.className='archive-actions';const open=document.createElement('button');open.className='btn btn-ghost';open.textContent='View outlook';open.onclick=()=>showForecast(f);actions.append(open);item.append(left,actions);target.append(item)});
}
document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>page(b.dataset.page));
document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{kind=b.dataset.kind;document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===b));renderMap()});
$('discussion-expand').onclick=()=>{$('discussion-content').classList.toggle('expanded');$('discussion-expand').textContent=$('discussion-content').classList.contains('expanded')?'Collapse':'Expand ↗'};
$('zoom-in').onclick=()=>{if(liveMap)liveMap.zoomIn(1,{animate:false});else{mapScale=Math.min(3,mapScale*1.25);renderMap()}};
$('zoom-out').onclick=()=>{if(liveMap)liveMap.zoomOut(1,{animate:false});else{mapScale=Math.max(.5,mapScale/1.25);renderMap()}};
$('zoom-reset').onclick=()=>{if(liveMap)liveMap.fitBounds([[24.1,-125],[49.6,-66.2]],{animate:false,padding:[24,24]});else{mapScale=1;mapOffset=[0,0];renderMap()}};
$('fit-outlook').onclick=fitToForecast;
$('map-theme').value=mapTheme;
$('map-theme').onchange=e=>{mapTheme=e.target.value;localStorage.setItem('stormcast.map.theme',mapTheme);applyMapTheme();renderMap()};
async function loadPublicForecasts(){
 try{
  const response=await fetch('./forecasts.json',{cache:'no-store'});if(!response.ok)throw Error('HTTP '+response.status);
  const raw=await response.json();if(raw.format!=='StormCast-Public-Forecasts'||!Array.isArray(raw.forecasts))throw Error('Invalid public forecast format');
  forecasts=raw.forecasts.filter(f=>f&&typeof f.title==='string'&&Array.isArray(f.features)).slice(0,100);
  showForecast(forecasts[0]);
 }catch(err){console.warn('Public forecast load:',err);forecasts=[];showForecast(null)}
}
loadPublicForecasts();

// StormCast 2.5 — public risk education (informational, no forecast modification)
const eduCategories=[
 ['TSTM','General Thunderstorms','Thunderstorms may occur, but organized severe weather is not currently expected.','Lightning can still be deadly; go indoors when thunder is heard.','#b7e4a1'],
 ['MRGL','Marginal · 1 of 5','Isolated severe thunderstorms are possible, with limited coverage or intensity.','Know how you will receive warnings. One storm can still be dangerous.','#2b8546'],
 ['SLGT','Slight · 2 of 5','Scattered severe thunderstorms are possible; some may produce damaging wind, hail, or tornadoes.','Stay weather-aware and be ready to move to shelter.','#f4e456'],
 ['ENH','Enhanced · 3 of 5','Numerous severe storms are possible, with a greater potential for impactful events.','Review your shelter plan before storms arrive.','#db9346'],
 ['MDT','Moderate · 4 of 5','Widespread severe weather or particularly intense storms may occur.','Take preparations seriously and be ready to act quickly.','#dc4c53'],
 ['HIGH','High · 5 of 5','An unusually dangerous severe-weather outbreak is expected.','Have a safe shelter readily accessible and closely follow official warnings.','#e06dc4']
];
function renderEducationCategories(){
 $('education-categories').innerHTML=eduCategories.map(([code,name,description,action,color])=>`<article class="edu-risk-card"><div class="edu-risk-top"><span class="edu-risk-color" style="background:${color}"></span><span><b>${name}</b><small>${code}</small></span></div><p>${description}</p><p class="edu-action"><b>Why take it seriously?</b> ${action}</p></article>`).join('');
}
const eduHazards={
 tornado:{heading:'Tornado probability',body:'The percentage represents the chance of a tornado within 25 miles of a point during the outlook period. A 5% area does not mean a 5% chance of your home being directly hit.',severe:'Significant tornado hatching refers to the potential for EF2-or-stronger tornadoes in the designated area.',safety:'If a tornado warning is issued, go immediately to a basement or a small interior room on the lowest floor of a sturdy building, away from windows. Mobile homes and vehicles are unsafe.'},
 hail:{heading:'Severe hail probability',body:'The percentage represents the chance of hail at least 1 inch in diameter within 25 miles of a point during the outlook period.',severe:'Significant hail hatching refers to the potential for hail at least 2 inches in diameter.',safety:'Move inside a sturdy building, away from windows. Do not go outside to protect a vehicle once a hailstorm begins.'},
 wind:{heading:'Severe thunderstorm wind probability',body:'The percentage represents the chance of thunderstorm wind gusts at least 58 mph, or qualifying wind damage, within 25 miles of a point during the outlook period.',severe:'Significant wind hatching refers to the potential for thunderstorm gusts at least 75 mph.',safety:'Shelter indoors away from windows. Avoid trees, power lines, and lightweight structures; destructive straight-line winds can be life-threatening.'}
};
function showEducationHazard(h){const x=eduHazards[h]||eduHazards.tornado;$('education-hazard-details').innerHTML=`<h4>${x.heading}</h4><p>${x.body}</p><div class="edu-callout"><b>Significant severe:</b> ${x.severe}</div><p><b>What to do:</b> ${x.safety}</p>`;document.querySelectorAll('.edu-hazard').forEach(b=>b.classList.toggle('active',b.dataset.hazard===h));}
renderEducationCategories();
document.querySelectorAll('.edu-hazard').forEach(b=>b.addEventListener('click',()=>showEducationHazard(b.dataset.hazard)));
showEducationHazard('tornado');
$('explain-outlook').addEventListener('click',()=>{page('education');showEducationHazard(kind==='categorical'?'tornado':kind);window.scrollTo?.(0,0)});

