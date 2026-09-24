import { RoundedBox } from "@react-three/drei"
import { floor, rooms, wallHeight, wallThickness, windowWallHeight, type Palette, type Room } from "./layout"

function Planks({ palette }: { palette: Palette }) {
  const count = 34
  return (
    <group position={[0, 0.001, 0]}>
      {Array.from({ length: count }, (_, index) => (
        <mesh key={index} rotation-x={-Math.PI / 2} position={[-floor.width / 2 + (index + 0.5) * (floor.width / count), 0, 0]} receiveShadow>
          <planeGeometry args={[0.02, floor.depth]} />
          <meshStandardMaterial color={palette.plank} />
        </mesh>
      ))}
    </group>
  )
}

function Wall({ x, z, length, rotated, palette }: { x: number; z: number; length: number; rotated: boolean; palette: Palette }) {
  return (
    <group position={[x, wallHeight / 2, z]} rotation-y={rotated ? Math.PI / 2 : 0}>
      <RoundedBox args={[length, wallHeight, wallThickness]} radius={0.04} castShadow receiveShadow>
        <meshStandardMaterial color={palette.wall} />
      </RoundedBox>
      <mesh position={[0, wallHeight / 2 + 0.005, 0]}>
        <boxGeometry args={[length, 0.012, wallThickness + 0.01]} />
        <meshStandardMaterial color={palette.wallTop} />
      </mesh>
    </group>
  )
}

function RoomShell({ room, palette }: { room: Room; palette: Palette }) {
  const left = room.x - room.width / 2
  const right = room.x + room.width / 2
  const back = room.z - room.depth / 2
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[room.x, 0.004, room.z + 0.1]} receiveShadow>
        <planeGeometry args={[room.width - 0.6, room.depth - 0.7]} />
        <meshStandardMaterial color={room.rug} />
      </mesh>
      {room.walls.includes("back") && <Wall x={room.x} z={back} length={room.width} rotated={false} palette={palette} />}
      {room.walls.includes("left") && <Wall x={left} z={room.z} length={room.depth} rotated palette={palette} />}
      {room.walls.includes("right") && <Wall x={right} z={room.z} length={room.depth} rotated palette={palette} />}
    </group>
  )
}

function WindowWall({ palette }: { palette: Palette }) {
  const z = -floor.depth / 2
  const panes = 8
  const paneWidth = floor.width / panes
  return (
    <group position={[0, 0, z]}>
      <mesh position={[0, 0.25, 0]} castShadow receiveShadow>
        <boxGeometry args={[floor.width, 0.5, 0.2]} />
        <meshStandardMaterial color={palette.wall} />
      </mesh>
      {Array.from({ length: panes }, (_, index) => (
        <group key={index} position={[-floor.width / 2 + (index + 0.5) * paneWidth, 0.5 + (windowWallHeight - 0.5) / 2, 0]}>
          <mesh>
            <planeGeometry args={[paneWidth - 0.1, windowWallHeight - 0.6]} />
            <meshStandardMaterial color="#dff1ff" transparent opacity={0.12} depthWrite={false} />
          </mesh>
          <mesh position={[paneWidth / 2, 0, 0.02]}>
            <boxGeometry args={[0.08, windowWallHeight - 0.5, 0.08]} />
            <meshStandardMaterial color={palette.frame} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, windowWallHeight, 0]}>
        <boxGeometry args={[floor.width, 0.12, 0.2]} />
        <meshStandardMaterial color={palette.frame} />
      </mesh>
    </group>
  )
}

export function Walls({ palette }: { palette: Palette }) {
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[floor.width, floor.depth]} />
        <meshStandardMaterial color={palette.floor} />
      </mesh>
      <Planks palette={palette} />
      <WindowWall palette={palette} />
      {rooms.map((room) => (
        <RoomShell key={room.id} room={room} palette={palette} />
      ))}
    </group>
  )
}
