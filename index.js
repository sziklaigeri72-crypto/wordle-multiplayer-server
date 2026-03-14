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

function getPlayerList(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return [];
  return room.players.map((p) => ({
    id: p.id,
    name: p.name,
    guesses: p.guesses,
    solved: p.solved,
    failed: p.failed,
  }));
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
            },
          ],
          started: false,
          winner: null,
          round: 1,
          maxRounds: 5,
          createdAt: Date.now(),
        };
        rooms.set(code, room);
        currentRoom = code;

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
          ws.send(JSON.stringify({ type: 'error', message: 'Csatlakoztál a szobához!' }));
          return;
        }

        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'A szoba nem található!' }));
          return;
        }

        if (room.players.length >= 8) {
          ws.send(JSON.stringify({ type: 'error', message: 'A szoba megtelt! (max 8 játékos)' }));
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
        });
        
        ws.joined = true;
        currentRoom = code;
        
        broadcastToRoom(currentRoom, {
          type: "players_update",
          players: getPlayerList(currentRoom) 
        });

        ws.send(
          JSON.stringify({
            type: 'room_joined',
            roomCode: code,
            playerId,
            word: room.word,
            players: getPlayerList(code),
            started: room.started,
          })
        );

        broadcastToRoom(code, {
          type: 'player_joined',
          players: getPlayerList(code),
          playerName,
        }, ws);
        break;
      }

      case 'start_game': {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        room.started = true;
        broadcastToRoom(currentRoom, {
          type: 'game_started',
          word: room.word,
          players: getPlayerList(currentRoom),
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

        if (msg.solved && !room.winner) {
          room.winner = playerId;
          broadcastToRoom(currentRoom, {
            type: 'game_over',
            winnerId: playerId,
            winnerName: playerName,
            players: getPlayerList(currentRoom),
          });
        } else {
          broadcastToRoom(currentRoom, {
            type: 'player_update',
            players: getPlayerList(currentRoom),
          }, ws);
        }

        const allDone = room.players.every((p) => p.solved || p.failed);
        if (allDone && !room.winner) {
          broadcastToRoom(currentRoom, {
            type: 'game_over',
            winnerId: null,
            winnerName: null,
            players: getPlayerList(currentRoom),
          });
        }
        break;
      }

      case 'next_round': {
        const room = rooms.get(currentRoom);
        if (!room) break;

        room.round += 1;
        room.winner = null;
        if (msg.word) room.word = msg.word; // Update word for new round

        room.players.forEach((p) => {
          p.solved = false;
          p.failed = false;
          p.guesses = 0;
        });

        broadcastToRoom(currentRoom, {
          type: 'new_round',
          round: room.round,
          word: room.word, // Send new word to everyone
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
          type: 'player_left',
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

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > 2 * 60 * 60 * 1000) {
      rooms.delete(code);
    }
  }
}, 30 * 60 * 1000);
