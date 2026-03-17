import { WebSocketServer } from 'ws';
import http from 'http';

const PORT = 8000;

// Room storage (in-memory)
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function broadcastToRoom(roomCode, message, excludeWs = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const data = JSON.stringify(message);
  room.players.forEach((player) => {
    if (player.ws !== excludeWs && player.ws.readyState === 1) {
      player.ws.send(data);
    }
  });
}

function sendToRoom(roomCode, message) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const data = JSON.stringify(message);
  room.players.forEach((player) => {
    if (player.ws.readyState === 1) {
      player.ws.send(data);
    }
  });
}

function getPlayerList(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return [];
  return room.players.map((p) => ({
    id: p.id,
    name: p.name,
    guesses: p.guesses,
    solved: p.solved,
    failed: p.failed,
    score: p.score || 0,
    totalScore: p.totalScore || 0,
    roundScore: p.roundScore || 0,
  }));
}

function calculateRoundScore(player) {
  if (player.solved) {
    // Base score for solving: 100, bonus for fewer guesses
    return Math.max(10, 100 - (player.guesses - 1) * 15);
  }
  return 0;
}

function cleanupRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (room.players.length === 0) {
    rooms.delete(roomCode);
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
});

const wss = new WebSocketServer({ server });

let nextPlayerId = 1;

wss.on('connection', (ws) => {
  ws.joined = false;

  const playerId = `player_${nextPlayerId++}`;
  let currentRoom = null;
  let playerName = '';

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'create_room': {
        const code = generateRoomCode();
        playerName = msg.name || `Játékos ${nextPlayerId}`;
        const maxRounds = msg.maxRounds || 5;
        const room = {
          code,
          word: msg.word,
          players: [
            {
              id: playerId,
              name: playerName,
              ws,
              guesses: 0,
              solved: false,
              failed: false,
              score: 0,
              totalScore: 0,
              roundScore: 0,
            },
          ],
          started: false,
          winner: null,
          round: 1,
          maxRounds,
          createdAt: Date.now(),
        };
        rooms.set(code, room);
        currentRoom = code;
        ws.joined = true;

        ws.send(
          JSON.stringify({
            type: 'room_created',
            roomCode: code,
            playerId,
            players: getPlayerList(code),
          })
        );
        break;
      }

      case 'join_room': {
        const code = msg.roomCode?.toUpperCase();
        const room = rooms.get(code);

        if (ws.joined) {
          ws.send(
            JSON.stringify({
              type: 'error',
              message: 'Már csatlakoztál a szobához!',
            })
          );
          return;
        }

        if (!room) {
          ws.send(
            JSON.stringify({
              type: 'error',
              message: 'A szoba nem található!',
            })
          );
          return;
        }
        if (room.players.length >= 8) {
          ws.send(
            JSON.stringify({
              type: 'error',
              message: 'A szoba megtelt! (max 8 játékos)',
            })
          );
          return;
        }

        playerName = msg.name || `Játékos ${nextPlayerId}`;
        room.players.push({
          id: playerId,
          name: playerName,
          ws,
          guesses: 0,
          solved: false,
          failed: false,
          score: 0,
          totalScore: 0,
          roundScore: 0,
        });
        currentRoom = code;
        ws.joined = true;

        ws.send(
          JSON.stringify({
            type: 'room_joined',
            roomCode: code,
            playerId,
            word: room.started ? room.word : null,
            players: getPlayerList(code),
            started: room.started,
            round: room.round || 1,
            maxRounds: room.maxRounds || 5,
          })
        );

        broadcastToRoom(
          code,
          {
            type: 'players_update',
            players: getPlayerList(code),
            playerName,
          },
          ws
        );
        break;
      }

      case 'start_game': {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        room.started = true;
        room.round = 1;

        // Reset all players for the first round
        room.players.forEach((p) => {
          p.guesses = 0;
          p.solved = false;
          p.failed = false;
          p.score = 0;
          p.totalScore = 0;
          p.roundScore = 0;
        });

        sendToRoom(currentRoom, {
          type: 'game_started',
          word: room.word,
          players: getPlayerList(currentRoom),
          round: room.round,
          maxRounds: room.maxRounds,
        });
        break;
      }

      case 'guess': {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;

        const player = room.players.find((p) => p.id === playerId);
        if (!player) return;

        player.guesses = msg.guessCount;
        player.solved = msg.solved || false;
        player.failed = msg.failed || false;

        // Calculate round score when player finishes
        if (player.solved || player.failed) {
          player.roundScore = calculateRoundScore(player);
          player.score = player.roundScore;
          player.totalScore = (player.totalScore || 0) + player.roundScore;
        }

        // Broadcast updated player list to everyone
        sendToRoom(currentRoom, {
          type: 'player_update',
          players: getPlayerList(currentRoom),
        });

        // Check if all players are done
        const allDone = room.players.every((p) => p.solved || p.failed);
        if (allDone) {
          // Find the winner of this round (highest round score)
          let bestPlayer = null;
          let bestScore = -1;
          room.players.forEach((p) => {
            if (p.roundScore > bestScore) {
              bestScore = p.roundScore;
              bestPlayer = p;
            }
          });

          sendToRoom(currentRoom, {
            type: 'game_over',
            winnerId: bestPlayer && bestPlayer.roundScore > 0 ? bestPlayer.id : null,
            winnerName: bestPlayer && bestPlayer.roundScore > 0 ? bestPlayer.name : null,
            players: getPlayerList(currentRoom),
            round: room.round,
            maxRounds: room.maxRounds,
          });
        }
        break;
      }

      case 'next_round': {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;

        // Increment round
        room.round = (room.round || 1) + 1;
        room.word = msg.word;
        room.winner = null;

        // Reset player round state but keep totalScore
        room.players.forEach((p) => {
          p.guesses = 0;
          p.solved = false;
          p.failed = false;
          p.roundScore = 0;
          p.score = 0;
        });

        // Check if game is completely over (all rounds played)
        if (room.round > (room.maxRounds || 5)) {
          // Find overall winner by totalScore
          let bestPlayer = null;
          let bestTotal = -1;
          room.players.forEach((p) => {
            if (p.totalScore > bestTotal) {
              bestTotal = p.totalScore;
              bestPlayer = p;
            }
          });

          sendToRoom(currentRoom, {
            type: 'game_finished',
            winnerId: bestPlayer ? bestPlayer.id : null,
            winnerName: bestPlayer ? bestPlayer.name : null,
            players: getPlayerList(currentRoom),
          });
          return;
        }

        sendToRoom(currentRoom, {
          type: 'new_round',
          word: room.word,
          round: room.round,
          maxRounds: room.maxRounds,
          players: getPlayerList(currentRoom),
        });
        break;
      }

      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.players = room.players.filter((p) => p.id !== playerId);
        broadcastToRoom(currentRoom, {
          type: 'players_update',
          players: getPlayerList(currentRoom),
          playerName,
        });
        cleanupRoom(currentRoom);
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`WebSocket server running on port ${PORT}`);
});

// Cleanup old rooms every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > 2 * 60 * 60 * 1000) {
      rooms.delete(code);
    }
  }
}, 30 * 60 * 1000);
