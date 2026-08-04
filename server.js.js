const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Ստատիկ ֆայլերի տրամադրում public թղթապանակից
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Հավելյալ ապահովում TON Connect-ի մանիֆեստի համար
app.get('/tonconnect-manifest.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tonconnect-manifest.json'));
});

const db = new sqlite3.Database('./cryptochess.db', (err) => {
  if (err) console.error('DB Error:', err.message);
  else console.log('📦 Միացավ SQLite տվյալների բազային');
});

db.run(`CREATE TABLE IF NOT EXISTS users (
  wallet TEXT PRIMARY KEY,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  draws INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.run(`CREATE TABLE IF NOT EXISTS games_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT,
  opponent TEXT,
  bet INTEGER,
  result TEXT,
  payout TEXT,
  played_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

let waitingPlayers = [];
let activeGames = {};
let onlineCount = 0;

const GAME_TIME = 180;

function broadcastStats() {
  db.get(`SELECT COUNT(*) as total FROM users`, (err, row) => {
    const totalUsers = row ? row.total : 0;
    io.emit('statsUpdate', { online: onlineCount, totalUsers: totalUsers });
  });
}

io.on('connection', (socket) => {
  onlineCount++;
  broadcastStats();
  console.log('🔗 Միացավ նոր խաղացող:', socket.id, '| Օնլայն՝', onlineCount);

  socket.on('registerUser', ({ wallet }) => {
    if (!wallet) return;
    socket.userWallet = wallet;

    db.run(`INSERT OR IGNORE INTO users (wallet) VALUES (?)`, [wallet], () => {
      broadcastStats();
      sendUserData(socket, wallet);
    });
  });

  socket.on('findMatch', (data) => {
    const bet = data.bet || 1;
    const wallet = data.wallet || socket.userWallet || ('PLAYER_' + socket.id.substring(0, 5));
    const player = { socketId: socket.id, wallet: wallet, bet: bet };
    
    const opponentIndex = waitingPlayers.findIndex(p => p.bet === bet && p.socketId !== socket.id);

    if (opponentIndex !== -1) {
      const opponent = waitingPlayers.splice(opponentIndex, 1)[0];
      const gameId = 'game_' + Date.now();
      const chess = new Chess();
      const prizePool = bet * 2;

      activeGames[gameId] = { 
        id: gameId,
        chess: chess, 
        p1: player,   
        p2: opponent, 
        bet: bet, 
        prizePool: prizePool,
        time: { w: GAME_TIME, b: GAME_TIME },
        timerStarted: false,
        timerInterval: null,
        drawOfferedBy: null
      };

      io.to(player.socketId).emit('gameStart', { gameId, color: 'w', opponent: opponent.wallet, prizePool, time: GAME_TIME });
      io.to(opponent.socketId).emit('gameStart', { gameId, color: 'b', opponent: player.wallet, prizePool, time: GAME_TIME });

    } else {
      waitingPlayers.push(player);
      socket.emit('waiting', `Սպասում ենք մրցակցին (${bet} TON)...`);
    }
  });

  socket.on('makeMove', ({ gameId, move }) => {
    const game = activeGames[gameId];
    if (!game) return;

    try {
      const validMove = game.chess.move(move);
      if (validMove) {
        if (!game.timerStarted) {
          game.timerStarted = true;
          startGameTimer(gameId);
        }

        game.drawOfferedBy = null;
        io.to(game.p1.socketId).emit('resetDrawUI');
        io.to(game.p2.socketId).emit('resetDrawUI');

        io.to(game.p1.socketId).emit('moveMade', { move, time: game.time, san: validMove.san });
        io.to(game.p2.socketId).emit('moveMade', { move, time: game.time, san: validMove.san });

        const c = game.chess;
        const isCheckmate = typeof c.isCheckmate === 'function' ? c.isCheckmate() : c.in_checkmate();
        const isStalemate = typeof c.isStalemate === 'function' ? c.isStalemate() : c.in_stalemate();
        const isThreefold = typeof c.isThreefoldRepetition === 'function' ? c.isThreefoldRepetition() : c.in_threefold_repetition();
        const isInsufficient = typeof c.isInsufficientMaterial === 'function' ? c.isInsufficientMaterial() : c.insufficient_material();
        const isDraw = typeof c.isDraw === 'function' ? c.isDraw() : c.in_draw();

        if (isCheckmate) {
          const currentTurn = typeof c.turn === 'function' ? c.turn() : c.turn;
          const winnerSocketId = currentTurn === 'w' ? game.p2.socketId : game.p1.socketId;
          const winnerWallet = currentTurn === 'w' ? game.p2.wallet : game.p1.wallet;

          recordGameResult(game, winnerSocketId);
          endGame(gameId, 'checkmate', winnerWallet);
        } else if (isStalemate || isThreefold || isInsufficient || isDraw) {
          recordGameResult(game, null);
          endGame(gameId, 'draw', null);
        }
      }
    } catch (err) {
      console.error("Քայլի սխալ:", err);
    }
  });

  socket.on('offerDraw', ({ gameId }) => {
    const game = activeGames[gameId];
    if (!game || game.drawOfferedBy) return;

    game.drawOfferedBy = socket.id;
    const opponentSocketId = socket.id === game.p1.socketId ? game.p2.socketId : game.p1.socketId;

    socket.emit('drawSent');
    io.to(opponentSocketId).emit('drawOffered');
  });

  socket.on('respondDraw', ({ gameId, accepted }) => {
    const game = activeGames[gameId];
    if (!game) return;

    if (accepted) {
      recordGameResult(game, null);
      endGame(gameId, 'draw', null);
    } else {
      game.drawOfferedBy = null;
      io.to(game.p1.socketId).emit('resetDrawUI');
      io.to(game.p2.socketId).emit('resetDrawUI');
      io.to(game.p1.socketId).emit('drawDeclined');
      io.to(game.p2.socketId).emit('drawDeclined');
    }
  });

  socket.on('resign', ({ gameId }) => {
    const game = activeGames[gameId];
    if (!game) return;
    const winnerSocketId = socket.id === game.p1.socketId ? game.p2.socketId : game.p1.socketId;
    const winnerWallet = socket.id === game.p1.socketId ? game.p2.wallet : game.p1.wallet;

    recordGameResult(game, winnerSocketId);
    endGame(gameId, 'resign', winnerWallet);
  });

  socket.on('disconnect', () => {
    onlineCount = Math.max(0, onlineCount - 1);
    broadcastStats();
    waitingPlayers = waitingPlayers.filter(p => p.socketId !== socket.id);
    console.log('❌ Խաղացողը դուրս եկավ:', socket.id, '| Օնլայն՝', onlineCount);
  });
});

function sendUserData(socket, wallet) {
  db.get(`SELECT * FROM users WHERE wallet = ?`, [wallet], (err, userRow) => {
    if (!userRow) return;
    db.all(`SELECT * FROM games_history WHERE wallet = ? ORDER BY id DESC LIMIT 10`, [wallet], (err, historyRows) => {
      socket.emit('userStats', { user: userRow, history: historyRows || [] });
    });
  });
}

function recordGameResult(game, winnerSocketId) {
  const p1 = game.p1;
  const p2 = game.p2;

  const p1Won = winnerSocketId === p1.socketId;
  const isDraw = !winnerSocketId;

  if (isDraw) {
    db.run(`UPDATE users SET draws = draws + 1 WHERE wallet = ?`, [p1.wallet]);
    db.run(`UPDATE users SET draws = draws + 1 WHERE wallet = ?`, [p2.wallet]);

    db.run(`INSERT INTO games_history (wallet, opponent, bet, result, payout) VALUES (?, ?, ?, ?, ?)`, 
      [p1.wallet, p2.wallet, p1.bet, 'Ոչ-ոքի', p1.bet + ' TON']);
    db.run(`INSERT INTO games_history (wallet, opponent, bet, result, payout) VALUES (?, ?, ?, ?, ?)`, 
      [p2.wallet, p1.wallet, p2.bet, 'Ոչ-ոքի', p2.bet + ' TON']);
  } else {
    const winnerWallet = p1Won ? p1.wallet : p2.wallet;
    const loserWallet = p1Won ? p2.wallet : p1.wallet;
    const payout = (game.prizePool * 0.9).toFixed(2);

    db.run(`UPDATE users SET wins = wins + 1 WHERE wallet = ?`, [winnerWallet]);
    db.run(`UPDATE users SET losses = losses + 1 WHERE wallet = ?`, [loserWallet]);

    db.run(`INSERT INTO games_history (wallet, opponent, bet, result, payout) VALUES (?, ?, ?, ?, ?)`, 
      [winnerWallet, loserWallet, game.bet, 'Հաղթանակ', '+' + payout + ' TON']);
    db.run(`INSERT INTO games_history (wallet, opponent, bet, result, payout) VALUES (?, ?, ?, ?, ?)`, 
      [loserWallet, winnerWallet, game.bet, 'Պարտություն', '-' + game.bet + ' TON']);
  }
}

function startGameTimer(gameId) {
  const game = activeGames[gameId];
  if (!game) return;

  if (game.timerInterval) clearInterval(game.timerInterval);

  game.timerInterval = setInterval(() => {
    const currentGame = activeGames[gameId];
    if (!currentGame) {
      clearInterval(game.timerInterval);
      return;
    }

    const currentTurn = typeof currentGame.chess.turn === 'function' ? currentGame.chess.turn() : currentGame.chess.turn;
    currentGame.time[currentTurn]--;

    io.to(currentGame.p1.socketId).emit('timeUpdate', currentGame.time);
    io.to(currentGame.p2.socketId).emit('timeUpdate', currentGame.time);

    if (currentGame.time[currentTurn] <= 0) {
      clearInterval(game.timerInterval);
      const winnerSocketId = currentTurn === 'w' ? currentGame.p2.socketId : currentGame.p1.socketId;

      recordGameResult(currentGame, winnerSocketId);
      endGame(gameId, 'timeout', currentTurn === 'w' ? currentGame.p2.wallet : currentGame.p1.wallet);
    }
  }, 1000);
}

function endGame(gameId, reason, winnerWallet) {
  const game = activeGames[gameId];
  if (!game) return;

  if (game.timerInterval) clearInterval(game.timerInterval);

  let payout = (reason === 'draw') ? game.bet : (game.prizePool * 0.9).toFixed(2);

  io.to(game.p1.socketId).emit('gameOver', { result: reason, winner: winnerWallet, payout });
  io.to(game.p2.socketId).emit('gameOver', { result: reason, winner: winnerWallet, payout });

  const s1 = io.sockets.sockets.get(game.p1.socketId);
  const s2 = io.sockets.sockets.get(game.p2.socketId);
  if (s1) sendUserData(s1, game.p1.wallet);
  if (s2) sendUserData(s2, game.p2.wallet);

  delete activeGames[gameId];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 CryptoChess Blitz սերվերը աշխատում է http://localhost:${PORT}`);
});