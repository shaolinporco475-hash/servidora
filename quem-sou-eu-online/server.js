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
let state = { players: [], assignments: null, phase: 'lobby' };

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

function broadcast() {
  const payload = JSON.stringify({ type: 'state', state });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(payload);
  });
}

function sendError(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message }));
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'state', state }));

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const name = String(msg.name || '').trim().slice(0, 24);
      if (!name) return sendError(ws, 'Digite um nome.');
      if (state.players.includes(name)) return sendError(ws, 'Já tem alguém com esse nome no grupo.');
      state.players.push(name);
      broadcast();
      return;
    }

    if (msg.type === 'leave') {
      const name = String(msg.name || '');
      state.players = state.players.filter(p => p !== name);
      if (state.assignments) delete state.assignments[name];
      broadcast();
      return;
    }

    if (msg.type === 'draw') {
      if (state.players.length < 3) return sendError(ws, 'Precisa de pelo menos 3 jogadores.');
      const cats = Array.isArray(msg.categories) && msg.categories.length
        ? msg.categories.filter(c => CATEGORY_POOLS[c])
        : Object.keys(CATEGORY_POOLS);
      const pool = cats.flatMap(c => CATEGORY_POOLS[c]);
      if (pool.length < state.players.length) return sendError(ws, 'Escolha mais categorias — não há nomes suficientes.');
      const names = shuffle(pool).slice(0, state.players.length);
      const assignments = {};
      state.players.forEach((p, i) => { assignments[p] = names[i]; });
      state.assignments = assignments;
      state.phase = 'revealed';
      broadcast();
      return;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Quem sou eu? rodando na porta ' + PORT));
