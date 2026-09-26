// Finds the JSON object an agent ended its message with: the last ```json block if there is one,
// else the last balanced top-level {...} in the text. Throws when neither parses.
// The closing fence must start a line: a fence inside a JSON string value (say, a ```yaml example
// in a Markdown reply) never does, because JSON escapes its newlines.
export function extractJsonObject(text: string): unknown {
  const fenced = [...text.matchAll(/```json[^\S\n]*\n([\s\S]*?)\n[^\S\n]*```/g)].at(-1)
  if (fenced) {
    try {
      return JSON.parse(fenced[1])
    } catch (error) {
      throw new Error(`the last \`\`\`json block is not valid JSON: ${(error as Error).message}`)
    }
  }
  const candidates = topLevelObjects(text)
  for (const candidate of candidates.reverse()) {
    try {
      return JSON.parse(candidate)
    } catch {}
  }
  throw new Error("the final message has no ```json block and no JSON object")
}

function topLevelObjects(text: string): string[] {
  const objects: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"' && depth > 0) inString = true
    else if (character === "{") {
      if (depth === 0) start = index
      depth++
    } else if (character === "}" && depth > 0) {
      depth--
      if (depth === 0) objects.push(text.slice(start, index + 1))
    }
  }
  return objects
}
