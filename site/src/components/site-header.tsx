import { Download } from "lucide-react"

export const repositoryUrl = "https://github.com/vinicius3333/agent-team"

const links = [
  { label: "How it works", href: "#pipeline" },
  { label: "Control", href: "#control" },
  { label: "Self-hosted", href: "#runners" },
  { label: "Docs", href: `${repositoryUrl}#readme` },
]

export function SiteHeader() {
  return (
    <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
      <a href="/" className="flex items-center gap-2.5" aria-label="agent-team home">
        <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-8" />
        <span className="font-mono text-xl font-bold tracking-tight">agent-team</span>
      </a>
      <nav aria-label="Main" className="hidden items-center gap-8 text-sm text-muted-foreground md:flex">
        {links.map((link) => (
          <a key={link.label} href={link.href} className="hover:text-foreground">
            {link.label}
          </a>
        ))}
      </nav>
      <a
        href="#install"
        className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        <Download size={16} /> Install
      </a>
    </header>
  )
}
