require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { TonClient, WalletContractV4, internal, toNano } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const client = new TonClient({
    endpoint: 'https://toncenter.com/api/v2/jsonRPC',
    apiKey: process.env.TON_API_KEY || ''
});

// TON ավտոմատ փոխանցման/վերադարձման ֆունկցիա
async function sendTonToWallet(toAddress, amountTon, comment = 'CryptoChess Payout') {
    try {
        if (!process.env.TREASURY_MNEMONIC) {
            console.log('⚠️ TREASURY_MNEMONIC-ը սահմանված չէ, բլոկչեյնով վճարումը բաց է թողնվում:');
            return false;
        }

        const mnemonic = process.env.TREASURY_MNEMONIC.split(' ');
        const key = await mnemonicToPrivateKey(mnemonic);

        const wallet = WalletContractV4.create({ workchain: 0, publicKey: key.publicKey });
        const walletContract = client.open(wallet);

        const seqno = await walletContract.getSeqno();
        
        console.log(`💸 Ուղարկվում է ${amountTon} TON հասցեին՝ ${toAddress} (${comment})...`);

        await walletContract.sendTransfer({
            seqno,
            secretKey: key.secretKey,
            messages: [
                internal({
                    to: toAddress,
                    value: toNano(amountTon.toString()),
                    bounce: false,
                    body: comment
                })
            ]
        });

        console.log('✅ Տրանզակցիան հաջողությամբ կատարվեց!');
        return true;
    } catch (error) {
        console.error('❌ Սխալ տրանզակցիայի ժամանակ:', error);
        return false;
    }
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/tonconnect-manifest.json', (req, res) => {
  res.json({
    "url": "https://cryptochess-kxfp.onrender.com",
    "name": "CryptoChess Blitz",
    "iconUrl": "https://cryptochess-kxfp.onrender.com/icon.png",
    "termsOfUseUrl": "https://cryptochess-kxfp.onrender.com",
    "privacyPolicyUrl": "https://cryptochess-kxfp.onrender.com"
  });
});

const db = new sqlite3.Database('./cryptochess.db', (err) => {
  if (err) console.error('DB Error:', err.message);
  else console.log('📦 Միացավ SQLite տվյալների բազային');
});

// Օգտատերերի աղյուսակ՝ ID-ով (սկսած 1000001-ից)
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet TEXT UNIQUE,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    draws INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.get(`SELECT seq FROM sqlite_sequence WHERE name = 'users'`, (err, row) => {
    if (!row) {
      db.run(`INSERT INTO sqlite_sequence(name, seq) VALUES('users', 1000000)`);
    }
  });
});

db.run(`CREATE TABLE IF NOT EXISTS games_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT,
  opponent TEXT,
  bet INTEGER,
  result TEXT,
  payout TEXT,
  played_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

let waitingPlayers = []; // { socketId, wallet, bet }
let activeGames = {};
let onlineCount = 0;

const GAME_TIME = 180; // 3 րոպե

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

  // Հերթագրում և հակառակորդի որոնում
  socket.on('joinQueue', (data) => {
    const bet = data.bet || 1;
    const wallet = data.wallet || socket.userWallet;
    
    if (!wallet) {
      socket.emit('errorMsg', 'Խնդրում ենք միացնել դրամապանակը:');
      return;
    }

    if (waitingPlayers.some(p => p.socketId === socket.id)) return;

    const opponentIndex = waitingPlayers.findIndex(p => p.bet === bet && p.socketId !== socket.id);

    if (opponentIndex !== -1) {
      const opponent = waitingPlayers.splice(opponentIndex, 1)[0];
      const gameId = 'game_' + Date.now();
      const chess = new Chess();
      const prizePool = bet * 2;

      activeGames[gameId] = { 
        id: gameId,
        chess: chess, 
        p1: { socketId: socket.id, wallet: wallet, bet: bet },    
        p2: opponent, 
        bet: bet, 
        prizePool: prizePool,
        time: { w: GAME_TIME, b: GAME_TIME },
        timerStarted: false,
        timerInterval: null,
        drawOfferedBy: null
      };

      io.to(socket.id).emit('gameStart', { gameId, color: 'w', opponent: opponent.wallet, prizePool, time: GAME_TIME });
      io.to(opponent.socketId).emit('gameStart', { gameId, color: 'b', opponent: wallet, prizePool, time: GAME_TIME });

    } else {
      const player = { socketId: socket.id, wallet: wallet, bet: bet };
      waitingPlayers.push(player);
      socket.emit('waiting', `Սպասում ենք մրցակցին (${bet} TON)...`);
    }
  });

  // Խաղացողը ինքնակամ չեղարկում է հերթը
  socket.on('cancelQueue', async () => {
    const index = waitingPlayers.findIndex(p => p.socketId === socket.id);
    if (index !== -1) {
      const player = waitingPlayers.splice(index, 1)[0];
      await sendTonToWallet(player.wallet, player.bet, 'CryptoChess Manual Refund');
      socket.emit('queueCancelled', { message: 'Հերթը չեղարկվեց, գումարը վերադարձվեց ձեր դրամապանակ:' });
    }
  });

  // Շախմատային քայլերի մշակում
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

  // Անջատման կառավարում (Anti-Cheat & Disconnect)
  socket.on('disconnect', async () => {
    onlineCount = Math.max(0, onlineCount - 1);
    broadcastStats();

    const index = waitingPlayers.findIndex(p => p.socketId === socket.id);
    if (index !== -1) {
      const player = waitingPlayers.splice(index, 1)[0];
      await sendTonToWallet(player.wallet, player.bet, 'CryptoChess Queue Disconnect Refund');
    }

    for (const gameId in activeGames) {
      const game = activeGames[gameId];
      if (game.p1.socketId === socket.id || game.p2.socketId === socket.id) {
        const isP1 = game.p1.socketId === socket.id;
        const winnerSocketId = isP1 ? game.p2.socketId : game.p1.socketId;
        const winnerWallet = isP1 ? game.p2.wallet : game.p1.wallet;

        console.log(`⚠️ Խաղացողը դուրս եկավ ակտիվ խաղից (${socket.id}). Հաղթանակը տրվում է մրցակցին:`);
        
        recordGameResult(game, winnerSocketId);
        endGame(gameId, 'disconnect', winnerWallet);
        break;
      }
    }

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
      [p1.wallet, p2.wallet, p1.bet, 'Ոչ-ոքի', '0.97 TON']);
    db.run(`INSERT INTO games_history (wallet, opponent, bet, result, payout) VALUES (?, ?, ?, ?, ?)`, 
      [p2.wallet, p1.wallet, p2.bet, 'Ոչ-ոքի', '0.97 TON']);
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
      if (game.timerInterval) clearInterval(game.timerInterval);
      return;
    }

    const currentTurn = typeof currentGame.chess.turn === 'function' ? currentGame.chess.turn() : currentGame.chess.turn;
    currentGame.time[currentTurn]--;

    io.to(currentGame.p1.socketId).emit('timeUpdate', currentGame.time);
    io.to(currentGame.p2.socketId).emit('timeUpdate', currentGame.time);

    if (currentGame.time[currentTurn] <= 0) {
      if (game.timerInterval) clearInterval(game.timerInterval);
      const winnerSocketId = currentTurn === 'w' ? currentGame.p2.socketId : currentGame.p1.socketId;

      recordGameResult(currentGame, winnerSocketId);
      endGame(gameId, 'timeout', currentTurn === 'w' ? currentGame.p2.wallet : currentGame.p1.wallet);
    }
  }, 1000);
}

async function endGame(gameId, reason, winnerWallet) {
  const game = activeGames[gameId];
  if (!game) return;

  if (game.timerInterval) {
    clearInterval(game.timerInterval);
    game.timerInterval = null;
  }

  if (reason === 'draw') {
    await sendTonToWallet(game.p1.wallet, 0.97, 'CryptoChess Draw Payout');
    await sendTonToWallet(game.p2.wallet, 0.97, 'CryptoChess Draw Payout');
  } else if (winnerWallet) {
    let payout = (game.prizePool * 0.9).toFixed(2);
    await sendTonToWallet(winnerWallet, payout, 'CryptoChess Prize Win');
  }

  io.to(game.p1.socketId).emit('gameOver', { result: reason, winner: winnerWallet });
  io.to(game.p2.socketId).emit('gameOver', { result: reason, winner: winnerWallet });

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