// app.js - Governance Kit Cloud Run PoC
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Firestore } = require('@google-cloud/firestore');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai').default;
const sgMail = require('@sendgrid/mail');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '6mb' }));

/* ==== CONFIG from env ==== */
const ROOT_FOLDER_ID = process.env.ROOT_FOLDER_ID || ''; // required
const TEMPLATE_FILE_IDS = (process.env.TEMPLATE_FILE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const LOG_COLLECTION = process.env.LOG_COLLECTION || 'governance_runs';
const OPENAI_KEY = process.env.OPENAI_KEY || '';
const SENDGRID_KEY = process.env.SENDGRID_API_KEY || '';
const PROJECT_ID = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT || process.env.PROJECT_ID;

/* basic checks */
if (!ROOT_FOLDER_ID) console.warn('ROOT_FOLDER_ID not set. Set env var before deploy.');
if (!TEMPLATE_FILE_IDS.length) console.warn('TEMPLATE_FILE_IDS empty. Set env var to your template ids.');

const firestore = new Firestore();
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// SendGrid
if (SENDGRID_KEY) sgMail.setApiKey(SENDGRID_KEY);

// Google auth for Drive/Docs/Slides/Sheets
const auth = new google.auth.GoogleAuth({
  scopes: [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/presentations',
    'https://www.googleapis.com/auth/spreadsheets'
  ]
});

async function getGcloudClients() {
  const authClient = await auth.getClient();
  const drive = google.drive({ version: 'v3', auth: authClient });
  const docs = google.docs({ version: 'v1', auth: authClient });
  const slides = google.slides({ version: 'v1', auth: authClient });
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  return { drive, docs, slides, sheets, authClient };
}

/* =================== Helpers =================== */

async function writeLog(requestId, data) {
  const docRef = firestore.collection(LOG_COLLECTION).doc(requestId);
  await docRef.set(Object.assign({}, data), { merge: true });
}

async function readLog(requestId) {
  const docRef = firestore.collection(LOG_COLLECTION).doc(requestId);
  const doc = await docRef.get();
  return doc.exists ? doc.data() : null;
}

function safeName(s) {
  return String(s || 'Customer').replace(/[^\w\- ]/g, '').trim();
}

async function createFolder(drive, parentId, name) {
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    },
    fields: 'id, webViewLink'
  });
  return res.data;
}

async function addEditorToFolder(drive, folderId, email) {
  if (!email) return;
  try {
    await drive.permissions.create({
      fileId: folderId,
      requestBody: { role: 'writer', type: 'user', emailAddress: email },
      fields: 'id',
      sendNotificationEmail: false
    });
  } catch (e) {
    console.warn('addEditorToFolder failed:', e.toString());
  }
}

async function copyTemplatesToFolder(drive, templateIds, destFolderId, customerName) {
  const copied = [];
  for (const id of templateIds) {
    try {
      const meta = await drive.files.get({ fileId: id, fields: 'id,name,mimeType' });
      let newName = meta.data.name.replace(/\[Customer\]/ig, `[Customer]`); // keep filename token
      // Copy
      const copy = await drive.files.copy({
        fileId: id,
        requestBody: { name: newName, parents: [destFolderId] },
        fields: 'id, name, mimeType, webViewLink'
      });
      copied.push({ id: copy.data.id, name: copy.data.name, mimeType: copy.data.mimeType, url: copy.data.webViewLink });
    } catch (e) {
      console.warn('copyTemplatesToFolder error', id, e.toString());
    }
  }
  return copied;
}

/* Minimal markdown->Google Doc renderer:
   - Inserts all text, then applies heading styles to lines starting with # or ##,
   - Applies bullet lists for lines starting with "- " or "* ",
   - Leaves tables as plain text.
*/
async function createDocFromMarkdown(docsClient, drive, folderId, title, markdown, form) {
  // Create blank doc via Drive
  const created = await drive.files.create({
    requestBody: { name: title, mimeType: 'application/vnd.google-apps.document', parents: [folderId] },
    fields: 'id, webViewLink'
  });
  const docId = created.data.id;

  // Build content string
  const headerTable = `Customer: ${form.customer || ''}\nDate: ${new Date().toISOString().slice(0,10)}\nMaturity: ${form.maturity || ''}\nUse Case: ${form.useCase || ''}\nClassification Levels: ${(form.classification || []).join(', ')}\n\n`;
  const footer = `\n\nSynthetic example content for demo use only.`;
  const content = `${title}\n\n${headerTable}${markdown || ''}${footer}`;

  // Insert full text
  await docsClient.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [
        { insertText: { location: { index: 1 }, text: content } }
      ]
    }
  });

  // Now style headings and lists by scanning text and computing ranges
  // Fetch the current doc to compute indices
  const doc = await docsClient.documents.get({ documentId: docId, fields: 'body.content' });
  // The body content contains elements and we compute a simple mapping from string positions to elements.
  // Easiest approach: construct the same string and compute character offsets locally.
  // We'll reconstruct the content and search for headings/lists.
  const raw = content;
  let idx = 1;
  const lines = raw.split(/\r?\n/);
  const requests = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const start = idx;
    const lineWithNewline = line + '\n';
    const end = idx + lineWithNewline.length - 1;
    // Headings
    if (/^#\s+/.test(line)) {
      const text = line.replace(/^#\s+/, '');
      // apply heading style
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: start, endIndex: start + text.length + 1 },
          paragraphStyle: { namedStyleType: 'HEADING_1' },
          fields: 'namedStyleType'
        }
      });
    } else if (/^##\s+/.test(line)) {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: start, endIndex: end },
          paragraphStyle: { namedStyleType: 'HEADING_2' },
          fields: 'namedStyleType'
        }
      });
    } else if (/^\s*[-*]\s+/.test(line)) {
      // We'll set bullets after building groups; mark with a placeholder
      // CreateParagraphBullets expects a range; we'll create groups by scanning contiguous list lines.
    }
    idx += lineWithNewline.length;
  }

  // For bullets: find contiguous blocks
  let p = 1;
  idx = 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLen = line.length + 1;
    if (/^\s*[-*]\s+/.test(line)) {
      // start group
      const start = idx;
      let j = i;
      while (j < lines.length && /^\s*[-*]\s+/.test(lines[j])) j++;
      const endIdx = idx + lines.slice(i, j).map(l => l.length + 1).reduce((a,b)=>a+b,0);
      // create bullets
      requests.push({
        createParagraphBullets: {
          range: { startIndex: start, endIndex: endIdx },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' // simple bullet
        }
      });
      // advance
      i = j - 1;
      let adv = 0;
      for (let k = 0; k < j - i - 1; k++) { adv += 1; }
    }
    idx += lineLen;
  }

  if (requests.length) {
    try {
      await docsClient.documents.batchUpdate({ documentId: docId, requestBody: { requests } });
    } catch (e) {
      console.warn('style batchUpdate failed', e.toString());
    }
  }

  return { id: docId, url: `https://docs.google.com/document/d/${docId}/edit` };
}

/* Simple replaceAll for Docs, Slides and Sheets */

// Docs - replaceAllText
async function replaceInDocs(docsClient, docId, replacements) {
  const requests = Object.keys(replacements).map(k => ({
    replaceAllText: {
      containsText: { text: k, matchCase: true },
      replaceText: String(replacements[k] || '')
    }
  }));
  if (!requests.length) return;
  await docsClient.documents.batchUpdate({ documentId: docId, requestBody: { requests } });
}

// Slides - replaceAllText
async function replaceInSlide(slidesClient, presentationId, replacements) {
  const requests = Object.keys(replacements).map(k => ({
    replaceAllText: { containsText: { text: k }, replaceText: String(replacements[k] || '') }
  }));
  if (!requests.length) return;
  await slidesClient.presentations.batchUpdate({ presentationId, requestBody: { requests } });
}

// Sheets - iterate values and replace
async function replaceInSheet(sheetsClient, spreadsheetId, replacements) {
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId });
  const sheets = meta.data.sheets || [];
  for (const sh of sheets) {
    const title = sh.properties.title;
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range: title });
    const vals = res.data.values || [];
    let changed = false;
    for (let r = 0; r < vals.length; r++) {
      for (let c = 0; c < (vals[r] || []).length; c++) {
        if (typeof vals[r][c] === 'string') {
          let cell = vals[r][c];
          Object.keys(replacements).forEach(k => {
            cell = cell.split(k).join(replacements[k]);
          });
          if (cell !== vals[r][c]) { vals[r][c] = cell; changed = true; }
        }
      }
    }
    if (changed) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId, range: title,
        valueInputOption: 'RAW',
        requestBody: { values: vals }
      });
    }
  }
}

/* parse markdown table to 2D array for RACI */
function parseMarkdownTable(md) {
  if (!md) return [];
  const lines = md.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const tableLines = lines.filter(l => /^\|.*\|$/.test(l));
  if (!tableLines.length) return [];
  const rows = [];
  for (let i = 0; i < tableLines.length; i++) {
    const L = tableLines[i];
    if (/^\|\s*-{3,}\s*(\|\s*-{3,}\s*)+\|?$/.test(L)) continue;
    const cells = L.split('|').slice(1, -1).map(c => c.trim());
    rows.push(cells);
  }
  return rows;
}

/* call OpenAI for main kit JSON
   Expects prompt text using buildPromptFromForm inlined here.
   Ensures strict JSON output.
*/
async function callChatGPT_JSON(promptText) {
  if (!OPENAI_KEY) throw new Error('OPENAI_KEY not set in env');
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are an Alation CEM assistant. Return only strict JSON with keys Charter, Policy, Playbook, DocuJamAgenda, MetricsSummary, RACI, TrainingMaterials.' },
      { role: 'user', content: promptText }
    ],
    max_tokens: 3200,
    temperature: 0.4
  });
  let content = resp.choices?.[0]?.message?.content || '';
  // try parse, if fails try to coerce
  try { return JSON.parse(content); } catch (e) {
    // attempt to extract JSON substring
    const first = content.indexOf('{'), last = content.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      try { return JSON.parse(content.slice(first, last + 1)); } catch (_) { /* fallthrough */ }
    }
    // fallback: return empty shape
    return { Charter: '', Policy: '', Playbook: '', DocuJamAgenda: '', MetricsSummary: '', RACI: '', TrainingMaterials: [] };
  }
}

/* Build prompt from form + references (references not implemented for PoC, but we include basic context) */
function buildPromptFromForm(form, refs) {
  const levels = (form.classification && form.classification.length) ? form.classification : ['Public','Internal','Confidential'];
  const tmpl = (form.templateTypes && form.templateTypes.length) ? form.templateTypes : ['Column','Table','Schema','BI Report'];
  return [
    'Return ONLY one JSON object with keys exactly: Charter, Policy, Playbook, DocuJamAgenda, MetricsSummary, RACI, TrainingMaterials.',
    'Each of the Charter, Policy, Playbook, DocuJamAgenda, and MetricsSummary must be multi-section markdown strings (use headings, bullets, numbered lists) and be exec-ready and specific to the customer.',
    'RACI must be a markdown table with columns Role | Person | R | A | C | I.',
    'TrainingMaterials must be a JSON array of objects {title, body} where body is markdown.',
    '',
    'Context:',
    `Customer: ${form.customer || '(unknown)'}`,
    `Maturity: ${form.maturity || '(unknown)'}`,
    `Use Case: ${form.useCase || 'Data Governance – Classification'}`,
    `Classification Levels: ${levels.join(', ')}`,
    `Template Types: ${tmpl.join(', ')}`,
    `Strategic Priorities: ${(form.priorities || []).join(', ')}`,
    `Vision (optional): ${form.vision || '(none provided)'}`,
    '',
    'Requirements: Charter: purpose, scope, RACI mapping, 30/60/90; Policy: handling rules; Playbook: steward curation workflow in Alation; DocuJamAgenda: 90–120 min; MetricsSummary: coverage % etc.',
    'Return strict JSON only.'
  ].join('\n');
}

/* Value pyramid builder (simple) */
async function callValuePyramidBuilder(form) {
  const prompt = [
    'Return a JSON array of objects with keys StrategicPriority, KeyDataInitiatives (array), AssociatedBenefits (array), AlationSolutionMapping (string), CatalogValueDrivers (array), KeyPeopleToTarget (array).',
    `Customer: ${form.customer || 'Customer'}`,
    `Strategic Priorities: ${(form.priorities||[]).join(', ')}`,
    'Return strict JSON array only.'
  ].join('\n');
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'system', content: 'You are a structured business analyst.' }, { role: 'user', content: prompt }],
    max_tokens: 1200, temperature: 0.4
  });
  try { return JSON.parse(resp.choices[0].message.content); } catch (e) {
    const content = resp.choices[0].message.content || '';
    const first = content.indexOf('['), last = content.lastIndexOf(']');
    if (first !== -1 && last !== -1) return JSON.parse(content.slice(first, last+1));
    return [];
  }
}

/* =================== Main processing pipeline =================== */

app.post('/webhook', async (req, res) => {
  const body = req.body || {};
  const requestId = body.request_id || uuidv4();
  const email = body.email || body.requesterEmail || '';
  const form = {
    customer: body.customer || '',
    maturity: body.maturity || '',
    useCase: body.useCase || '',
    classification: body.classification || [],
    templateTypes: body.templateTypes || [],
    priorities: body.priorities || [],
    vision: body.vision || '',
    notes: body.notes || ''
  };

  // Basic validation
  if (!form.customer) return res.status(400).json({ error: 'customer is required' });

  // Idempotency check
  try {
    const existing = await readLog(requestId);
    if (existing && existing.status === 'DONE') {
      return res.status(200).json({ status: 'already_done', folderUrl: existing.folderUrl });
    }
    if (existing && existing.status === 'IN_PROGRESS') {
      return res.status(409).json({ status: 'in_progress' });
    }
    // mark IN_PROGRESS
    await writeLog(requestId, { createdAt: new Date().toISOString(), status: 'IN_PROGRESS', payload: form, requesterEmail: email });
  } catch (e) {
    console.error('log error', e.toString());
  }

  // respond quickly and process asynchronously
  res.status(202).json({ status: 'accepted', requestId });

  // process (no await)
  processRequest(requestId, form, email).catch(async (err) => {
    console.error('processRequest error', err);
    await writeLog(requestId, { status: 'FAILED', error: String(err) });
  });
});

async function processRequest(requestId, form, requesterEmail) {
  const clients = await getGcloudClients();
  const { drive, docs, slides, sheets } = clients;

  // create root folder for this kit
  const ts = new Date().toISOString().replace(/[:.]/g,'-');
  const safeCustomer = safeName(form.customer || 'Customer');
  const folderName = `${safeCustomer} - AI Governance Kit - ${ts}`;
  const folder = await createFolder(drive, ROOT_FOLDER_ID, folderName);
  const folderId = folder.id;

  // grant requester edit access
  if (requesterEmail) await addEditorToFolder(drive, folderId, requesterEmail);

  // copy templates into dest folder
  const copied = await copyTemplatesToFolder(drive, TEMPLATE_FILE_IDS, folderId, form.customer);

  // build prompt and call GPT to produce kit JSON
  const prompt = buildPromptFromForm(form, {});
  const kit = await callChatGPT_JSON(prompt);
  // ensure keys exist
  kit.Charter = kit.Charter || '';
  kit.Policy = kit.Policy || '';
  kit.Playbook = kit.Playbook || '';
  kit.DocuJamAgenda = kit.DocuJamAgenda || '';
  kit.MetricsSummary = kit.MetricsSummary || '';
  kit.RACI = kit.RACI || '';
  kit.TrainingMaterials = Array.isArray(kit.TrainingMaterials) ? kit.TrainingMaterials : [];

