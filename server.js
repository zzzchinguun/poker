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
  console.log('[Auth] Token received:', token ? `${token.slice(0, 30)}...` : 'NO TOKEN');

  if (!token) {
    console.log('[Auth] No token provided');
    return next(new Error('Authentication required'));
  }

  if (supabase) {
    console.log('[Auth] Validating token with Supabase...');
    try {
      const { data, error } = await supabase.auth.getUser(token);
      console.log('[Auth] Supabase response:', {
        hasData: !!data,
        hasUser: !!data?.user,
        userId: data?.user?.id,
        error: error ? { message: error.message, status: error.status } : null
      });

      if (error) {
        console.log('[Auth] Supabase error:', error.message);
        return next(new Error(`Invalid token: ${error.message}`));
      }
      if (!data?.user) {
        console.log('[Auth] No user in response');
        return next(new Error('Invalid token: No user found'));
      }
      socket.userId = data.user.id;
      socket.userEmail = data.user.email;
      console.log('[Auth] User authenticated:', socket.userId);
    } catch (err) {
      console.error('[Auth] Exception during validation:', err);
      return next(new Error(`Auth error: ${err.message}`));
    }
  } else {
    // Dev mode without Supabase
    console.log('[Auth] Dev mode - no Supabase');
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
      // Pass the userId explicitly since socket might lose context
      await removePlayerFromTable(socket, playerData.tableId, playerData.odilsId);
      playerSockets.delete(socket.id);
    }
  });
});

// Remove player from table
async function removePlayerFromTable(socket, tableId, odilsId = null) {
  const state = tables.get(tableId);
  if (!state) return;

  // Use odilsId if provided (from disconnect handler), otherwise use socket.userId
  const odils = odilsId || socket.userId;
  const playerIndex = state.players.findIndex((p) => p.id === odils);
  if (playerIndex === -1) return;

  const player = state.players[playerIndex];
  const wasPlayersTurn = player.isTurn;

  console.log(`[Leave] Removing player ${player.name} (${odils}) from table ${tableId}`);
  console.log(`[Leave] Player had ${player.chips} chips, was their turn: ${wasPlayersTurn}`);

  // Save player's chips to database before removing
  if (supabase && player.chips !== 1000) {
    // Update the user's balance in profiles table
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('balance')
        .eq('id', odils)
        .single();

      const currentBalance = profile?.balance || 0;
      const chipsChange = player.chips - 1000; // Difference from starting chips
      const newBalance = currentBalance + chipsChange;

      await supabase
        .from('profiles')
        .update({ balance: newBalance })
        .eq('id', odils);

      console.log(`[Leave] Updated ${player.name}'s balance: ${currentBalance} + ${chipsChange} = ${newBalance}`);
    } catch (err) {
      console.error(`[Leave] Failed to update balance:`, err);
    }
  }

  // If it was this player's turn, move to next player before removing
  if (wasPlayersTurn && state.players.length > 1) {
    player.isTurn = false;
    player.folded = true; // Mark as folded so they're skipped

    // Check if only one active player remains
    const activePlayers = state.players.filter((p) => !p.folded && p.id !== odils);
    if (activePlayers.length === 1) {
      // Award pot to remaining player
      state.players.splice(playerIndex, 1);
      endHand(tableId, activePlayers[0]);

      // Update DB
      if (supabase) {
        await supabase
          .from('poker_tables')
          .update({ current_players: state.players.length })
          .eq('id', tableId);
      }
      socket.leave(tableId);
      return;
    }

    // Move to next player
    moveToNextPlayer(tableId);
  }

  // Now remove the player
  const newPlayerIndex = state.players.findIndex((p) => p.id === odils);
  if (newPlayerIndex !== -1) {
    state.players.splice(newPlayerIndex, 1);
  }
  socket.leave(tableId);

  // Adjust currentPlayerIndex if needed
  if (state.currentPlayerIndex >= state.players.length) {
    state.currentPlayerIndex = 0;
  }

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
    // Reset remaining player's state
    state.players.forEach((p) => {
      p.isTurn = false;
      p.folded = false;
      p.bet = 0;
      p.cards = null;
      p.isDealer = false;
      p.isSmallBlind = false;
      p.isBigBlind = false;
    });
  }

  broadcastGameState(tableId);
}

// Start a new hand
function startNewHand(tableId) {
  const state = tables.get(tableId);
  if (!state || state.players.length < 2) return;

  console.log(`Starting new hand at table ${tableId} with ${state.players.length} players`);

  // Ensure dealerIndex is valid
  state.dealerIndex = state.dealerIndex % state.players.length;

  const numPlayers = state.players.length;
  const isHeadsUp = numPlayers === 2;

  // In heads-up (2 players):
  // - Dealer is Small Blind and acts FIRST preflop, LAST post-flop
  // - Other player is Big Blind
  // In 3+ players:
  // - Dealer is just dealer
  // - Next player is Small Blind
  // - Next is Big Blind
  // - First to act preflop is after Big Blind

  let sbIndex, bbIndex;
  if (isHeadsUp) {
    // Heads-up: dealer is small blind
    sbIndex = state.dealerIndex;
    bbIndex = (state.dealerIndex + 1) % numPlayers;
  } else {
    // 3+ players: standard positions
    sbIndex = (state.dealerIndex + 1) % numPlayers;
    bbIndex = (state.dealerIndex + 2) % numPlayers;
  }

  // Reset players
  state.players.forEach((p, i) => {
    p.cards = dealCards();
    p.bet = 0;
    p.folded = false;
    p.isDealer = i === state.dealerIndex;
    p.isSmallBlind = i === sbIndex;
    p.isBigBlind = i === bbIndex;
    p.isTurn = false;
  });

  // Post blinds
  state.players[sbIndex].chips -= 5;
  state.players[sbIndex].bet = 5;
  state.players[bbIndex].chips -= 10;
  state.players[bbIndex].bet = 10;

  state.pot = 15;
  state.currentBet = 10;
  state.communityCards = [];
  state.phase = 'preflop';

  // First to act preflop:
  // - Heads-up: dealer/small blind acts first
  // - 3+ players: player after big blind acts first
  let firstToAct;
  if (isHeadsUp) {
    firstToAct = sbIndex; // Dealer/SB acts first in heads-up preflop
  } else {
    firstToAct = (bbIndex + 1) % numPlayers;
  }

  state.players[firstToAct].isTurn = true;
  state.currentPlayerIndex = firstToAct;

  console.log(`[Hand] Dealer: ${state.players[state.dealerIndex].name}, SB: ${state.players[sbIndex].name}, BB: ${state.players[bbIndex].name}`);
  console.log(`[Hand] First to act: ${state.players[firstToAct].name}`);

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

  if (activePlayers.length === 0) {
    console.log(`[Turn] No active players, ending hand`);
    return;
  }

  // Find next active player
  let nextIndex = (state.currentPlayerIndex + 1) % state.players.length;
  let attempts = 0;

  while (state.players[nextIndex].folded && attempts < state.players.length) {
    nextIndex = (nextIndex + 1) % state.players.length;
    attempts++;
  }

  // Check if betting round is complete
  // Everyone who hasn't folded has either:
  // 1. Matched the current bet, OR
  // 2. Is all-in (chips === 0)
  // AND we've gone around at least once (tracked by checking if we're back to/past the last raiser)
  const bettingComplete = activePlayers.every(
    (p) => p.bet === state.currentBet || p.chips === 0
  );

  // We need to check if everyone has had a chance to act
  // In heads-up preflop: SB acts first, BB can raise, then SB again, etc.
  // The round is complete when both have matched and it's cycled back
  const everyoneActed = bettingComplete && nextIndex <= state.currentPlayerIndex;

  console.log(`[Turn] Current: ${state.currentPlayerIndex}, Next: ${nextIndex}, BettingComplete: ${bettingComplete}, EveryoneActed: ${everyoneActed}`);

  if (everyoneActed) {
    // Move to next phase
    advancePhase(tableId);
  } else {
    state.players[nextIndex].isTurn = true;
    state.currentPlayerIndex = nextIndex;
    console.log(`[Turn] Now ${state.players[nextIndex].name}'s turn`);
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
      const activePlayersForWinner = state.players.filter((p) => !p.folded);
      const winner = activePlayersForWinner[Math.floor(Math.random() * activePlayersForWinner.length)];
      endHand(tableId, winner);
      return;
  }

  // Post-flop: first active player after dealer starts
  // In heads-up: this will be the big blind (non-dealer)
  const activePlayers = state.players.filter((p) => !p.folded);
  if (activePlayers.length === 0) return;

  const dealerIndex = state.players.findIndex((p) => p.isDealer);
  let firstToAct = (dealerIndex + 1) % state.players.length;
  let attempts = 0;

  // Find first non-folded player after dealer
  while (state.players[firstToAct].folded && attempts < state.players.length) {
    firstToAct = (firstToAct + 1) % state.players.length;
    attempts++;
  }

  state.players[firstToAct].isTurn = true;
  state.currentPlayerIndex = firstToAct;

  console.log(`[Phase] Advanced to ${state.phase}, first to act: ${state.players[firstToAct].name}`);

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
    hasKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    supabaseUrl: process.env.SUPABASE_URL ? process.env.SUPABASE_URL.slice(0, 30) + '...' : null
  });
});

// Debug endpoint to test token validation
app.post('/debug/validate-token', express.json(), async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'No token provided' });
  }
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }
  try {
    const { data, error } = await supabase.auth.getUser(token);
    res.json({
      success: !error && !!data?.user,
      userId: data?.user?.id,
      email: data?.user?.email,
      error: error ? { message: error.message, status: error.status } : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
