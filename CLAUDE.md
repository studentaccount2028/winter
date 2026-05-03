# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Frontend** (run from project root):
```
npm run dev       # Vite dev server (default port 5173)
npm run build     # Production build
npm run lint      # ESLint
npm run preview   # Preview production build
```

**Backend** (run from `server/`):
```
node index.js     # or: npm start
```

Both must be running simultaneously for multiplayer to work. The server runs on port 3001 by default. Set `VITE_SERVER_URL` to override the server URL (defaults to `http://localhost:3001`).

## Architecture

### Overview

Single-page multiplayer 3D FPS. The entire frontend lives in `src/App.jsx` (~1200+ lines). The backend is `server/index.js` (~120 lines). No routing, no build-time config beyond Vite.

### Frontend (`src/App.jsx`)

**Scene structure**: React Three Fiber renders one of two scenes — `SunsetScene` (venice) or `NightScene` (starry) — inside a `<Canvas>`. Each scene composes `Player`, `Objects`, `Rocks`, `Multiplayer`, `Shooter`, and environment components.

**State flow**:
1. App mounts → socket connects → `UsernameScreen` shown (username = null)
2. Username submitted → `set_username` emitted → server returns `user_data` (weapons array) → `LobbyScreen` shown
3. Room joined → Canvas renders the 3D scene

**SocketContext**: A React context wrapping the whole tree that provides `socketRef`, `dataRef` (remote player interpolation targets), `playerIds`, `myId`, `messages`, `sendChat`, `myColorIndex`, `onKicked`, `dyingRef`, `dyingIds`, `username`, `weapons`. Components call `useContext(SocketContext)` to access these.

**Player movement**: Fully custom — WASD + gravity + jump in `Player` component using `useFrame`. No physics library. Collision detection is manual ray/cylinder/sphere checks against `ROCK_COLLIDERS`, `BOX_COLLIDERS`.

**Shooter**: `R` key fires while pointer-locked. Lasers are local JS objects (not React state) managed in a `useRef` array, updated each frame in `useFrame`. Hit detection uses ray-sphere intersection against remote player positions from `dataRef`. Occlusion checked via `rayBlockedByRocks()`.

**Remote players**: Positions arrive via `move` socket events and are stored in `dataRef.current[id].tx/ty/tz/try`. Each frame, actual positions lerp toward targets using `k = 1 - Math.pow(0.001, delta)`.

**Weapons system**: The server stores `{ username: { weapons: ['laser', ...] } }` in `server/users.json`. On login the client receives the weapons array and stores it in `weapons` state. `Inventory` HUD maps over this array. The active weapon is `weapons[0]` (index 0 = equipped).

### Backend (`server/index.js`)

Stateless relay + minimal persistence. `players` object holds in-memory state per socket. `users.json` holds per-username weapon loadouts. No database.

Key socket events:
- `set_username` → looks up/creates user in `users.json`, emits `user_data` back
- `join_room` → adds to Socket.io room, sends existing players, notifies room
- `move` → relays position to room peers (client throttles to 30ms)
- `shoot` → relays to room peers; hit detection is authoritative on each client
- `chat` → relays to room, 200-char cap

### Key Constants (top of `App.jsx`)

```
LASER_SPEED      40 units/s
LASER_COOLDOWN   500ms
LASER_MAX_RANGE  36 units
LASER_HIT_R      0.32 (sphere radius for hit detection)
PLAYER_COLORS    array of color objects used for player tinting
```

### Adding a New Weapon

1. Add constants near `LASER_*` at the top of `App.jsx`
2. Handle the new weapon's fire logic inside `Shooter`'s `useFrame`/keydown handler, gated by the active weapon
3. The server already stores arbitrary weapon names in `users.json` — no server change needed unless the weapon has server-side effects
4. Grant the weapon via the shop/coin system by updating the `weapons` array in `users.json` and emitting `user_data` to the client
