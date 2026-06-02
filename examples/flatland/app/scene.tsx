import { useLayoutEffect } from 'react'
import { Center, ContactShadows, OrbitControls, Environment, useGLTF } from '@react-three/drei/webgpu'

// Exact structure from the reference baking-soft-shadows demo the user pasted,
// adapted for our NativeScript + runCanvasApp setup + ContactShadows (instead of Accumulative).
// - Same group + Center positioning/rotations/scales for Suzi, sphere, and box.
// - Same Suzi material (orange + roughness 0).
// - OrbitControls with the exact polar limits from the reference.
// - Local venice_sunset_1k.hdr (the project's asset) instead of the "city" preset,
//   because the built-in preset can't be loaded on Android without network/bundled assets.
// - Gold clear color (#daa520) matching the app's page backgroundColor so there is no white.
// - Full edge-to-edge canvas behavior restored to the previous stable version.

export function Scene() {
  return (
    <>
      <color attach="background" args={['#daa520']} />

      <group position={[0, -0.5, 0]}>
        <Center top>
          <Suzi rotation={[-0.63, 0, 0]} scale={2} />
        </Center>

        <Center top position={[-2, 0, 1]}>
          <mesh castShadow>
            <sphereGeometry args={[0.25, 64, 64]} />
            <meshStandardMaterial color="lightblue" />
          </mesh>
        </Center>

        <Center top position={[2.5, 0, 1]}>
          <mesh castShadow rotation={[0, Math.PI / 4, 0]}>
            <boxGeometry args={[0.5, 0.5, 0.5]} />
            <meshStandardMaterial color="indianred" />
          </mesh>
        </Center>

        {/* ContactShadows instead of the baked AccumulativeShadows from the reference */}
        <ContactShadows position={[0, 0, 0]} opacity={0.75} scale={12} blur={2} far={4} color="#1a120b" />
      </group>

      <OrbitControls minPolarAngle={0} maxPolarAngle={Math.PI / 2} />

      {/* Use the project's local HDR (venice_sunset_1k.hdr) — "city" preset requires
          assets that aren't available on Android without extra bundling/network. */}
      <Environment files="~/assets/venice_sunset_1k.hdr" background={false} blur={0.65} />
    </>
  )
}

function Suzi(props: any) {
  const { scene, materials } = useGLTF('~/assets/suzi-meshopt.glb')

  useLayoutEffect(() => {
    scene.traverse((obj: any) => {
      if (obj.isMesh) {
        obj.receiveShadow = true
        obj.castShadow = true
        obj.material.color.set('orange')
        obj.material.roughness = 0
      }
    })
  }, [scene, materials])

  return <primitive object={scene} {...props} />
}
