import { api } from "@/api/client"
import { useAsync } from "@/api/hooks"
import { EmptyState } from "@/components/empty-state"
import { BrandingGallery } from "@/components/branding-gallery"
import { Skeleton } from "@/components/ui/skeleton"
import { useProjectView } from "./context"

export function ProjectBranding({ version = "" }: { version?: string }) {
  const { name } = useProjectView()
  const { value, loading } = useAsync(() => api.branding(name), [name, version])
  if (loading && value === null) return <Skeleton className="h-48 w-full" />
  if (!value?.length) return <EmptyState title="No branding images yet">The illustrator saves the logo and screens in design/branding/.</EmptyState>
  return <BrandingGallery project={name} images={value} />
}
