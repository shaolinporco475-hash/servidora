const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const CATEGORY_POOLS = {
  Famosos: ["Beyoncé","Michael Jackson","Cristiano Ronaldo","Pelé","Einstein","Frida Kahlo","Ayrton Senna","Anitta","Neymar","Oprah Winfrey","Elvis Presley","Cleópatra"],
  Filmes: ["Shrek","Darth Vader","Homem-Aranha","Mulher-Maravilha","Woody","Indiana Jones","Harry Potter","Jack Sparrow","Homem de Ferro","Yoda","E.T.","Batman"],
  Desenhos: ["Bob Esponja","Mickey Mouse","Pernalonga","Pica-Pau","Scooby-Doo","Pikachu","Naruto","Goku","Dora Aventureira","Peppa Pig","Tom e Jerry","Wandinha Addams"]
};

let state = {
  players: [], assignments: null, phase: 'lobby', chat: [], turnIndex: 0,
  pendingQuestion: null, questionHistory: [], scores: {}, winner: null,
  host: null, usedGuess: {}
};
const socketNames = new Map();
const lastChatAt = new Map();
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function shuffle(arr) { const a=arr.slice(); for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }
function allPool() { return Object.values(CATEGORY_POOLS).flat(); }
function availableSecret() {
  const used = new Set(Object.values(state.assignments || {}));
  const free = allPool().filter(x => !used.has(x));
  return shuffle(free)[0] || shuffle(allPool())[0];
}
function assignNewPlayer(name) {
  if (!state.assignments) state.assignments = {};
  state.assignments[name] = availableSecret();
}
function normalizeGuess(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function levenshtein(a, b) {
  const prev = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function guessMatches(guess, secret) {
  const a = normalizeGuess(guess);
  const b = normalizeGuess(secret);
  if (!a || !b) return false;
  if (a === b) return true;
  // Aceita pequenos erros de digitação sem deixar o chute permissivo demais.
  const maxDistance = b.length <= 6 ? 1 : b.length <= 12 ? 2 : 3;
  return levenshtein(a, b) <= maxDistance;
}
function resetRoom() {
  state = { players: [], assignments: null, phase: 'lobby', chat: [], turnIndex: 0, pendingQuestion: null, questionHistory: [], scores: {}, winner: null, host: null, usedGuess: {} };
}
function finishRound() {
  state.assignments = null;
  state.phase = 'lobby';
  state.turnIndex = 0;
  state.pendingQuestion = null;
  state.questionHistory = [];
  state.winner = null;
  state.chat = [];
  state.usedGuess = {};
  state.players.forEach(p => { state.scores[p] = state.scores[p] || 0; });
}
function sendState(ws) {
  if (ws.readyState !== 1) return;
  const name = socketNames.get(ws);
  const publicState = { ...state, assignments: {} };
  if (state.assignments) for (const [player, secret] of Object.entries(state.assignments)) if (player !== name) publicState.assignments[player] = secret;
  publicState.mySecret = name && state.assignments ? (state.assignments[name] || null) : null;
  publicState.pendingQuestion = state.pendingQuestion ? { ...state.pendingQuestion } : null;
  publicState.iUsedGuess = !!(name && state.usedGuess[name]);
  // Cada jogador só recebe o próprio histórico de perguntas.
  publicState.questionHistory = (state.questionHistory || []).filter(item => item.asker === name);
  // Tentativas são resolvidas imediatamente no servidor, então não há resposta pendente.
  publicState.pendingGuess = null;
  ws.send(JSON.stringify({ type:'state', state:publicState }));
}
function broadcast(){ wss.clients.forEach(sendState); }
function sendError(ws,message){ if(ws.readyState===1) ws.send(JSON.stringify({type:'error',message})); }
function startRound(categories) {
  const cats = Array.isArray(categories) && categories.length ? categories.filter(c=>CATEGORY_POOLS[c]) : Object.keys(CATEGORY_POOLS);
  const pool = cats.flatMap(c=>CATEGORY_POOLS[c]);
  if(pool.length < state.players.length) return false;
  const names = shuffle(pool).slice(0,state.players.length);
  state.assignments = {}; state.players.forEach((p,i)=>state.assignments[p]=names[i]);
  state.phase='playing'; state.turnIndex=0; state.pendingQuestion=null; state.questionHistory=[]; state.winner=null; state.usedGuess={};
  state.players.forEach(p=>{state.scores[p]=state.scores[p]||0;});
  return true;
}

wss.on('connection', ws => {
  sendState(ws);
  ws.on('message', raw => {
    let msg; try { msg=JSON.parse(raw); } catch { return; }

    if(msg.type==='join'){
      const name=String(msg.name||'').trim().slice(0,24);
      if(!name) return sendError(ws,'Digite um nome.');
      if(socketNames.has(ws)) return sendError(ws,'Você já está conectado.');
      if(state.players.includes(name)) return sendError(ws,'Já tem alguém com esse nome no grupo.');
      socketNames.set(ws,name); state.players.push(name); state.scores[name]=state.scores[name]||0;
      if(!state.host) state.host=name;
      if(state.phase==='playing') assignNewPlayer(name);
      broadcast(); return;
    }

    if(msg.type==='leave'){
      const name=socketNames.get(ws); if(!name) return;
      const oldIndex=state.players.indexOf(name);
      state.players=state.players.filter(p=>p!==name);
      if(state.assignments) delete state.assignments[name];
      if(state.pendingQuestion && (state.pendingQuestion.asker===name)) state.pendingQuestion=null;
      if(name===state.host) state.host=state.players[0]||null;
      socketNames.delete(ws); lastChatAt.delete(ws);
      if(!state.players.length) resetRoom();
      else { if(oldIndex>=0 && oldIndex<state.turnIndex) state.turnIndex--; state.turnIndex%=state.players.length; }
      broadcast(); return;
    }

    if(msg.type==='draw'){
      const requester=socketNames.get(ws);
      if(requester!==state.host) return sendError(ws,'Só quem criou a sala pode iniciar a partida.');
      if(state.players.length<2) return sendError(ws,'Precisa de pelo menos 2 jogadores.');
      if(!startRound(msg.categories)) return sendError(ws,'Escolha mais categorias — não há nomes suficientes.');
      broadcast(); return;
    }

    if(msg.type==='newRound'){
      const requester=socketNames.get(ws);
      if(requester!==state.host) return sendError(ws,'Só o líder da sala pode iniciar uma nova rodada.');
      if(state.players.length<2) return sendError(ws,'Precisa de pelo menos 2 jogadores.');
      if(state.phase!=='finished') return sendError(ws,'A rodada atual ainda não terminou.');
      if(!startRound(msg.categories)) return sendError(ws,'Escolha mais categorias — não há nomes suficientes.');
      broadcast(); return;
    }

    if(msg.type==='question'){
      const asker=socketNames.get(ws), question=String(msg.question||'').trim().slice(0,120);
      if(!asker || state.phase!=='playing') return;
      if(state.players[state.turnIndex]!==asker) return sendError(ws,'Não é seu turno.');
      if(state.pendingQuestion) return sendError(ws,'Aguarde a resposta antes de continuar.');
      if(!question) return sendError(ws,'Digite uma pergunta.');
      state.pendingQuestion={asker,question}; broadcast(); return;
    }

    if(msg.type==='guess'){
      const guesser=socketNames.get(ws);
      const guess=String(msg.guess||'').trim().slice(0,80);
      if(!guesser || state.phase!=='playing') return;
      if(state.players[state.turnIndex]!==guesser) return sendError(ws,'Não é seu turno.');
      if(state.pendingQuestion) return sendError(ws,'Aguarde a resposta da pergunta antes de tentar acertar.');
      if(state.usedGuess[guesser]) return sendError(ws,'Você já usou sua única tentativa nesta rodada.');
      if(!guess) return sendError(ws,'Digite o personagem que você acha que é.');

      const secret=state.assignments?.[guesser] || '';
      const correct=guessMatches(guess, secret);
      state.usedGuess[guesser]=true;
      if(correct){
        state.scores[guesser]=(state.scores[guesser]||0)+1;
        state.winner=guesser;
        state.phase='finished';
        broadcast();
        return;
      }

      // Errou: a tentativa não precisa de resposta de outro jogador.
      state.turnIndex=(state.turnIndex+1)%state.players.length;
      broadcast();
      return;
    }

    if(msg.type==='answer'){
      const responder=socketNames.get(ws); if(!responder) return;
      if(state.pendingQuestion){
        if(state.pendingQuestion.asker===responder) return sendError(ws,'Quem fez a pergunta não pode respondê-la.');
        if(msg.answer!=='yes'&&msg.answer!=='no') return;
        const q=state.pendingQuestion;
        state.questionHistory.push({asker:q.asker,responder,question:q.question,answer:msg.answer});
        state.pendingQuestion=null;
        if(msg.answer==='no') state.turnIndex=(state.turnIndex+1)%state.players.length;
        broadcast(); return;
      }
      return;
    }

    if(msg.type==='finishRoom'){
      const requester=socketNames.get(ws);
      if(requester!==state.host) return sendError(ws,'Só o líder da sala pode finalizar a partida.');
      finishRound();
      broadcast();
      return;
    }

    if(msg.type==='chat'){
      const name=socketNames.get(ws), text=String(msg.text||'').trim().slice(0,300), now=Date.now();
      if(!name||!text||!state.players.includes(name)) return;
      const last=lastChatAt.get(ws)||0; if(now-last<3000) return sendError(ws,'Aguarde 3 segundos antes de enviar outra mensagem.');
      lastChatAt.set(ws,now); state.chat.push({name,text,ts:now}); if(state.chat.length>100) state.chat=state.chat.slice(-100); broadcast(); return;
    }
  });

  ws.on('close',()=>{
    const name=socketNames.get(ws); if(!name) return;
    const oldIndex=state.players.indexOf(name);
    state.players=state.players.filter(p=>p!==name);
    if(state.assignments) delete state.assignments[name];
    if(state.pendingQuestion && (state.pendingQuestion.asker===name)) state.pendingQuestion=null;
    if(name===state.host) state.host=state.players[0]||null;
    socketNames.delete(ws); lastChatAt.delete(ws);
    if(!state.players.length) resetRoom();
    else { if(oldIndex>=0&&oldIndex<state.turnIndex) state.turnIndex--; state.turnIndex%=state.players.length; }
    broadcast();
  });
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log('Quem sou eu? rodando na porta '+PORT));
