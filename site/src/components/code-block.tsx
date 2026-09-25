import type { ReactNode } from "react"
import { CopyButton } from "@/components/copy-button"

function YamlLine({ line }: { line: string }) {
  const match = line.match(/^(\s*)([\w-]+)(:)(.*)$/)
  if (!match) return <>{line}</>
  const [, indent, key, colon, rest] = match
  return (
    <>
      {indent}
      <span className="text-(--syntax-key)">{key}</span>
      {colon}
      {rest}
    </>
  )
}

type CodeBlockProps = {
  title: string
  copyText: string
  code: string
  language?: "yaml" | "shell"
  lineNumbers?: boolean
  footer?: ReactNode
}

export function CodeBlock({ title, copyText, code, language = "shell", lineNumbers = false, footer }: CodeBlockProps) {
  const lines = code.split("\n")
  return (
    <figure className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_18px_40px_-28px_rgb(11_11_16/0.35)]">
      <figcaption className="flex items-center gap-3 border-b border-border py-1.5 pr-1.5 pl-4 font-mono text-xs text-muted-foreground">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-[#ff5f57]" />
          <span className="size-2.5 rounded-full bg-[#febc2e]" />
          <span className="size-2.5 rounded-full bg-[#28c840]" />
        </span>
        <span className="flex-1">{title}</span>
        <CopyButton text={copyText} label={`Copy ${title}`} />
      </figcaption>
      <div className="flex overflow-x-auto font-mono text-[13px] leading-7">
        {lineNumbers && (
          <div className="border-r border-border px-3 py-3 text-right text-muted-foreground/70 select-none" aria-hidden="true">
            {lines.map((_, index) => (
              <div key={index}>{index + 1}</div>
            ))}
          </div>
        )}
        <pre className="flex-1 px-4 py-3">
          <code>
            {lines.map((line, index) => (
              <div key={index}>{language === "yaml" ? <YamlLine line={line} /> : line || " "}</div>
            ))}
          </code>
        </pre>
      </div>
      {footer}
    </figure>
  )
}
