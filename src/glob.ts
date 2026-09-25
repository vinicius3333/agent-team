import { matchesGlob } from "node:path"

// Repo paths use brackets literally: Next.js routes live in folders like app/api/groups/[groupId]/. Node's
// matchesGlob reads [groupId] as a character class, so src/app/[id]/** never matched src/app/[id]/page.tsx and
// every such task failed with "edited files outside allowedPaths". Brackets are swapped for private characters on
// both sides, so they only match themselves; agents that escape them (\[id\]) get the same result.
const open = "\u0001"
const close = "\u0002"

function literalBrackets(value: string): string {
  return value.replace(/\\([[\]])/g, "$1").replaceAll("[", open).replaceAll("]", close)
}

export function matchesPath(path: string, pattern: string): boolean {
  if (path === pattern) return true
  return matchesGlob(literalBrackets(path), literalBrackets(pattern))
}
