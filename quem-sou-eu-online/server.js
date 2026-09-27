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
  pendingQuestion: null, pendingGuess: null, questionHistory: [], scores: {}, winner: null,
  host: null
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
function resetRoom() {
  state = { players: [], assignments: null, phase: 'lobby', chat: [], turnIndex: 0, pendingQuestion: null, pendingGuess: null, questionHistory: [], scores: {}, winner: null, host: null };
}
function sendState(ws) {
  if (ws.readyState !== 1) return;
  const name = socketNames.get(ws);
  const publicState = { ...state, assignments: {} };
  if (state.assignments) for (const [player, secret] of Object.entries(state.assignments)) if (player !== name) publicState.assignments[player] = secret;
  publicState.mySecret = name && state.assignments ? (state.assignments[name] || null) : null;
  if (state.pendingQuestion) {
    publicState.pendingQuestion = { ...state.pendingQuestion };
    if (state.pendingQuestion.target !== name) publicState.pendingQuestion.question = null;
  }
  if (state.pendingGuess) {
    publicState.pendingGuess = { ...state.pendingGuess };
    if (state.pendingGuess.target !== name) publicState.pendingGuess.guess = null;
  }
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
  state.phase='playing'; state.turnIndex=0; state.pendingQuestion=null; state.pendingGuess=null; state.questionHistory=[]; state.winner=null;
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
      if(state.pendingQuestion && (state.pendingQuestion.asker===name || state.pendingQuestion.target===name)) state.pendingQuestion=null;
      if(state.pendingGuess && (state.pendingGuess.guesser===name || state.pendingGuess.target===name)) state.pendingGuess=null;
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

    if(msg.type==='question'){
      const asker=socketNames.get(ws), target=String(msg.target||'').trim(), question=String(msg.question||'').trim().slice(0,120);
      if(!asker || state.phase!=='playing') return;
      if(state.players[state.turnIndex]!==asker) return sendError(ws,'Não é seu turno.');
      if(state.pendingQuestion||state.pendingGuess) return sendError(ws,'Aguarde a resposta antes de continuar.');
      if(!target||target===asker||!state.players.includes(target)) return sendError(ws,'Escolha um jogador válido.');
      if(!question) return sendError(ws,'Digite uma pergunta.');
      state.pendingQuestion={asker,target,question}; broadcast(); return;
    }

    if(msg.type==='guess'){
      const guesser=socketNames.get(ws), target=String(msg.target||'').trim(), guess=String(msg.guess||'').trim().slice(0,80);
      if(!guesser || state.phase!=='playing') return;
      if(state.players[state.turnIndex]!==guesser) return sendError(ws,'Não é seu turno.');
      if(state.pendingQuestion||state.pendingGuess) return sendError(ws,'Aguarde a resposta antes de continuar.');
      if(!target||target===guesser||!state.players.includes(target)) return sendError(ws,'Escolha um jogador válido.');
      if(!guess) return sendError(ws,'Digite o nome que você acha que é.');
      state.pendingGuess={guesser,target,guess}; broadcast(); return;
    }

    if(msg.type==='answer'){
      const responder=socketNames.get(ws); if(!responder) return;
      if(state.pendingQuestion){
        if(state.pendingQuestion.target!==responder) return sendError(ws,'Só o jogador escolhido pode responder.');
        if(msg.answer!=='yes'&&msg.answer!=='no') return;
        const q=state.pendingQuestion;
        state.questionHistory.push({asker:q.asker,target:q.target,question:q.question,answer:msg.answer});
        state.pendingQuestion=null;
        if(msg.answer==='no') state.turnIndex=(state.turnIndex+1)%state.players.length;
        broadcast(); return;
      }
      if(!state.pendingGuess) return;
      if(state.pendingGuess.target!==responder) return sendError(ws,'Só o jogador escolhido pode responder.');
      if(msg.answer!=='yes'&&msg.answer!=='no') return;
      const pending=state.pendingGuess; state.pendingGuess=null;
      if(msg.answer==='yes'){
        const secret=state.assignments?.[responder];
        if(pending.guess.localeCompare(String(secret||''),'pt-BR',{sensitivity:'base'})===0){
          state.scores[pending.guesser]=(state.scores[pending.guesser]||0)+1;
          state.winner=pending.guesser; state.phase='finished'; broadcast(); return;
        }
      }
      if(msg.answer==='no') state.turnIndex=(state.turnIndex+1)%state.players.length;
      broadcast(); return;
    }

    if(msg.type==='finishRoom'){
      const requester=socketNames.get(ws);
      if(requester!==state.host) return sendError(ws,'Só quem criou a sala pode finalizar.');
      wss.clients.forEach(client=>{ if(client.readyState===1) client.send(JSON.stringify({type:'room_reset'})); });
      resetRoom(); broadcast(); return;
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
    if(state.pendingQuestion && (state.pendingQuestion.asker===name||state.pendingQuestion.target===name)) state.pendingQuestion=null;
    if(state.pendingGuess && (state.pendingGuess.guesser===name||state.pendingGuess.target===name)) state.pendingGuess=null;
    if(name===state.host) state.host=state.players[0]||null;
    socketNames.delete(ws); lastChatAt.delete(ws);
    if(!state.players.length) resetRoom();
    else { if(oldIndex>=0&&oldIndex<state.turnIndex) state.turnIndex--; state.turnIndex%=state.players.length; }
    broadcast();
  });
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log('Quem sou eu? rodando na porta '+PORT));
