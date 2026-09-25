import { useEffect, useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function GitIdentityCard() {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api
      .gitIdentity()
      .then((identity) => {
        if (!identity) return
        setName(identity.name)
        setEmail(identity.email)
      })
      .catch((error: Error) => toast.error(`Could not load the git identity: ${error.message}`))
  }, [])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      await api.saveGitIdentity({ name, email })
      toast.success("Git identity saved")
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Git identity</CardTitle>
        <CardDescription>The author of every commit agent-team makes in your projects. GitHub shows the avatar of the account that owns this email.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="grid gap-2">
            <Label htmlFor="git-name">Name</Label>
            <Input id="git-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Ada Lovelace" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="git-email">Email</Label>
            <Input id="git-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="ada@example.com" required />
          </div>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />} Save
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
