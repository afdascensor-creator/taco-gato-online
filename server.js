const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 25000,
  pingInterval: 10000
});

const PORT = process.env.PORT || 3000;
app.use(express.static("public"));

const rooms = new Map();

const DEFINITIONS = {
  Taco: { emoji: "🌮", color: "#e85d04", type: "normal", count: 11, key: "card_taco" },
  Gato: { emoji: "🐱", color: "#0f9b8e", type: "normal", count: 11, key: "card_gato" },
  Cabra: { emoji: "🐐", color: "#4c9a2a", type: "normal", count: 11, key: "card_cabra" },
  Queso: { emoji: "🧀", color: "#f2a900", type: "normal", count: 11, key: "card_queso" },
  Pizza: { emoji: "🍕", color: "#d62828", type: "normal", count: 11, key: "card_pizza" },
  Gorila: { emoji: "🦍", color: "#1d4e89", type: "especial", count: 3, key: "card_gorila" },
  Marmota: { emoji: "🦫", color: "#7b3f00", type: "especial", count: 3, key: "card_marmota" },
  Narval: { emoji: "🦄", color: "#7b2cbf", type: "especial", count: 3, key: "card_narval" }
};

function dealCountForPlayers(n) {
  if (n >= 2 && n <= 5) return 12;
  if (n === 6) return 10;
  if (n === 7 || n === 8) return 8;
  return 12;
}

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = "";
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function buildDeck() {
  const deck = [];
  for (const [name, def] of Object.entries(DEFINITIONS)) {
    for (let i = 0; i < def.count; i++) {
      deck.push({
        id: crypto.randomUUID(),
        name,
        nameKey: def.key,
        emoji: def.emoji,
        color: def.color,
        type: def.type
      });
    }
  }
  return shuffle(deck);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function msg(key, params = {}) {
  return { key, params };
}

function getSocketRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return null;
  return rooms.get(code);
}

function playerPublic(player) {
  return {
    id: player.id,
    name: player.name,
    count: player.deck.length,
    connected: player.connected
  };
}

function roomPublic(room, forPlayerId) {
  const me = room.players.find((p) => p.id === forPlayerId);
  return {
    code: room.code,
    hostId: room.hostId,
    maxPlayers: room.maxPlayers,
    started: room.started,
    phase: room.phase,
    players: room.players.map(playerPublic),
    me: me ? playerPublic(me) : null,
    currentPlayerId: room.currentPlayerId,
    centerCount: room.center.length,
    lastPlayed: room.lastPlayed ? {
      card: room.lastPlayed.card,
      playerId: room.lastPlayed.playerId,
      playerName: room.players.find((p) => p.id === room.lastPlayed.playerId)?.name || ""
    } : null,
    boxCount: room.box.length,
    message: room.message,
    slap: room.slap ? {
      card: room.slap.card,
      entries: room.slap.entries.map((e) => ({
        playerId: e.playerId,
        pressedAt: Boolean(e.pressedAt)
      }))
    } : null,
    reaction: room.reaction ? {
      card: room.reaction.card,
      entries: room.reaction.entries.map((e) => ({
        playerId: e.playerId,
        stage: e.stage,
        readyAt: e.readyAt
      }))
    } : null,
    winnerId: room.winnerId
  };
}

function broadcast(room) {
  for (const player of room.players) {
    if (player.socketId) io.to(player.socketId).emit("state", roomPublic(room, player.id));
  }
}

function sendError(socket, key, params = {}) {
  socket.emit("errorMessage", msg(key, params));
}

function createRoom(socket, data) {
  const maxPlayers = Number(data.maxPlayers);
  if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 8) {
    sendError(socket, "err_invalid_players");
    return;
  }

  const code = makeRoomCode();
  const player = {
    id: crypto.randomUUID(),
    socketId: socket.id,
    name: String(data.name || "Jugador 1").slice(0, 24),
    deck: [],
    connected: true
  };

  const room = {
    code,
    hostId: player.id,
    maxPlayers,
    players: [player],
    started: false,
    box: [],
    center: [],
    currentPlayerId: null,
    phase: "lobby",
    lastPlayed: null,
    message: msg("room_created"),
    slap: null,
    reaction: null,
    winnerId: null
  };

  rooms.set(code, room);
  socket.join(code);
  socket.data.roomCode = code;
  socket.data.playerId = player.id;
  socket.emit("joined", { code, playerId: player.id });
  broadcast(room);
}

function joinRoom(socket, data) {
  const code = String(data.code || "").trim().toUpperCase();
  const room = rooms.get(code);

  if (!room) return sendError(socket, "err_room_not_found");
  if (room.started) return sendError(socket, "err_game_started");
  if (room.players.length >= room.maxPlayers) return sendError(socket, "err_room_full");

  const player = {
    id: crypto.randomUUID(),
    socketId: socket.id,
    name: String(data.name || `Jugador ${room.players.length + 1}`).slice(0, 24),
    deck: [],
    connected: true
  };

  room.players.push(player);
  socket.join(code);
  socket.data.roomCode = code;
  socket.data.playerId = player.id;
  socket.emit("joined", { code, playerId: player.id });

  room.message = msg("player_joined", { player: player.name });
  broadcast(room);
}

function startGame(socket) {
  const room = getSocketRoom(socket);
  if (!room) return;

  if (socket.data.playerId !== room.hostId) return sendError(socket, "err_only_host");
  if (room.players.length !== room.maxPlayers) return sendError(socket, "err_missing_players", { count: room.maxPlayers });

  const deal = dealCountForPlayers(room.maxPlayers);
  const deck = buildDeck();
  const used = deck.slice(0, room.maxPlayers * deal);

  room.box = deck.slice(room.maxPlayers * deal);
  room.players.forEach((player, index) => {
    player.deck = used.slice(index * deal, (index + 1) * deal);
  });

  room.center = [];
  room.started = true;
  room.phase = "normal";
  room.currentPlayerId = room.players[0].id;
  room.lastPlayed = null;
  room.slap = null;
  room.reaction = null;
  room.winnerId = null;
  room.message = msg("game_started", { deal, box: room.box.length });

  broadcast(room);
}

function nextTurn(room, fromPlayerId) {
  let index = room.players.findIndex((p) => p.id === fromPlayerId);
  if (index < 0) index = 0;
  for (let i = 0; i < room.players.length; i++) {
    index = (index + 1) % room.players.length;
    const candidate = room.players[index];
    if (candidate.deck.length > 0) {
      room.currentPlayerId = candidate.id;
      return;
    }
  }
}

function playCard(socket) {
  const room = getSocketRoom(socket);
  if (!room || room.phase !== "normal") return;

  const playerId = socket.data.playerId;
  if (room.currentPlayerId !== playerId) return;

  const player = room.players.find((p) => p.id === playerId);
  if (!player || player.deck.length === 0) return;

  const previous = room.center.length ? room.center[room.center.length - 1] : null;
  const card = player.deck.shift();

  room.center.push({ card, playerId });
  room.lastPlayed = { card, playerId };
  room.message = msg("player_played", { player: player.name, cardKey: card.nameKey, emoji: card.emoji });

  if (card.type === "especial") {
    room.phase = "reaction";
    room.reaction = {
      card,
      entries: room.players.map((p) => ({
        playerId: p.id,
        stage: 0,
        firstAt: null,
        readyAt: null,
        completedAt: null
      }))
    };
    room.message = msg("special_started", { cardKey: card.nameKey, emoji: card.emoji });
    broadcast(room);
    return;
  }

  if (previous && previous.card.name === card.name) {
    room.phase = "slap";
    room.slap = {
      card,
      entries: room.players.map((p) => ({ playerId: p.id, pressedAt: null }))
    };
    room.message = msg("match_started", { cardKey: card.nameKey, emoji: card.emoji });
    broadcast(room);
    return;
  }

  if (player.deck.length === 0) {
    room.phase = "finished";
    room.winnerId = player.id;
    room.message = msg("winner", { player: player.name });
    broadcast(room);
    return;
  }

  nextTurn(room, playerId);
  broadcast(room);
}

function takeCenter(room, playerId, reasonKey, params = {}) {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return;

  const cards = room.center.map((x) => x.card);
  player.deck.push(...cards);

  room.center = [];
  room.lastPlayed = null;
  room.phase = "normal";
  room.slap = null;
  room.reaction = null;
  room.currentPlayerId = playerId;
  room.message = msg("take_center", {
    player: player.name,
    count: cards.length,
    reasonKey,
    ...params
  });
}

function hand(socket) {
  const room = getSocketRoom(socket);
  if (!room || room.phase === "finished" || !room.started) return;

  const playerId = socket.data.playerId;

  if (room.phase !== "slap") {
    takeCenter(room, playerId, "reason_penalty_no_match");
    broadcast(room);
    return;
  }

  const entry = room.slap.entries.find((e) => e.playerId === playerId);
  if (!entry || entry.pressedAt) return;

  entry.pressedAt = Date.now();

  if (room.slap.entries.every((e) => e.pressedAt)) {
    const loser = room.slap.entries.reduce((late, e) => e.pressedAt > late.pressedAt ? e : late);
    takeCenter(room, loser.playerId, "reason_last_hand", { cardKey: room.slap.card.nameKey });
  } else {
    room.message = msg("hand_received");
  }

  broadcast(room);
}

function specialClick(socket) {
  const room = getSocketRoom(socket);
  if (!room || room.phase !== "reaction" || !room.reaction) return;

  const playerId = socket.data.playerId;
  const entry = room.reaction.entries.find((e) => e.playerId === playerId);
  if (!entry || entry.stage === 2) return;

  const now = Date.now();

  if (entry.stage === 0) {
    entry.stage = 1;
    entry.firstAt = now;
    entry.readyAt = now + 2000;
    room.message = msg("special_first_click");
    broadcast(room);
    return;
  }

  if (entry.stage === 1) {
    if (now < entry.readyAt) return sendError(socket, "err_wait_two_seconds");

    entry.stage = 2;
    entry.completedAt = now;

    if (room.reaction.entries.every((e) => e.stage === 2)) {
      const loser = room.reaction.entries.reduce((late, e) => e.completedAt > late.completedAt ? e : late);
      takeCenter(room, loser.playerId, "reason_last_special", { cardKey: room.reaction.card.nameKey });
    } else {
      room.message = msg("special_completed_waiting");
    }

    broadcast(room);
  }
}

function disconnect(socket) {
  const room = getSocketRoom(socket);
  if (!room) return;

  const player = room.players.find((p) => p.id === socket.data.playerId);
  if (player) {
    player.connected = false;
    player.socketId = null;
    room.message = msg("player_disconnected", { player: player.name });
    broadcast(room);
  }

  if (!room.players.some((p) => p.connected)) {
    setTimeout(() => {
      const currentRoom = rooms.get(room.code);
      if (currentRoom && !currentRoom.players.some((p) => p.connected)) rooms.delete(room.code);
    }, 60000);
  }
}

io.on("connection", (socket) => {
  socket.on("createRoom", (data) => createRoom(socket, data || {}));
  socket.on("joinRoom", (data) => joinRoom(socket, data || {}));
  socket.on("startGame", () => startGame(socket));
  socket.on("playCard", () => playCard(socket));
  socket.on("hand", () => hand(socket));
  socket.on("specialClick", () => specialClick(socket));
  socket.on("disconnect", () => disconnect(socket));
});

server.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
