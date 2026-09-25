export const fps = 30

export type RoleName = "PM" | "Architect" | "Illustrator" | "Designer" | "Planner" | "Workers" | "Reviewer" | "QA"

type StageId = "spec" | "architecture" | "branding" | "design" | "plan" | "build" | "qa" | "deploy"

type StageDefinition = {
  id: StageId
  title: string
  role: RoleName | null
  output: string
  durationInFrames: number
}

const definitions: StageDefinition[] = [
  { id: "spec", title: "Writing the spec", role: "PM", output: "docs/spec.md", durationInFrames: 45 },
  { id: "architecture", title: "Designing the architecture", role: "Architect", output: "docs/architecture.md", durationInFrames: 45 },
  { id: "branding", title: "Drawing the brand", role: "Illustrator", output: "design/branding/", durationInFrames: 45 },
  { id: "design", title: "Building the design system", role: "Designer", output: "design/tokens.css", durationInFrames: 45 },
  { id: "plan", title: "Planning the tasks", role: "Planner", output: "tasks.json", durationInFrames: 40 },
  { id: "build", title: "Building the tasks", role: "Workers", output: "5 tasks, 2 at a time, each reviewed", durationInFrames: 96 },
  { id: "qa", title: "Testing the whole app", role: "QA", output: ".agent-team/qa/round-1/", durationInFrames: 50 },
  { id: "deploy", title: "Live preview", role: null, output: "trycloudflare.com", durationInFrames: 100 },
]

export const stages = definitions.map((stage, index) => ({
  ...stage,
  from: definitions.slice(0, index).reduce((total, previous) => total + previous.durationInFrames, 0),
}))

export type Stage = (typeof stages)[number]

export const durationInFrames = stages.reduce((total, stage) => total + stage.durationInFrames, 0)

export function stageAt(frame: number): Stage {
  return stages.findLast((stage) => frame >= stage.from) ?? stages[0]
}

export function stageById(id: StageId): Stage {
  return stages.find((stage) => stage.id === id)!
}

export const tasks = [
  "Scaffold the app",
  "Jokes API",
  "Post a joke",
  "Vote on jokes",
  "Daily top 10",
]

export const build = {
  leadInFrames: 8,
  parallelTasks: 2,
  framesPerWave: 24,
  reviewStartsAt: 13,
  mergedAt: 20,
}

export type TaskStatus = "todo" | "building" | "reviewing" | "merged"

export function taskStatus(taskIndex: number, buildFrame: number): TaskStatus {
  const wave = Math.floor(taskIndex / build.parallelTasks)
  const laneOffset = (taskIndex % build.parallelTasks) * 3
  const taskFrame = buildFrame - build.leadInFrames - wave * build.framesPerWave - laneOffset
  if (taskFrame < 0) return "todo"
  if (taskFrame >= build.mergedAt) return "merged"
  if (taskFrame >= build.reviewStartsAt) return "reviewing"
  return "building"
}

export function activeRolesAt(frame: number): RoleName[] {
  const stage = stageAt(frame)
  if (stage.id !== "build") return stage.role ? [stage.role] : []
  const statuses = tasks.map((_, index) => taskStatus(index, frame - stage.from))
  const roles: RoleName[] = []
  if (statuses.includes("building")) roles.push("Workers")
  if (statuses.includes("reviewing")) roles.push("Reviewer")
  return roles.length > 0 ? roles : ["Workers"]
}
