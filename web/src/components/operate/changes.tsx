import { ChangeHistoryCard, ChangeRequestCard } from "@/components/project/changes-card"

export function OperateChanges() {
  return (
    <div className="flex flex-col gap-4">
      <ChangeRequestCard />
      <ChangeHistoryCard />
    </div>
  )
}
