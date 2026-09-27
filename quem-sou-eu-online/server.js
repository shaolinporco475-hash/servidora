const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const CATEGORY_POOLS = {
  "Famosos": ["Beyoncé","Michael Jackson","Cristiano Ronaldo","Pelé","Einstein","Frida Kahlo","Ayrton Senna","Anitta","Neymar","Oprah Winfrey","Elvis Presley","Cleópatra"],
  "Filmes": ["Shrek","Darth Vader","Homem-Aranha","Mulher-Maravilha","Woody","Indiana Jones","Harry Potter","Jack Sparrow","Homem de Ferro","Yoda","E.T.","Batman"],
  "Desenhos": ["Bob Esponja","Mickey Mouse","Pernalonga","Pica-Pau","Scooby-Doo","Pikachu","Naruto","Goku","Dora Aventureira","Peppa Pig","Tom e Jerry","Wandinha Addams"]
};

// Estado único, compartilhado por todo mundo que abrir o link (sempre o mesmo grupo).
let state = { players: [], assignments: null, phase: 'lobby', chat: [], turnIndex: 0, pendingQuestion: null, pendingGuess: null, scores: {}, winner: null };
const socketNames = new Map();
const lastChatAt = new Map();

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sendState(ws) {
  if (ws.readyState !== 1) return;
  const name = socketNames.get(ws);
  const publicState = { ...state, assignments: {} };
  if (state.assignments) {
    Object.entries(state.assignments).forEach(([player, secret]) => {
      if (player !== name) publicState.assignments[player] = secret;
    });
  }
  publicState.mySecret = name && state.assignments ? (state.assignments[name] || null) : null;
  if (state.pendingQuestion) {
    publicState.pendingQuestion = { ...state.pendingQuestion };
    if (state.pendingQuestion.target !== name) publicState.pendingQuestion.question = null;
  }
  if (state.pendingGuess) {
    publicState.pendingGuess = { ...state.pendingGuess };
    if (state.pendingGuess.target !== name) publicState.pendingGuess.guess = null;
  }
  ws.send(JSON.stringify({ type: 'state', state: publicState }));
}

function broadcast() {
  wss.clients.forEach(client => sendState(client));
}

function sendError(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message }));
}

wss.on('connection', ws => {
  sendState(ws);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const name = String(msg.name || '').trim().slice(0, 24);
      if (!name) return sendError(ws, 'Digite um nome.');
      if (socketNames.has(ws)) return sendError(ws, 'Você já está conectado.');
      if (state.players.includes(name)) return sendError(ws, 'Já tem alguém com esse nome no grupo.');
      socketNames.set(ws, name);
      state.players.push(name);
      state.scores[name] = state.scores[name] || 0;
      broadcast();
      return;
    }

    if (msg.type === 'leave') {
      const name = socketNames.get(ws);
      if (!name) return;
      const oldIndex = state.players.indexOf(name);
      state.players = state.players.filter(p => p !== name);
      if (state.assignments) delete state.assignments[name];
      if (state.pendingQuestion && (state.pendingQuestion.asker === name || state.pendingQuestion.target === name)) state.pendingQuestion = null;
      if (state.pendingGuess && (state.pendingGuess.guesser === name || state.pendingGuess.target === name)) state.pendingGuess = null;
      if (state.players.length === 0) { state.phase = 'lobby'; state.assignments = null; state.turnIndex = 0; state.pendingGuess = null; state.winner = null; state.scores = {}; }
      else if (oldIndex >= 0 && oldIndex < state.turnIndex) state.turnIndex--;
      if (state.players.length) state.turnIndex = state.turnIndex % state.players.length;
      socketNames.delete(ws);
      broadcast();
      return;
    }

    if (msg.type === 'draw') {
      if (state.players.length < 2) return sendError(ws, 'Precisa de pelo menos 2 jogadores.');
      const cats = Array.isArray(msg.categories) && msg.categories.length
        ? msg.categories.filter(c => CATEGORY_POOLS[c])
        : Object.keys(CATEGORY_POOLS);
      const pool = cats.flatMap(c => CATEGORY_POOLS[c]);
      if (pool.length < state.players.length) return sendError(ws, 'Escolha mais categorias — não há nomes suficientes.');
      const names = shuffle(pool).slice(0, state.players.length);
      const assignments = {};
      state.players.forEach((p, i) => { assignments[p] = names[i]; });
      state.assignments = assignments;
      state.phase = 'playing';
      state.turnIndex = 0;
      state.pendingQuestion = null;
      state.pendingGuess = null;
      state.winner = null;
      state.players.forEach(p => { state.scores[p] = state.scores[p] || 0; });
      broadcast();
      return;
    }
    if (msg.type === 'question') {
      const asker = socketNames.get(ws);
      const target = String(msg.target || '').trim();
      const question = String(msg.question || '').trim().slice(0, 120);
      if (!asker || state.phase !== 'playing') return;
      if (state.players[state.turnIndex] !== asker) return sendError(ws, 'Não é seu turno.');
      if (state.pendingQuestion || state.pendingGuess) return sendError(ws, 'Aguarde a resposta antes de continuar.');
      if (!target || target === asker || !state.players.includes(target)) return sendError(ws, 'Escolha um jogador válido.');
      if (!question) return sendError(ws, 'Digite uma pergunta.');
      state.pendingQuestion = { asker, target, question };
      broadcast();
      return;
    }

    if (msg.type === 'guess') {
      const guesser = socketNames.get(ws);
      const target = String(msg.target || '').trim();
      const guess = String(msg.guess || '').trim().slice(0, 80);
      if (!guesser || state.phase !== 'playing') return;
      if (state.players[state.turnIndex] !== guesser) return sendError(ws, 'Não é seu turno.');
      if (state.pendingQuestion || state.pendingGuess) return sendError(ws, 'Aguarde a resposta antes de continuar.');
      if (!target || target === guesser || !state.players.includes(target)) return sendError(ws, 'Escolha um jogador válido.');
      if (!guess) return sendError(ws, 'Digite o nome que você acha que é.');
      state.pendingGuess = { guesser, target, guess };
      broadcast();
      return;
    }

    if (msg.type === 'answer') {
      const responder = socketNames.get(ws);
      if (!responder) return;

      if (state.pendingQuestion) {
        if (state.pendingQuestion.target !== responder) return sendError(ws, 'Só o jogador escolhido pode responder.');
        if (msg.answer !== 'yes' && msg.answer !== 'no') return;
        state.pendingQuestion = null;
        if (msg.answer === 'no') state.turnIndex = (state.turnIndex + 1) % state.players.length;
        broadcast();
        return;
      }

      if (!state.pendingGuess) return;
      if (state.pendingGuess.target !== responder) return sendError(ws, 'Só o jogador escolhido pode responder.');
      if (msg.answer !== 'yes' && msg.answer !== 'no') return;
      const pending = state.pendingGuess;
      state.pendingGuess = null;
      if (msg.answer === 'yes') {
        const secret = state.assignments?.[responder];
        if (pending.guess.toLocaleLowerCase('pt-BR') === String(secret || '').toLocaleLowerCase('pt-BR')) {
          state.scores[pending.guesser] = (state.scores[pending.guesser] || 0) + 1;
          state.winner = pending.guesser;
          state.phase = 'finished';
          broadcast();
          return;
        }
        broadcast();
        return;
      }
      state.turnIndex = (state.turnIndex + 1) % state.players.length;
      broadcast();
      return;
    }

    if (msg.type === 'chat') {
      const name = socketNames.get(ws);
      const text = String(msg.text || '').trim().slice(0, 300);
      const now = Date.now();
      if (!name || !text || !state.players.includes(name)) return;
      const last = lastChatAt.get(ws) || 0;
      if (now - last < 3000) return sendError(ws, 'Aguarde 3 segundos antes de enviar outra mensagem.');
      lastChatAt.set(ws, now);
      state.chat.push({ name, text, ts: now });
      if (state.chat.length > 100) state.chat = state.chat.slice(-100);
      broadcast();
      return;
    }
  });

  ws.on('close', () => {
    const name = socketNames.get(ws);
    if (!name) return;
    const oldIndex = state.players.indexOf(name);
    state.players = state.players.filter(p => p !== name);
    if (state.assignments) delete state.assignments[name];
    if (state.pendingQuestion && (state.pendingQuestion.asker === name || state.pendingQuestion.target === name)) state.pendingQuestion = null;
      if (state.pendingGuess && (state.pendingGuess.guesser === name || state.pendingGuess.target === name)) state.pendingGuess = null;
    socketNames.delete(ws);
    lastChatAt.delete(ws);
    if (!state.players.length) { state.phase = 'lobby'; state.assignments = null; state.turnIndex = 0; state.pendingQuestion = null; state.pendingGuess = null; }
    else { if (oldIndex >= 0 && oldIndex < state.turnIndex) state.turnIndex--; state.turnIndex %= state.players.length; }
    broadcast();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Quem sou eu? rodando na porta ' + PORT));
