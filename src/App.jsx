import { useRef, useEffect, useState, useMemo, useCallback, Suspense, createContext, useContext } from 'react'
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import { PointerLockControls, Grid, Environment, useGLTF, MeshReflectorMaterial, Lightformer, Sparkles, Stars, useTexture, useAnimations } from '@react-three/drei'
import { RepeatWrapping, PlaneGeometry, Color, Object3D, Quaternion, Vector3 } from 'three'
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { io } from 'socket.io-client'
import { EffectComposer, Bloom, ToneMapping, SMAA, N8AO, GodRays } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import { Physics, RigidBody, CuboidCollider, CylinderCollider } from '@react-three/rapier'

const SPEED = 6

// ─── Shared geometry / controls ──────────────────────────────────────────────

function DeskModel(props) {
  const { scene } = useGLTF('/models/metal_office_desk_4k.gltf')
  useEffect(() => {
    scene.traverse((child) => {
      if (child.isMesh) { child.castShadow = true; child.receiveShadow = true }
    })
  }, [scene])
  return <primitive object={scene} castShadow receiveShadow {...props} />
}
useGLTF.preload('/models/metal_office_desk_4k.gltf')
useGLTF.preload('/models/zombie/scene.gltf')

function Player() {
  const controlsRef = useRef()
  const keys = useRef({ w: false, a: false, s: false, d: false })
  const velocityY = useRef(0)
  const grounded = useRef(false)
  const bobPhase = useRef(0)
  const bobStrength = useRef(0)
  const { camera } = useThree()
  const carCtx = useContext(CarContext)

  useEffect(() => {
    const down = (e) => {
      if (document.activeElement?.tagName === 'INPUT') return
      if (e.code === 'KeyW') keys.current.w = true
      if (e.code === 'KeyS') keys.current.s = true
      if (e.code === 'KeyA') keys.current.a = true
      if (e.code === 'KeyD') keys.current.d = true
      if (e.code === 'Space' && grounded.current) {
        e.preventDefault()
        velocityY.current = 14
        grounded.current = false
      }
    }
    const up = (e) => {
      if (e.code === 'KeyW') keys.current.w = false
      if (e.code === 'KeyS') keys.current.s = false
      if (e.code === 'KeyA') keys.current.a = false
      if (e.code === 'KeyD') keys.current.d = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [])

  useFrame((_, delta) => {
    const ctrl = controlsRef.current
    if (!ctrl?.isLocked) return
    if (carCtx?.inCarRef.current) return

    const { w, a, s, d } = keys.current

    // Extract horizontal axes from camera matrix (matches PointerLockControls internally)
    const me = camera.matrix.elements
    const fwd = ((w ? 1 : 0) - (s ? 1 : 0)) * SPEED * delta
    const rgt = ((d ? 1 : 0) - (a ? 1 : 0)) * SPEED * delta

    // Move and resolve each axis separately — gives hard wall stop + wall sliding
    camera.position.x += me[2] * fwd + me[0] * rgt
    resolveBoxX(camera.position)

    camera.position.z += -me[0] * fwd + me[2] * rgt
    resolveBoxZ(camera.position)

    resolveRocks(camera.position)

    // Ground height: terrain or top of any object the player is over
    const terrainY = (_fbm(camera.position.x / 25, -camera.position.z / 25) - 0.5) * 3.0
    const objY = getObjectSurfaceY(camera.position)
    const groundY = Math.max(terrainY, objY)

    // Gravity
    velocityY.current = Math.max(velocityY.current - 25 * delta, -30)
    camera.position.y += velocityY.current * delta

    const eyeTarget = groundY + 1.7
    if (camera.position.y < eyeTarget) {
      camera.position.y = eyeTarget
      velocityY.current = 0
      grounded.current = true
    } else {
      grounded.current = false
    }

    // Head bob — lerp strength so it fades in/out smoothly
    const moving = w || a || s || d
    const targetStrength = (moving && grounded.current) ? 1 : 0
    bobStrength.current += (targetStrength - bobStrength.current) * (1 - Math.pow(0.004, delta))
    bobPhase.current += delta * 9
    camera.position.y += Math.sin(bobPhase.current) * 0.04 * bobStrength.current
  })

  return <PointerLockControls ref={controlsRef} />
}

const CUBES = [
  { pos: [ 2, 0.5, -10], color: '#1a4dcc', metalness: 0,    roughness: 0.85, emissive: '#000',    emissiveIntensity: 0 },
  { pos: [ 8, 0.5,  -4], color: '#ff6600', metalness: 0,    roughness: 0.4,  emissive: '#ff4400', emissiveIntensity: 3 },
  { pos: [-8, 0.5, -12], color: '#6e5f50', metalness: 0.05, roughness: 0.95, emissive: '#000',    emissiveIntensity: 0 },
]

// Noise helpers — fbm gives natural multi-scale dune shapes
function _hash(x, y) { const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return n - Math.floor(n) }
function _snoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
  return _hash(ix,iy)*(1-ux)*(1-uy) + _hash(ix+1,iy)*ux*(1-uy) + _hash(ix,iy+1)*(1-ux)*uy + _hash(ix+1,iy+1)*ux*uy
}
function _fbm(x, y) {
  return _snoise(x,y)*0.50 + _snoise(x*2,y*2)*0.25 + _snoise(x*4,y*4)*0.125 + _snoise(x*8,y*8)*0.0625
}

function SandGround() {
  const diffuse = useTexture('/textures/sand/gravelly_sand_diff_4k.jpg')
  const [normal, roughness] = useLoader(EXRLoader, [
    '/textures/sand/gravelly_sand_nor_gl_4k.exr',
    '/textures/sand/gravelly_sand_rough_4k.exr',
  ])

  const geo = useMemo(() => {
    const g = new PlaneGeometry(500, 500, 300, 300)
    const pos = g.attributes.position
    for (let i = 0; i < pos.count; i++) {
      pos.setZ(i, (_fbm(pos.getX(i) / 25, pos.getY(i) / 25) - 0.5) * 3.0)
    }
    pos.needsUpdate = true
    g.computeVertexNormals()
    return g
  }, [])

  useMemo(() => {
    for (const t of [diffuse, normal, roughness]) {
      t.wrapS = t.wrapT = RepeatWrapping
      t.repeat.set(30, 30)
    }
  }, [diffuse, normal, roughness])

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow geometry={geo}>
      <meshStandardMaterial map={diffuse} normalMap={normal} roughnessMap={roughness} roughness={1} metalness={0} />
    </mesh>
  )
}

function Floor() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[500, 500]} />
      <MeshReflectorMaterial
        mirror={0.5}
        roughness={0.7}
        blur={[300, 100]}
        mixBlur={1}
        mixStrength={0.5}
        resolution={1024}
        depthScale={1}
        minDepthThreshold={0.85}
        color="#202020"
      />
    </mesh>
  )
}

function SceneGrid() {
  return (
    <Grid
      position={[0, 0.01, 0]}
      cellSize={1} cellThickness={0.5} cellColor="#3a3a3a"
      sectionSize={10} sectionThickness={1} sectionColor="#555"
      fadeDistance={80} infiniteGrid
    />
  )
}

// ─── Desert rocks ─────────────────────────────────────────────────────────────
// Each entry: [x, z, scaleX, scaleY, scaleZ, rotY]
// Avoid existing objects: desk@[-4,0,-6], cubes@[2,-10],[8,-4],[-8,-12]
const ROCK_DATA = [
  // Left canyon wall
  [-22,   -8, 2.5, 1.5, 2.2, 0.8],
  [-25,   -5, 1.8, 1.2, 1.6, 2.3],
  [-28,  -12, 3.0, 1.8, 2.8, 1.1],
  [-20,   -3, 1.2, 0.8, 1.1, 0.4],
  [-18,  -16, 2.2, 1.4, 2.0, 3.0],
  [-30,  -18, 1.5, 1.0, 1.4, 1.7],
  [-32,   -9, 2.8, 1.7, 2.5, 0.5],
  [-26,  -22, 1.4, 0.9, 1.3, 2.8],
  [-35,  -25, 3.5, 2.0, 3.0, 0.3],
  [-40,  -15, 2.0, 1.3, 1.8, 1.9],
  [-42,  -30, 4.0, 2.5, 3.5, 2.4],
  [-38,  -35, 1.8, 1.1, 1.6, 0.7],
  [-45,  -40, 2.5, 1.5, 2.2, 1.3],
  [-50,  -20, 3.2, 2.0, 2.8, 0.9],
  [-48,  -10, 1.6, 1.0, 1.5, 3.2],
  // Right canyon wall
  [ 20,   -8, 2.8, 1.7, 2.5, 2.1],
  [ 24,   -5, 1.6, 1.0, 1.4, 0.6],
  [ 27,  -12, 3.5, 2.0, 3.0, 3.2],
  [ 22,  -18, 1.9, 1.2, 1.7, 1.4],
  [ 30,   -8, 2.2, 1.4, 2.0, 0.2],
  [ 32,  -20, 1.4, 0.9, 1.3, 2.6],
  [ 35,  -14, 3.0, 1.8, 2.6, 1.0],
  [ 28,  -25, 1.7, 1.1, 1.5, 3.5],
  [ 38,  -30, 4.2, 2.5, 3.8, 0.8],
  [ 42,  -18, 2.3, 1.4, 2.1, 2.0],
  [ 45,  -35, 3.0, 1.8, 2.7, 1.5],
  [ 40,  -45, 1.9, 1.2, 1.7, 0.4],
  [ 48,  -12, 2.0, 1.3, 1.8, 2.7],
  // Mid-ground scatter
  [  5,  -14, 1.5, 1.0, 1.3, 0.7],
  [ -5,  -20, 1.8, 1.1, 1.6, 2.2],
  [ 10,  -22, 2.0, 1.3, 1.8, 1.5],
  [-12,  -28, 2.5, 1.5, 2.2, 3.1],
  [ 15,  -30, 1.6, 1.0, 1.4, 0.9],
  [ -3,  -35, 2.8, 1.7, 2.5, 2.7],
  [  7,  -38, 1.4, 0.9, 1.2, 1.2],
  [-14,  -42, 3.0, 1.8, 2.7, 0.5],
  [ 12,  -45, 2.2, 1.4, 2.0, 3.4],
  [ -8,  -50, 1.9, 1.2, 1.7, 1.8],
  [ 18,  -52, 2.4, 1.5, 2.2, 0.6],
  [-18,  -55, 1.7, 1.1, 1.5, 2.3],
  [  3,  -58, 2.0, 1.3, 1.8, 1.0],
  // Small foreground rocks (texture detail near player)
  [ -6,   -8, 0.6, 0.4, 0.5, 1.2],
  [  3,   -7, 0.8, 0.5, 0.7, 2.5],
  [-16,  -10, 0.7, 0.5, 0.6, 0.3],
  [ 14,   -9, 0.9, 0.6, 0.8, 1.8],
  [ -2,  -11, 0.5, 0.3, 0.4, 3.0],
  [ 16,  -13, 0.6, 0.4, 0.5, 0.8],
  [-11,  -13, 0.7, 0.5, 0.6, 2.0],
  // Small rock clusters in distance
  [-20,  -44, 0.8, 0.5, 0.7, 0.9],
  [-22,  -46, 0.5, 0.3, 0.4, 2.1],
  [-18,  -48, 0.6, 0.4, 0.5, 1.6],
  [ 22,  -42, 0.9, 0.6, 0.8, 0.4],
  [ 25,  -44, 0.6, 0.4, 0.5, 2.9],
  [ 20,  -46, 0.7, 0.5, 0.6, 1.3],
  [  8,  -30, 0.5, 0.3, 0.4, 0.5],
  [ -6,  -32, 0.7, 0.4, 0.6, 3.1],
  // Deep horizon (large boulders for depth)
  [-20,  -65, 4.5, 2.8, 4.0, 0.6],
  [ 15,  -70, 5.0, 3.0, 4.5, 2.3],
  [ -5,  -75, 3.8, 2.3, 3.5, 1.1],
  [ 30,  -65, 4.0, 2.5, 3.6, 0.4],
  [-35,  -70, 3.5, 2.2, 3.2, 2.8],
  [  0,  -80, 4.8, 3.0, 4.2, 1.7],
  [-25,  -85, 3.0, 1.8, 2.8, 0.9],
  [ 20,  -80, 4.0, 2.4, 3.6, 3.1],
  // Anchor boulders — large statement rocks
  [-12,  -35, 3.2, 2.0, 2.8, 0.7],
  [ 18,  -40, 3.0, 1.8, 2.6, 2.2],
  [-55,  -50, 6.0, 4.0, 5.5, 0.4],
  [ 55,  -45, 7.0, 4.5, 6.0, 2.1],
  [  0,  -90, 8.0, 5.0, 7.0, 1.5],
  [-30,  -55, 5.0, 3.2, 4.5, 0.8],
  [ 35,  -60, 5.5, 3.5, 5.0, 1.9],
  // Behind player
  [-15,   10, 2.0, 1.3, 1.8, 1.4],
  [ 18,    8, 1.8, 1.1, 1.6, 2.8],
  [-25,   15, 3.0, 1.8, 2.7, 0.3],
  [ 30,   12, 2.4, 1.5, 2.2, 1.9],
  [ 10,   18, 1.5, 0.9, 1.3, 3.5],
  [ -8,   20, 2.0, 1.3, 1.8, 0.7],
  [ 42,    8, 3.5, 2.2, 3.2, 1.2],
  [-38,   10, 2.8, 1.7, 2.5, 2.5],
]

const PLAYER_RADIUS = 0.45

// [minX, maxX, minZ, maxZ, topY]
const BOX_COLLIDERS = [
  [ 1.5,  2.5, -10.5,  -9.5, 1.0 ], // blue cube
  [ 7.5,  8.5,  -4.5,  -3.5, 1.0 ], // orange cube
  [-8.5, -7.5, -12.5, -11.5, 1.0 ], // brown cube
  [-5.2, -2.8,  -6.6,  -5.4, 0.75], // desk (approximate)
  // parkour course
  [12.25, 15.75, -1.75,  1.75,  2],
  [18.75, 21.25, -5.25, -2.75,  5],
  [14,    16,    -9,    -7,     8],
  [19,    21,    -13,   -11,   11],
  [14,    16,    -17,   -15,   14],
  [18.75, 21.25, -21.25,-18.75,17],
]

const PARKOUR_PLATFORMS = [
  { pos: [14,   1,    0], size: [3.5, 2,  3.5], color: '#d4c5a0', roughness: 0.9  },
  { pos: [20,   2.5, -4], size: [2.5, 5,  2.5], color: '#b8a88a', roughness: 0.85 },
  { pos: [15,   4,   -8], size: [2,   8,  2],   color: '#9a8870', roughness: 0.8  },
  { pos: [20,   5.5,-12], size: [2,   11, 2],   color: '#806855', roughness: 0.8  },
  { pos: [15,   7,  -16], size: [2,   14, 2],   color: '#663f2e', roughness: 0.75 },
  { pos: [20,   8.5,-20], size: [2.5, 17, 2.5], color: '#4a2d1e', roughness: 0.7  },
]

// [cx, cz, radius, topY] — skip tiny pebbles (sx < 0.9)
const ROCK_COLLIDERS = ROCK_DATA
  .filter(([,, sx,, sz]) => Math.max(sx, sz) >= 0.9)
  .map(([x, z, sx, sy, sz]) => [x, z, Math.max(sx, sz) * 0.72, sy * 1.45 - 0.3])

// [cx, cy, cz, radius] — 3-D bounding sphere for laser shield checks
const ROCK_SHIELD_COLLIDERS = ROCK_DATA
  .filter(([,, sx,, sz]) => Math.max(sx, sz) >= 0.9)
  .map(([x, z, sx, sy, sz]) => [x, sy * 0.45 - 0.3, z, Math.max(sx, sy, sz) * 0.82])

function _boxWallActive(pos, minX, maxX, minZ, maxZ, topY) {
  if (pos.x > minX && pos.x < maxX && pos.z > minZ && pos.z < maxZ) return false
  if (pos.y >= topY + 1.7) return false
  const x0 = minX - PLAYER_RADIUS, x1 = maxX + PLAYER_RADIUS
  const z0 = minZ - PLAYER_RADIUS, z1 = maxZ + PLAYER_RADIUS
  return pos.x > x0 && pos.x < x1 && pos.z > z0 && pos.z < z1
}

// Per-scene room walls — set by enclosed scenes, cleared on unmount
let _roomWalls = []

function resolveBoxX(pos) {
  for (const [minX, maxX, minZ, maxZ, topY] of BOX_COLLIDERS) {
    if (!_boxWallActive(pos, minX, maxX, minZ, maxZ, topY)) continue
    const x0 = minX - PLAYER_RADIUS, x1 = maxX + PLAYER_RADIUS
    pos.x = pos.x < (x0 + x1) * 0.5 ? x0 : x1
  }
  for (const [minX, maxX, minZ, maxZ, topY] of _roomWalls) {
    if (!_boxWallActive(pos, minX, maxX, minZ, maxZ, topY)) continue
    const x0 = minX - PLAYER_RADIUS, x1 = maxX + PLAYER_RADIUS
    pos.x = pos.x < (x0 + x1) * 0.5 ? x0 : x1
  }
}

function resolveBoxZ(pos) {
  for (const [minX, maxX, minZ, maxZ, topY] of BOX_COLLIDERS) {
    if (!_boxWallActive(pos, minX, maxX, minZ, maxZ, topY)) continue
    const z0 = minZ - PLAYER_RADIUS, z1 = maxZ + PLAYER_RADIUS
    pos.z = pos.z < (z0 + z1) * 0.5 ? z0 : z1
  }
  for (const [minX, maxX, minZ, maxZ, topY] of _roomWalls) {
    if (!_boxWallActive(pos, minX, maxX, minZ, maxZ, topY)) continue
    const z0 = minZ - PLAYER_RADIUS, z1 = maxZ + PLAYER_RADIUS
    pos.z = pos.z < (z0 + z1) * 0.5 ? z0 : z1
  }
}

function resolveRocks(pos) {
  for (const [cx, cz, r, topY] of ROCK_COLLIDERS) {
    const dx = pos.x - cx, dz = pos.z - cz
    const distSq = dx * dx + dz * dz
    if (distSq < r * r) continue          // inside footprint — ground snap handles it
    if (pos.y >= topY + 1.7) continue     // clearly on top — skip
    const minDist = r + PLAYER_RADIUS
    if (distSq < minDist * minDist) {
      const dist = Math.sqrt(distSq) || 0.001
      pos.x = cx + (dx / dist) * minDist
      pos.z = cz + (dz / dist) * minDist
    }
  }
}

// Returns the highest surface Y beneath the player from any object, or -Infinity
function getObjectSurfaceY(pos) {
  let best = -Infinity
  for (const [minX, maxX, minZ, maxZ, topY] of BOX_COLLIDERS) {
    if (pos.x > minX && pos.x < maxX && pos.z > minZ && pos.z < maxZ)
      best = Math.max(best, topY)
  }
  for (const [minX, maxX, minZ, maxZ, topY] of _roomWalls) {
    if (pos.x > minX && pos.x < maxX && pos.z > minZ && pos.z < maxZ)
      best = Math.max(best, topY)
  }
  for (const [cx, cz, r, topY] of ROCK_COLLIDERS) {
    const dx = pos.x - cx, dz = pos.z - cz
    if (dx * dx + dz * dz < r * r)
      best = Math.max(best, topY)
  }
  return best
}

const _dummy = new Object3D()

function Rocks() {
  const meshRef = useRef()
  const diffuse  = useTexture('/textures/rocks/aerial_rocks_02_diff_4k.jpg')
  const roughTex = useTexture('/textures/rocks/aerial_rocks_02_rough_4k.jpg')
  const [normal] = useLoader(EXRLoader, ['/textures/rocks/aerial_rocks_02_nor_gl_4k.exr'])

  useMemo(() => {
    for (const t of [diffuse, roughTex, normal]) {
      t.wrapS = t.wrapT = RepeatWrapping
      t.repeat.set(1, 1)
    }
  }, [diffuse, roughTex, normal])

  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    ROCK_DATA.forEach(([x, z, sx, sy, sz, rotY], i) => {
      _dummy.position.set(x, sy * 0.45 - 0.3, z)
      _dummy.scale.set(sx, sy, sz)
      _dummy.rotation.set(0.1, rotY, 0.05)
      _dummy.updateMatrix()
      mesh.setMatrixAt(i, _dummy.matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
  }, [])

  return (
    <instancedMesh ref={meshRef} args={[null, null, ROCK_DATA.length]} castShadow receiveShadow>
      <icosahedronGeometry args={[1, 1]} />
      <meshStandardMaterial
        map={diffuse} normalMap={normal} roughnessMap={roughTex}
        roughness={1} metalness={0} flatShading
      />
    </instancedMesh>
  )
}

function Objects() {
  return (
    <>
      <Suspense fallback={null}>
        <DeskModel position={[-4, 0, -6]} scale={1} />
      </Suspense>
      {CUBES.map(({ pos, color, metalness, roughness, emissive, emissiveIntensity }, i) => (
        <mesh key={i} position={pos} castShadow receiveShadow>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial
            color={color} metalness={metalness} roughness={roughness}
            emissive={emissive} emissiveIntensity={emissiveIntensity}
          />
        </mesh>
      ))}
      {PARKOUR_PLATFORMS.map(({ pos, size, color, roughness }, i) => (
        <mesh key={'pk' + i} position={pos} castShadow receiveShadow>
          <boxGeometry args={size} />
          <meshStandardMaterial color={color} roughness={roughness} metalness={0} />
        </mesh>
      ))}
      <Rocks />
    </>
  )
}

// ─── Orion constellation ─────────────────────────────────────────────────────

const ORION_STARS = [
  { pos: [-14, 95, -150], size: 1.4, color: '#ffaa77', intensity: 5.0 }, // Betelgeuse
  { pos: [  14, 92, -150], size: 1.0, color: '#c8d8ff', intensity: 4.0 }, // Bellatrix
  { pos: [  -8, 72, -150], size: 0.8, color: '#ddeeff', intensity: 3.5 }, // Mintaka
  { pos: [   0, 70, -150], size: 0.9, color: '#eef2ff', intensity: 4.0 }, // Alnilam
  { pos: [   8, 73, -150], size: 0.8, color: '#ddeeff', intensity: 3.5 }, // Alnitak
  { pos: [  -9, 52, -150], size: 0.9, color: '#c8d8ff', intensity: 3.5 }, // Saiph
  { pos: [  16, 50, -150], size: 1.3, color: '#e8f0ff', intensity: 5.5 }, // Rigel
]

function Orion() {
  return (
    <>
      {ORION_STARS.map(({ pos, size, color, intensity }, i) => (
        <mesh key={i} position={pos}>
          <sphereGeometry args={[size, 8, 8]} />
          <meshStandardMaterial color="black" emissive={color} emissiveIntensity={intensity} toneMapped={false} />
        </mesh>
      ))}
    </>
  )
}

// ─── World physics colliders (for car) ───────────────────────────────────────

function WorldColliders() {
  return (
    <>
      {BOX_COLLIDERS.map(([minX, maxX, minZ, maxZ, topY], i) => (
        <RigidBody key={'b' + i} type="fixed"
          position={[(minX + maxX) / 2, topY / 2, (minZ + maxZ) / 2]}
        >
          <CuboidCollider args={[(maxX - minX) / 2, topY / 2, (maxZ - minZ) / 2]} />
        </RigidBody>
      ))}
      {ROCK_COLLIDERS.map(([cx, cz, radius, topY], i) => (
        <RigidBody key={'r' + i} type="fixed" position={[cx, 0, cz]}>
          <CylinderCollider args={[topY / 2, radius]} position={[0, topY / 2, 0]} />
        </RigidBody>
      ))}
    </>
  )
}

// ─── Car ─────────────────────────────────────────────────────────────────────

function Car() {
  const { camera } = useThree()
  const bodyRef = useRef()
  const carAngle = useRef(0)
  const carSpeed = useRef(0)
  const carKeys = useRef({ w: false, a: false, s: false, d: false })
  const { inCarRef, nearCarRef } = useContext(CarContext)

  useEffect(() => {
    const handle = (e) => {
      if (document.activeElement?.tagName === 'INPUT') return
      const down = e.type === 'keydown'
      if (e.code === 'KeyW') carKeys.current.w = down
      if (e.code === 'KeyS') carKeys.current.s = down
      if (e.code === 'KeyA') carKeys.current.a = down
      if (e.code === 'KeyD') carKeys.current.d = down
      if (e.code === 'KeyE' && down) {
        if (inCarRef.current) {
          inCarRef.current = false
          carKeys.current = { w: false, a: false, s: false, d: false }
          carSpeed.current *= 0.1
          if (bodyRef.current) {
            const pos = bodyRef.current.translation()
            const sideX = Math.cos(carAngle.current)
            const sideZ = -Math.sin(carAngle.current)
            camera.position.set(pos.x + sideX * 2.5, pos.y + 1.7, pos.z + sideZ * 2.5)
          }
        } else if (nearCarRef.current) {
          inCarRef.current = true
        }
      }
    }
    window.addEventListener('keydown', handle)
    window.addEventListener('keyup', handle)
    return () => { window.removeEventListener('keydown', handle); window.removeEventListener('keyup', handle) }
  }, [inCarRef, nearCarRef, camera])

  useFrame((_, delta) => {
    if (!bodyRef.current) return

    const pos = bodyRef.current.translation()
    const dx = camera.position.x - pos.x
    const dz = camera.position.z - pos.z
    nearCarRef.current = !inCarRef.current && Math.sqrt(dx * dx + dz * dz) < CAR_ENTER_DIST

    if (!inCarRef.current) {
      _carHUD.inCar = false
      const vel = bodyRef.current.linvel()
      bodyRef.current.setLinvel({ x: vel.x * 0.85, y: vel.y, z: vel.z * 0.85 }, true)
      return
    }

    const { w, a, s, d } = carKeys.current
    const steer = (a ? 1 : 0) - (d ? 1 : 0)
    if (Math.abs(carSpeed.current) > 0.3) {
      carAngle.current += steer * CAR_TURN_SPEED * delta * Math.sign(carSpeed.current)
    }

    const throttle = (w ? 1 : 0) - (s ? 1 : 0)
    carSpeed.current += throttle * CAR_ACCELERATION * delta
    carSpeed.current -= carSpeed.current * CAR_DRAG * delta
    carSpeed.current = Math.max(-CAR_REVERSE_MAX, Math.min(CAR_MAX_SPEED, carSpeed.current))

    const vx = Math.sin(carAngle.current) * carSpeed.current
    const vz = Math.cos(carAngle.current) * carSpeed.current
    bodyRef.current.setLinvel({ x: vx, y: bodyRef.current.linvel().y, z: vz }, true)

    const hy = carAngle.current / 2
    bodyRef.current.setRotation({ x: 0, y: Math.sin(hy), z: 0, w: Math.cos(hy) }, true)

    camera.position.x = pos.x - Math.sin(carAngle.current) * 0.3
    camera.position.y = pos.y + 0.9
    camera.position.z = pos.z - Math.cos(carAngle.current) * 0.3

    _carHUD.speed = Math.abs(carSpeed.current) * CAR_MPH_SCALE
    _carHUD.inCar = true
  })

  const WHEEL_POSITIONS = [[-1.05, -0.25, 1.5], [1.05, -0.25, 1.5], [-1.05, -0.25, -1.5], [1.05, -0.25, -1.5]]

  return (
    <RigidBody ref={bodyRef} position={[6, 1, 2]}
      enabledRotations={[false, true, false]}
      linearDamping={0.4} angularDamping={20} mass={600} restitution={0.05} friction={0.9}
    >
      {/* Chassis */}
      <mesh castShadow receiveShadow>
        <boxGeometry args={[2, 0.65, 4.2]} />
        <meshStandardMaterial color="#c0392b" metalness={0.7} roughness={0.2} />
      </mesh>
      {/* Cabin */}
      <mesh castShadow receiveShadow position={[0, 0.62, 0.15]}>
        <boxGeometry args={[1.75, 0.72, 2.3]} />
        <meshStandardMaterial color="#962d22" metalness={0.5} roughness={0.35} />
      </mesh>
      {/* Windshield */}
      <mesh position={[0, 0.62, 1.42]}>
        <boxGeometry args={[1.7, 0.68, 0.08]} />
        <meshStandardMaterial color="#aaddff" transparent opacity={0.35} roughness={0} metalness={0.1} />
      </mesh>
      {/* Wheels */}
      {WHEEL_POSITIONS.map(([x, y, z], i) => (
        <mesh key={i} position={[x, y, z]} rotation={[0, 0, Math.PI / 2]} castShadow>
          <cylinderGeometry args={[0.38, 0.38, 0.28, 14]} />
          <meshStandardMaterial color="#111" roughness={0.95} />
        </mesh>
      ))}
    </RigidBody>
  )
}

// ─── Zombie ──────────────────────────────────────────────────────────────────

const PRAYING_POSITIONS = [
  [5, 0, -12],
  [-8, 0, -18],
  [14, 0, -8],
]

function PrayingGuy({ position }) {
  const group = useRef()
  const fbx = useLoader(FBXLoader, '/models/Praying.fbx')
  const clone = useMemo(() => fbx.clone(true), [fbx])
  const { actions } = useAnimations(clone.animations, group)

  useEffect(() => {
    const first = Object.values(actions)[0]
    if (first) first.play()
  }, [actions])

  return <primitive ref={group} object={clone} position={position} scale={0.022} castShadow />
}

function PrayingGuys() {
  return (
    <Suspense fallback={null}>
      {PRAYING_POSITIONS.map((pos, i) => <PrayingGuy key={i} position={pos} />)}
    </Suspense>
  )
}

// ─── Venice Sunset ────────────────────────────────────────────────────────────

function SunsetScene() {
  const [sun, setSun] = useState(null)
  const inCarRef = useRef(false)
  const nearCarRef = useRef(false)
  const carCtx = useMemo(() => ({ inCarRef, nearCarRef }), [])

  return (
    <CarContext.Provider value={carCtx}>
    <>
      <fogExp2 attach="fog" args={['#c8a890', 0.03]} />

      <mesh ref={setSun} position={[15, 20, 10]} visible={false}>
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial color="#ffeecc" />
      </mesh>

      <Environment preset="sunset" background>
        <Lightformer visible={false} form="rect" intensity={1.5} color="#c8d8ff"
          position={[0, 10, -5]} rotation={[Math.PI / 2, 0, 0]} scale={[12, 6, 1]} />
        <Lightformer visible={false} form="rect" intensity={1} color="#ddeeff"
          position={[10, 4, -4]} rotation={[0, -Math.PI / 2, 0]} scale={[6, 3, 1]} />
        <Lightformer visible={false} form="rect" intensity={2} color="#ff9944"
          position={[8, 6, 8]} rotation={[-0.3, -0.8, 0]} scale={[8, 4, 1]} />
      </Environment>

      <directionalLight
        position={[15, 20, 10]} intensity={2} color="#ffffff" castShadow
        shadow-mapSize-width={4096} shadow-mapSize-height={4096}
        shadow-camera-near={0.5} shadow-camera-far={60}
        shadow-camera-left={-15} shadow-camera-right={15}
        shadow-camera-top={15} shadow-camera-bottom={-15}
        shadow-bias={-0.0001}
      />

      <Suspense fallback={null}>
        <SandGround />
      </Suspense>

      <Sparkles count={50} scale={20} size={2} speed={0.2}
        opacity={0.4} color="#ffcc88" position={[0, 3, -8]} />

      <Objects />

      <EffectComposer multisampling={0}>
        <N8AO aoRadius={1.0} intensity={2} aoSamples={16}
          denoiseSamples={4} denoiseRadius={12} distanceFalloff={1} depthAwareUpsampling />
        <SMAA />
        <Bloom luminanceThreshold={1.2} luminanceSmoothing={0.025} intensity={0.4} mipmapBlur />
        {sun && (
          <GodRays sun={sun} samples={60} density={0.96} decay={0.92}
            weight={0.5} exposure={0.6} clampMax={1} />
        )}
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      </EffectComposer>

      <Player />
      <Multiplayer />
      <Shooter />
      <Coins />
      <PrayingGuys />

      <Physics gravity={[0, -20, 0]}>
        <RigidBody type="fixed">
          <CuboidCollider args={[250, 0.5, 250]} position={[0, -0.5, 0]} />
        </RigidBody>
        <WorldColliders />
        <Car />
      </Physics>
    </>
    </CarContext.Provider>
  )
}

// ─── Starry Night ─────────────────────────────────────────────────────────────

function NightWater() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[500, 500]} />
      <MeshReflectorMaterial
        mirror={0.8}
        roughness={0.5}
        blur={[300, 100]}
        mixBlur={0.8}
        mixStrength={0.8}
        resolution={1024}
        depthScale={1.2}
        minDepthThreshold={0.4}
        color="#0a1828"
        metalness={0.6}
      />
    </mesh>
  )
}

function NightScene() {
  return (
    <>
      <Environment files="/envs/rogland_clear_night_2k.exr" background environmentIntensity={0.25} />

      <ambientLight intensity={0.06} color="#7090c0" />

      <directionalLight
        position={[15, 4, -10]} intensity={0.6} color="#4488ff" castShadow
        shadow-mapSize-width={4096} shadow-mapSize-height={4096}
        shadow-camera-near={0.1} shadow-camera-far={80}
        shadow-camera-left={-20} shadow-camera-right={20}
        shadow-camera-top={20} shadow-camera-bottom={-20}
        shadow-bias={-0.0001} shadow-radius={1}
      />

      <pointLight position={[15, 20, -10]} intensity={1} distance={100} color="#ffffff" />

      <Suspense fallback={null}>
        <SandGround />
      </Suspense>

      <Sparkles count={35} scale={22} size={1.5} speed={0.08}
        opacity={0.2} color="#aac8ff" position={[0, 4, -8]} />

      <Objects />

      <EffectComposer multisampling={0}>
        <N8AO aoRadius={1.0} intensity={1.5} aoSamples={16}
          denoiseSamples={4} denoiseRadius={5} distanceFalloff={1} depthAwareUpsampling />
        <SMAA />
        <Bloom luminanceThreshold={0.7} luminanceSmoothing={0.025} intensity={2.0} mipmapBlur />
        <ToneMapping mode={ToneMappingMode.REINHARD2_ADAPTIVE} />
      </EffectComposer>

      <Player />
      <Multiplayer />
      <Shooter />
      <Coins />
    </>
  )
}

// ─── Snowfall (Stronghold) ────────────────────────────────────────────────────

// [minX, maxX, minZ, maxZ, topY] — walls + floor for the enclosed room
const SNOWFALL_COLLIDERS = [
  [-9, 9,  8.75, 10.75, 4.5], // north wall
  [-9, 9, -10.75, -8.75, 4.5], // south wall
  [ 8.75, 10.75, -9, 9, 4.5], // east wall
  [-10.75, -8.75, -9, 9, 4.5], // west wall
  [-8.75, 8.75, -8.75, 8.75, 0], // floor
]

function ZombieModel({ position, rotation }) {
  const { scene } = useGLTF('/models/zombie/scene.gltf')
  const clone = useMemo(() => scene.clone(true), [scene])
  // Model is Z-up from its exporter, scale ~97 units tall → need 0.018 to reach ~1.75m
  return <primitive object={clone} position={position} rotation={rotation} scale={0.018} />
}

function Chandelier({ position }) {
  const lightRef = useRef()
  const t0 = useMemo(() => Math.random() * 1000, [])

  useFrame(() => {
    if (!lightRef.current) return
    const t = (performance.now() + t0) / 1000
    const flicker = Math.sin(t * 4.9) * 0.5 + Math.sin(t * 11.1) * 0.2 + Math.sin(t * 2.3) * 0.6
    lightRef.current.intensity = 10 + flicker
  })

  const candleAngles = useMemo(() => Array.from({ length: 8 }, (_, i) => (i / 8) * Math.PI * 2), [])

  return (
    <group position={position}>
      {/* Chain */}
      <mesh position={[0, 0.38, 0]}>
        <cylinderGeometry args={[0.025, 0.025, 0.75, 6]} />
        <meshStandardMaterial color="#1a1a14" roughness={0.5} metalness={0.85} />
      </mesh>
      {/* Outer ring */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.72, 0.055, 7, 28]} />
        <meshStandardMaterial color="#2c2010" roughness={0.4} metalness={0.75} />
      </mesh>
      {/* Cross bars */}
      <mesh>
        <boxGeometry args={[1.44, 0.045, 0.045]} />
        <meshStandardMaterial color="#2c2010" roughness={0.4} metalness={0.75} />
      </mesh>
      <mesh>
        <boxGeometry args={[0.045, 0.045, 1.44]} />
        <meshStandardMaterial color="#2c2010" roughness={0.4} metalness={0.75} />
      </mesh>
      {/* Candles */}
      {candleAngles.map((angle, i) => {
        const cx = Math.cos(angle) * 0.72
        const cz = Math.sin(angle) * 0.72
        return (
          <group key={i} position={[cx, -0.07, cz]}>
            <mesh>
              <cylinderGeometry args={[0.038, 0.038, 0.15, 6]} />
              <meshStandardMaterial color="#ede5cc" roughness={0.9} />
            </mesh>
            <mesh position={[0, 0.12, 0]}>
              <sphereGeometry args={[0.045, 5, 4]} />
              <meshStandardMaterial color="#ffdd55" emissive="#ffaa00" emissiveIntensity={12} toneMapped={false} />
            </mesh>
          </group>
        )
      })}
      <pointLight ref={lightRef} color="#ffcc66" intensity={10} distance={24} decay={1.1} />
    </group>
  )
}

function Torch({ position }) {
  const lightRef = useRef()
  const t0 = useMemo(() => Math.random() * 1000, [])

  useFrame(() => {
    if (!lightRef.current) return
    const t = (performance.now() + t0) / 1000
    const flicker = Math.sin(t * 7.3) * 0.18 + Math.sin(t * 13.7) * 0.12 + Math.sin(t * 3.1) * 0.22
    lightRef.current.intensity = 3.2 + flicker
  })

  return (
    <group position={position}>
      <mesh position={[0, -0.22, 0]}>
        <cylinderGeometry args={[0.04, 0.06, 0.42, 6]} />
        <meshStandardMaterial color="#3a2008" roughness={0.95} />
      </mesh>
      <mesh position={[0, 0.06, 0]}>
        <sphereGeometry args={[0.09, 6, 5]} />
        <meshStandardMaterial color="#ff7700" emissive="#ff5500" emissiveIntensity={7} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.06, 0]}>
        <sphereGeometry args={[0.16, 5, 4]} />
        <meshStandardMaterial color="#ff9900" emissive="#ff8800" emissiveIntensity={2} toneMapped={false} transparent opacity={0.25} />
      </mesh>
      <pointLight ref={lightRef} color="#ff9944" intensity={3.5} distance={16} decay={1.5} />
    </group>
  )
}

function FallingSnow() {
  const count = 280
  const { positions, speeds } = useMemo(() => {
    const positions = new Float32Array(count * 3)
    const speeds = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      positions[i * 3]     = (Math.random() - 0.5) * 16
      positions[i * 3 + 1] = Math.random() * 4.4
      positions[i * 3 + 2] = (Math.random() - 0.5) * 16
      speeds[i] = 0.28 + Math.random() * 0.38
    }
    return { positions, speeds }
  }, [])

  const ref = useRef()
  useFrame((_, delta) => {
    if (!ref.current) return
    const attr = ref.current.geometry.attributes.position
    for (let i = 0; i < count; i++) {
      const y = attr.getY(i) - speeds[i] * delta
      attr.setY(i, y < 0.05 ? 4.35 : y)
    }
    attr.needsUpdate = true
  })

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" array={positions} count={count} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial color="#d0dff5" size={0.055} transparent opacity={0.55} sizeAttenuation />
    </points>
  )
}

function SnowfallScene() {
  useEffect(() => {
    _roomWalls = SNOWFALL_COLLIDERS
    return () => { _roomWalls = [] }
  }, [])

  const stoneDark = { color: '#3a3530', roughness: 0.97, metalness: 0 }
  const stoneMid  = { color: '#302c28', roughness: 0.95, metalness: 0 }

  const torchPositions = [
    [-3.5, 2.1,  8.6], [ 3.5, 2.1,  8.6],
    [-3.5, 2.1, -8.6], [ 3.5, 2.1, -8.6],
    [ 8.6, 2.1, -3.5], [ 8.6, 2.1,  3.5],
    [-8.6, 2.1, -3.5], [-8.6, 2.1,  3.5],
  ]
  const chandelierPositions = [
    [0,    4.0,  0   ],
    [-4.5, 4.0,  4.5 ],
    [ 4.5, 4.0, -4.5 ],
    [-4.5, 4.0, -4.5 ],
    [ 4.5, 4.0,  4.5 ],
  ]

  return (
    <>
      <color attach="background" args={['#08080d']} />
      <fogExp2 attach="fog" args={['#08080d', 0.03]} />

      <ambientLight intensity={0.55} color="#6a4820" />

      {/* Floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[18, 18, 6, 6]} />
        <meshStandardMaterial {...stoneMid} />
      </mesh>

      {/* Ceiling */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 4.5, 0]}>
        <planeGeometry args={[18, 18]} />
        <meshStandardMaterial {...stoneDark} />
      </mesh>

      {/* Walls */}
      <mesh position={[0, 2.25,  9]} castShadow receiveShadow>
        <boxGeometry args={[18, 4.5, 0.5]} />
        <meshStandardMaterial {...stoneDark} />
      </mesh>
      <mesh position={[0, 2.25, -9]} castShadow receiveShadow>
        <boxGeometry args={[18, 4.5, 0.5]} />
        <meshStandardMaterial {...stoneDark} />
      </mesh>
      <mesh position={[ 9, 2.25, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.5, 4.5, 18]} />
        <meshStandardMaterial {...stoneDark} />
      </mesh>
      <mesh position={[-9, 2.25, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.5, 4.5, 18]} />
        <meshStandardMaterial {...stoneDark} />
      </mesh>

      {/* Corner pillars */}
      {[[-8.25, -8.25], [8.25, -8.25], [-8.25, 8.25], [8.25, 8.25]].map(([x, z], i) => (
        <mesh key={i} position={[x, 2.25, z]} castShadow receiveShadow>
          <boxGeometry args={[1.2, 4.5, 1.2]} />
          <meshStandardMaterial color="#2a2a2a" roughness={0.98} />
        </mesh>
      ))}

      {/* Chandeliers */}
      {chandelierPositions.map((pos, i) => <Chandelier key={i} position={pos} />)}

      {/* Torches */}
      {torchPositions.map((pos, i) => <Torch key={i} position={pos} />)}

      {/* Zombies */}
      <ZombieModel position={[ 3,  0,  3]} rotation={[0,  Math.PI * 1.25, 0]} />
      <ZombieModel position={[-4,  0, -3]} rotation={[0,  Math.PI * 0.3,  0]} />
      <ZombieModel position={[ 0,  0, -5]} rotation={[0,  0,              0]} />

      <FallingSnow />

      <EffectComposer multisampling={0}>
        <N8AO aoRadius={0.9} intensity={4} aoSamples={16}
          denoiseSamples={4} denoiseRadius={8} distanceFalloff={1} depthAwareUpsampling />
        <SMAA />
        <Bloom luminanceThreshold={0.4} luminanceSmoothing={0.025} intensity={2.5} mipmapBlur />
        <ToneMapping mode={ToneMappingMode.REINHARD2_ADAPTIVE} />
      </EffectComposer>

      <Player />
      <Multiplayer />
      <Shooter />
    </>
  )
}

// ─── Sound Engine ─────────────────────────────────────────────────────────────

let _audioCtx = null

function _getACtx() {
  if (!_audioCtx) {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    fetch('/sounds/laser.mp3')
      .then(r => r.arrayBuffer())
      .then(arr => _audioCtx.decodeAudioData(arr))
      .then(buf => { _laserAudioBuf = buf })
  }
  if (_audioCtx.state === 'suspended') _audioCtx.resume()
  return _audioCtx
}

let _laserAudioBuf = null

async function _getLaserBuf() {
  if (_laserAudioBuf) return _laserAudioBuf
  const ctx = _getACtx()
  const res = await fetch('/sounds/laser.mp3')
  const arr = await res.arrayBuffer()
  _laserAudioBuf = await ctx.decodeAudioData(arr)
  return _laserAudioBuf
}

function _playLaserBuf(detune = 0) {
  _getLaserBuf().then(buf => {
    const ctx = _getACtx()
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.detune.value = detune
    const g = ctx.createGain(); g.gain.value = 0.8
    src.connect(g); g.connect(ctx.destination)
    src.start()
  })
}

function playShoot(weaponId) {
  if (weaponId === 'machine_gun') {
    const ctx = _getACtx()
    const frames = Math.floor(ctx.sampleRate * 0.05)
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2
    const src = ctx.createBufferSource()
    src.buffer = buf
    const filt = ctx.createBiquadFilter()
    filt.type = 'bandpass'; filt.frequency.value = 1200; filt.Q.value = 0.8
    const g = ctx.createGain(); g.gain.value = 0.3
    src.connect(filt); filt.connect(g); g.connect(ctx.destination)
    src.start()
    return
  }
  if (weaponId === 'double_laser') {
    _playLaserBuf(0)
    _playLaserBuf(-150)
    return
  }
  _playLaserBuf(0)
}

function playHit() {
  const ctx = _getACtx()
  const now = ctx.currentTime
  const osc = ctx.createOscillator(); const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(200, now)
  osc.frequency.exponentialRampToValueAtTime(35, now + 0.3)
  gain.gain.setValueAtTime(0.7, now)
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35)
  osc.connect(gain); gain.connect(ctx.destination)
  osc.start(now); osc.stop(now + 0.35)
  const frames = Math.floor(ctx.sampleRate * 0.12)
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 3
  const src = ctx.createBufferSource()
  src.buffer = buf
  const ng = ctx.createGain(); ng.gain.value = 0.45
  src.connect(ng); ng.connect(ctx.destination)
  src.start()
}

function playCoin() {
  const ctx = _getACtx()
  ;[523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
    const t = ctx.currentTime + i * 0.07
    const osc = ctx.createOscillator(); const gain = ctx.createGain()
    osc.type = 'sine'; osc.frequency.value = freq
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(0.25, t + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14)
    osc.connect(gain); gain.connect(ctx.destination)
    osc.start(t); osc.stop(t + 0.15)
  })
}

function playEnemyShoot(ox, oy, oz) {
  _getLaserBuf().then(buf => {
    const ctx = _getACtx()
    const now = ctx.currentTime
    const panner = ctx.createPanner()
    panner.panningModel = 'HRTF'
    panner.distanceModel = 'inverse'
    panner.refDistance = 3
    panner.maxDistance = 60
    panner.rolloffFactor = 1.5
    if (panner.positionX) {
      panner.positionX.setValueAtTime(ox, now)
      panner.positionY.setValueAtTime(oy, now)
      panner.positionZ.setValueAtTime(oz, now)
    } else {
      panner.setPosition(ox, oy, oz)
    }
    const src = ctx.createBufferSource()
    src.buffer = buf
    const g = ctx.createGain(); g.gain.value = 0.8
    src.connect(g); g.connect(panner); panner.connect(ctx.destination)
    src.start()
  })
}

function SoundListener() {
  const { camera } = useThree()
  useFrame(() => {
    if (!_audioCtx) return
    const ctx = _audioCtx
    const l = ctx.listener
    const me = camera.matrix.elements
    if (l.positionX) {
      l.positionX.setValueAtTime(camera.position.x, ctx.currentTime)
      l.positionY.setValueAtTime(camera.position.y, ctx.currentTime)
      l.positionZ.setValueAtTime(camera.position.z, ctx.currentTime)
      l.forwardX.setValueAtTime(-me[8],  ctx.currentTime)
      l.forwardY.setValueAtTime(-me[9],  ctx.currentTime)
      l.forwardZ.setValueAtTime(-me[10], ctx.currentTime)
      l.upX.setValueAtTime(me[4], ctx.currentTime)
      l.upY.setValueAtTime(me[5], ctx.currentTime)
      l.upZ.setValueAtTime(me[6], ctx.currentTime)
    } else {
      l.setPosition(camera.position.x, camera.position.y, camera.position.z)
      l.setOrientation(-me[8], -me[9], -me[10], me[4], me[5], me[6])
    }
  })
  return null
}

// ─── Multiplayer ─────────────────────────────────────────────────────────────

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? (import.meta.env.PROD ? window.location.origin : `http://${window.location.hostname}:3001`)
const SocketContext = createContext(null)
const CarContext = createContext(null)

const CAR_MAX_SPEED    = 25
const CAR_REVERSE_MAX  = 8
const CAR_ACCELERATION = 30
const CAR_DRAG         = 1.0
const CAR_TURN_SPEED   = 1.6
const CAR_ENTER_DIST   = 4
const CAR_MPH_SCALE    = 4.5

const _carHUD = { speed: 0, inCar: false }

const PLAYER_COLORS = [
  { color: '#ff6600', emissive: '#ff3300', emissiveIntensity: 4 },
  { color: '#1a4dcc', emissive: '#0033ff', emissiveIntensity: 4 },
]

const LASER_SPEED     = 40    // units/sec
const LASER_MAX_AGE   = 1.4   // seconds before beam disappears
const LASER_LENGTH    = 3.5   // visible beam segment length
const LASER_HIT_R     = 0.32  // tight to 0.6×0.6×0.6 player cube
const LASER_MAX_RANGE = 36    // max ray reach
const LASER_COOLDOWN  = 500   // ms between shots

const WEAPON_COOLDOWNS    = { laser: 500, machine_gun: 80, double_laser: 500 }
const DOUBLE_LASER_OFFSET = 0.18

const COIN_POSITIONS = [
  [-7, -6], [4, -8], [-3, -11], [8, -13], [-9, -15],
  [1, -17], [6, -19], [-5, -21], [9, -10], [-1, -7],
]
const COIN_COLLECT_R = 0.8

const SHOP_ITEMS = [
  { id: 'double_laser', label: 'DOUBLE LASER', cost: 3, desc: 'two parallel beams' },
  { id: 'machine_gun',  label: 'MACHINE GUN',  cost: 5, desc: 'hold R to rapid-fire' },
]

const _laserQ = new Quaternion()
const _laserV = new Vector3()
const _yAxis  = new Vector3(0, 1, 0)

let _laserCounter = 0

function _perpXZ(dx, dz) {
  const len = Math.sqrt(dx * dx + dz * dz) || 1
  return [dz / len, -dx / len]
}

// Returns how far along the ray the first rock intersection occurs (or LASER_MAX_RANGE)
function getLaserMaxDist(ox, oy, oz, dx, dy, dz) {
  let minT = LASER_MAX_RANGE
  for (const [cx, cy, cz, r] of ROCK_SHIELD_COLLIDERS) {
    const wx = cx - ox, wy = cy - oy, wz = cz - oz
    const tC = wx * dx + wy * dy + wz * dz
    if (tC <= 0) continue
    const qx = wx - tC * dx, qy = wy - tC * dy, qz = wz - tC * dz
    const dSq = qx * qx + qy * qy + qz * qz
    if (dSq < r * r) {
      const tEntry = tC - Math.sqrt(r * r - dSq)
      if (tEntry > 0) minT = Math.min(minT, tEntry)
    }
  }
  return minT
}

// True if any rock sits between origin and tTarget along the ray
function rayBlockedByRocks(ox, oy, oz, dx, dy, dz, tTarget) {
  for (const [cx, cy, cz, r] of ROCK_SHIELD_COLLIDERS) {
    const wx = cx - ox, wy = cy - oy, wz = cz - oz
    const tC = wx * dx + wy * dy + wz * dz
    if (tC <= 0 || tC >= tTarget) continue
    const qx = wx - tC * dx, qy = wy - tC * dy, qz = wz - tC * dz
    if (qx * qx + qy * qy + qz * qz < r * r) return true
  }
  return false
}

function RemotePlayer({ id, colorIndex }) {
  const { dataRef } = useContext(SocketContext)
  const meshRef = useRef()
  const { color, emissive, emissiveIntensity } = PLAYER_COLORS[colorIndex % PLAYER_COLORS.length]

  useFrame((_, delta) => {
    const p = dataRef.current[id]
    if (!p || !meshRef.current) return
    const k = 1 - Math.pow(0.001, delta)
    p.x += (p.tx - p.x) * k
    p.y += (p.ty - p.y) * k
    p.z += (p.tz - p.z) * k
    meshRef.current.position.set(p.x, p.y - 1.0, p.z)
  })

  return (
    <mesh ref={meshRef} castShadow>
      <boxGeometry args={[0.6, 0.6, 0.6]} />
      <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={emissiveIntensity} roughness={0.4} metalness={0.1} />
    </mesh>
  )
}

function DyingPlayer({ id }) {
  const { dyingRef } = useContext(SocketContext)
  const meshRef = useRef()
  const spinY   = useRef(0)
  const d = dyingRef.current[id]
  if (!d) return null
  const { color, emissive, emissiveIntensity } = PLAYER_COLORS[d.colorIndex % PLAYER_COLORS.length]

  useFrame((_, delta) => {
    if (!meshRef.current) return
    const t = Math.min((performance.now() - d.diedAt) / 700, 1)
    spinY.current += delta * 10
    meshRef.current.rotation.y = spinY.current
    meshRef.current.position.set(d.x, (d.y - 1.0) + t * 1.4, d.z)
    meshRef.current.scale.setScalar(Math.max(1 - t, 0))
  })

  return (
    <mesh ref={meshRef} position={[d.x, d.y - 1.0, d.z]}>
      <boxGeometry args={[0.6, 0.6, 0.6]} />
      <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={emissiveIntensity} roughness={0.4} metalness={0.1} />
    </mesh>
  )
}

function Multiplayer() {
  const { socketRef, playerIds, dyingRef, dyingIds } = useContext(SocketContext)
  const { camera } = useThree()
  const lastSend = useRef(0)

  useFrame(() => {
    if (!socketRef.current?.connected) return
    const now = performance.now()
    if (now - lastSend.current < 33) return
    lastSend.current = now
    const me = camera.matrix.elements
    socketRef.current.emit('move', {
      x: camera.position.x, y: camera.position.y, z: camera.position.z,
      ry: Math.atan2(-me[2], -me[0]),
    })
  })

  return (
    <>
      {playerIds.map((id, i) => <RemotePlayer key={id} id={id} colorIndex={i} />)}
      {dyingIds.map(id => <DyingPlayer key={`d-${id}`} id={id} />)}
    </>
  )
}

// ─── Laser beam visual ───────────────────────────────────────────────────────

function LaserBeam({ laserData }) {
  const meshRef = useRef()

  useFrame(() => {
    if (!meshRef.current || !laserData) return
    const { ox, oy, oz, dx, dy, dz, born } = laserData
    const t    = (performance.now() - born) / 1000
    const head = Math.min(t * LASER_SPEED, laserData.maxDist ?? LASER_MAX_RANGE)
    const tail = Math.max(0, Math.min(t * LASER_SPEED - LASER_LENGTH, laserData.maxDist ?? LASER_MAX_RANGE))
    const len  = head - tail
    const mid  = (head + tail) * 0.5

    meshRef.current.position.set(ox + dx * mid, oy + dy * mid, oz + dz * mid)
    _laserV.set(dx, dy, dz)
    _laserQ.setFromUnitVectors(_yAxis, _laserV)
    meshRef.current.quaternion.copy(_laserQ)
    meshRef.current.scale.set(1, Math.max(len, 0.01), 1)
  })

  return (
    <mesh ref={meshRef}>
      <cylinderGeometry args={[0.015, 0.06, 1, 6]} />
      <meshStandardMaterial color="black" emissive={laserData.emissive} emissiveIntensity={10} toneMapped={false} />
    </mesh>
  )
}

// ─── Shooter ─────────────────────────────────────────────────────────────────

function Shooter() {
  const { socketRef, playerIds, myColorIndex, onKicked, weapons, activeWeapon } = useContext(SocketContext)
  const { camera } = useThree()
  const lasersRef       = useRef({})
  const [laserIds, setLaserIds] = useState([])
  const lastShot        = useRef(0)
  const rHeld           = useRef(false)
  const playerIdsRef    = useRef(playerIds)
  const onKickedRef     = useRef(onKicked)
  const activeWeaponRef = useRef(activeWeapon)
  const weaponsRef      = useRef(weapons)
  useEffect(() => { playerIdsRef.current = playerIds }, [playerIds])
  useEffect(() => { onKickedRef.current = onKicked }, [onKicked])
  useEffect(() => { activeWeaponRef.current = activeWeapon }, [activeWeapon])
  useEffect(() => { weaponsRef.current = weapons }, [weapons])

  const addLaser = useCallback((key, ox, oy, oz, dx, dy, dz, colorIdx) => {
    const { emissive } = PLAYER_COLORS[colorIdx % PLAYER_COLORS.length]
    const maxDist = getLaserMaxDist(ox, oy, oz, dx, dy, dz)
    const now     = performance.now()
    const laserId = `${key}-${_laserCounter++}`
    lasersRef.current[laserId] = { ox, oy, oz, dx, dy, dz, emissive, born: now, maxDist }
    setLaserIds(prev => [...prev, laserId])
    setTimeout(() => {
      delete lasersRef.current[laserId]
      setLaserIds(prev => prev.filter(x => x !== laserId))
    }, LASER_MAX_AGE * 1000 + 100)
  }, [])

  const fireCurrent = useCallback(() => {
    if (!document.pointerLockElement) return
    const now      = performance.now()
    const weaponId = weaponsRef.current[activeWeaponRef.current] ?? 'laser'
    const cooldown = WEAPON_COOLDOWNS[weaponId] ?? 500
    if (now - lastShot.current < cooldown) return
    lastShot.current = now
    playShoot(weaponId)

    const me = camera.matrix.elements
    const nx = -me[8], ny = -me[9], nz = -me[10]
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
    const dx = nx / len, dy = ny / len, dz = nz / len
    const ox = camera.position.x + dx * 0.35
    const oy = camera.position.y + dy * 0.35
    const oz = camera.position.z + dz * 0.35

    if (weaponId === 'double_laser') {
      const [px, pz] = _perpXZ(dx, dz)
      const oxA = ox + px * DOUBLE_LASER_OFFSET, ozA = oz + pz * DOUBLE_LASER_OFFSET
      const oxB = ox - px * DOUBLE_LASER_OFFSET, ozB = oz - pz * DOUBLE_LASER_OFFSET
      socketRef.current?.emit('shoot', { ox: oxA, oy, oz: ozA, dx, dy, dz })
      socketRef.current?.emit('shoot', { ox: oxB, oy, oz: ozB, dx, dy, dz })
      addLaser('local-a', oxA, oy, ozA, dx, dy, dz, myColorIndex)
      addLaser('local-b', oxB, oy, ozB, dx, dy, dz, myColorIndex)
    } else {
      socketRef.current?.emit('shoot', { ox, oy, oz, dx, dy, dz })
      addLaser('local', ox, oy, oz, dx, dy, dz, myColorIndex)
    }
  }, [camera, socketRef, myColorIndex, addLaser])

  // R key down/up — shoot (machine_gun fires via useFrame; others fire on keydown)
  useEffect(() => {
    const down = (e) => {
      if (e.code !== 'KeyR') return
      if (document.activeElement?.tagName === 'INPUT') return
      rHeld.current = true
      const weaponId = weaponsRef.current[activeWeaponRef.current] ?? 'laser'
      if (weaponId !== 'machine_gun') fireCurrent()
    }
    const up = (e) => { if (e.code === 'KeyR') rHeld.current = false }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [fireCurrent])

  // Machine gun continuous fire
  useFrame(() => {
    if (weaponsRef.current[activeWeaponRef.current] === 'machine_gun' && rHeld.current) {
      fireCurrent()
    }
  })

  // Receive shots from other players
  useEffect(() => {
    const socket = socketRef.current
    if (!socket) return
    const handler = ({ id, ox, oy, oz, dx, dy, dz }) => {
      const idx = playerIdsRef.current.indexOf(id)
      addLaser(id, ox, oy, oz, dx, dy, dz, idx >= 0 ? idx : 0)
      playEnemyShoot(ox, oy, oz)

      // Ray–sphere hit check against my camera position
      const wx = camera.position.x - ox
      const wy = (camera.position.y - 1.0) - oy
      const wz = camera.position.z - oz
      const tClosest = wx * dx + wy * dy + wz * dz
      if (tClosest > 0 && tClosest < LASER_MAX_RANGE) {
        const qx = wx - tClosest * dx
        const qy = wy - tClosest * dy
        const qz = wz - tClosest * dz
        if (qx * qx + qy * qy + qz * qz < LASER_HIT_R * LASER_HIT_R) {
          if (!rayBlockedByRocks(ox, oy, oz, dx, dy, dz, tClosest)) {
            onKickedRef.current?.()
          }
        }
      }
    }
    socket.on('shoot', handler)
    return () => socket.off('shoot', handler)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return laserIds.map(id => {
    const data = lasersRef.current[id]
    return data ? <LaserBeam key={id} laserData={data} /> : null
  })
}

// ─── Coins ───────────────────────────────────────────────────────────────────

function CoinMesh({ x, y, z }) {
  const meshRef = useRef()
  useFrame((_, delta) => {
    if (!meshRef.current) return
    meshRef.current.rotation.y += delta * 1.8
    meshRef.current.position.y = y + Math.sin(performance.now() / 600) * 0.08
  })
  return (
    <mesh ref={meshRef} position={[x, y, z]}>
      <torusGeometry args={[0.18, 0.055, 8, 24]} />
      <meshStandardMaterial color="#ffd700" emissive="#ffd700" emissiveIntensity={3}
        metalness={0.9} roughness={0.15} toneMapped={false} />
    </mesh>
  )
}

function Coins() {
  const { collectCoin, collectedCoins } = useContext(SocketContext)
  const { camera } = useThree()
  const collectedRef = useRef(collectedCoins)
  useEffect(() => { collectedRef.current = collectedCoins }, [collectedCoins])

  useFrame(() => {
    const cx = camera.position.x, cz = camera.position.z
    COIN_POSITIONS.forEach(([x, z], idx) => {
      if (collectedRef.current.has(idx)) return
      const dx = cx - x, dz = cz - z
      if (dx * dx + dz * dz < COIN_COLLECT_R * COIN_COLLECT_R) collectCoin(idx)
    })
  })

  return COIN_POSITIONS.map(([x, z], idx) => {
    if (collectedCoins.has(idx)) return null
    const y = (_fbm(x / 25, -z / 25) - 0.5) * 3.0 + 0.35
    return <CoinMesh key={idx} x={x} y={y} z={z} />
  })
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

function ChatBox() {
  const { myId, messages, sendChat, playerIds } = useContext(SocketContext)
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const inputRef = useRef()

  useEffect(() => {
    const onKey = (e) => {
      if (e.code === 'KeyT' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault()
        document.exitPointerLock()
        setOpen(true)
        setTimeout(() => inputRef.current?.focus(), 30)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const send = () => {
    const text = input.trim()
    if (text) sendChat(text)
    setInput('')
  }

  const labelFor = (id) => {
    if (id === myId) return { label: 'You', color: 'rgba(255,255,255,0.85)' }
    const idx = playerIds.indexOf(id)
    const col = PLAYER_COLORS[idx % PLAYER_COLORS.length]
    return { label: `Player ${idx + 2}`, color: col?.color ?? '#aaa' }
  }

  return (
    <div style={{
      position: 'fixed', bottom: 48, left: 20, zIndex: 10,
      width: 290, display: 'flex', flexDirection: 'column', gap: 4,
      pointerEvents: open ? 'auto' : 'none',
    }}>
      {/* Message log */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {messages.map(msg => {
          const { label, color } = labelFor(msg.id)
          return (
            <div key={msg.key} style={{
              background: 'rgba(0,0,0,0.45)',
              backdropFilter: 'blur(8px)',
              borderRadius: 8, padding: '5px 10px',
              fontSize: 12, fontFamily: 'monospace',
              display: 'flex', gap: 6, alignItems: 'baseline',
              border: '1px solid rgba(255,255,255,0.06)',
            }}>
              <span style={{ color, fontWeight: 'bold', whiteSpace: 'nowrap' }}>{label}</span>
              <span style={{ color: 'rgba(255,255,255,0.75)', wordBreak: 'break-word' }}>{msg.text}</span>
            </div>
          )
        })}
      </div>

      {/* Input */}
      <div style={{ pointerEvents: 'auto' }}>
        {open ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.code === 'Enter') { send(); setOpen(false) }
                if (e.code === 'Escape') { setOpen(false); inputRef.current?.blur() }
              }}
              onBlur={() => setOpen(false)}
              placeholder="Say something..."
              maxLength={200}
              style={{
                flex: 1, background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)',
                borderRadius: 8, padding: '7px 10px', color: '#fff',
                fontSize: 12, fontFamily: 'monospace', outline: 'none',
              }}
            />
          </div>
        ) : (
          <div style={{ color: 'rgba(255,255,255,0.18)', fontSize: 10, fontFamily: 'monospace', letterSpacing: '0.08em' }}>
            T to chat
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Inventory HUD ───────────────────────────────────────────────────────────

function Inventory() {
  const { myColorIndex, weapons, activeWeapon, setActiveWeapon, coins, leaveRoom } = useContext(SocketContext)
  const { color } = PLAYER_COLORS[myColorIndex % PLAYER_COLORS.length]

  useEffect(() => {
    const onWheel = (e) => {
      if (!document.pointerLockElement) return
      setActiveWeapon(prev => ((prev + (e.deltaY > 0 ? 1 : -1)) % weapons.length + weapons.length) % weapons.length)
    }
    const onKey = (e) => {
      if (document.activeElement?.tagName === 'INPUT') return
      if (e.code === 'Digit1') setActiveWeapon(0)
      if (e.code === 'Digit2' && weapons.length > 1) setActiveWeapon(1)
      if (e.code === 'Digit3' && weapons.length > 2) setActiveWeapon(2)
    }
    window.addEventListener('wheel', onWheel)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('wheel', onWheel); window.removeEventListener('keydown', onKey) }
  }, [weapons.length, setActiveWeapon])

  return (
    <div style={{
      position: 'fixed', bottom: 52, left: '50%', transform: 'translateX(-50%)',
      zIndex: 20, pointerEvents: 'none',
    }}>
      <div style={{
        background: 'rgba(0,0,0,0.52)',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 10, padding: '7px 20px',
        display: 'flex', alignItems: 'center', gap: 12,
        backdropFilter: 'blur(10px)',
        boxShadow: `0 0 18px ${color}18`,
        outline: `1px solid ${color}22`,
      }}>
        {weapons.map((w, i) => (
          <div key={w} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '3px 7px', borderRadius: 6,
            background: i === activeWeapon ? `${color}22` : 'transparent',
            border: `1px solid ${i === activeWeapon ? color + '55' : 'transparent'}`,
            transition: 'background 0.12s, border-color 0.12s',
          }}>
            {/* CSS gun barrel */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, position: 'relative', height: 14 }}>
              <div style={{ width: 20, height: 5, background: 'rgba(255,255,255,0.35)', borderRadius: '1px 2px 2px 1px' }} />
              <div style={{ width: 5, height: 12, background: 'rgba(255,255,255,0.2)', borderRadius: '0 2px 2px 0', marginTop: 3 }} />
              <div style={{ position: 'absolute', bottom: -4, left: 8, width: 7, height: 7, background: 'rgba(255,255,255,0.15)', borderRadius: '0 0 2px 2px' }} />
            </div>
            <div style={{ color: i === activeWeapon ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.45)', fontSize: 11, fontFamily: 'monospace', letterSpacing: '0.1em' }}>
              {w.toUpperCase()}
            </div>
            <div style={{
              width: 9, height: 9, borderRadius: '50%',
              background: color, boxShadow: `0 0 8px ${color}, 0 0 16px ${color}66`,
            }} />
            <div style={{ color: 'rgba(255,255,255,0.25)', fontSize: 10, fontFamily: 'monospace', letterSpacing: '0.08em' }}>
              [{i + 1}]
            </div>
          </div>
        ))}
        <div style={{
          marginLeft: 4, paddingLeft: 12, borderLeft: '1px solid rgba(255,255,255,0.10)',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ffd700', boxShadow: '0 0 8px #ffd700, 0 0 16px #ffd70066' }} />
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, fontFamily: 'monospace' }}>{coins}</div>
        </div>
        <div style={{ marginLeft: 4, paddingLeft: 12, borderLeft: '1px solid rgba(255,255,255,0.10)', pointerEvents: 'auto' }}>
          <button
            onClick={leaveRoom}
            style={{
              background: 'none', border: 'none', padding: 0,
              color: 'rgba(255,255,255,0.35)', fontSize: 11, fontFamily: 'monospace',
              letterSpacing: '0.1em', cursor: 'pointer',
            }}
            onMouseEnter={e => e.target.style.color = 'rgba(255,255,255,0.85)'}
            onMouseLeave={e => e.target.style.color = 'rgba(255,255,255,0.35)'}
          >
            ← LOBBY
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Death Screen ────────────────────────────────────────────────────────────

function DeathScreen({ onRespawn, onMenu }) {
  const btn = (bg) => ({
    background: bg,
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: 10, padding: '12px 28px',
    color: 'rgba(255,255,255,0.85)', fontSize: 12,
    fontFamily: 'monospace', letterSpacing: '0.12em',
    cursor: 'pointer',
  })
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)',
      fontFamily: 'monospace',
    }}>
      <div style={{
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 20, padding: '44px 52px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20,
        backdropFilter: 'blur(24px)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
      }}>
        <div style={{ color: 'rgba(255,80,80,0.9)', fontSize: 24, letterSpacing: '0.22em', fontWeight: 300 }}>
          ELIMINATED
        </div>
        <div style={{ color: 'rgba(255,255,255,0.28)', fontSize: 11, letterSpacing: '0.12em' }}>
          you were shot
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
          <button
            onClick={onRespawn}
            style={btn('rgba(255,100,0,0.25)')}
            onMouseEnter={e => e.target.style.background = 'rgba(255,100,0,0.38)'}
            onMouseLeave={e => e.target.style.background = 'rgba(255,100,0,0.25)'}
          >
            RESPAWN
          </button>
          <button
            onClick={onMenu}
            style={btn('rgba(255,255,255,0.07)')}
            onMouseEnter={e => e.target.style.background = 'rgba(255,255,255,0.13)'}
            onMouseLeave={e => e.target.style.background = 'rgba(255,255,255,0.07)'}
          >
            RETURN TO MENU
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Lobby ────────────────────────────────────────────────────────────────────

const WORLDS = [
  { id: 'venice',   label: 'Venice Sunset', sub: 'Warm desert dusk' },
  { id: 'starry',   label: 'Starry Night',  sub: 'Clear desert midnight' },
  { id: 'snowfall', label: 'Snowfall',       sub: 'Dark stronghold' },
]

function LobbyScreen({ lobby, onJoin }) {
  const [expanded, setExpanded] = useState({})

  const card = {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: 20,
    padding: '28px 28px 22px',
    width: 260,
    display: 'flex', flexDirection: 'column', gap: 12,
    backdropFilter: 'blur(20px)',
    boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
  }

  return (
    <div style={{
      width: '100vw', height: '100vh',
      background: 'radial-gradient(ellipse at 50% 60%, #0d1a2e 0%, #060810 100%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'monospace', gap: 48,
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ color: 'rgba(255,255,255,0.9)', fontSize: 32, letterSpacing: '0.25em', fontWeight: 300 }}>
          WINTER
        </div>
        <div style={{ color: 'rgba(255,255,255,0.25)', fontSize: 11, letterSpacing: '0.15em', marginTop: 6 }}>
          CHOOSE A WORLD
        </div>
      </div>

      <div style={{ display: 'flex', gap: 20 }}>
        {WORLDS.map(({ id, label, sub }) => {
          const count = lobby[id]?.length ?? 0
          const isExpanded = expanded[id]
          return (
            <div key={id} style={card}>
              <div>
                <div style={{ color: 'rgba(255,255,255,0.88)', fontSize: 15, letterSpacing: '0.05em' }}>{label}</div>
                <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11, marginTop: 3 }}>{sub}</div>
              </div>

              <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>
                {count} {count === 1 ? 'player' : 'players'} online
              </div>

              <button
                onClick={() => setExpanded(e => ({ ...e, [id]: !e[id] }))}
                style={{
                  background: 'none', border: 'none', padding: 0,
                  color: 'rgba(255,255,255,0.28)', fontSize: 11, cursor: 'pointer',
                  textAlign: 'left', letterSpacing: '0.08em',
                }}
              >
                {isExpanded ? '▼ hide players' : '▶ show players'}
              </button>

              {isExpanded && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minHeight: 20 }}>
                  {count === 0
                    ? <div style={{ color: 'rgba(255,255,255,0.2)', fontSize: 11 }}>no one here yet</div>
                    : lobby[id].map((pid, i) => (
                        <div key={pid} style={{
                          color: i === 0 ? '#ff8844' : '#4488ff',
                          fontSize: 11, letterSpacing: '0.05em',
                        }}>
                          · Player {i + 1} <span style={{ color: 'rgba(255,255,255,0.2)' }}>{pid.slice(0, 6)}</span>
                        </div>
                      ))
                  }
                </div>
              )}

              <button
                onClick={() => onJoin(id)}
                style={{
                  marginTop: 4,
                  background: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.18)',
                  borderRadius: 10, padding: '10px 0',
                  color: 'rgba(255,255,255,0.85)', fontSize: 12,
                  letterSpacing: '0.12em', cursor: 'pointer',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => e.target.style.background = 'rgba(255,255,255,0.14)'}
                onMouseLeave={e => e.target.style.background = 'rgba(255,255,255,0.08)'}
              >
                ENTER
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Username Screen ──────────────────────────────────────────────────────────

function SnowCanvas() {
  const canvasRef = useRef(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    let animId
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight }
    resize()
    window.addEventListener('resize', resize)

    const flakes = Array.from({ length: 160 }, () => ({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      r: 0.8 + Math.random() * 2.2,
      speed: 0.4 + Math.random() * 1.2,
      drift: (Math.random() - 0.5) * 0.4,
      opacity: 0.2 + Math.random() * 0.6,
    }))

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      for (const f of flakes) {
        ctx.beginPath()
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(220,235,255,${f.opacity})`
        ctx.fill()
        f.y += f.speed
        f.x += f.drift
        if (f.y > canvas.height + 4) { f.y = -4; f.x = Math.random() * canvas.width }
        if (f.x > canvas.width + 4) f.x = -4
        if (f.x < -4) f.x = canvas.width + 4
      }
      animId = requestAnimationFrame(draw)
    }
    draw()
    return () => { cancelAnimationFrame(animId); window.removeEventListener('resize', resize) }
  }, [])
  return <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
}

function WinterTitle() {
  const WORD = 'WINTER'
  const [displayed, setDisplayed] = useState('')
  const [done, setDone] = useState(false)
  useEffect(() => {
    let i = 0
    const id = setInterval(() => {
      i++
      setDisplayed(WORD.slice(0, i))
      if (i === WORD.length) { clearInterval(id); setDone(true) }
    }, 120)
    return () => clearInterval(id)
  }, [])
  return (
    <div style={{ color: 'rgba(255,255,255,0.9)', fontSize: 32, letterSpacing: '0.25em', fontWeight: 300, display: 'inline-flex', alignItems: 'center' }}>
      {displayed}
      <span style={{
        display: 'inline-block', width: 2, height: '1.1em', background: 'rgba(255,255,255,0.75)',
        marginLeft: 3, verticalAlign: 'middle',
        animation: done ? 'blink 1s step-end infinite' : 'none',
        opacity: done ? undefined : 1,
      }} />
      <style>{`@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }`}</style>
    </div>
  )
}

function UsernameScreen({ onLogin, disabled }) {
  const [value, setValue] = useState('')

  const card = {
    position: 'relative',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: 20, padding: '28px 28px 22px', width: 260,
    display: 'flex', flexDirection: 'column', gap: 16,
    backdropFilter: 'blur(20px)',
    boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
  }

  const submit = () => {
    const name = value.trim()
    if (name) onLogin(name)
  }

  return (
    <div style={{
      position: 'relative', overflow: 'hidden',
      width: '100vw', height: '100vh',
      background: 'radial-gradient(ellipse at 50% 60%, #0d1a2e 0%, #060810 100%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'monospace', gap: 48,
    }}>
      <SnowCanvas />
      <div style={{ textAlign: 'center', position: 'relative' }}>
        <WinterTitle />
        <div style={{ color: 'rgba(255,255,255,0.25)', fontSize: 11, letterSpacing: '0.15em', marginTop: 6 }}>ENTER USERNAME</div>
      </div>
      <div style={card}>
        <input
          autoFocus
          maxLength={24}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="username"
          style={{
            background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 8, padding: '8px 12px', color: 'rgba(255,255,255,0.85)',
            fontSize: 13, fontFamily: 'monospace', outline: 'none', letterSpacing: '0.05em',
          }}
        />
        <button
          onClick={submit}
          disabled={disabled || !value.trim()}
          style={{
            background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.18)',
            borderRadius: 10, padding: '10px 0', color: 'rgba(255,255,255,0.85)',
            fontSize: 12, letterSpacing: '0.12em', cursor: 'pointer', transition: 'background 0.15s',
          }}
          onMouseEnter={e => e.target.style.background = 'rgba(255,255,255,0.14)'}
          onMouseLeave={e => e.target.style.background = 'rgba(255,255,255,0.08)'}
        >
          PLAY
        </button>
      </div>
    </div>
  )
}

// ─── CrosshairHUD ────────────────────────────────────────────────────────────

function CrosshairHUD() {
  const { weapons, activeWeapon } = useContext(SocketContext)
  const weapon = weapons[activeWeapon] ?? 'laser'
  const start  = weapon === 'double_laser' ? 5 : 7
  const s = 'rgba(255,255,255,0.72)'
  return (
    <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 10, pointerEvents: 'none' }}>
      <svg width="20" height="20">
        <line x1="0" y1="10" x2={start} y2="10" stroke={s} strokeWidth="1.5" />
        <line x1={20 - start} y1="10" x2="20" y2="10" stroke={s} strokeWidth="1.5" />
        <line x1="10" y1="0" x2="10" y2={start} stroke={s} strokeWidth="1.5" />
        <line x1="10" y1={20 - start} x2="10" y2="20" stroke={s} strokeWidth="1.5" />
        <circle cx="10" cy="10" r="1.2" fill="rgba(255,255,255,0.85)" />
      </svg>
    </div>
  )
}

// ─── Speedometer ─────────────────────────────────────────────────────────────

function Speedometer() {
  const [mph, setMph] = useState(0)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let id
    const tick = () => {
      setMph(Math.round(_carHUD.speed))
      setVisible(_carHUD.inCar)
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [])

  if (!visible) return null

  const pct = Math.min(mph / (CAR_MAX_SPEED * CAR_MPH_SCALE), 1)
  const barColor = pct < 0.5 ? '#00e5ff' : pct < 0.8 ? '#ffcc00' : '#ff4444'

  return (
    <div style={{
      position: 'fixed', bottom: 48, right: 32,
      background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 14, padding: '12px 20px', backdropFilter: 'blur(12px)',
      fontFamily: 'monospace', pointerEvents: 'none', minWidth: 110, zIndex: 20,
    }}>
      <div style={{ fontSize: 42, fontWeight: 700, color: '#fff', lineHeight: 1, letterSpacing: '-0.02em' }}>
        {mph}
      </div>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.18em', marginTop: 2 }}>
        MPH
      </div>
      <div style={{ marginTop: 8, height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct * 100}%`,
          background: barColor, borderRadius: 2,
          transition: 'width 0.05s linear, background 0.2s',
        }} />
      </div>
    </div>
  )
}

// ─── Shop ─────────────────────────────────────────────────────────────────────

function ShopScreen({ onClose }) {
  const { coins, weapons, socketRef, spendCoins } = useContext(SocketContext)

  const btnStyle = (disabled) => ({
    background: disabled ? 'rgba(255,255,255,0.03)' : 'rgba(255,200,0,0.18)',
    border: `1px solid ${disabled ? 'rgba(255,255,255,0.08)' : 'rgba(255,200,0,0.35)'}`,
    borderRadius: 10, padding: '10px 24px',
    color: disabled ? 'rgba(255,255,255,0.25)' : 'rgba(255,220,80,0.9)',
    fontSize: 12, fontFamily: 'monospace', letterSpacing: '0.12em',
    cursor: disabled ? 'not-allowed' : 'pointer',
  })

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)', fontFamily: 'monospace' }}
      onClick={onClose}
    >
      <div
        style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 20, padding: '40px 52px', display: 'flex', flexDirection: 'column', gap: 20, backdropFilter: 'blur(24px)', boxShadow: '0 20px 60px rgba(0,0,0,0.7)' }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ color: 'rgba(255,255,255,0.9)', fontSize: 18, letterSpacing: '0.2em' }}>SHOP</div>
          <div style={{ color: '#ffd700', fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ffd700', boxShadow: '0 0 8px #ffd700' }} />
            {coins} coins
          </div>
        </div>

        {SHOP_ITEMS.map(({ id, label, cost, desc }) => {
          const owned     = weapons.includes(id)
          const canAfford = coins >= cost
          const disabled  = owned || !canAfford
          return (
            <div key={id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, padding: '14px 18px', borderRadius: 12, background: owned ? 'rgba(255,255,255,0.04)' : 'transparent', border: '1px solid rgba(255,255,255,0.08)' }}>
              <div>
                <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 13, letterSpacing: '0.08em' }}>{label}</div>
                <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11, marginTop: 3 }}>{desc}</div>
                <div style={{ color: '#ffd700', fontSize: 11, marginTop: 2 }}>{cost} coins</div>
              </div>
              <button
                disabled={disabled}
                onClick={() => { socketRef.current?.emit('buy_weapon', { weapon: id }); spendCoins(cost) }}
                style={btnStyle(disabled)}
              >
                {owned ? 'OWNED' : canAfford ? 'BUY' : 'NEED MORE'}
              </button>
            </div>
          )
        })}

        <div style={{ color: 'rgba(255,255,255,0.2)', fontSize: 10, textAlign: 'center', letterSpacing: '0.08em' }}>
          B or click outside to close
        </div>
      </div>
    </div>
  )
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  const socketRef = useRef(null)
  const dataRef   = useRef({})
  const [playerIds, setPlayerIds]   = useState([])
  const [lobby, setLobby]           = useState({ venice: [], starry: [], snowfall: [] })
  const [currentRoom, setCurrentRoom] = useState(null)
  const [myId, setMyId]             = useState(null)
  const [messages, setMessages]     = useState([])
  const [hitFlash, setHitFlash]     = useState(false)
  const [showDeathScreen, setShowDeathScreen] = useState(false)
  const [username, setUsername]     = useState(null)
  const [weapons, setWeapons]       = useState([])
  const [activeWeapon, setActiveWeapon] = useState(0)
  const [coins, setCoins]           = useState(0)
  const [collectedCoins, setCollectedCoins] = useState(() => new Set())
  const [shopOpen, setShopOpen]     = useState(false)
  const dyingRef     = useRef({})
  const [dyingIds, setDyingIds]     = useState([])
  const isDeadRef    = useRef(false)
  const playerIdsRef = useRef([])
  playerIdsRef.current = playerIds

  const addMessage = (msg) => {
    const entry = { ...msg, key: `${msg.id}-${Date.now()}` }
    setMessages(prev => [...prev.slice(-19), entry])
    setTimeout(() => setMessages(prev => prev.filter(m => m.key !== entry.key)), 8000)
  }

  useEffect(() => {
    const socket = io(SERVER_URL, { transports: ['websocket'] })
    socketRef.current = socket

    socket.on('connect', () => setMyId(socket.id))
    socket.on('lobby', rooms => setLobby(rooms))
    socket.on('chat', msg => addMessage(msg))
    socket.on('user_data', ({ weapons }) => setWeapons(weapons))

    socket.on('room_players', players => {
      dataRef.current = Object.fromEntries(
        Object.entries(players).map(([id, p]) => [id, { ...p, tx: p.x, ty: p.y, tz: p.z, try: p.ry }])
      )
      setPlayerIds(Object.keys(players))
    })

    socket.on('join', ({ id, ...p }) => {
      dataRef.current[id] = { ...p, tx: p.x, ty: p.y, tz: p.z, try: p.ry }
      setPlayerIds(prev => [...prev, id])
    })

    socket.on('move', ({ id, x, y, z, ry }) => {
      const p = dataRef.current[id]
      if (p) { p.tx = x; p.ty = y; p.tz = z; p.try = ry }
    })

    socket.on('leave', id => {
      const p = dataRef.current[id]
      if (p) {
        dyingRef.current[id] = {
          x: p.x, y: p.y, z: p.z,
          colorIndex: playerIdsRef.current.indexOf(id),
          diedAt: performance.now(),
        }
        setDyingIds(prev => [...prev, id])
        setTimeout(() => {
          delete dyingRef.current[id]
          setDyingIds(prev => prev.filter(x => x !== id))
        }, 750)
      }
      delete dataRef.current[id]
      setPlayerIds(prev => prev.filter(pid => pid !== id))
    })

    return () => socket.disconnect()
  }, [])

  const sendChat = (text) => socketRef.current?.emit('chat', text)

  const collectCoin = useCallback((idx) => {
    setCollectedCoins(prev => {
      if (prev.has(idx)) return prev
      playCoin()
      const next = new Set(prev); next.add(idx)
      setCoins(c => c + 1)
      return next
    })
  }, [])

  const spendCoins = useCallback((n) => setCoins(c => Math.max(0, c - n)), [])

  useEffect(() => {
    setActiveWeapon(i => Math.min(i, Math.max(0, weapons.length - 1)))
  }, [weapons])

  useEffect(() => {
    const onKey = (e) => {
      if (e.code === 'KeyB' && document.activeElement?.tagName !== 'INPUT') {
        if (document.pointerLockElement) document.exitPointerLock()
        setShopOpen(s => !s)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handleLogin = useCallback((name) => {
    socketRef.current?.emit('set_username', { username: name })
    setUsername(name)
  }, [])

  const joinRoom = (roomId) => {
    socketRef.current?.emit('join_room', roomId)
    dataRef.current = {}
    setPlayerIds([])
    setCurrentRoom(roomId)
  }

  const leaveRoom = useCallback(() => {
    socketRef.current?.emit('leave_room')
    dataRef.current = {}
    setPlayerIds([])
    setCurrentRoom(null)
  }, [])

  const onKicked = useCallback(() => {
    if (isDeadRef.current) return
    isDeadRef.current = true
    playHit()
    setHitFlash(true)
    setTimeout(() => { setHitFlash(false); setShowDeathScreen(true) }, 600)
  }, [])

  const respawn = useCallback(() => {
    isDeadRef.current = false
    setShowDeathScreen(false)
    socketRef.current?.emit('join_room', currentRoom)
  }, [currentRoom])

  const myColorIndex = useMemo(() => {
    if (!myId || !currentRoom) return 0
    const idx = (lobby[currentRoom] ?? []).indexOf(myId)
    return idx >= 0 ? idx : 0
  }, [myId, currentRoom, lobby])

  const ctx = { socketRef, dataRef, playerIds, myId, messages, sendChat, myColorIndex, onKicked, dyingRef, dyingIds, username, weapons, activeWeapon, setActiveWeapon, coins, collectCoin, collectedCoins, spendCoins, leaveRoom }

  if (!username) return (
    <SocketContext.Provider value={ctx}>
      <UsernameScreen onLogin={handleLogin} disabled={!myId} />
    </SocketContext.Provider>
  )

  if (!currentRoom) return (
    <SocketContext.Provider value={ctx}>
      <LobbyScreen lobby={lobby} onJoin={joinRoom} />
    </SocketContext.Provider>
  )

  return (
    <SocketContext.Provider value={ctx}>
      <div style={{ width: '100vw', height: '100vh' }}>
        <Canvas shadows gl={{ antialias: false, toneMappingExposure: 0.8 }}
          camera={{ fov: 75, near: 0.1, far: 1000, position: [0, 1.7, 5] }}>
          {currentRoom === 'venice' ? <SunsetScene /> : currentRoom === 'starry' ? <NightScene /> : <SnowfallScene />}
          <SoundListener />
        </Canvas>

        <ChatBox />

        <Inventory />

        <CrosshairHUD />
        <Speedometer />

        {hitFlash && (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 50, pointerEvents: 'none',
            background: 'rgba(220,20,20,0.38)',
          }} />
        )}

        {showDeathScreen && (
          <DeathScreen
            onRespawn={respawn}
            onMenu={() => { setShowDeathScreen(false); leaveRoom() }}
          />
        )}

        {shopOpen && <ShopScreen onClose={() => setShopOpen(false)} />}

        <div style={{
          position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)',
          color: '#fff', opacity: 0.4, fontSize: 13, fontFamily: 'monospace',
          pointerEvents: 'none', whiteSpace: 'nowrap',
        }}>
          Click to capture mouse · WASD move · Space jump · E enter/exit car · Scroll/1-3 weapon · B shop · Esc release
        </div>
      </div>
    </SocketContext.Provider>
  )
}
