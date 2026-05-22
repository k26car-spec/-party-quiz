const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let state = {
  phase: 'lobby',      // lobby | starting | question | reveal | leaderboard | finished
  questions: [],
  currentQ: -1,
  players: {},         // socketId -> { name, score, answer }
  startTime: null,
  duration: 20,
  timer: null,
};

function getLeaderboard(limit = 20) {
  return Object.values(state.players)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));
}

function broadcastPlayerCount() {
  io.emit('player_count', Object.keys(state.players).length);
}

function sendQuestion() {
  const q = state.questions[state.currentQ];
  state.phase = 'question';
  state.startTime = Date.now();
  Object.values(state.players).forEach(p => { p.answer = null; });

  io.emit('question_start', {
    index: state.currentQ,
    total: state.questions.length,
    text: q.text,
    options: q.options,
    duration: state.duration,
    startTime: state.startTime,
  });

  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(revealAnswer, state.duration * 1000);
}

function revealAnswer() {
  if (state.phase !== 'question') return;
  if (state.timer) clearTimeout(state.timer);
  const q = state.questions[state.currentQ];
  state.phase = 'reveal';
  io.emit('question_reveal', {
    correctIndex: q.correctIndex,
    leaderboard: getLeaderboard(),
    isLast: state.currentQ >= state.questions.length - 1,
  });
}

io.on('connection', (socket) => {
  socket.on('player_join', ({ name }) => {
    if (state.phase !== 'lobby') {
      socket.emit('join_error', '遊戲已開始，無法加入');
      return;
    }
    const n = (name || '').trim().slice(0, 20);
    if (!n) return;
    state.players[socket.id] = { name: n, score: 0, answer: null };
    socket.emit('join_ok', { name: n });
    broadcastPlayerCount();
  });

  socket.on('submit_answer', ({ answerIndex }) => {
    const p = state.players[socket.id];
    if (!p || state.phase !== 'question' || p.answer !== null) return;

    const elapsed = (Date.now() - state.startTime) / 1000;
    const q = state.questions[state.currentQ];
    const isCorrect = answerIndex === q.correctIndex;
    let points = 0;

    if (isCorrect) {
      const ratio = Math.max(0, (state.duration - elapsed) / state.duration);
      points = 1000 + Math.floor(ratio * 500);
    }

    p.answer = answerIndex;
    p.score += points;
    socket.emit('answer_result', { isCorrect, points, score: p.score });

    const answered = Object.values(state.players).filter(x => x.answer !== null).length;
    const total = Object.keys(state.players).length;
    io.emit('answer_progress', { answered, total });

    if (answered >= total) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(revealAnswer, 1500);
    }
  });

  socket.on('host_set_questions', (questions) => {
    state.questions = questions;
    socket.emit('questions_saved', questions.length);
  });

  socket.on('host_start', () => {
    if (state.questions.length === 0) return;
    Object.values(state.players).forEach(p => { p.score = 0; p.answer = null; });
    state.phase = 'starting';
    state.currentQ = 0;
    io.emit('game_starting', { countdown: 3 });
    setTimeout(sendQuestion, 3000);
  });

  socket.on('host_next', () => {
    if (state.phase !== 'reveal') return;
    if (state.currentQ < state.questions.length - 1) {
      state.currentQ++;
      sendQuestion();
    } else {
      state.phase = 'finished';
      io.emit('game_over', { leaderboard: getLeaderboard() });
    }
  });

  socket.on('host_reset', () => {
    if (state.timer) clearTimeout(state.timer);
    state.phase = 'lobby';
    state.currentQ = -1;
    state.startTime = null;
    state.timer = null;
    Object.values(state.players).forEach(p => { p.score = 0; p.answer = null; });
    io.emit('game_reset');
    broadcastPlayerCount();
  });

  socket.on('join_screen', () => {
    socket.join('screen');
    socket.emit('screen_state', {
      phase: state.phase,
      playerCount: Object.keys(state.players).length,
    });
  });

  socket.on('disconnect', () => {
    if (state.players[socket.id]) {
      delete state.players[socket.id];
      broadcastPlayerCount();
    }
  });
});

app.get('/api/qrcode', async (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const url = `${proto}://${host}/`;
  try {
    const qr = await QRCode.toDataURL(url, { width: 256, margin: 2 });
    res.json({ qr, url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Party Quiz on port ${PORT}`));
