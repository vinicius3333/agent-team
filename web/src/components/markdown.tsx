import { Children, isValidElement, useMemo, useRef, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { urls } from "@/api/client"
import { CopyButton } from "@/components/copy-button"
import { cn } from "@/lib/utils"

const imagePattern = /\.(png|jpe?g|webp|gif)$/i
const hexColorPattern = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
// The illustrator's files in design/branding/, named like 02-landing.png or 02-landing.mobile.png.
const brandingImagePattern = /^\d{2}-[\w.-]+\.(?:png|jpe?g|webp)$/i

export function resolvePath(base: string, relative: string): string {
  const parts = (base ? base.split("/").slice(0, -1) : []).concat(relative.split("/"))
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === ".") continue
    if (part === "..") out.pop()
    else out.push(part)
  }
  return out.join("/")
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[`*_~]/g, "")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-") || "section"
  )
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ""
}

export interface Heading {
  level: number
  text: string
  id: string
}

export function extractHeadings(source: string): Heading[] {
  const headings: Heading[] = []
  let fence: string | null = null
  for (const line of source.split("\n")) {
    const fenceMatch = /^\s*(```|~~~)/.exec(line)
    if (fenceMatch) {
      fence = fence ? (line.trim().startsWith(fence) ? null : fence) : fenceMatch[1]
      continue
    }
    if (fence) continue
    const match = /^(#{1,3})\s+(.*?)\s*#*\s*$/.exec(line)
    if (match) {
      const text = match[2].replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "")
      headings.push({ level: match[1].length, text, id: slugify(text) })
    }
  }
  return headings
}

interface MarkdownProps {
  text: string
  project?: string
  path?: string
  onOpenDocument?: (path: string) => void
  className?: string
}

export function Markdown({ text, project, path = "", onOpenDocument, className }: MarkdownProps) {
  const rootRef = useRef<HTMLDivElement>(null)

  const components = useMemo<Components>(() => {
    const heading = (level: 1 | 2 | 3 | 4 | 5 | 6) =>
      function MarkdownHeading({ children }: { children?: ReactNode }) {
        const Tag = `h${level}` as const
        return (
          <Tag id={`md-${slugify(textOf(children))}`} className="scroll-mt-4">
            {children}
          </Tag>
        )
      }
    return {
      h1: heading(1),
      h2: heading(2),
      h3: heading(3),
      h4: heading(4),
      h5: heading(5),
      h6: heading(6),
      img: ({ src, alt }) => {
        const raw = typeof src === "string" ? src : ""
        if (!raw) return <>{alt}</>
        if (/^https?:/i.test(raw)) return <img src={raw} alt={alt ?? ""} loading="lazy" />
        if (project && imagePattern.test(raw)) return <img src={urls.raw(project, resolvePath(path, raw))} alt={alt ?? ""} loading="lazy" />
        return <>{alt}</>
      },
      a: ({ href, children }) => {
        const raw = href ?? ""
        if (raw.startsWith("#")) {
          const target = raw.slice(1).toLowerCase()
          return (
            <a
              href={raw}
              onClick={(event) => {
                event.preventDefault()
                rootRef.current?.querySelector(`#md-${CSS.escape(target)}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
              }}
            >
              {children}
            </a>
          )
        }
        if (/^(https?|mailto):/i.test(raw)) {
          return (
            <a href={raw} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          )
        }
        if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return <>{children}</>
        const target = resolvePath(path, raw.split("#")[0])
        if (/\.md$/i.test(target) && onOpenDocument) {
          return (
            <a
              href={`#${target}`}
              onClick={(event) => {
                event.preventDefault()
                onOpenDocument(target)
              }}
            >
              {children}
            </a>
          )
        }
        if (!project) return <>{children}</>
        return (
          <a href={urls.file(project, target)} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        )
      },
      pre: ({ children }) => {
        const code = Children.toArray(children)[0]
        const className = isValidElement<{ className?: string }>(code) ? (code.props.className ?? "") : ""
        const language = /language-([\w+#.-]+)/.exec(className)?.[1] ?? "text"
        return (
          <div className="md-code">
            <div className="md-code-head">
              <span>{language}</span>
              <CopyButton value={textOf(children).replace(/\n$/, "")} label="Copy code" />
            </div>
            <pre>{children}</pre>
          </div>
        )
      },
      code: ({ className, children }) => {
        const value = textOf(children)
        if (!className && hexColorPattern.test(value)) {
          return (
            <code className="inline-flex items-center gap-1.5 align-middle">
              <span className="inline-block size-3 shrink-0 rounded-sm border border-foreground/20" style={{ background: value }} aria-hidden="true" />
              {value}
            </code>
          )
        }
        if (!className && project && brandingImagePattern.test(value)) {
          const source = urls.brandingImage(project, value)
          return (
            <a href={source} target="_blank" rel="noopener noreferrer" className="group inline-flex flex-col gap-1 align-top no-underline" title={`Open ${value}`}>
              <code>{value}</code>
              <img src={source} alt={`Branding image ${value}`} loading="lazy" className="max-h-64 w-auto max-w-full rounded-md border object-contain object-top transition group-hover:opacity-90" />
            </a>
          )
        }
        return <code className={className}>{children}</code>
      },
      table: ({ children }) => (
        <div className="md-table">
          <table>{children}</table>
        </div>
      ),
    }
  }, [project, path, onOpenDocument])

  return (
    <div ref={rootRef} className={cn("markdown", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
