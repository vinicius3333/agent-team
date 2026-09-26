import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react"
import { ImagePlus, Loader2, Mic, MicOff, SendHorizontal, Square, X } from "lucide-react"
import { toast } from "sonner"
import { api, urls } from "@/api/client"
import { planningPhases } from "@/api/types"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useProjectView } from "./context"

const maxAttachments = 4
const maxImageBytes = 5 * 1024 * 1024
const maxMentionResults = 8
const messageMaxLength = 4000

interface Attachment {
  // Set once the upload finishes.
  file: string | null
  preview: string
}

interface Mention {
  value: string
  hint: string
}

// The Web Speech API is not in the TypeScript DOM types yet.
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
  start(): void
  stop(): void
}

function speechRecognition(): (new () => SpeechRecognitionLike) | null {
  const scope = window as unknown as Record<string, unknown>
  return (scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null) as (new () => SpeechRecognitionLike) | null
}

// The @word that ends right before the caret, if any.
function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|\s)@([\w./-]*)$/.exec(text.slice(0, caret))
  return match ? { start: caret - match[2].length - 1, query: match[2] } : null
}

function useMentionCandidates(): Mention[] {
  const { name, detail } = useProjectView()
  const [files, setFiles] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    api
      .files(name)
      .then((list) => !cancelled && setFiles(list))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [name])
  return useMemo(
    () => [
      ...detail.tasks.map((task) => ({ value: task.id, hint: task.title })),
      ...planningPhases.map((phase) => ({ value: phase, hint: "phase" })),
      ...files.map((file) => ({ value: file, hint: "file" })),
    ],
    [detail.tasks, files],
  )
}

export function LeadComposer({ busy, onSend, onStop }: { busy: boolean; onSend: (text: string, attachments: string[]) => Promise<boolean>; onStop: () => void }) {
  const { name } = useProjectView()
  const [text, setText] = useState("")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [listening, setListening] = useState(false)
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const candidates = useMentionCandidates()
  const Recognition = useMemo(() => speechRecognition(), [])

  const matches = useMemo(() => {
    if (!mention) return []
    const query = mention.query.toLowerCase()
    return candidates.filter((candidate) => candidate.value.toLowerCase().includes(query) || candidate.hint.toLowerCase().includes(query)).slice(0, maxMentionResults)
  }, [candidates, mention])

  useEffect(() => () => recognitionRef.current?.stop(), [])

  // The textarea starts at one line and grows with the text; max-h caps it at 40% of the viewport, then it scrolls.
  useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = "auto"
    input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`
  }, [text])

  const uploading = attachments.some((attachment) => attachment.file === null)
  const canSend = !busy && !uploading && text.trim().length > 0

  const addImages = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"))
    const room = maxAttachments - attachments.length
    if (images.length > room) toast.warning(`Attach up to ${maxAttachments} images per message.`)
    for (const image of images.slice(0, Math.max(0, room))) {
      if (image.size > maxImageBytes) {
        toast.error(`${image.name} is larger than 5 MB.`)
        continue
      }
      const preview = URL.createObjectURL(image)
      setAttachments((current) => [...current, { file: null, preview }])
      try {
        const { file } = await api.uploadChatImage(name, image)
        setAttachments((current) => current.map((attachment) => (attachment.preview === preview ? { ...attachment, file } : attachment)))
      } catch (error) {
        setAttachments((current) => current.filter((attachment) => attachment.preview !== preview))
        URL.revokeObjectURL(preview)
        toast.error(error instanceof Error ? error.message : "Could not upload the image.")
      }
    }
  }

  const removeAttachment = (preview: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.preview !== preview))
    URL.revokeObjectURL(preview)
  }

  const send = async () => {
    if (!canSend) return
    recognitionRef.current?.stop()
    const sent = await onSend(
      text.trim(),
      attachments.flatMap((attachment) => (attachment.file ? [attachment.file] : [])),
    )
    if (!sent) return
    setText("")
    attachments.forEach((attachment) => URL.revokeObjectURL(attachment.preview))
    setAttachments([])
  }

  const updateMention = (value: string, caret: number) => {
    setMention(mentionQuery(value, caret))
    setHighlight(0)
  }

  const pickMention = (candidate: Mention) => {
    if (!mention) return
    const caret = inputRef.current?.selectionStart ?? text.length
    const next = `${text.slice(0, mention.start)}@${candidate.value} ${text.slice(caret)}`
    setText(next)
    setMention(null)
    requestAnimationFrame(() => {
      const position = mention.start + candidate.value.length + 2
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(position, position)
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && matches.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        setHighlight((current) => (current + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length)
        return
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault()
        pickMention(matches[highlight])
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        setMention(null)
        return
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send()
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"))
    if (!images.length) return
    event.preventDefault()
    void addImages(images)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.files.length) return
    event.preventDefault()
    void addImages([...event.dataTransfer.files])
  }

  const toggleVoice = () => {
    if (!Recognition) return
    if (listening) {
      recognitionRef.current?.stop()
      return
    }
    const recognition = new Recognition()
    recognition.lang = navigator.language
    recognition.continuous = true
    recognition.interimResults = false
    // Final phrases are appended to whatever is typed, so voice and keyboard can mix.
    recognition.onresult = (event) => {
      let spoken = ""
      for (let index = event.resultIndex; index < event.results.length; index++) {
        if (event.results[index].isFinal) spoken += event.results[index][0].transcript
      }
      if (spoken.trim()) setText((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}${spoken.trim()}`.slice(0, messageMaxLength))
    }
    recognition.onerror = (event) => {
      if (event.error !== "aborted" && event.error !== "no-speech") toast.error(event.error === "not-allowed" ? "Allow the microphone in the browser to dictate." : `Voice input failed: ${event.error}.`)
    }
    recognition.onend = () => {
      setListening(false)
      recognitionRef.current = null
    }
    recognitionRef.current = recognition
    recognition.start()
    setListening(true)
  }

  return (
    <div className="relative border-t p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:p-3" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      {mention && matches.length > 0 && (
        <ul role="listbox" aria-label="Mentions" className="absolute bottom-full left-3 z-10 mb-1 max-h-64 w-[min(28rem,calc(100%-1.5rem))] overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md">
          {matches.map((candidate, index) => (
            <li
              key={`${candidate.hint}-${candidate.value}`}
              role="option"
              aria-selected={index === highlight}
              onMouseDown={(event) => {
                event.preventDefault()
                pickMention(candidate)
              }}
              className={cn("flex cursor-pointer items-baseline gap-2 rounded px-2 py-1", index === highlight && "bg-accent text-accent-foreground")}
            >
              <span className="shrink-0 font-mono">@{candidate.value}</span>
              <span className="truncate text-xs text-muted-foreground">{candidate.hint}</span>
            </li>
          ))}
        </ul>
      )}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((attachment) => (
            <div key={attachment.preview} className="relative size-16 overflow-hidden rounded-md border">
              <img src={attachment.file ? urls.chatUpload(name, attachment.file) : attachment.preview} alt="Attached image" className="size-full object-cover" />
              {attachment.file === null && (
                <span className="absolute inset-0 flex items-center justify-center bg-background/60">
                  <Loader2 className="size-4 animate-spin" />
                </span>
              )}
              <button
                type="button"
                onClick={() => removeAttachment(attachment.preview)}
                aria-label="Remove image"
                className="absolute top-0.5 right-0.5 flex size-6 items-center justify-center rounded-full bg-background/90 text-foreground shadow"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex min-w-0 items-end gap-1 sm:gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          onChange={(event) => {
            void addImages([...(event.target.files ?? [])])
            event.target.value = ""
          }}
        />
        <Button type="button" variant="ghost" size="icon" onClick={() => fileRef.current?.click()} disabled={attachments.length >= maxAttachments} aria-label="Attach images">
          <ImagePlus />
        </Button>
        {Recognition && (
          <Button type="button" variant={listening ? "destructive" : "ghost"} size="icon" onClick={toggleVoice} aria-label={listening ? "Stop dictation" : "Dictate a message"} aria-pressed={listening}>
            {listening ? <MicOff /> : <Mic />}
          </Button>
        )}
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          maxLength={messageMaxLength}
          placeholder={listening ? "Listening…" : "Ask the lead, @ to mention"}
          aria-label="Message to the project lead"
          onChange={(event) => {
            setText(event.target.value)
            updateMention(event.target.value, event.target.selectionStart)
          }}
          onClick={(event) => updateMention(text, event.currentTarget.selectionStart)}
          onBlur={() => setMention(null)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="max-h-[40dvh] min-h-9 min-w-0 flex-1 resize-none overflow-y-auto rounded-2xl border border-input bg-transparent px-3 py-1.5 text-base sm:text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
        />
        {busy ? (
          <Button type="button" variant="outline" onClick={onStop} aria-label="Stop">
            <Square /> <span className="hidden sm:inline">Stop</span>
          </Button>
        ) : (
          <Button type="button" onClick={() => void send()} disabled={!canSend} aria-label="Send">
            <SendHorizontal /> <span className="hidden sm:inline">Send</span>
          </Button>
        )}
      </div>
    </div>
  )
}
