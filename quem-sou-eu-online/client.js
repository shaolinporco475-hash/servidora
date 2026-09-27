
const CATEGORY_POOLS_NAMES = ["Famosos","Filmes","Desenhos"];
let myName = localStorage.getItem('qse_myname') || '';
let sessionToken = localStorage.getItem('qse_session') || '';
let state = { players: [], assignments: null, phase: 'lobby', chat: [], questionHistory: [], scores: {}, host: null, winner: null, turnIndex: 0, pendingQuestion: null };
let ws = null;
let lastChatCount = 0;
let chatCooldownUntil = 0;

function escapeHtml(s){
  return s.replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function switchStage(id){
  document.querySelectorAll('.stage').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function renderCatToggles(){
  const c = document.getElementById('cat-toggles');
  c.innerHTML = '';
  CATEGORY_POOLS_NAMES.forEach(cat=>{
    const lab = document.createElement('label');
    const inp = document.createElement('input');
    inp.type='checkbox'; inp.value=cat; inp.checked=true;
    lab.appendChild(inp); lab.appendChild(document.createTextNode(cat));
    c.appendChild(lab);
  });
}
renderCatToggles();

function connect(){
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(proto + '//' + location.host + '/ws');
  ws = socket;
  joinSent = false;
  const badge = document.getElementById('mode-badge');
  const text = document.getElementById('mode-text');

  socket.onopen = ()=>{
    if (ws !== socket) return;
    badge.classList.add('on');
    text.textContent = 'Online — conectado ao servidor';
    if(myName && !joinSent) {
      joinSent = true;
      socket.send(JSON.stringify({ type:'join', name: myName, token: sessionToken }));
    }
  };
  socket.onclose = ()=>{
    if (ws !== socket) return;
    ws = null;
    joinSent = false;
    badge.classList.remove('on');
    text.textContent = 'Conexão perdida — tentando de novo…';
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  };
  socket.onerror = ()=>{
    if (ws === socket) text.textContent = 'Erro de conexão — tentando de novo…';
  };
  socket.onmessage = ev=>{
    if (ws !== socket) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if(msg.type === 'joined'){
      if(msg.name) myName = msg.name;
      if(msg.token){ sessionToken = msg.token; localStorage.setItem('qse_session', sessionToken); }
      joinSent = true;
      render();
    }
    if(msg.type === 'state'){ state = msg.state; render(); }
    if(msg.type === 'error'){
      showError(msg.message);
      // Se o token não for mais válido, permite uma nova entrada com um token novo.
      if(msg.message === 'Já tem alguém com esse nome no grupo.'){
        sessionToken = '';
        localStorage.removeItem('qse_session');
        joinSent = false;
      }
    }
  };
}
function showError(text){
  const j = document.getElementById('join-error');
  const l = document.getElementById('lobby-error');
  if(document.getElementById('stage-join').classList.contains('active')) j.textContent = text;
  else l.textContent = text;
}

function render(){
  if(!myName){
    switchStage('stage-join');
    document.getElementById('chat-panel').classList.remove('active');
    return;
  }
  document.getElementById('chat-panel').classList.remove('active');
  if(!state.players.includes(myName)){
    // fomos removidos (ou servidor reiniciou) — reentra
    if(ws && ws.readyState === 1) ws.send(JSON.stringify({ type:'join', name: myName, token: sessionToken }));
    switchStage('stage-join');
    return;
  }
  if((state.phase === 'playing' || state.phase === 'finished') && state.assignments){
    renderGame();
    renderChat();
    document.getElementById('chat-panel').classList.add('active');
    switchStage('stage-result');
  } else {
    const list = document.getElementById('lobby-players');
    list.innerHTML = '';
    state.players.forEach(p=>{
      const li = document.createElement('li');
      if(p === myName) li.classList.add('me');
      li.textContent = p + (p === myName ? ' (você)' : '');
      list.appendChild(li);
    });
    document.getElementById('draw-btn').disabled = state.players.length < 2 || state.host !== myName;
    document.getElementById('draw-btn').textContent = state.host === myName ? 'Começar partida' : 'Aguardando o líder';
    switchStage('stage-lobby');
  }
}

function renderGame(){
  const ranking = document.getElementById('ranking-list');
  ranking.innerHTML='';
  [...state.players].sort((a,b)=>(state.scores?.[b]||0)-(state.scores?.[a]||0)).forEach((p,i)=>{
    const li=document.createElement('li');
    const span=document.createElement('span'); span.textContent=(i+1)+'º '+p+(p===myName?' (você)':'');
    const b=document.createElement('b'); b.textContent=(state.scores?.[p]||0)+' ponto'+((state.scores?.[p]||0)===1?'':'s');
    li.append(span,b); ranking.appendChild(li);
  });

  const finished=state.phase==='finished';
  document.getElementById('finished-card').style.display=finished?'flex':'none';
  document.getElementById('finish-room-btn').style.display=state.host===myName?'block':'none';
  document.getElementById('host-note').textContent=state.host===myName?'Você é o líder. Só você pode finalizar a partida.':'';

  if(finished){
    const winner=state.winner||'—';
    document.getElementById('winner-name').textContent=winner;
    document.getElementById('winner-message').textContent=winner===myName?'Você acertou e ganhou 1 ponto.':winner+' acertou e ganhou 1 ponto.';
  }

  const turnName=state.players[state.turnIndex]||'—';
  document.getElementById('turn-name').textContent=turnName+(turnName===myName?' (seu turno)':'');

  const target=document.getElementById('target-input');
  target.innerHTML='';
  state.players.filter(p=>p!==myName).forEach(p=>{
    const o=document.createElement('option'); o.value=p; o.textContent=p; target.appendChild(o);
  });

  const isMyTurn=turnName===myName;
  const q=state.pendingQuestion;
  const isQResponder=q&&q.target===myName;
  const waiting=!!q;
  ['question-btn','target-input','question-input','guess-btn','guess-input'].forEach(id=>document.getElementById(id).disabled=finished||!isMyTurn||waiting);

  document.getElementById('question-card').style.display=finished||isQResponder?'none':'block';
  document.getElementById('guess-card').style.display=finished||isQResponder?'none':'block';

  const status=document.getElementById('question-status');
  const guessStatus=document.getElementById('guess-status');
  if(finished){
    status.textContent='A rodada terminou.';
    guessStatus.textContent='';
  } else if(q&&q.asker===myName){
    status.textContent='Pergunta enviada. Aguarde a resposta.';
    guessStatus.textContent='';
  } else if(waiting){
    status.textContent='É sua vez de responder.';
    guessStatus.textContent='';
  } else if(!isMyTurn){
    status.textContent='Aguarde seu turno.';
    guessStatus.textContent='';
  } else {
    status.textContent='Faça uma pergunta de SIM ou NÃO para descobrir seu personagem.';
    guessStatus.textContent='Se você errar a tentativa, o turno passa para o próximo.';
  }

  if(isQResponder){
    // A pergunta aparece somente para quem precisa responder.
    document.getElementById('answer-card').style.display='block';
  } else {
    document.getElementById('answer-card').style.display='none';
  }
  if(isQResponder){
    document.getElementById('answer-guesser').textContent=q.asker;
    document.getElementById('answer-guess').textContent=q.question;
  }

  const ul=document.getElementById('result-list'); ul.innerHTML='';
  state.players.filter(p=>p!==myName).forEach(p=>{
    const li=document.createElement('li');
    const b=document.createElement('b'); b.textContent=state.assignments?.[p]||'?';
    const span=document.createElement('span'); span.textContent=p;
    li.append(b,span); ul.appendChild(li);
  });

  const hist=document.getElementById('question-history'); hist.innerHTML='';
  const history=state.questionHistory||[];
  if(!history.length){
    const li=document.createElement('li'); li.className='status'; li.textContent='Você ainda não fez nenhuma pergunta.'; hist.appendChild(li);
  } else {
    history.forEach(item=>{
      const li=document.createElement('li');
      const qline=document.createElement('div'); qline.className='q'; qline.textContent=item.question;
      const aline=document.createElement('div'); aline.className='a'; aline.textContent=item.target+' respondeu '+(item.answer==='yes'?'SIM':'NÃO');
      li.append(qline,aline); hist.appendChild(li);
    });
  }
}
function renderChat(){
  const box = document.getElementById('chat-msgs');
  const chat = state.chat || [];
  if(!chat.length){
    box.innerHTML = '<p class="chat-empty">Nenhuma mensagem ainda.</p>';
  } else {
    box.innerHTML = chat.map(m=>{
      const mine = m.name === myName ? ' me' : '';
      return '<div class="chat-msg'+mine+'"><b>'+escapeHtml(m.name)+':</b> '+escapeHtml(m.text)+'</div>';
    }).join('');
  }
  if(chat.length !== lastChatCount){
    box.scrollTop = box.scrollHeight;
    lastChatCount = chat.length;
  }
}
function sendChat(){
  if(Date.now() < chatCooldownUntil) return;
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if(!text || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type:'chat', text }));
  input.value = '';
  chatCooldownUntil = Date.now() + 3000;
}
document.getElementById('chat-send').onclick = sendChat;
document.getElementById('chat-input').addEventListener('keydown', e=>{
  if(e.key === 'Enter'){ e.preventDefault(); sendChat(); }
});

document.getElementById('join-btn').onclick = ()=>{
  const v = document.getElementById('name-input').value.trim();
  document.getElementById('join-error').textContent = '';
  if(!v) { document.getElementById('join-error').textContent = 'Digite seu nome.'; return; }
  myName = v;
  localStorage.setItem('qse_myname', v);
  if(ws && ws.readyState === 1) ws.send(JSON.stringify({ type:'join', name: v, token: sessionToken }));
};
document.getElementById('name-input').addEventListener('keydown', e=>{
  if(e.key === 'Enter'){ e.preventDefault(); document.getElementById('join-btn').click(); }
});
document.getElementById('draw-btn').onclick = ()=>{
  document.getElementById('lobby-error').textContent = '';
  const cats = Array.from(document.querySelectorAll('#cat-toggles input:checked')).map(i=>i.value);
  ws.send(JSON.stringify({ type:'draw', categories: cats }));
};
document.getElementById('question-btn').onclick = ()=>{
  const target = document.getElementById('target-input').value;
  const question = document.getElementById('question-input').value.trim();
  if(!target || !question || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type:'question', target, question }));
  document.getElementById('question-input').value = '';
};
document.getElementById('guess-btn').onclick = ()=>{
  const guess = document.getElementById('guess-input').value.trim();
  if(!guess || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type:'guess', guess }));
  document.getElementById('guess-input').value = '';
};
document.getElementById('question-input').addEventListener('keydown', e=>{
  if(e.key === 'Enter'){ e.preventDefault(); document.getElementById('question-btn').click(); }
});
document.getElementById('guess-input').addEventListener('keydown', e=>{
  if(e.key === 'Enter'){ e.preventDefault(); document.getElementById('guess-btn').click(); }
});

document.getElementById('answer-yes').onclick = ()=>{ if(ws && ws.readyState===1) ws.send(JSON.stringify({type:'answer', answer:'yes'})); };
document.getElementById('answer-no').onclick = ()=>{ if(ws && ws.readyState===1) ws.send(JSON.stringify({type:'answer', answer:'no'})); };
document.getElementById('new-round-btn').onclick = ()=>{
  if(state.host !== myName) return;
  const cats = Array.from(document.querySelectorAll('#cat-toggles input:checked')).map(i=>i.value);
  if(ws && ws.readyState===1) ws.send(JSON.stringify({ type:'draw', categories: cats }));
};
document.getElementById('finish-room-btn').onclick = ()=>{
  if(state.host===myName && ws && ws.readyState===1) ws.send(JSON.stringify({type:'finishRoom'}));
};
function leave(){
  ws.send(JSON.stringify({ type:'leave', name: myName }));
  localStorage.removeItem('qse_myname');
  localStorage.removeItem('qse_session');
  myName = '';
  switchStage('stage-join');
}
document.getElementById('leave-btn').onclick = leave;
document.getElementById('leave-btn-2').onclick = leave;

connect();
