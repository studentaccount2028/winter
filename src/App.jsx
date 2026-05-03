import { useRef, useEffect, useState, useMemo, Suspense } from 'react'
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import { PointerLockControls, Grid, Environment, useGLTF, MeshReflectorMaterial, Lightformer, Sparkles, Stars, useTexture } from '@react-three/drei'
import { RepeatWrapping, PlaneGeometry, Color, Object3D } from 'three'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'
import { EffectComposer, Bloom, ToneMapping, SMAA, N8AO, GodRays } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'

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

function Player() {
  const controlsRef = useRef()
  const keys = useRef({ w: false, a: false, s: false, d: false })
  const velocityY = useRef(0)
  const grounded = useRef(false)
  const bobPhase = useRef(0)
  const bobStrength = useRef(0)
  const { camera } = useThree()

  useEffect(() => {
    const down = (e) => {
      if (e.code === 'KeyW') keys.current.w = true
      if (e.code === 'KeyS') keys.current.s = true
      if (e.code === 'KeyA') keys.current.a = true
      if (e.code === 'KeyD') keys.current.d = true
      if (e.code === 'Space' && grounded.current) {
        e.preventDefault()
        velocityY.current = 8
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

    const { w, a, s, d } = keys.current
    if (w) ctrl.moveForward( SPEED * delta)
    if (s) ctrl.moveForward(-SPEED * delta)
    if (d) ctrl.moveRight(  SPEED * delta)
    if (a) ctrl.moveRight( -SPEED * delta)

    // Terrain height — matches SandGround geometry formula exactly
    const groundY = (_fbm(camera.position.x / 25, -camera.position.z / 25) - 0.5) * 3.0

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

// ─── Venice Sunset ────────────────────────────────────────────────────────────

function SunsetScene() {
  const [sun, setSun] = useState(null)

  return (
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
    </>
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
    </>
  )
}

// ─── UI + root ────────────────────────────────────────────────────────────────

function EnvPicker({ value, onChange }) {
  const options = [
    { key: 'sunset', label: 'Venice Sunset' },
    { key: 'night',  label: 'Starry Night'  },
  ]
  return (
    <div style={{
      position: 'fixed', top: 20, right: 20, zIndex: 10,
      padding: '14px 12px',
      display: 'flex', flexDirection: 'column', gap: 6,
      background: 'rgba(255,255,255,0.06)',
      backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
      border: '1px solid rgba(255,255,255,0.12)', borderRadius: 18,
      boxShadow: '0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08)',
    }}>
      <span style={{
        color: 'rgba(255,255,255,0.35)', fontSize: 9, fontFamily: 'monospace',
        textTransform: 'uppercase', letterSpacing: '0.14em',
        paddingLeft: 6, marginBottom: 2,
      }}>
        Environment
      </span>
      {options.map(({ key, label }) => {
        const active = value === key
        return (
          <button key={key} onClick={() => onChange(key)} style={{
            background: active ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.02)',
            border: `1px solid ${active ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.06)'}`,
            borderRadius: 10, padding: '9px 22px',
            color: active ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.4)',
            fontSize: 12, fontFamily: 'monospace', cursor: 'pointer',
            textAlign: 'left', letterSpacing: '0.03em',
            transition: 'background 0.15s, color 0.15s, border-color 0.15s',
            outline: 'none', whiteSpace: 'nowrap',
            boxShadow: active ? 'inset 0 1px 0 rgba(255,255,255,0.12)' : 'none',
          }}>
            {label}
          </button>
        )
      })}
    </div>
  )
}

export default function App() {
  const [preset, setPreset] = useState('sunset')

  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <Canvas shadows gl={{ antialias: false, toneMappingExposure: 0.8 }}
        camera={{ fov: 75, near: 0.1, far: 1000, position: [0, 1.7, 5] }}>
        {preset === 'sunset' ? <SunsetScene /> : <NightScene />}
      </Canvas>
      <EnvPicker value={preset} onChange={setPreset} />
      <div style={{
        position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)',
        color: '#fff', opacity: 0.5, fontSize: 13, fontFamily: 'monospace',
        pointerEvents: 'none', whiteSpace: 'nowrap',
      }}>
        Click to capture mouse · WASD to move · Esc to release
      </div>
    </div>
  )
}
