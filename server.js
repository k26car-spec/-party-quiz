const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));
app.use(express.json());

let progressDebounce = null;
function broadcastProgress() {
  if (progressDebounce) return;
  progressDebounce = setTimeout(() => {
    progressDebounce = null;
    const answered = Object.values(state.players).filter(x => x.answer !== null).length;
    const total = Object.keys(state.players).length;
    io.emit('answer_progress', { answered, total });
  }, 300);
}

let state = {
  phase: 'lobby',
  questions: [],
  currentQ: -1,
  players: {},         // socketId -> { name, score, answer }
  startTime: null,
  duration: 20,
  timer: null,
  roster: {},          // { studentId: name }
};

function getLeaderboard(limit = 20) {
  return Object.values(state.players)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));
}

function buildSyncData() {
  const syncData = { phase: state.phase };
  if (state.phase === 'question' && state.currentQ >= 0) {
    const q = state.questions[state.currentQ];
    syncData.question = {
      index: state.currentQ,
      total: state.questions.length,
      text: q.text,
      options: q.options,
      duration: state.duration,
      startTime: state.startTime,
    };
  }
  return syncData;
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

  const fullRanking = getLeaderboard(999);
  const top10 = fullRanking.slice(0, 10);
  const total = fullRanking.length;

  io.emit('question_reveal', {
    correctIndex: q.correctIndex,
    explanation: q.explanation || '',
    leaderboard: top10,
    isLast: state.currentQ >= state.questions.length - 1,
  });

  // 傳個人排名給每位玩家
  Object.entries(state.players).forEach(([sid, player]) => {
    const rank = fullRanking.findIndex(p => p.name === player.name) + 1;
    io.to(sid).emit('your_rank', { rank, total });
  });
}

io.on('connection', (socket) => {
  // 新連線告知是否啟用名單模式
  if (Object.keys(state.roster).length > 0) {
    socket.emit('roster_active', true);
  }

  socket.on('player_join', ({ name, studentId }) => {
    const n = (name || '').trim().slice(0, 20);
    const sid = (studentId || '').trim();

    // 1. 相同名字 → 重連，恢復分數（名單模式也適用）
    const existing = Object.entries(state.players).find(([, p]) => p.name === n && n !== '');
    if (existing) {
      const [oldSid, playerData] = existing;
      delete state.players[oldSid];
      state.players[socket.id] = { ...playerData, answer: null };
      socket.emit('join_ok', { name: n, score: state.players[socket.id].score });
      broadcastPlayerCount();
      const syncData = buildSyncData();
      socket.emit('player_sync', syncData);
      return;
    }

    // 2. 新加入
    let resolvedName = '';
    const hasRoster = Object.keys(state.roster).length > 0;

    if (hasRoster) {
      if (!sid) { socket.emit('join_error', '請輸入學號或姓名'); return; }
      // 先用學號查，查不到再用姓名查
      resolvedName = state.roster[sid];
      if (!resolvedName) {
        const entry = Object.entries(state.roster).find(([, name]) => name === sid);
        if (entry) resolvedName = entry[1];
      }
      if (!resolvedName) { socket.emit('join_error', `「${sid}」不在名單中`); return; }
      const alreadyIn = Object.values(state.players).find(p => p.name === resolvedName);
      if (alreadyIn) { socket.emit('join_error', '此帳號已加入遊戲'); return; }
    } else {
      resolvedName = n;
      if (!resolvedName) return;
    }

    if (state.phase !== 'lobby') {
      socket.emit('join_error', '遊戲已開始，無法加入');
      return;
    }

    state.players[socket.id] = { name: resolvedName, score: 0, answer: null };
    socket.emit('join_ok', { name: resolvedName, score: 0 });
    broadcastPlayerCount();
    socket.emit('player_sync', buildSyncData());
  });

  socket.on('host_set_roster', (roster) => {
    state.roster = roster;
    const count = Object.keys(roster).length;
    socket.emit('roster_saved', count);
    io.emit('roster_active', count > 0);
  });

  socket.on('host_clear_roster', () => {
    state.roster = {};
    socket.emit('roster_saved', 0);
    io.emit('roster_active', false);
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

    broadcastProgress();

    const answered = Object.values(state.players).filter(x => x.answer !== null).length;
    const total = Object.keys(state.players).length;
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
    if (Object.keys(state.players).length === 0) return;
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
      io.emit('game_over', { leaderboard: getLeaderboard(6) });
    }
  });

  socket.on('host_reset', () => {
    if (state.timer) clearTimeout(state.timer);
    state.phase = 'lobby';
    state.currentQ = -1;
    state.startTime = null;
    state.timer = null;
    state.players = {};
    io.emit('game_reset');
    broadcastPlayerCount();
  });

  socket.on('host_sync', () => {
    socket.emit('host_state', {
      phase: state.phase,
      currentQ: state.currentQ,
      total: state.questions.length,
      playerCount: Object.keys(state.players).length,
      rosterCount: Object.keys(state.roster).length,
    });
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
