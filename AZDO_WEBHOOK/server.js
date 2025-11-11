// server.js
// npm i express node-fetch@2
require('dotenv').config(); // <-- Lê automaticamente o ficheiro .env
const express = require('express');
const fetch = require('node-fetch');

// ---- Config carregada do ficheiro .env ----
const AZDO_ORG     = process.env.AZDO_ORG;      // ex: 'a-tua-org'
const AZDO_PROJECT = process.env.AZDO_PROJECT;  // ex: 'o-teu-projeto'
const AZDO_PAT     = process.env.AZDO_PAT;      // token PAT

// ---- Util ----
function b64(s){ return Buffer.from(s).toString('base64'); }
function authHeader(){ return { 'Authorization': `Basic ${b64(':'+AZDO_PAT)}` }; }

// Estados “canon”
const STATE = { Doing: 'Doing', CodeReview: 'CodeReview', Done: 'Done' };

// Transições permitidas no teu WIT (ajusta se o teu processo for diferente)
const ALLOW = {
  [STATE.Doing]:      new Set([STATE.CodeReview]),
  [STATE.CodeReview]: new Set([STATE.Doing, STATE.Done]),
  [STATE.Done]:       new Set([]),
};

// ---- Lógica principal ----
// Decisão apenas pelo status do PR
function targetState(_eventType, resource){
  const status = resource?.status; // 'active' | 'completed' | 'abandoned'
  if (status === 'abandoned') return STATE.Doing;
  if (status === 'completed') return STATE.Done;
  if (status === 'active')    return STATE.CodeReview;
  return null;
}

// Anti-eventos fora de ordem: ignora "completed" nos 5s após receber o primeiro evento do PR
const PR_FIRST_SEEN = new Map(); // prId -> timestamp(ms)
function rememberPR(resource){
  const prId = resource?.pullRequestId;
  if (prId && !PR_FIRST_SEEN.has(prId)) PR_FIRST_SEEN.set(prId, Date.now());
}
function tooSoonCompleted(resource, millis = 5000){
  const prId = resource?.pullRequestId;
  const t0 = prId ? PR_FIRST_SEEN.get(prId) : null;
  return t0 && (Date.now() - t0) < millis;
}

// ---- Azure DevOps REST helpers ----
async function setWorkItemState(id, state){
  const url = `https://dev.azure.com/${AZDO_ORG}/${AZDO_PROJECT}/_apis/wit/workitems/${id}?api-version=7.1`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { ...authHeader(), 'Content-Type': 'application/json-patch+json' },
    body: JSON.stringify([{ op:'add', path:'/fields/System.State', value: state }])
  });
  if (!resp.ok){
    const t = await resp.text();
    console.error('❌ Falha ao atualizar WI', id, resp.status, t);
    throw new Error(`Update WI ${id} failed (${resp.status})`);
  }
}

async function getWorkItem(id){
  const url = `https://dev.azure.com/${AZDO_ORG}/${AZDO_PROJECT}/_apis/wit/workitems/${id}?api-version=7.1`;
  const resp = await fetch(url, { headers: { ...authHeader() } });
  if (!resp.ok){
    const t = await resp.text();
    console.error('❌ getWorkItem falhou', id, resp.status, t);
    throw new Error('getWorkItem failed');
  }
  return resp.json(); // fields['System.WorkItemType'], fields['System.State']
}

async function getAllowedStates(workItemType){
  const url = `https://dev.azure.com/${AZDO_ORG}/${AZDO_PROJECT}/_apis/wit/workitemtypes/${encodeURIComponent(workItemType)}/states?api-version=7.1`;
  const resp = await fetch(url, { headers: { ...authHeader() } });
  if (!resp.ok){
    const t = await resp.text();
    console.error('❌ getAllowedStates falhou', workItemType, resp.status, t);
    throw new Error('getAllowedStates failed');
  }
  const data = await resp.json(); // { value: [{name, category}...] }
  return (data.value || []).map(s => s.name);
}

// Se o tipo não suportar CodeReview, cai para Doing; para Done tenta equivalentes comuns
async function pickSafeStateForWI(wiId, desired){
  const wi = await getWorkItem(wiId);
  const type = wi?.fields?.['System.WorkItemType'];
  const allowed = await getAllowedStates(type);

  if (allowed.includes(desired)) return desired;

  if (desired === STATE.CodeReview && allowed.includes(STATE.Doing)) return STATE.Doing;

  if (desired === STATE.Done) {
    if (allowed.includes(STATE.Done))     return STATE.Done;
    if (allowed.includes('Closed'))       return 'Closed';
    if (allowed.includes('Resolved'))     return 'Resolved';
  }

  console.log(`↪ WI ${wiId} (${type}) não suporta "${desired}" (allowed: ${allowed.join(', ')})`);
  return null;
}

// Atualiza com validação de transições atuais do WI (devolve true se mudou algo)
async function safeUpdate(wiId, desired){
  const finalState = await pickSafeStateForWI(wiId, desired);
  if (!finalState) return false;

  const wi = await getWorkItem(wiId);
  const current = wi?.fields?.['System.State'];
  if (!current) return false;

  if (current === finalState) {
    console.log(`= WI ${wiId} já em ${finalState}`);
    return false; // nada mudou
  }

  if (!ALLOW[current]?.has(finalState)) {
    console.log(`↪ Ignorado: transição não permitida ${current} → ${finalState}`);
    return false;
  }

  await setWorkItemState(wiId, finalState);
  return true;
}

// Fallback: obter WIs ligados ao PR (payload → API com e sem project)
async function fetchPRWorkItemIds(resource){
  const repoId = resource?.repository?.id;
  const prId   = resource?.pullRequestId;
  if (!repoId || !prId) return [];
  const urls = [
    `https://dev.azure.com/${AZDO_ORG}/${AZDO_PROJECT}/_apis/git/repositories/${repoId}/pullrequests/${prId}/workitems?api-version=7.1`,
    `https://dev.azure.com/${AZDO_ORG}/_apis/git/repositories/${repoId}/pullrequests/${prId}/workitems?api-version=7.1`
  ];
  for (const url of urls){
    try{
      const resp = await fetch(url, { headers: { ...authHeader() } });
      if (!resp.ok){
        const t = await resp.text();
        console.warn('fetchPRWorkItemIds: tentativa falhou', resp.status, url, t);
        continue;
      }
      const data = await resp.json();
      return (data.value || []).map(v => v.id).filter(Boolean);
    }catch(e){
      console.error('fetchPRWorkItemIds: erro fetch', e?.message || e, url);
      continue;
    }
  }
  return [];
}

async function getLinkedWorkItemIds(resource){
  const fromPayload = (resource?.workItemRefs || []).map(r => r.id).filter(Boolean);
  if (fromPayload.length) return fromPayload;
  try{
    return await fetchPRWorkItemIds(resource);
  }catch{
    return [];
  }
}

// ---- Server ----
const app = express();
app.use(express.json({ type: '*/*' }));

app.post('/webhook', async (req, res) => {
  try{
    const { eventType, resource } = req.body || {};
    const status = resource?.status;

    console.log('### WEBHOOK RECEBIDO ###');
    console.log('eventType:', eventType, '| status:', status, '| repo:', resource?.repository?.name, '| prId:', resource?.pullRequestId);

    rememberPR(resource);

    const desired = targetState(eventType, resource);
    if (!desired) {
      console.log('↪ Sem mudança de estado.');
      return res.status(200).send('No state change');
    }

    // anti “Done” precoce (eventos fora de ordem)
    if (desired === STATE.Done && tooSoonCompleted(resource)) {
      console.log('↪ Ignorado Done precoce (anti out-of-order)');
      return res.status(200).send('Ignored early completed');
    }

    const ids = await getLinkedWorkItemIds(resource || {});
    console.log('Work items ligados:', ids);
    if (!ids.length){
      console.log('↪ Nenhum work item ligado ao PR.');
      return res.status(200).send('No linked work items');
    }

    let updated = 0;
    for (const id of ids){
      const ok = await safeUpdate(id, desired);
      if (ok) updated++;
    }
    console.log(`✅ Atualização concluída para ${updated} work item(s) → ${desired}`);
    res.status(200).send(`Updated ${updated} WI(s) → ${desired}`);
  }catch(err){
    console.error('❌ Erro no webhook:', err?.message || err);
    res.status(500).send('Error');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Listening on', port));
