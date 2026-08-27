import { useEffect, useMemo, useState } from "react"
import { AuthMiniButton, useAuthMini } from "auth-mini-react-components"
import { LinkitProvider, LinkitUserDisplay, useLinkit, type LinkitProfile } from "linkit-react-components"
import { BrainCircuit, CheckCircle2, CircleHelp, Loader2, Plus, Send, Sparkles } from "lucide-react"
import { Button } from "./components/ui/button"
import { Input } from "./components/ui/input"
import { Textarea } from "./components/ui/textarea"
import { Badge } from "./components/ui/badge"
import { remiApi, type Anchor, type Candidate, type Inference } from "./lib/remi-api"

function ProfileIdentity() {
  const { getMe } = useLinkit()
  const [profile, setProfile] = useState<LinkitProfile | null>(null)
  useEffect(() => { void getMe().then((me) => setProfile(me.profile ?? null)).catch(() => setProfile(null)) }, [getMe])
  return <LinkitUserDisplay compact profile={profile} userId={profile?.user_id} />
}

function AppSurface() {
  const { sdk, status } = useAuthMini()
  const [anchors, setAnchors] = useState<Anchor[]>([])
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [question, setQuestion] = useState("")
  const [answer, setAnswer] = useState("")
  const [anchorQuestion, setAnchorQuestion] = useState("")
  const [anchorAnswer, setAnchorAnswer] = useState("")
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [inference, setInference] = useState<Inference | null>(null)
  const [error, setError] = useState<string | null>(null)

  const authenticated = status === "authenticated" && sdk
  const load = async () => {
    if (!sdk) return
    setLoading(true); setError(null)
    try { const [nextAnchors, nextCandidates] = await Promise.all([remiApi.listAnchors(sdk), remiApi.listCandidates(sdk)]); setAnchors(nextAnchors); setCandidates(nextCandidates) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load your cognitive model.") }
    finally { setLoading(false) }
  }
  useEffect(() => { if (authenticated) void load() }, [authenticated])
  const submitInference = async () => { if (!sdk || !question.trim()) return; setSubmitting(true); setError(null); try { setInference(await remiApi.infer(sdk, { question })) } catch (cause) { setError(cause instanceof Error ? cause.message : "Inference failed.") } finally { setSubmitting(false) } }
  const createAnchor = async () => { if (!sdk || !anchorQuestion.trim()) return; setSubmitting(true); try { const item = await remiApi.createAnchor(sdk, { question: anchorQuestion, answer: anchorAnswer }); setAnchors((current) => [item, ...current]); setAnchorQuestion(""); setAnchorAnswer("") } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create anchor.") } finally { setSubmitting(false) } }
  const approve = async (candidate: Candidate) => { if (!sdk) return; setSubmitting(true); try { const item = await remiApi.approveCandidate(sdk, candidate.id); setAnchors((current) => [item, ...current]); setCandidates((current) => current.filter((x) => x.id !== candidate.id)) } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not approve candidate.") } finally { setSubmitting(false) } }
  const anchorCount = useMemo(() => anchors.filter((anchor) => anchor.answer).length, [anchors])

  if (!authenticated) return <main className="grid min-h-screen place-items-center p-6"><div className="max-w-md space-y-4 text-center"><BrainCircuit className="mx-auto size-10 text-primary"/><h1 className="text-2xl font-semibold">ReMi 鉴心</h1><p className="text-sm text-muted-foreground">登录后建立并调用你的认知模型。</p><AuthMiniButton lang="zh-CN" /></div></main>
  return <main className="mx-auto min-h-screen max-w-5xl p-4 md:p-8"><header className="mb-8 flex items-center gap-3 border-b pb-4"><BrainCircuit className="size-6 text-primary"/><div className="min-w-0"><h1 className="font-semibold">ReMi 鉴心</h1><p className="text-sm text-muted-foreground">Anchor evidence · Probe discovery · bounded inference</p></div><div className="ml-auto flex items-center gap-3"><ProfileIdentity/><AuthMiniButton lang="zh-CN" size="sm" variant="ghost"/></div></header>
  {error && <p className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
  <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]"><section className="space-y-5"><div className="rounded-lg border bg-card p-5"><div className="mb-4 flex items-center gap-2"><Sparkles className="size-4 text-primary"/><h2 className="font-medium">面向问题的推理</h2></div><Textarea value={question} onChange={(event)=>setQuestion(event.target.value)} placeholder="提出一个需要分身依据已有认知回答的问题" rows={4}/><div className="mt-3 flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground">回答仅以已批准的 Soul Anchor 为证据；证据不足会暴露边界。</p><Button disabled={submitting || !question.trim()} onClick={()=>void submitInference()}>{submitting?<Loader2 className="animate-spin"/>:<Send/>}推理</Button></div>{inference && <div className="mt-5 space-y-3 border-t pt-4"><p className="whitespace-pre-wrap text-sm leading-6">{inference.answer}</p><p className="text-xs text-muted-foreground">边界：{inference.boundary}</p><div className="flex flex-wrap gap-1">{inference.recalled_anchor_ids.map((id)=><Badge key={id} variant="secondary">证据 {id.slice(0,8)}</Badge>)}</div></div>}</div>
  <div className="rounded-lg border bg-card p-5"><div className="mb-4 flex items-center gap-2"><Plus className="size-4 text-primary"/><h2 className="font-medium">添加 Soul Anchor</h2></div><div className="grid gap-3"><Input value={anchorQuestion} onChange={(event)=>setAnchorQuestion(event.target.value)} placeholder="未来会被反复问到的问题"/><Textarea value={anchorAnswer} onChange={(event)=>setAnchorAnswer(event.target.value)} placeholder="当前稳定答案；留空则作为 Soul Probe" rows={3}/><div className="flex justify-end"><Button disabled={submitting || !anchorQuestion.trim()} onClick={()=>void createAnchor()}><Plus/>保存认知单元</Button></div></div></div>
  <div className="rounded-lg border bg-card"><div className="flex items-center justify-between border-b px-5 py-4"><div><h2 className="font-medium">已批准的认知证据</h2><p className="text-sm text-muted-foreground">{anchorCount} 个已回答 Anchor，{anchors.length-anchorCount} 个 Probe</p></div>{loading&&<Loader2 className="size-4 animate-spin text-muted-foreground"/>}</div><div className="divide-y">{anchors.map((anchor)=><article className="p-5" key={anchor.id}><div className="mb-2 flex items-center gap-2"><Badge variant={anchor.answer?"default":"secondary"}>{anchor.answer?"Anchor":"Probe"}</Badge><span className="text-xs text-muted-foreground">{anchor.source}</span></div><h3 className="font-medium">{anchor.question}</h3><p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{anchor.answer ?? "尚未形成稳定答案；该问题会引导后续感知。"}</p></article>)}{!loading&&anchors.length===0&&<p className="p-8 text-center text-sm text-muted-foreground">先添加一个问题与答案，建立可复用的认知证据。</p>}</div></div></section>
  <aside className="space-y-5"><div className="rounded-lg border bg-card p-5"><div className="mb-2 flex items-center gap-2"><CircleHelp className="size-4 text-primary"/><h2 className="font-medium">待审批的 Soul Probe</h2></div><p className="mb-4 text-sm text-muted-foreground">系统发现值得继续探索的问题，不会直接把它们当作答案。</p><div className="space-y-3">{candidates.map((candidate)=><div className="rounded-md border p-3" key={candidate.id}><Badge variant="secondary">{candidate.kind==="probe"?"Probe":"Anchor"}</Badge><p className="mt-2 text-sm font-medium">{candidate.question}</p>{candidate.answer&&<p className="mt-1 text-sm text-muted-foreground">{candidate.answer}</p>}<Button className="mt-3 w-full" disabled={submitting} onClick={()=>void approve(candidate)} size="sm" variant="outline"><CheckCircle2/>批准</Button></div>)}{!loading&&candidates.length===0&&<p className="text-sm text-muted-foreground">暂无待审批候选。</p>}</div></div></aside></div></main>
}

export default function App() { return <LinkitProvider linkitBaseUrl="https://linkit.ntnl.io"><AppSurface /></LinkitProvider> }
