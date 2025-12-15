// server.js (or index.js)
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);

// Render requires the port to be set via an environment variable
const PORT = process.env.PORT || 3000;

// Initialize Supabase Client using the Service Role Key (secure connection)
// These keys will be provided via Render Environment Variables later
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error("Supabase environment variables are missing!");
  // In a real app, you might crash the process here if essential keys are missing
} else {
  console.log("Supabase client successfully initialized.");
  // You can now use this client to interact with your DB securely
  // const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
}


// Configure Socket.IO
// Allow cross-origin requests from your future Vercel frontend domain
const io = socketIo(server, {
  cors: {
    origin: "*", // For now, use '*' (wildcard). Update this later to your Vercel URL!
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
  
  // This is where your game logic events go (e.g., 'joinTable', 'bet', 'fold')
  socket.on('playerAction', (actionData) => {
      console.log('Received action:', actionData);
      // Process action, update DB via Supabase client, broadcast new state
      // io.emit('gameStateUpdate', newState);
  });
});

app.get('/', (req, res) => {
  res.send('Poker Socket.IO Server is Running!');
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
