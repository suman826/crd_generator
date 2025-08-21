
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const morgan = require('morgan');
require('dotenv').config();

let fetchFn = global.fetch;
if (!fetchFn) { fetchFn = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args)); }
const fetch = fetchFn;

const app = express();
const PORT = process.env.PORT || 5057;
const CRD_SERVER_URL = process.env.CRD_SERVER_URL || "https://crd.davinci.hl7.org/r4";

app.use(cors());
app.use(express.json({limit: '8mb'}));
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));

const trimSlashes = (s='') => s.replace(/\/+$/,''); // ✅ forward slashes only

function readJsonFile(p){ return JSON.parse(fs.readFileSync(p,'utf8')); }
function bundleWrap(resources){
  const entries=(resources||[]).filter(Boolean).map(r=>({fullUrl: r.id?`${r.resourceType}/${r.id}`:undefined, resource:r}));
  return {resourceType:"Bundle", type:"searchset", total: entries.length, entry: entries};
}
function keyCanon(s){ return (s||'').toLowerCase().replace(/[^a-z]/g,''); }
function inferBundleForKey(key, payload){
  const canon = keyCanon(key);
  const ctx = payload.context || {};
  const draft = ctx.draftOrders?.entry?.map(e=>e.resource) || [];
  const find = (t)=> draft.find(r=>r && r.resourceType===t);
  const patientId = ctx.patientId || 'demo-patient';
  const patient = {resourceType:"Patient", id:patientId, name:[{text:"Test Patient"}]};
  if(canon.includes('servicerequest')){
    const sr = find('ServiceRequest');
    const role={resourceType:"PractitionerRole",id:"prr1",practitioner:{reference:"Practitioner/p1"},organization:{reference:"Organization/o1"}};
    const prac={resourceType:"Practitioner",id:"p1",name:[{text:"Alice Smith, MD"}]};
    const org={resourceType:"Organization",id:"o1",name:"Good Health Clinic"};
    return bundleWrap([sr, patient, role, prac, org].filter(Boolean));
  }
  if(canon.includes('devicerequest')){
    const dr = find('DeviceRequest');
    const device={resourceType:"Device",id:"dev1",type: dr?.codeCodeableConcept};
    const role={resourceType:"PractitionerRole",id:"prr1",practitioner:{reference:"Practitioner/p1"},organization:{reference:"Organization/o1"}};
    const prac={resourceType:"Practitioner",id:"p1",name:[{text:"Alice Smith, MD"}]};
    const org={resourceType:"Organization",id:"o1",name:"Good Health Clinic"};
    return bundleWrap([dr, device, patient, role, prac, org].filter(Boolean));
  }
  if(canon.includes('medicationrequest')){
    const mr = find('MedicationRequest');
    const role={resourceType:"PractitionerRole",id:"prr1",practitioner:{reference:"Practitioner/p1"},organization:{reference:"Organization/o1"}};
    const prac={resourceType:"Practitioner",id:"p1",name:[{text:"Alice Smith, MD"}]};
    const org={resourceType:"Organization",id:"o1",name:"Good Health Clinic"};
    return bundleWrap([mr, patient, role, prac, org].filter(Boolean));
  }
  if(canon.includes('coverage')){
    const coverage={resourceType:"Coverage",id:"cov1",status:"active",beneficiary:{reference:`Patient/${patientId}`},payor:[{reference:"Organization/payer1"}]};
    const payer={resourceType:"Organization",id:"payer1",name:"Example Health Plan"};
    return bundleWrap([coverage, patient, payer]);
  }
  return bundleWrap([patient]);
}
function alignPrefetchToDiscovery(serviceMeta, payload, buildPrefetch){
  if(!serviceMeta || typeof serviceMeta!=='object') return payload;
  const preKeys = Object.keys(serviceMeta.prefetch || {});
  if(!preKeys.length) return payload;
  payload.prefetch = Object.assign({}, payload.prefetch || {});
  preKeys.forEach((k)=>{
    if(payload.prefetch[k] == null){
      payload.prefetch[k] = buildPrefetch ? inferBundleForKey(k, payload) : null;
    }
  });
  return payload;
}
async function fetchServiceMetaIfNeeded(url){
  try{
    const base = url.replace(/\/cds-services\/.*/, '');
    const discUrls = [`${base}/.well-known/cds-services`, `${base}/cds-services`];
    for(const d of discUrls){
      try{
        const r=await fetch(d,{headers:{'Accept':'application/json'}});
        const j=await r.json();
        const svcs=j.services || j['cds-services'] || [];
        const id=url.split('/').pop();
        const m=svcs.find(s=>s.id===id);
        if(m) return m;
      }catch{}
    }
  }catch{}
  return null;
}

app.get('/api/config', (_req,res)=> res.json({ defaultServerUrl: CRD_SERVER_URL }));

app.get('/api/requests', (_req,res)=>{
  const dir = path.join(__dirname,'requests');
  if(!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
  const files = fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(name=>({name}));
  res.json({ files });
});

app.get('/api/requests/:name', (req,res)=>{
  const filePath = path.join(__dirname,'requests',req.params.name);
  if(!fs.existsSync(filePath)) return res.status(404).json({error:'File not found'});
  try{ res.json(readJsonFile(filePath)); } catch(e){ res.status(400).json({error:e.message}); }
});

app.get('/api/discovery', async (req,res)=>{
  const base = trimSlashes((req.query.serverUrl||CRD_SERVER_URL));
  const attempts=[`${base}/.well-known/cds-services`, `${base}/cds-services`];
  let lastErr=null;
  for(const url of attempts){
    try{
      const r=await fetch(url,{headers:{'Accept':'application/json'}});
      const j=await r.json();
      if(r.ok && (j.services || j['cds-services'])) return res.json({url, data:j});
      lastErr = `HTTP ${r.status}`;
    }catch(e){ lastErr=e.message; }
  }
  res.status(502).json({ error:`Discovery failed for ${base}`, tried: attempts, lastErr });
});

app.post('/api/invoke', async (req,res)=>{
  try{
    const { filename, serviceId, serviceIdOverride, serverUrl, buildPrefetch, serviceMeta, authToken, payload: payloadIn } = req.body || {};
    const base = trimSlashes((serverUrl||CRD_SERVER_URL));
    const chosen=(serviceIdOverride && serviceIdOverride.trim()) || serviceId;
    if(!chosen) return res.status(400).json({error:"serviceId (or full URL) is required"});
    const url = /^https?:\/\//i.test(chosen) ? chosen : `${base}/cds-services/${chosen}`;

    let payload=null;
    if(filename){
      const fp=path.join(__dirname,'requests',filename);
      if(!fs.existsSync(fp)) return res.status(400).json({error:`Request file not found: ${filename}`});
      payload = readJsonFile(fp);
    } else if (payloadIn){ payload = payloadIn; }
    else { return res.status(400).json({error:"Provide either filename or payload"}); }

    if(payload && Object.prototype.hasOwnProperty.call(payload,'fhirServer')) delete payload.fhirServer;
    if(!payload.user && payload?.context?.userId) payload.user = payload.context.userId;

    let meta = serviceMeta;
    if(!meta && /^https?:\/\//i.test(chosen)) meta = await fetchServiceMetaIfNeeded(url);
    if(meta){ payload = alignPrefetchToDiscovery(meta, payload, !!buildPrefetch); }
    else if(buildPrefetch){
      const wanted=['serviceRequestBundle','deviceRequestBundle','medicationRequestBundle','coverageBundle'];
      payload.prefetch = Object.assign({}, payload.prefetch || {});
      for(const k of wanted){
        if(payload.prefetch[k] == null){
          payload.prefetch[k] = inferBundleForKey(k, payload) || null;
        }
      }
    }

    const headers={'Content-Type':'application/json','Accept':'application/json'};
    if(authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const r=await fetch(url,{method:'POST', headers, body: JSON.stringify(payload)});
    const text=await r.text(); let data=null; try{ data=JSON.parse(text); }catch{ data={raw:text}; }
    res.status(r.status).json({ url, status: r.status, ok: r.ok, data });
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/', (_req,res)=> res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, ()=>{
  console.log(`CRD Client listening on http://localhost:${PORT}`);
  console.log(`Default CRD base: ${CRD_SERVER_URL}`);
});
