import { useRef } from 'react'
// @react-three/nativescript re-exports the WebGPU build of @react-three/fiber, so r3f hooks come
// from the same entry as the bootstrap.
import { useFrame } from '@react-three/nativescript'
import { OrbitControls } from '@react-three/drei/webgpu'

// Bare starter scene: one lit, rotating mesh you can orbit. Swap in your own geometry, drop a GLTF
// model in app/assets and load it with useGLTF('~/assets/<file>.glb'), and you're off.
export function Scene() {
  const mesh = useRef<any>(null)
  useFrame((_state, delta) => {
    if (mesh.current) mesh.current.rotation.y += delta * 0.5
  })

  return (
    <>
      <color attach="background" args={['#15161a']} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 5, 5]} intensity={2.5} />
      <mesh ref={mesh}>
        <torusKnotGeometry args={[0.7, 0.25, 128, 32]} />
        <meshStandardMaterial color="#e0533d" roughness={0.3} metalness={0.1} />
      </mesh>
      <OrbitControls enableDamping />
    </>
  )
}
