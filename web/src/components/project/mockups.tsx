import { api } from "@/api/client"
import { useAsync } from "@/api/hooks"
import { EmptyState } from "@/components/empty-state"
import { MockupGallery } from "@/components/mockup-gallery"
import { Skeleton } from "@/components/ui/skeleton"
import { useProjectView } from "./context"

export function ProjectMockups({ version = "" }: { version?: string }) {
  const { name } = useProjectView()
  const { value, loading } = useAsync(() => api.mockups(name), [name, version])
  if (loading && value === null) return <Skeleton className="h-48 w-full" />
  if (!value?.length) return <EmptyState title="No mockups yet">The illustrator saves images in design/mockups/.</EmptyState>
  return <MockupGallery project={name} images={value} />
}
