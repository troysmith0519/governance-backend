# AI Governance Kit - Cloud Run PoC

## What this does
This small Cloud Run service generates a customer-ready Data Governance Starter Kit by copying Drive templates, calling OpenAI to create content, producing Google Docs/Sheets/Slides, filling the RACI, replacing placeholders, and emailing the requester.

## Quick overview
- POST a JSON payload to `/webhook` and the service creates a folder under `ROOT_FOLDER_ID` with all deliverables.
- Each run is logged in Firestore for audit and idempotency.
- The service adds the requester as an editor on the created folder so they can review and tweak deliverables.

## Prerequisites (fill these before deploy)
- Google Cloud project with billing enabled  
- Service account `governance-kit-sa@<PROJECT>.iam.gserviceaccount.com` with Editor access to the Drive Templates and Root Kits folders  
- Firestore initialized (Native mode)  
- OpenAI API key (set as `OPENAI_KEY`)  
- SendGrid API key (set as `SENDGRID_API_KEY`)  
- The Root Kits folder id `ROOT_FOLDER_ID` (Drive id) and the comma separated list `TEMPLATE_FILE_IDS` of template file ids

## Minimal local run
1. In the repo folder, install deps:
```bash
npm install
2. Set these environment variables locally for testing:
export OPENAI_KEY="sk-..."
export SENDGRID_API_KEY="SG-..."
export ROOT_FOLDER_ID="1UwhbiWAge47C6h0Vx82RlqblMzEelmzx"
export TEMPLATE_FILE_IDS="id1,id2,id3"
3. Start locally:
node app.js
# Service available at http://localhost:8080
