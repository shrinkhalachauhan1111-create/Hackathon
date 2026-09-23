import React, { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";

const API = (import.meta.env.VITE_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const QUEUE_KEY = "waterwatch_pending_tests_v1";
const CACHE_KEY = "waterwatch_cached_dashboard_v1";
const INITIAL_SETTINGS = { min_positive: 2, radius_km: 2, window_days: 14, rainfall_threshold_mm: 30, alert_radius_km: 3 };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
const blankForm = () => ({ household_id:"",ward_id:"",test_type:"E. coli",result:"positive",tested_at:today(),latitude:"",longitude:"" });
const queued = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch { return []; } };
const saveQueue = value => localStorage.setItem(QUEUE_KEY, JSON.stringify(value));
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random()}`;
const query = settings => new URLSearchParams(settings).toString();

async function api(path, options={}) {
  const response = await fetch(`${API}${path}`, { ...options, headers: { "Content-Type":"application/json", ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail || body));
    error.isHttp = true;
    throw error;
  }
  return body;
}

function parseCSV(text) {
  const lines = []; let row = []; let cell = ""; let quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i=0; i<text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i+1] === '"') { cell+='"'; i++; } else quoted=!quoted; }
    else if (c === "," && !quoted) { row.push(cell.trim());cell=""; }
    else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i+1] === "\n") i++;
      row.push(cell.trim()); if (row.some(v=>v)) lines.push(row); row=[];cell="";
    } else cell+=c;
  }
  row.push(cell.trim()); if (row.some(v=>v)) lines.push(row);
  if (quoted) throw new Error("CSV contains an unclosed quotation mark.");
  if (!lines.length) return [];
  const headers = lines.shift().map(h=>h.toLowerCase());
  return lines.map((cells,idx)=> {
    if (cells.length !== headers.length) throw new Error(`CSV row ${idx+2} has ${cells.length} columns; expected ${headers.length}.`);
    return Object.fromEntries(headers.map((h,j)=>[h,cells[j]]));
  });
}

function MapPanel({ tests, clusters, geojson }) {
  const divRef = useRef(null); const mapRef=useRef(null);
  useEffect(()=>{
    if (!divRef.current) return;
    const map=L.map(divRef.current, { scrollWheelZoom: false }).setView([9.97,76.29], 11);
    mapRef.current=map;
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19
    }).addTo(map);
    return ()=>{map.remove();mapRef.current=null;};
  },[]);
  useEffect(()=>{
    const map=mapRef.current; if(!map)return;
    const group=L.featureGroup().addTo(map); const hasBounds=[];
    if(geojson?.features?.length){
      try {
        const layer=L.geoJSON(geojson, { style:{color:"#5f90a3",weight:2,fillColor:"#0e7490",fillOpacity:.06},
          onEachFeature:(feature,shape)=>shape.bindPopup(`Ward: ${String(feature.properties?.ward_id||feature.properties?.name||"unlabelled")}`) }).addTo(group);
        if(layer.getBounds().isValid())hasBounds.push(layer.getBounds());
      } catch { /* malformed shape should not crash the rest of the dashboard */ }
    }
    tests.filter(t=>t.latitude != null && t.longitude != null).forEach(t=>{
      const mark=L.circleMarker([t.latitude,t.longitude], {radius:7,weight:2,color:t.result==="positive"?"#bd4248":"#137e71",
        fillColor:t.result==="positive"?"#f16b70":"#41c5a4",fillOpacity:.85}).addTo(group);
      mark.bindPopup(`<strong>${t.result === "positive" ? "Positive" : "Negative"}</strong><br>${escapeHTML(t.test_type)}<br>${escapeHTML(t.ward_id)}<br>${escapeHTML(t.tested_at)}`);
      hasBounds.push(mark.getLatLng());
    });
    clusters.forEach(c=>{
      L.circle([c.latitude,c.longitude],{radius:c.alert_radius_km*1000,color:"#f6a43a",weight:2,fillOpacity:.08}).addTo(group);
      const mark=L.circleMarker([c.latitude,c.longitude],{radius:11,color:"#923c13",weight:3,fillColor:"#ffc06b",fillOpacity:.95}).addTo(group);
      mark.bindPopup(`<strong>Potential cluster</strong><br>${escapeHTML(c.test_type)} — ${c.positive_count} observations<br>${escapeHTML(c.ward_id)}<br>Simulated alert radius: ${c.alert_radius_km} km`);
      hasBounds.push(mark.getLatLng());
    });
    if (hasBounds.length) map.fitBounds(L.latLngBounds(hasBounds),{padding:[28,28],maxZoom:14});
    return ()=>group.remove();
  },[tests,clusters,geojson]);
  return <div className="map-holder"><div ref={divRef} className="map"/><div className="map-legend"><span><i className="dot red"/> Positive</span><span><i className="dot green"/> Negative</span><span><i className="dot amber"/> Cluster / alert radius</span></div></div>;
}
function escapeHTML(value) {return String(value ?? "").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));}

export default function App(){
  const [page,setPage]=useState("overview"); const [settings,setSettings]=useState(INITIAL_SETTINGS);
  const [dashboard,setDashboard]=useState(()=>{try{return JSON.parse(localStorage.getItem(CACHE_KEY)||"null");}catch{return null;}});
  const [geojson,setGeojson]=useState(null); const [tests,setTests]=useState([]);
  const [form,setForm]=useState(blankForm); const [online,setOnline]=useState(navigator.onLine);
  const [pending,setPending]=useState(queued().length); const [message,setMessage]=useState(""); const [busy,setBusy]=useState(false);
  const [testFile,setTestFile]=useState(null); const [rainFile,setRainFile]=useState(null); const [wardFile,setWardFile]=useState(null);
  const [demoMode,setDemoMode]=useState(false);
  const refresh=useCallback(async(config=settings)=>{
    const [d,t,g] = await Promise.all([api(`/api/dashboard?${query(config)}`),api("/api/tests"),api("/api/ward-boundaries")]);
    setDashboard(d);setTests(t);setGeojson(g);setDemoMode(t.some(x=>x.source==="demo"));
    localStorage.setItem(CACHE_KEY,JSON.stringify(d));
  },[settings]);
  const sync=useCallback(async()=>{
    if(!navigator.onLine)return;
    const copy=queued(); if(!copy.length)return;
    let left=[];let done=0;
    for(const record of copy){
      try { await api("/api/tests", {method:"POST",body:JSON.stringify(record)});done++; }
      catch(error){left.push(record);if(!error.isHttp) {left.push(...copy.slice(done+left.length));break;} }
    }
    saveQueue(left);setPending(left.length);
    if(done) {setMessage(`Synced ${done} locally saved observation(s).`);await refresh().catch(()=>{});}
    if(left.length && done===0) setMessage("Some offline records still need syncing. Check the API connection or validation.");
  },[refresh]);
  useEffect(()=>{
    refresh().catch(()=>setMessage("Backend unavailable. Cached results are shown if available. Start FastAPI, then refresh."));
  },[]); // initial load only
  useEffect(()=>{
    const on=()=>{setOnline(true); sync();}; const off=()=>setOnline(false);
    window.addEventListener("online",on);window.addEventListener("offline",off);
    return()=>{window.removeEventListener("online",on);window.removeEventListener("offline",off);};
  },[sync]);
  const changeSettings=(key,value)=>setSettings(old=>({...old,[key]:Number(value)}));
  async function applySettings(e){e.preventDefault();setBusy(true);try{await refresh();setMessage("Cluster and alert settings updated.");}catch(e){setMessage(e.message);}finally{setBusy(false);}}
  async function submitTest(e){
    e.preventDefault();setBusy(true);setMessage("");
    try{
      if((form.latitude==="") !== (form.longitude==="")) throw new Error("Provide both coordinates, or leave both blank.");
      const record={...form,client_id:uid(),latitude:form.latitude===""?null:Number(form.latitude),longitude:form.longitude===""?null:Number(form.longitude),source:"user"};
      if(!navigator.onLine) {const all=[...queued(),record];saveQueue(all);setPending(all.length);setMessage("Saved OFFLINE on this device. Sync when internet returns.");}
      else {
        try {const res=await api("/api/tests",{method:"POST",body:JSON.stringify(record)});
          setMessage(res.duplicate?"Duplicate observation already saved.":"Observation saved. Check the dashboard for cluster changes.");await refresh();}
        catch(err){if(err.isHttp) throw err;const all=[...queued(),record];saveQueue(all);setPending(all.length);setMessage("Could not reach the API. Saved on this device; press Sync later.");}
      }
      setForm(blankForm());
    }catch(e){setMessage(`Please check the form: ${e.message}`);}finally{setBusy(false);}
  }
  async function useLocation(){if(!navigator.geolocation){setMessage("Geolocation not supported. Enter coordinates manually.");return;}
    navigator.geolocation.getCurrentPosition(pos=>setForm(f=>({...f,latitude:String(pos.coords.latitude.toFixed(6)),longitude:String(pos.coords.longitude.toFixed(6))})),
      ()=>setMessage("Location permission denied/unavailable. Enter coordinates manually or leave blank."),{enableHighAccuracy:true,timeout:9000});
  }
  async function simulate(cluster){
    setBusy(true);try{const result=await api(`/api/alerts/${cluster.id}/simulate`,{method:"POST",body:JSON.stringify(settings)});
      setMessage(`SIMULATION ONLY: ${result.households_represented_in_data} household(s) represented in test records within ${cluster.alert_radius_km} km. No messages were sent.`);
      await refresh();}catch(e){setMessage(e.message);}finally{setBusy(false);}
  }
  async function loadDemo(){setBusy(true);try{const res=await api("/api/demo/load",{method:"POST"});await refresh();setMessage(`Loaded ${res.synthetic_demo_tests_added} fictional demo records. Import organiser data for your real demo.`);}catch(e){setMessage(e.message);}finally{setBusy(false);}}
  async function clearDemo(){setBusy(true);try{await api("/api/demo/clear",{method:"POST"});await refresh();setMessage("Synthetic demo records removed. Your own records remain.");}catch(e){setMessage(e.message);}finally{setBusy(false);}}
  async function importFiles(){
    if(!testFile&&!rainFile&&!wardFile){setMessage("Choose a CSV or GeoJSON file first.");return;}
    setBusy(true);try{
      const records=testFile?parseCSV(await testFile.text()).map((r,i)=>({
        client_id:r.client_id||`import-${uid()}`,household_id:r.household_id,ward_id:r.ward_id,
        test_type:r.test_type,result:r.result.toLowerCase(),tested_at:r.tested_at,
        latitude:r.latitude===""||r.latitude==null?null:Number(r.latitude),longitude:r.longitude===""||r.longitude==null?null:Number(r.longitude),source:"import"})):[];
      const rainfall=rainFile?parseCSV(await rainFile.text()).map(r=>({ward_id:r.ward_id,date:r.date,rainfall_mm:Number(r.rainfall_mm)})):[];
      const ward_geojson=wardFile?JSON.parse(await wardFile.text()):null;
      const response=await api("/api/import/bulk",{method:"POST",body:JSON.stringify({tests:records,rainfall,ward_geojson})});
      setMessage(`Imported ${response.added_tests} tests, skipped ${response.duplicate_tests} duplicates, loaded ${response.rainfall_records} rainfall records${response.ward_boundaries_imported?" and ward boundaries":""}.`);
      setTestFile(null);setRainFile(null);setWardFile(null);await refresh();setPage("overview");
    }catch(e){setMessage(`Import failed: ${e.message}. Check the CSV headers and date format in README.`);}finally{setBusy(false);}
  }
  async function fixLocation(test){
    const coords=window.prompt(`Test #${test.id}: enter latitude,longitude separated by a comma.`);
    if(coords===null)return;const [a,b]=coords.split(",").map(v=>v.trim());
    if(!a||!b||!Number.isFinite(Number(a))||!Number.isFinite(Number(b))){setMessage("Please provide two valid numeric coordinates.");return;}
    setBusy(true);try{await api(`/api/tests/${test.id}/location`,{method:"PATCH",body:JSON.stringify({latitude:Number(a),longitude:Number(b)})});await refresh();setMessage(`Test #${test.id} location corrected.`);}catch(e){setMessage(e.message);}finally{setBusy(false);}
  }
  const stats=dashboard?.stats || {total:0,positive:0,negative:0,missing_location:0,clusters:0};
  const clusters=dashboard?.clusters||[];const wards=dashboard?.wards||[];
  const input=(key,opts={})=><input {...opts} value={form[key]} onChange={e=>setForm(f=>({...f,[key]:e.target.value}))}/>;
  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-icon">≈</div><div><strong>WaterWatch</strong><small>PANCHAYAT INTELLIGENCE</small></div></div>
      <div className="nav-heading">WORKSPACE</div>
      {[ ["overview","◈","Overview"],["log","＋","Log water test"],["observations","▤","Observations"],["import","⇧","Import data"] ].map(([id,icon,label])=><button key={id} className={`nav-link ${page===id?"active":""}`} onClick={()=>setPage(id)}><span>{icon}</span>{label}</button>)}
      <div className="sidebar-bottom"><span className={`status-dot ${online?"on":"off"}`}/>{online?"Device online":"Device offline"}<br/><small>Queued observations: {pending}</small><button className="side-sync" disabled={busy||!online||!pending} onClick={sync}>↻ Sync queued tests</button></div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="crumb">ANAVANDI 2026 <span>/</span> Water &amp; Coast</div><div className="prototype-pill">● PROTOTYPE · NOT A SAFETY CERTIFICATE</div></header>
      <div className="content">
        {message&&<div className="toast" role="status"><span>{message}</span><button onClick={()=>setMessage("")}>×</button></div>}
        {demoMode&&<div className="demo-banner">DEMO MODE: fictional test locations and observations are loaded. They do not describe actual drinking-water conditions. <button disabled={busy} onClick={clearDemo}>Remove demo records</button></div>}
        {page==="overview"&&<>
          <div className="heading-row"><div><div className="eyebrow">COMMUNITY EARLY-WARNING SYSTEM</div><h1>Water quality overview<span className="accent">.</span></h1><p>Combine household tests and rainfall to spot potential contamination patterns.</p></div><button className="btn primary" onClick={()=>setPage("log")}>＋ Log a new test</button></div>
          <div className="stats-grid">{[["Tests logged",stats.total,"◫"],["Positive observations",stats.positive,"!"],["Potential clusters",stats.clusters,"◎"],["Missing locations",stats.missing_location,"⌖"]].map(([label,n,ico],i)=><div className="stat" key={label}><div className={`stat-icon s${i}`}>{ico}</div><div className="stat-count">{n}</div><div className="stat-label">{label}</div></div>)}</div>
          <div className="section-grid"><section className="panel map-panel"><div className="panel-title"><div><h2>Live observation map</h2><p>Points show recorded results · amber rings indicate simulated alert zones</p></div><span className="tag">{dashboard?.reference_date?`Data through ${dashboard.reference_date}`:"No test data"}</span></div>
            <MapPanel tests={dashboard?.tests||[]} clusters={clusters} geojson={geojson}/><div className="note">Map tiles need internet; previously entered observations can still be queued offline. Location-free records appear in Observations but not on the map or in spatial clusters.</div></section>
            <section className="panel settings"><div className="panel-title"><div><h2>Detection settings</h2><p>Adjust the prototype rules</p></div></div>
              <form onSubmit={applySettings} className="settings-form">
                <label>Positive households needed <input type="number" min="2" max="20" value={settings.min_positive} onChange={e=>changeSettings("min_positive",e.target.value)}/></label>
                <label>Cluster distance (km) <input type="number" min="0.1" max="50" step="0.5" value={settings.radius_km} onChange={e=>changeSettings("radius_km",e.target.value)}/></label>
                <label>Lookback days <input type="number" min="1" max="365" value={settings.window_days} onChange={e=>changeSettings("window_days",e.target.value)}/></label>
                <label>Rainfall flag, 3-day total (mm) <input type="number" min="0" max="1000" value={settings.rainfall_threshold_mm} onChange={e=>changeSettings("rainfall_threshold_mm",e.target.value)}/></label>
                <label>Alert simulation radius (km) <input type="number" min="0.1" max="50" step="0.5" value={settings.alert_radius_km} onChange={e=>changeSettings("alert_radius_km",e.target.value)}/></label>
                <button disabled={busy} className="btn dark" type="submit">Recalculate clusters →</button>
              </form><div className="note">Rainfall is contextual evidence, not proof of contamination or its cause.</div>
            </section></div>
          <div className="section-grid lower"><section className="panel"><div className="panel-title"><div><h2>Detected clusters</h2><p>Positive tests of the same type close together</p></div><span className="tag">{clusters.length} signals</span></div>
            {!clusters.length?<div className="empty"><div className="empty-icon">◎</div><strong>No clusters for current settings</strong><p>Import the organiser dataset or load fictional demo data to test the flow.</p><button className="btn outline" disabled={busy} onClick={loadDemo}>Load fictional demo data</button></div>:<div className="cluster-list">{clusters.map(c=><div className="cluster" key={c.id}><div className="cluster-head"><span className="badge amber">POTENTIAL CLUSTER</span><small>{c.id}</small></div><h3>{c.test_type} · {c.ward_id}</h3><div className="cluster-metrics"><span><strong>{c.unique_households}</strong> positive households</span><span><strong>{c.rainfall_mm_3d} mm</strong> rainfall / 3 days</span></div><p className="muted">{c.rainfall_flag?"Elevated rainfall flag":"Below configured rainfall flag"} · {c.alert_radius_km} km alert radius</p><button disabled={busy||c.alert_simulated} className={`btn ${c.alert_simulated?"success":"outline"}`} onClick={()=>simulate(c)}>{c.alert_simulated?"✓ Alert simulated":"Simulate household alert →"}</button></div>)}</div>}
          </section><section className="panel"><div className="panel-title"><div><h2>Ward response dashboard</h2><p>Prioritise wards for follow-up checks</p></div></div><div className="table-wrap"><table><thead><tr><th>Ward</th><th>Positive</th><th>3-day rain</th><th>Clusters</th></tr></thead><tbody>{wards.map(w=><tr key={w.ward_id}><td>{w.ward_id}</td><td><span className="count-red">{w.positive}</span></td><td>{w.rainfall_mm.toFixed(1)} mm</td><td>{w.clusters}</td></tr>)}</tbody></table>{!wards.length&&<div className="empty small">No ward data yet.</div>}</div><div className="note">Ward mapping uses the ward identifier supplied in the test record. Import the organiser's GeoJSON for ward outlines.</div></section></div>
        </>}
        {page==="log"&&<><div className="heading-row"><div><div className="eyebrow">FIELD-WORKER ENTRY</div><h1>Log a water test<span className="accent">.</span></h1><p>Works without connectivity: records queue in this browser for later sync.</p></div></div><section className="panel form-panel"><form onSubmit={submitTest} className="log-form"><div className="form-grid"><label>Household / sample ID *{input("household_id",{placeholder:"HH-101",required:true,maxLength:100})}</label><label>Ward ID *{input("ward_id",{placeholder:"Ward 4",required:true,maxLength:100})}</label><label>Test type *<select value={form.test_type} onChange={e=>setForm(f=>({...f,test_type:e.target.value}))}><option>E. coli</option><option>Coliform</option><option>Nitrate</option><option>Other</option></select></label><label>Result *<select value={form.result} onChange={e=>setForm(f=>({...f,result:e.target.value}))}><option value="positive">Positive observation</option><option value="negative">Negative observation</option></select></label><label>Date of test *{input("tested_at",{type:"date",required:true})}</label></div><div className="subheading">Location <span>(optional now, required for map and cluster detection)</span></div><button className="btn outline locate" type="button" onClick={useLocation}>⌖ Use my current location</button><div className="form-grid"><label>Latitude{input("latitude",{type:"number",step:"any",min:-90,max:90,placeholder:"9.967000"})}</label><label>Longitude{input("longitude",{type:"number",step:"any",min:-180,max:180,placeholder:"76.286000"})}</label></div><div className="warning">If location is missing, your observation will still be saved and flagged for later correction. Do not interpret a negative observation as a certificate that water is safe.</div><button type="submit" className="btn primary large" disabled={busy}>{busy?"Saving...":online?"Save observation →":"Save offline →"}</button></form></section></>}
        {page==="observations"&&<><div className="heading-row"><div><div className="eyebrow">AUDIT TRAIL</div><h1>Test observations<span className="accent">.</span></h1><p>Review records, identify missing locations and check sync progress.</p></div><button className="btn outline" disabled={busy} onClick={()=>refresh().catch(e=>setMessage(e.message))}>↻ Refresh</button></div><section className="panel"><div className="table-wrap"><table><thead><tr><th>ID / household</th><th>Ward</th><th>Type</th><th>Result</th><th>Date</th><th>Location</th></tr></thead><tbody>{tests.map(t=><tr key={t.id}><td><strong>#{t.id}</strong><br/>{t.household_id}{t.source==="demo"&&<small className="demo-tag"> DEMO</small>}</td><td>{t.ward_id}</td><td>{t.test_type}</td><td><span className={`badge ${t.result==="positive"?"red":"teal"}`}>{t.result}</span></td><td>{t.tested_at}</td><td>{t.latitude==null?<button disabled={busy} className="text-button" onClick={()=>fixLocation(t)}>+ Add location</button>:`${t.latitude.toFixed(4)}, ${t.longitude.toFixed(4)}`}</td></tr>)}</tbody></table>{!tests.length&&<div className="empty small">No saved observations yet.</div>}</div></section><div className="info-panel">Offline queue on this browser: <strong>{pending}</strong> observation(s). <button className="btn outline" disabled={busy||!online||!pending} onClick={sync}>Sync now</button></div></>}
        {page==="import"&&<><div className="heading-row"><div><div className="eyebrow">ORGANISER RESOURCE PACK</div><h1>Import supplied data<span className="accent">.</span></h1><p>Use the actual panchayat tests, rainfall records and ward boundaries.</p></div></div><section className="panel import-panel"><div className="warning">The organiser's files are not bundled here. Match their column names to the template headers before importing. Demo data is fictional.</div><div className="import-grid"><label className="upload"><span>01 / WATER TESTS</span><strong>Tests CSV</strong><p>household_id, ward_id, test_type, result, tested_at, latitude, longitude</p><input type="file" accept=".csv,text/csv" onChange={e=>setTestFile(e.target.files?.[0]||null)}/><small>{testFile?.name||"Choose tests.csv"}</small></label><label className="upload"><span>02 / RAINFALL</span><strong>Rainfall CSV</strong><p>ward_id, date, rainfall_mm</p><input type="file" accept=".csv,text/csv" onChange={e=>setRainFile(e.target.files?.[0]||null)}/><small>{rainFile?.name||"Choose rainfall.csv"}</small></label><label className="upload"><span>03 / WARD BOUNDARIES</span><strong>GeoJSON</strong><p>GeoJSON FeatureCollection of ward boundaries</p><input type="file" accept=".geojson,.json,application/json" onChange={e=>setWardFile(e.target.files?.[0]||null)}/><small>{wardFile?.name||"Choose wards.geojson"}</small></label></div><div className="actions"><button className="btn primary" disabled={busy} onClick={importFiles}>{busy?"Importing...":"Import selected files →"}</button><button className="btn outline" disabled={busy} onClick={loadDemo}>Load fictional demo data</button></div><p className="note">Importing data is additive. Test duplicates are skipped; rainfall values with the same ward and day are updated. Demo and real records should not be mixed when interpreting signals.</p></section></>}
        <footer>ANAVANDI · WATERWATCH PROTOTYPE <span>Potential signal only · Confirm through authorised testing and approved public-health guidance.</span></footer>
      </div>
    </main>
  </div>;
}
