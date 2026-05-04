const { createServer } = require('http')
const express = require('express')
const { Server } = require('socket.io')
const fs   = require('fs')
const path = require('path')

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, { cors: { origin: '*' } })

const DIST = path.join(__dirname, '../dist')
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST))
  app.get(/.*/, (_, res) => res.sendFile(path.join(DIST, 'index.html')))
}

const USERS_FILE = path.join(__dirname, 'users.json')

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) }
  catch { return {} }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2))
}

// players[id] = { room: null|'venice'|'starry', x, y, z, ry, username }
const players = {}

function lobbyState() {
  const rooms = { venice: [], starry: [] }
  for (const [id, p] of Object.entries(players)) {
    if (p.room === 'venice') rooms.venice.push(id)
    if (p.room === 'starry') rooms.starry.push(id)
  }
  return rooms
}

function broadcastLobby() {
  io.emit('lobby', lobbyState())
}

io.on('connection', socket => {
  console.log('+ player', socket.id)
  players[socket.id] = { room: null, x: 0, y: 1.7, z: 5, ry: 0, username: null }
  socket.emit('lobby', lobbyState())

  socket.on('join_room', roomId => {
    const p = players[socket.id]
    if (!p) return

    if (p.room === roomId) {
      // Respawn in same room — just resync state without broadcasting leave/join
      const existing = {}
      for (const [id, other] of Object.entries(players)) {
        if (id !== socket.id && other.room === roomId)
          existing[id] = { x: other.x, y: other.y, z: other.z, ry: other.ry }
      }
      socket.emit('room_players', existing)
      return
    }

    // Leave previous room
    if (p.room) {
      socket.to(p.room).emit('leave', socket.id)
      socket.leave(p.room)
    }

    p.room = roomId
    socket.join(roomId)

    // Send existing room players to the joiner
    const existing = {}
    for (const [id, other] of Object.entries(players)) {
      if (id !== socket.id && other.room === roomId)
        existing[id] = { x: other.x, y: other.y, z: other.z, ry: other.ry }
    }
    socket.emit('room_players', existing)

    // Tell existing room players about the joiner
    socket.to(roomId).emit('join', { id: socket.id, x: p.x, y: p.y, z: p.z, ry: p.ry })

    broadcastLobby()
  })

  socket.on('leave_room', () => {
    const p = players[socket.id]
    if (!p?.room) return
    socket.to(p.room).emit('leave', socket.id)
    socket.leave(p.room)
    p.room = null
    broadcastLobby()
  })

  socket.on('move', data => {
    const p = players[socket.id]
    if (!p?.room) return
    Object.assign(p, data)
    socket.to(p.room).emit('move', { id: socket.id, ...data })
  })

  socket.on('shoot', data => {
    const p = players[socket.id]
    if (!p?.room) return
    socket.to(p.room).emit('shoot', { id: socket.id, ...data })
  })

  socket.on('chat', text => {
    const p = players[socket.id]
    if (!p?.room || typeof text !== 'string' || !text.trim()) return
    io.to(p.room).emit('chat', { id: socket.id, text: text.slice(0, 200) })
  })

  socket.on('set_username', ({ username }) => {
    if (typeof username !== 'string') return
    const name = username.trim().slice(0, 24)
    if (!name) return

    const users = loadUsers()
    if (!users[name]) {
      users[name] = { weapons: ['laser'] }
      saveUsers(users)
    }

    players[socket.id].username = name
    socket.emit('user_data', { weapons: users[name].weapons })
  })

  socket.on('buy_weapon', ({ weapon }) => {
    const p = players[socket.id]
    if (!p?.username) return
    if (!['double_laser', 'machine_gun'].includes(weapon)) return
    const users = loadUsers()
    const user  = users[p.username]
    if (!user || user.weapons.includes(weapon)) return
    user.weapons.push(weapon)
    saveUsers(users)
    socket.emit('user_data', { weapons: user.weapons })
  })

  socket.on('disconnect', () => {
    console.log('- player', socket.id)
    const p = players[socket.id]
    if (p?.room) socket.to(p.room).emit('leave', socket.id)
    delete players[socket.id]
    broadcastLobby()
  })
})

const PORT = process.env.PORT || 3001
httpServer.listen(PORT, () => console.log(`server running on :${PORT}`))
