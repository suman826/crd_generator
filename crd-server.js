// server.js
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");

const app = express();
app.use(bodyParser.json());

// Load valid codes
const validCodes = JSON.parse(fs.readFileSync("./valid_code.json", "utf-8"));

// =====================
// Utility functions
// =====================
function isValidCode(code) {
  if (!code) return false;
  return validCodes.CPT.includes(code) ||
         validCodes.HCPCS.includes(code) ||
         validCodes.RxNorm.includes(code);
}

function getSystemForCode(code) {
  if (/^[A-Z]\d{4}$/.test(code)) {
    return "https://www.cms.gov/medicare/coding/hcpcs-release-code-sets";
  }
  if (/^\d{5}$/.test(code)) {
    return "http://www.ama-assn.org/go/cpt";
  }
  if (/^\d{6,7}$/.test(code)) {
    return "http://www.nlm.nih.gov/research/umls/rxnorm";
  }
  return "http://example.org/unknown-system";
}

function getPrefetchResource(prefetch) {
  if (!prefetch) return null;
  const keys = Object.keys(prefetch);
  if (keys.length === 0) return null;
  return prefetch[keys[0]];
}

function getDraftResource(reqBody) {
  if (reqBody?.systemActions?.length) {
    const r = reqBody.systemActions[0].resource;
    if (r?.resourceType && r?.id) return r;
  }
  if (reqBody?.context?.draftOrders?.entry?.length) {
    const r = reqBody.context.draftOrders.entry[0].resource;
    if (r?.resourceType && r?.id) return r;
  }
  const prefetchResource = getPrefetchResource(reqBody?.prefetch);
  if (prefetchResource?.resourceType) {
    return {
      resourceType: prefetchResource.resourceType,
      id: prefetchResource.id || "idfromcontext"
    };
  }
  return null;
}

function validatePaFlag(serviceRequest) {
  if (!serviceRequest.extension) {
    return { valid: true, paFlag: null };
  }
  const paExt = serviceRequest.extension.find(
    (ext) =>
      ext.url.includes("pa-requirement-flag") ||
      ext.url === "pa-needed"
  );
  if (!paExt) {
    return { valid: true, paFlag: null };
  }
  if (!("valueBoolean" in paExt)) {
    return { valid: false, error: "Invalid PA flag format or ignored with default behavior" };
  }
  if (typeof paExt.valueBoolean !== "boolean") {
    return { valid: false, error: "Invalid PA flag format or ignored with default behavior" };
  }
  return { valid: true, paFlag: paExt.valueBoolean };
}

// =====================
// Dynamic encounter type detection
// =====================
function getEncounterType(draftBundle) {
  const encounterEntry = draftBundle?.entry?.find(e => e.resource?.resourceType === "Encounter");
  if (!encounterEntry) return "unknown";

  const code = encounterEntry.resource?.class?.code?.toLowerCase();
  if (["IMP", "inpatient"].includes(code)) return "inpatient";
  if (["AMB", "outpatient", "outp"].includes(code)) return "outpatient";
  return "other";
}

// =====================
// PA Rules (CPT/HCPCS)
// =====================
const cptRules = {
  "70551": { paMessage: "MRI Brain requires prior authorization.", paNeeded: "auth-needed", docNeeded: "clinical", docPurpose: "withpa", infoNeeded: "performer" },
  "99213": { paMessage: "Office visit (low complexity) does not require PA.", paNeeded: "no-auth", docNeeded: "admin", docPurpose: "withclaim", infoNeeded: "location" },
  "E0260": { paMessage: "Hospital bed rental requires PA.", paNeeded: "auth-needed", docNeeded: "patient", docPurpose: "retain-doc", infoNeeded: "timeframe" },
  "E0424": { paMessage: "Stationary compressed gas oxygen system requires PA.", paNeeded: "auth-needed", docNeeded: "clinical", docPurpose: "withpa", infoNeeded: "contract-window" },
  "E0601": { paMessage: "CPAP device requires PA and supporting documentation.", paNeeded: "auth-needed", docNeeded: "patient", docPurpose: "withorder", infoNeeded: "detail-code" },
  "G0180": { paMessage: "Home health certification require PA.", paNeeded: "auth-needed", docNeeded: "admin", docPurpose: "OTH", infoNeeded: "OTH" },
  "92015": { paMessage: "92015 does not require prior authorization.", paNeeded: "no-auth", docNeeded: "none", docPurpose: "NA", infoNeeded: "NA"},
  "97802": { paMessage: "97802 does not require prior authorization.", paNeeded: "no-auth", docNeeded: "none", docPurpose: "NA", infoNeeded: "NA"}
};

// PA Rules (Medication)
const medicationRules = {
  "617314": { paMessage: "Prior authorization required for Adalimumab", paNeeded: "yes", docNeeded: "yes", docPurpose: "PA", infoNeeded: "clinical documentation including diagnosis and previous therapy" },
  "83367": { paMessage: "No prior authorization required for Atorvastatin", paNeeded: "no", docNeeded: "none", docPurpose: "NA", infoNeeded: "NA" }
};

// PA Rules (RxNorm)
const rxNormRules = {
  "1993270": { paMessage: "Semaglutide (Ozempic) requires prior authorization.", paNeeded: "auth-needed", docNeeded: "clinical", docPurpose: "withpa", infoNeeded: "diagnosis" },
  "617314": { paMessage: "Amoxicillin does not require prior authorization.", paNeeded: "no-auth", docNeeded: "admin", docPurpose: "withclaim", infoNeeded: "OTH" },
  "744624": { paMessage: "Adalimumab requires prior authorization and step therapy documentation.", paNeeded: "auth-needed", docNeeded: "clinical", docPurpose: "withpa", infoNeeded: "diagnosis-history" }
};

// =====================
// Extract Codes from draftOrders/Resources
// =====================
function extractCodes(bundle) {
  const codes = [];

  const pullCodesFromArray = (arr) => {
    if (!arr) return;
    const arrNorm = Array.isArray(arr) ? arr : [arr];
    arrNorm.forEach(item => {
      if (item?.coding) item.coding.forEach(c => c.code && codes.push(c.code));
      else if (item?.code) codes.push(item.code);
    });
  };

  const pullResourceCodes = (resource) => {
    if (!resource) return;
    [
      resource.code,
      resource.codeCodeableConcept,
      resource.productCodeableConcept,
      resource.medicationCodeableConcept,
      resource.reasonCode,
      resource.orderDetail
    ].forEach(pullCodesFromArray);
    if (Array.isArray(resource.type)) pullCodesFromArray(resource.type);
  };

  bundle?.context?.draftOrders?.entry?.forEach(e => pullResourceCodes(e.resource));
  pullResourceCodes(bundle?.prefetch?.deviceRequest);
  pullResourceCodes(bundle?.prefetch?.medicationRequest);
  bundle?.systemActions?.forEach(action => pullResourceCodes(action.resource));

  return codes;
}

// =====================
// Discovery Endpoint
// =====================
app.get("/cds-services", (req, res) => {
  res.json({
    services: [
      {
        id: "order-sign-crd",
        hook: "order-sign",
        title: "Coverage Requirements Discovery",
        description: "Dynamic CRD RI in Node.js",
        prefetch: {
          patient: "Patient/{{context.patientId}}",
          coverage: "Coverage?patient={{context.patientId}}"
        }
      }
    ]
  });
});

// =====================
// CDS Service Endpoint
// =====================
app.post("/cds-services/order-sign-crd", (req, res) => {
  console.log("Incoming CRD Request:", JSON.stringify(req.body, null, 2));

  if (!req.body?.hook) {
    return res.status(400).json({ error: "invalid_request", message: "Missing required field: hook" });
  }
  if (req.body.hook !== "order-sign") {
    return res.status(400).json({
      error: "CRD-004: Unsupported hook type",
      hook: req.body.hook,
      message: `The hook '${req.body.hook}' is not supported by this CRD service.`
    });
  }

  // Determine patient reference
  let patientRef = null;
  if (req.body?.context?.patientId) patientRef = `Patient/${req.body.context.patientId.replace(/^Patient\//,'')}`;
  else if (req.body?.prefetch?.deviceRequest?.subject?.reference && req.body.prefetch.deviceRequest.subject.reference !== "Patient/null") patientRef = req.body.prefetch.deviceRequest.subject.reference;
  else if (req.body?.prefetch?.patient?.id) patientRef = `Patient/${req.body.prefetch.patient.id.replace(/^Patient\//,'')}`;

  if (!patientRef) {
    return res.json({
      cards: [{ summary: "Missing patient reference", indicator: "critical", detail: "The CRD request did not include a valid patient reference.", source: { label: "CRD Test Server", url: "http://localhost:3011" } }]
    });
  }

  // Get coverage
  let coverageId = null;
  const coverageEntry = req.body?.prefetch?.coverageBundle?.entry?.find(e => e.resource?.resourceType === "Coverage");
  if (coverageEntry?.resource?.id) coverageId = coverageEntry.resource.id;

  if (!coverageId) {
    return res.json({
      cards: [{ summary: "Cannot evaluate prior authorization rules", detail: "No Coverage information provided for this patient.", indicator: "warning", source: { label: "CRD RI Server (Node.js)" } }]
    });
  }

  // Extract codes
  const codes = extractCodes(req.body);
  const cptCode = (codes.length ? codes[0] : "UNKNOWN").toUpperCase();

  if (!isValidCode(cptCode)) {
    return res.status(400).json({ error: "CRD-008: Invalid CPT/HCPCS/RxNorm code", code: cptCode || "MISSING", message: `The code '${cptCode || "MISSING"}' is not recognized.` });
  }

  // Get base rules
  let rules = cptRules[cptCode] || medicationRules[cptCode] || rxNormRules[cptCode] || { paMessage: "No prior authorization required", paNeeded: "conditional", docNeeded: "conditional", docPurpose: "OTH", infoNeeded: "OTH" };
  
  const draftResource = getDraftResource(req.body);

  // Validate PA flag if present
  const paValidation = validatePaFlag(draftResource);
  if (!paValidation.valid) {
    return res.status(400).json({ error: "Invalid or malformed PA requirement flag", message: paValidation.error });
  }

  // ---------------------
  // Dynamic inpatient/outpatient logic
  // ---------------------
  const encounterType = getEncounterType(req.body.context.draftOrders);
  if (encounterType === "inpatient" && rules.paNeeded === "auth-needed") {
    rules = { ...rules, paMessage: `${rules.paMessage} (inpatient exception: no PA required)`, paNeeded: "no-auth", docNeeded: "none", docPurpose: "NA", infoNeeded: "NA" };
  }

  // Build CRD response
  const response = {
    cards: [{
      uuid: "uuid-" + cptCode,
      summary: rules.paMessage.includes("requires") ? "Prior Authorization Required" : "No Prior Auth Needed",
      indicator: rules.paMessage.includes("requires") ? "warning" : "info",
      detail: `Coverage info for patient ${patientRef}. Code: ${cptCode}`,
      source: { label: "CRD RI Server (Node.js)", url: "http://localhost:3011", topic: { system: "http://hl7.org/fhir/us/davinci-crd/CodeSystem/temp", code: "guideline", display: "Coverage Requirement" } },
      links: [{ label: "Coverage Guidelines", url: "https://example.org/guidelines/" + cptCode, type: "absolute" }],
      suggestions: rules.paMessage.includes("requires") ? [{
        label: "Submit Prior Auth (PAS)",
        actions: [{ type: "create", description: "Submit a PAS Claim Bundle", resource: { resourceType: "Claim", id: "claim-" + cptCode } }]
      }] : []
    }],
    systemActions: [{
      type: "update",
      resource: {
        resourceType: draftResource.resourceType,
        id: draftResource.id,
        extension: [{
          url: "http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information",
          extension: [
            { url: "coverage", valueReference: { reference: `Coverage/${coverageId}` } },
            { url: "covered", valueCode: "covered" },
            { url: "pa-needed", valueCode: rules.paNeeded },
            { url: "doc-needed", valueCode: rules.docNeeded },
            { url: "doc-purpose", valueCode: rules.docPurpose },
            { url: "info-needed", valueCode: rules.infoNeeded },
            { url: "billingCode", valueCoding: { system: getSystemForCode(cptCode), code: cptCode } },
            { url: "reason", valueCodeableConcept: { coding: [{ system: "http://hl7.org/fhir/us/davinci-crd/CodeSystem/temp", code: "auth-out-network", display: "Authorization needed out-of-network" }], text: "In-network required unless exigent circumstances" } }
          ]
        }],
        status: "draft",
        intent: "original-order",
        code: { coding: [{ system: getSystemForCode(cptCode), code: cptCode }] },
        subject: { reference: patientRef },
        authoredOn: new Date().toISOString()
      }
    }]
  };

  res.json(response);
});

// =====================
// Start Server
// =====================
const PORT = process.env.PORT || 3011;
app.listen(PORT, () => console.log(`CRD RI Node.js server running at http://localhost:${PORT}`));
