const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3001;

// Initialize Supabase with Service Role Key
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
if (supabaseUrl && supabaseServiceRoleKey) {
  supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
  console.log('Supabase client initialized');
} else {
  console.warn('Supabase environment variables missing - running without DB');
}

// In-memory game state (in production, use Redis or DB)
const tables = new Map(); // tableId -> GameState
const playerSockets = new Map(); // socketId -> { odilsId, tableId }

// Configure Socket.IO
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
  },
});

// Middleware to authenticate socket connections
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error('Authentication required'));
  }

  if (supabase) {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return next(new Error('Invalid token'));
    }
    socket.userId = user.id;
    socket.userEmail = user.email;
  } else {
    // Dev mode without Supabase
    socket.userId = 'dev-user-' + socket.id;
    socket.userEmail = 'dev@test.com';
  }

  next();
});

// Helper: Get or create table game state
function getTableState(tableId) {
  if (!tables.has(tableId)) {
    tables.set(tableId, {
      tableId,
      players: [],
      communityCards: [],
      pot: 0,
      currentBet: 0,
      phase: 'waiting', // waiting, preflop, flop, turn, river, showdown
      dealerIndex: 0,
      currentPlayerIndex: 0,
      turnTimer: 30,
    });
  }
  return tables.get(tableId);
}

// Helper: Broadcast game state to all players at table
function broadcastGameState(tableId) {
  const state = tables.get(tableId);
  if (state) {
    io.to(tableId).emit('game_state', state);
  }
}

// Helper: Get player's username
async function getUsername(userId) {
  if (supabase) {
    const { data } = await supabase
      .from('profiles')
      .select('username')
      .eq('id', userId)
      .single();
    return data?.username || 'Player';
  }
  return 'Player-' + userId.slice(-4);
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.userId} (${socket.id})`);

  // Join a table
  socket.on('join_table', async ({ tableId }) => {
    console.log(`${socket.userId} joining table ${tableId}`);

    const state = getTableState(tableId);
    const existingPlayer = state.players.find((p) => p.id === socket.userId);

    if (existingPlayer) {
      // Reconnecting player
      socket.join(tableId);
      playerSockets.set(socket.id, { odilsId: socket.userId, tableId });
      broadcastGameState(tableId);
      return;
    }

    if (state.players.length >= 8) {
      socket.emit('error', 'Table is full');
      return;
    }

    // Get username
    const username = await getUsername(socket.userId);

    // Find next available position
    const takenPositions = state.players.map((p) => p.position);
    let position = 0;
    while (takenPositions.includes(position)) position++;

    // Add player to table
    const newPlayer = {
      id: socket.userId,
      name: username,
      chips: 1000, // Starting chips
      position,
      cards: null,
      bet: 0,
      folded: false,
      isDealer: state.players.length === 0,
      isSmallBlind: false,
      isBigBlind: false,
      isTurn: false,
    };

    state.players.push(newPlayer);
    socket.join(tableId);
    playerSockets.set(socket.id, { odilsId: socket.userId, tableId });

    // Update current_players in DB
    if (supabase) {
      await supabase
        .from('poker_tables')
        .update({ current_players: state.players.length })
        .eq('id', tableId);
    }

    console.log(`Table ${tableId} now has ${state.players.length} players`);

    // Start game if we have 2+ players and game is waiting
    if (state.players.length >= 2 && state.phase === 'waiting') {
      startNewHand(tableId);
    } else {
      broadcastGameState(tableId);
    }
  });

  // Leave a table
  socket.on('leave_table', async ({ tableId }) => {
    console.log(`${socket.userId} leaving table ${tableId}`);
    await removePlayerFromTable(socket, tableId);
  });

  // Player action (fold, check, call, bet, raise)
  socket.on('player_action', ({ tableId, action, amount }) => {
    const state = tables.get(tableId);
    if (!state) return;

    const playerIndex = state.players.findIndex((p) => p.id === socket.userId);
    if (playerIndex === -1) return;

    const player = state.players[playerIndex];
    if (!player.isTurn) {
      socket.emit('error', 'Not your turn');
      return;
    }

    console.log(`${player.name} action: ${action} ${amount || ''}`);

    switch (action) {
      case 'fold':
        player.folded = true;
        break;

      case 'check':
        if (state.currentBet > player.bet) {
          socket.emit('error', 'Cannot check, must call or raise');
          return;
        }
        break;

      case 'call':
        const callAmount = state.currentBet - player.bet;
        player.chips -= callAmount;
        player.bet = state.currentBet;
        state.pot += callAmount;
        break;

      case 'bet':
      case 'raise':
        const betAmount = amount || state.currentBet * 2;
        const totalBet = betAmount;
        const toAdd = totalBet - player.bet;
        player.chips -= toAdd;
        player.bet = totalBet;
        state.currentBet = totalBet;
        state.pot += toAdd;
        break;
    }

    // Move to next player
    player.isTurn = false;
    moveToNextPlayer(tableId);
  });

  // Handle disconnect
  socket.on('disconnect', async () => {
    console.log(`User disconnected: ${socket.userId}`);
    const playerData = playerSockets.get(socket.id);
    if (playerData) {
      await removePlayerFromTable(socket, playerData.tableId);
      playerSockets.delete(socket.id);
    }
  });
});

// Remove player from table
async function removePlayerFromTable(socket, tableId) {
  const state = tables.get(tableId);
  if (!state) return;

  const playerIndex = state.players.findIndex((p) => p.id === socket.userId);
  if (playerIndex === -1) return;

  state.players.splice(playerIndex, 1);
  socket.leave(tableId);

  // Update DB
  if (supabase) {
    await supabase
      .from('poker_tables')
      .update({ current_players: state.players.length })
      .eq('id', tableId);
  }

  // If not enough players, reset to waiting
  if (state.players.length < 2) {
    state.phase = 'waiting';
    state.communityCards = [];
    state.pot = 0;
    state.currentBet = 0;
  }

  broadcastGameState(tableId);
}

// Start a new hand
function startNewHand(tableId) {
  const state = tables.get(tableId);
  if (!state || state.players.length < 2) return;

  console.log(`Starting new hand at table ${tableId}`);

  // Reset players
  state.players.forEach((p, i) => {
    p.cards = dealCards();
    p.bet = 0;
    p.folded = false;
    p.isDealer = i === state.dealerIndex;
    p.isSmallBlind = i === (state.dealerIndex + 1) % state.players.length;
    p.isBigBlind = i === (state.dealerIndex + 2) % state.players.length;
    p.isTurn = false;
  });

  // Post blinds
  const sbIndex = (state.dealerIndex + 1) % state.players.length;
  const bbIndex = (state.dealerIndex + 2) % state.players.length;

  state.players[sbIndex].chips -= 5;
  state.players[sbIndex].bet = 5;
  state.players[bbIndex].chips -= 10;
  state.players[bbIndex].bet = 10;

  state.pot = 15;
  state.currentBet = 10;
  state.communityCards = [];
  state.phase = 'preflop';

  // First to act is after big blind
  const firstToAct = (bbIndex + 1) % state.players.length;
  state.players[firstToAct].isTurn = true;
  state.currentPlayerIndex = firstToAct;

  broadcastGameState(tableId);
}

// Move to next player or next phase
function moveToNextPlayer(tableId) {
  const state = tables.get(tableId);
  if (!state) return;

  const activePlayers = state.players.filter((p) => !p.folded);

  // Check for winner (only one player left)
  if (activePlayers.length === 1) {
    endHand(tableId, activePlayers[0]);
    return;
  }

  // Find next active player
  let nextIndex = (state.currentPlayerIndex + 1) % state.players.length;
  let attempts = 0;

  while (state.players[nextIndex].folded && attempts < state.players.length) {
    nextIndex = (nextIndex + 1) % state.players.length;
    attempts++;
  }

  // Check if betting round is complete (everyone has matched the bet)
  const bettingComplete = activePlayers.every(
    (p) => p.bet === state.currentBet || p.chips === 0
  );

  if (bettingComplete && nextIndex <= state.currentPlayerIndex) {
    // Move to next phase
    advancePhase(tableId);
  } else {
    state.players[nextIndex].isTurn = true;
    state.currentPlayerIndex = nextIndex;
    broadcastGameState(tableId);
  }
}

// Advance to next phase
function advancePhase(tableId) {
  const state = tables.get(tableId);
  if (!state) return;

  // Reset bets for new round
  state.players.forEach((p) => (p.bet = 0));
  state.currentBet = 0;

  switch (state.phase) {
    case 'preflop':
      state.phase = 'flop';
      state.communityCards = [randomCard(), randomCard(), randomCard()];
      break;
    case 'flop':
      state.phase = 'turn';
      state.communityCards.push(randomCard());
      break;
    case 'turn':
      state.phase = 'river';
      state.communityCards.push(randomCard());
      break;
    case 'river':
      state.phase = 'showdown';
      // Determine winner (simplified - random for now)
      const activePlayers = state.players.filter((p) => !p.folded);
      const winner = activePlayers[Math.floor(Math.random() * activePlayers.length)];
      endHand(tableId, winner);
      return;
  }

  // First active player after dealer starts
  const dealerIndex = state.players.findIndex((p) => p.isDealer);
  let firstToAct = (dealerIndex + 1) % state.players.length;
  while (state.players[firstToAct].folded) {
    firstToAct = (firstToAct + 1) % state.players.length;
  }
  state.players[firstToAct].isTurn = true;
  state.currentPlayerIndex = firstToAct;

  broadcastGameState(tableId);
}

// End the hand
function endHand(tableId, winner) {
  const state = tables.get(tableId);
  if (!state) return;

  console.log(`${winner.name} wins ${state.pot}`);

  winner.chips += state.pot;

  state.winner = {
    playerId: winner.id,
    hand: 'Winner!', // Simplified
    amount: state.pot,
  };

  broadcastGameState(tableId);

  // Start new hand after delay
  setTimeout(() => {
    state.winner = null;
    state.dealerIndex = (state.dealerIndex + 1) % state.players.length;
    if (state.players.length >= 2) {
      startNewHand(tableId);
    } else {
      state.phase = 'waiting';
      broadcastGameState(tableId);
    }
  }, 3000);
}

// Helper: Deal 2 cards to a player
function dealCards() {
  return [randomCard(), randomCard()];
}

// Helper: Generate random card
function randomCard() {
  const suits = ['♠', '♥', '♦', '♣'];
  const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  return values[Math.floor(Math.random() * values.length)] + suits[Math.floor(Math.random() * suits.length)];
}

app.get('/', (req, res) => {
  res.send('Poker Socket.IO Server is Running!');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    tables: tables.size,
    supabaseConfigured: !!supabase,
    hasUrl: !!process.env.SUPABASE_URL,
    hasKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
