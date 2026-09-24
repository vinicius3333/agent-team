import { models } from "./clay"
import { bookshelves, lamps, plants, type Placement } from "./layout"
import { Clay } from "./models"

function Row({ spec, placements }: { spec: Parameters<typeof Clay>[0]["spec"]; placements: Placement[] }) {
  return (
    <group>
      {placements.map(([x, z, rotationY = 0]) => (
        <Clay key={`${x},${z}`} spec={spec} position={[x, 0, z]} rotationY={rotationY} />
      ))}
    </group>
  )
}

export function Decor() {
  return (
    <group>
      <Row spec={models.plant} placements={plants} />
      <Row spec={models.bookshelf} placements={bookshelves} />
      <Row spec={models.lamp} placements={lamps} />
      <Clay spec={models.sofa} position={[-6.1, 0, 3.2]} />
    </group>
  )
}
