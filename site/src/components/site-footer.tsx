import { repositoryUrl } from "@/components/site-header"

const links = [
  { label: "GitHub", href: repositoryUrl },
  { label: "README", href: `${repositoryUrl}#readme` },
  { label: "Brand guide", href: `${repositoryUrl}/tree/main/docs/brand` },
  { label: "MIT license", href: `${repositoryUrl}/blob/main/LICENSE` },
]

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-2.5">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-8" />
          <span className="font-mono text-lg font-bold">agent-team</span>
          <span className="text-sm text-muted-foreground">Self-hosted AI product team</span>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
          {links.map((link) => (
            <a key={link.label} href={link.href} className="hover:text-foreground">
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  )
}
