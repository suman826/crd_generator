
// CRD Client Testing Tool - Discovery-aligned Prefetch (v1.3.0)
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

function readJsonFile(p){ return JSON.parse(fs.readFileSync(p,'utf8')); }
function bundleWrap(resources){
  const entries=(resources||[]).filter(Boolean).map(r=>({fullUrl: r.id?`${r.resourceType}/${r.id}`:undefined, resource:r}));
  return {resourceType:"Bundle", type:"searchset", total: entries.length, entry: entries};
}
function inferBundleForKey(key, payload){
  const ctx = payload.context || {};
  const draft = ctx.draftOrders?.entry?.map(e=>e.resource) || [];
  const find = (t)=> draft.find(r=>r && r.resourceType===t);
  const patientId = ctx.patientId || 'demo-patient';
  const patient = {resourceType:"Patient", id:patientId, name:[{text:"Test Patient"}]};
  if(/serviceRequest/i.test(key)){
    const sr = find('ServiceRequest');
    const role={resourceType:"PractitionerRole",id:"prr1",practitioner:{reference:"Practitioner/p1"},organization:{reference:"Organization/o1"}};
    const prac={resourceType:"Practitioner",id:"p1",name:[{text:"Alice Smith, MD"}]};
    const org={resourceType:"Organization",id:"o1",name:"Good Health Clinic"};
    return bundleWrap([sr, patient, role, prac, org].filter(Boolean));
  }
  if(/deviceRequest/i.test(key)){
    const dr = find('DeviceRequest');
    const device={resourceType:"Device",id:"dev1",type: dr?.codeCodeableConcept};
    const role={resourceType:"PractitionerRole",id:"prr1",practitioner:{reference:"Practitioner/p1"},organization:{reference:"Organization/o1"}};
    const prac={resourceType:"Practitioner",id:"p1",name:[{text:"Alice Smith, MD"}]};
    const org={resourceType:"Organization",id:"o1",name:"Good Health Clinic"};
    return bundleWrap([dr, device, patient, role, prac, org].filter(Boolean));
  }
  if(/medicationRequest/i.test(key)){
    const mr = find('MedicationRequest');
    const role={resourceType:"PractitionerRole",id:"prr1",practitioner:{reference:"Practitioner/p1"},organization:{reference:"Organization/o1"}};
    const prac={resourceType:"Practitioner",id:"p1",name:[{text:"Alice Smith, MD"}]};
    const org={resourceType:"Organization",id:"o1",name:"Good Health Clinic"};
    return bundleWrap([mr, patient, role, prac, org].filter(Boolean));
  }
  if(/coverage/i.test(key)){
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
    if(payload.prefetch[k]) return;
    if(buildPrefetch){ payload.prefetch[k] = inferBundleForKey(k, payload); }
  });
  return payload;
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
  const base=(req.query.serverUrl||CRD_SERVER_URL).replace(/\/+$/,'');
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
    const { filename, serviceId, serviceIdOverride, serverUrl, buildPrefetch, serviceMeta, authToken } = req.body || {};
    const base=(serverUrl||CRD_SERVER_URL).replace(/\/+$/,'');
    const chosen=(serviceIdOverride && serviceIdOverride.trim()) || serviceId;
    if(!chosen) return res.status(400).json({error:"serviceId (or full URL) is required"});
    const url = /^https?:\/\//i.test(chosen) ? chosen : `${base}/cds-services/${chosen}`;
    let payload=null;
    if(filename){
      const fp=path.join(__dirname,'requests',filename);
      if(!fs.existsSync(fp)) return res.status(400).json({error:`Request file not found: ${filename}`});
      payload = readJsonFile(fp);
    } else if (req.body.payload){ payload = req.body.payload; }
    else { return res.status(400).json({error:"Provide either filename or payload"}); }
    if(payload && Object.prototype.hasOwnProperty.call(payload,'fhirServer')) delete payload.fhirServer;
    if(serviceMeta){ payload = alignPrefetchToDiscovery(serviceMeta, payload, !!buildPrefetch); }
    else if(buildPrefetch){
      payload.prefetch = Object.assign({}, payload.prefetch || {}, {
        serviceRequestBundle: payload.prefetch?.serviceRequestBundle || inferBundleForKey('serviceRequestBundle', payload),
        deviceRequestBundle: payload.prefetch?.deviceRequestBundle || inferBundleForKey('deviceRequestBundle', payload),
        medicationRequestBundle: payload.prefetch?.medicationRequestBundle || inferBundleForKey('medicationRequestBundle', payload),
        coverageBundle: payload.prefetch?.coverageBundle || inferBundleForKey('coverageBundle', payload)
      });
    }
    const headers={'Content-Type':'application/json','Accept':'application/json'};
    if(authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const r=await fetch(url,{method:'POST', headers, body: JSON.stringify(payload)});
    const text=await r.text(); let data=null; try{ data=JSON.parse(text); }catch{ data={raw:text}; }
    res.status(r.status).json({ url, status:r.status, ok:r.ok, data });
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/', (_req,res)=> res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT, ()=>{
  console.log(`CRD Client on http://localhost:${PORT}`);
  console.log(`Default CRD base: ${CRD_SERVER_URL}`);
});
