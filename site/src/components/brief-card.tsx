const briefLines = ["A dad joke app. Users post", "jokes, vote them up, and see", "a daily top 10."]

export function BriefCard() {
  return (
    <figure className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_60px_-34px_rgb(11_11_16/0.25)]">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex gap-1.5" aria-hidden="true">
          <span className="size-3 rounded-full bg-[#ff5f57]" />
          <span className="size-3 rounded-full bg-[#febc2e]" />
          <span className="size-3 rounded-full bg-[#28c840]" />
        </div>
        <figcaption className="font-mono text-sm font-medium">brief.md</figcaption>
        <span className="text-xs text-muted-foreground">Plain text</span>
      </div>
      <div className="flex min-h-[220px] font-mono text-[15px] leading-8">
        <div className="border-r border-border px-3 py-4 text-right text-muted-foreground select-none" aria-hidden="true">
          {briefLines.map((_, index) => (
            <div key={index}>{index + 1}</div>
          ))}
        </div>
        <p className="px-4 py-4">
          {briefLines.map((line, index) => (
            <span key={line} className="block">
              {line}
              {index === briefLines.length - 1 && <span className="caret ml-1 inline-block h-5 w-[3px] translate-y-1 bg-primary" aria-hidden="true" />}
            </span>
          ))}
        </p>
      </div>
    </figure>
  )
}
