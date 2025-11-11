# 🔄 Automatismo: Sincronizar estado do Work Item com o estado do Pull Request

## 🎯 Objetivo
Automatizar a atualização do estado dos **Work Items** (tipo `FeatureDev`) de acordo com a atividade de **Pull Requests (PRs)** no **Azure DevOps**.

| Evento no PR | Novo estado do Work Item |
|---------------|--------------------------|
| PR criado / ativo | `CodeReview` |
| PR abandonado | `Doing` |
| PR completado (merge) | `Done` |

---

## 🏗️ Arquitetura

1. **Azure DevOps Service Hooks**  
   - Eventos: `Pull request created` e `Pull request updated`.

2. **Webhook Node.js/Express**  
   - Recebe os eventos enviados pelo Azure DevOps.
   - Lê o campo `resource.status` do PR:
     - `active` → `CodeReview`
     - `abandoned` → `Doing`
     - `completed` → `Done`
   - Obtém os IDs dos Work Items ligados e atualiza o campo `System.State` via **Azure DevOps REST API**.

---

## ⚙️ Tecnologias Utilizadas

- [Node.js](https://nodejs.org/) + [Express](https://expressjs.com/) — servidor HTTP para receber webhooks.  
- [node-fetch@2](https://www.npmjs.com/package/node-fetch) — comunicação com a API REST do Azure DevOps.  
- [ngrok](https://ngrok.com/) — cria túnel HTTPS público para o servidor local.  
- [Azure DevOps](https://dev.azure.com/) — Boards, Repos, Service Hooks e REST API.

---

## 🔐 Pré-requisitos

### PAT (Personal Access Token)
Deve conter os seguintes *scopes*:
- ✅ **Work Items – Read & write**
- ⚙️ **Code – Read** *(opcional; apenas para fallback de PR → Work Items)*

### Processo de Trabalho
O Work Item Type `FeatureDev` deve ter os estados:
- `Doing` (In Progress)
- `CodeReview` (In Progress)
- `Done` (Completed)

Regras de transição necessárias:
- `Doing → CodeReview`
- `CodeReview → Doing`
- `CodeReview → Done`

---

## 🌍 Variáveis de Ambiente

| Variável | Descrição | Exemplo |
|-----------|------------|----------|
| `AZDO_ORG` | Nome da organização no Azure DevOps | `minha-org` |
| `AZDO_PROJECT` | Nome do projeto | `projeto-estagio-TEST` |
| `AZDO_PAT` | Token PAT com permissões | `xyz123...` |

---

## 🔁 Fluxo de Eventos Tratados

### 📦 Pull request created
- `resource.status = active` → Work Item vai para **CodeReview**  
- Se o payload não contiver `workItemRefs`, é usado um *fallback* via API (requer scope `Code (Read)`).

### 🔧 Pull request updated
| Status do PR | Novo estado do WI |
|---------------|------------------|
| `active` | CodeReview |
| `abandoned` | Doing |
| `completed` | Done |

🔒 **Proteção extra:** o script ignora transições para `Done` nos primeiros **5 segundos** após o primeiro evento do PR (evita eventos fora de ordem).

---

## 🚀 Passos Funcionais (implementação)

1. Criar o servidor **Node.js** (`server.js`)  
   ```bash
   npm i express node-fetch@2
   node server.js
