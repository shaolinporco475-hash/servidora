# Quem sou eu? — versão online

Servidor Node (Express + WebSocket) que sincroniza o jogo entre aparelhos diferentes, em tempo real, para o mesmo grupo fixo de amigos.

## Rodar local (opcional, pra testar)
```
npm install
npm start
```
Depois abra `http://localhost:3000` em algumas abas pra simular vários jogadores.

## Subir no Render
1. Suba esta pasta inteira num repositório do GitHub.
2. No painel do Render: **New +** → **Web Service** (não "Static Site" — esse aqui precisa rodar um servidor).
3. Conecte o repositório.
4. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free está ok.
5. Clique em **Create Web Service**. Em alguns minutos o Render te dá uma URL pública — é esse link que todo mundo abre.

## Sobre o plano gratuito do Render
- O servidor "dorme" depois de um tempo sem uso e demora uns 30s pra acordar na primeira visita — normal, só esperar.
- O estado do jogo (quem entrou, quem é quem) fica na memória do servidor: se ele reiniciar, o grupo esvazia e é só entrar de novo com os mesmos nomes.
