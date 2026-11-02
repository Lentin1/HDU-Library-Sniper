"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { ArrowLeft, LogIn, QrCode, RefreshCw, ShieldCheck } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldLabel, FormError } from "@/components/ui/field"
import { Form } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { api } from "../api"
import { useSession } from "../queries"
import { useAppStore } from "../store"
import { Busy, loginSchema } from "../shared"
import type { QrLoginStart, SessionStatus } from "../../shared/types"

// 二维码状态机。UI 只对“确定性”状态做反馈，不做中间态伪反馈：
//  - loading：正在获取二维码（确定）
//  - ready：二维码已就绪，等待用户扫码（确定）
//  - confirmed：已确认登录成功（确定）
//  - expired / error：二维码已失效或获取失败（确定，需要换码）
// 轮询期间（ready 之后、confirmed/expired 之前）不产生任何“等待服务器/已扫描/待确认”
// 文案——SSO 不暴露这些中间态，任何此类反馈都是歧义。
type QrState = "loading" | "ready" | "confirmed" | "expired" | "error"

function LoginPage({ onCancel }: { onCancel?: () => void }) {
  const navigate = useNavigate()
  const setSession = useAppStore((state) => state.setSession)
  const setAddingAccount = useAppStore((state) => state.setAddingAccount)
  const queryClient = useQueryClient()

  // 登录成功即切换到该账户：清空上一个账户的缓存，其它账户继续在后台运行。
  const enterAccount = useCallback(async (session: SessionStatus) => {
    setSession(session)
    setAddingAccount(false)
    queryClient.removeQueries()
    await navigate({ to: "/plans" })
  }, [navigate, queryClient, setAddingAccount, setSession])
  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { studentId: "", password: "" },
  })
  const [error, setError] = useState("")
  const [qr, setQr] = useState<QrLoginStart | null>(null)
  const [qrState, setQrState] = useState<QrState>("loading")
  const [qrMessage, setQrMessage] = useState("正在获取登录二维码")
  const qrNonce = useRef(0)

  const loadQr = useCallback(async () => {
    const nonce = ++qrNonce.current
    setQr(null)
    setQrState("loading")
    setQrMessage("正在获取登录二维码")
    try {
      const nextQr = await api.qrStart()
      if (nonce !== qrNonce.current) return
      setQr(nextQr)
      setQrState("ready")
      setQrMessage("请使用钉钉扫码登录")
    } catch (cause) {
      if (nonce !== qrNonce.current) return
      setQrState("error")
      setQrMessage(cause instanceof Error ? cause.message : "二维码获取失败")
    }
  }, [])

  // 二维码生命周期由两个独立时钟驱动，互不干扰：
  //  - 轮询时钟：只探测“是否已确认/是否已失效”，不改变二维码本身；
  //  - 到期时钟：二维码展示超过安全窗口后自动换新码，避免用户对着失效码空等。
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const loop = useRef({ stopped: true })

  useEffect(() => {
    if (!qr) return
    const currentQr = qr
    let cancelled = false

    async function tick() {
      if (loop.current.stopped || cancelled) return
      try {
        const result = await api.qrStatus(currentQr.uuid)
        if (loop.current.stopped || cancelled) return
        if (result.status === "confirmed") {
          setQrState("confirmed")
          if (result.session?.authenticated) {
            await enterAccount(result.session)
          } else {
            setQrState("error")
            setQrMessage("扫码已确认，但登录态校验失败")
          }
          return
        }
        if (result.status === "expired") {
          // SSO 判定该码已失效：自动换新码，不打扰用户。
          void loadQr()
          return
        }
        if (result.status === "error") {
          // 服务端短暂异常：不立即判死，稍后重试一轮。
          await new Promise((resolve) => setTimeout(resolve, 800))
          if (loop.current.stopped || cancelled) return
          pollTimer.current = setTimeout(tick, 0)
          return
        }
        // waiting：二维码仍有效，静默继续下一轮。
        pollTimer.current = setTimeout(tick, 1000)
      } catch {
        if (loop.current.stopped || cancelled) return
        pollTimer.current = setTimeout(tick, 1500)
      }
    }

    loop.current.stopped = false
    pollTimer.current = setTimeout(tick, 800)

    // 到期自动换码：在安全窗口到期前提前刷新。
    const ttl = Math.max(20, currentQr.ttlSeconds || 90)
    const lead = Math.min(10, Math.floor(ttl / 4))
    expiryTimer.current = setTimeout(() => {
      if (loop.current.stopped || cancelled) return
      void loadQr()
    }, Math.max(0, (ttl - lead) * 1000))

    return () => {
      cancelled = true
      loop.current.stopped = true
      if (pollTimer.current) clearTimeout(pollTimer.current)
      if (expiryTimer.current) clearTimeout(expiryTimer.current)
    }
  }, [qr, loadQr, enterAccount])

  useEffect(() => {
    void loadQr()
  }, [loadQr])

  async function submit(values: z.infer<typeof loginSchema>) {
    setError("")
    try {
      const result = await api.login(values.studentId, values.password)
      if (!result.success) throw new Error(result.message)
      await enterAccount(result.session ?? await api.session())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败")
    }
  }

  const qrBusy = qrState === "loading"
  const showQr = qr?.image && qrState !== "loading"

  return (
    <main className="relative grid min-h-svh place-items-center overflow-hidden p-6">
      <Card className="relative z-10 w-full min-w-0 max-w-[min(86vw,48rem)] overflow-hidden">
        <CardHeader className="min-w-0">
          <div className="mb-4 flex items-center gap-3">
            <img src="/app-icon.png" alt="" className="size-11 rounded-lg" />
            <div>
              <CardTitle>HDU Sniper</CardTitle>
              <CardDescription>预约工作台</CardDescription>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <CardTitle render={<h1 />} className="text-3xl">
              {onCancel ? "添加图书馆账户" : "登录图书馆账户"}
            </CardTitle>
            {onCancel && (
              <Button variant="ghost" size="sm" onClick={onCancel}>
                <ArrowLeft className="size-4" />
                返回工作台
              </Button>
            )}
          </div>
          {onCancel && (
            <CardDescription>新账户会与已有账户同时在后台运行，各自独立预约与签到。</CardDescription>
          )}
        </CardHeader>
        <div className="grid gap-0 px-6 pb-6 md:grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)]">
          <Form onSubmit={form.handleSubmit(submit)} className="contents">
            <div className="grid content-start gap-4 md:pr-6">
              <Field>
                <FieldLabel>学号</FieldLabel>
                <Input className="w-full" autoComplete="username" {...form.register("studentId")} />
                {form.formState.errors.studentId?.message && (
                  <FormError>{form.formState.errors.studentId.message}</FormError>
                )}
              </Field>
              <Field>
                <FieldLabel>数字杭电密码</FieldLabel>
                <Input
                  className="w-full"
                  type="password"
                  autoComplete="current-password"
                  {...form.register("password")}
                />
                {form.formState.errors.password?.message && (
                  <FormError>{form.formState.errors.password.message}</FormError>
                )}
              </Field>
              {error && (
                <Alert variant="error">
                  <ShieldCheck className="size-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" loading={form.formState.isSubmitting}>
                <LogIn className="size-4" />
                进入工作台
              </Button>
            </div>
          </Form>
          <Separator orientation="vertical" className="hidden md:block" />
          <div className="grid content-start gap-4 pt-6 md:pt-0 md:pl-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <QrCode className="size-4" />
                扫码登录
              </div>
              <Badge variant={qrState === "error" || qrState === "expired" ? "warning" : "secondary"}>
                {qrState === "loading" && "加载中"}
                {qrState === "ready" && "待扫码"}
                {qrState === "confirmed" && "已确认"}
                {qrState === "expired" && "已过期"}
                {qrState === "error" && "异常"}
              </Badge>
            </div>
            <div className="relative mx-auto aspect-square w-full max-w-60 overflow-hidden rounded-xl border bg-background">
              {showQr ? (
                <img
                  src={qr.image}
                  alt="SSO 登录二维码"
                  className="size-full object-contain"
                />
              ) : null}
              {qrBusy && (
                <div className="absolute inset-0 grid place-items-center gap-2 bg-background/85 text-xs text-muted-foreground">
                  <Spinner className="size-5" />
                  {qrMessage}
                </div>
              )}
              {(qrState === "expired" || qrState === "error") && (
                <div className="absolute inset-0 grid place-items-center bg-background/92 p-4 text-center">
                  <div className="grid gap-3">
                    <p className="text-xs leading-5 text-muted-foreground">{qrMessage}</p>
                    <Button size="sm" onClick={() => void loadQr()}>
                      <RefreshCw className="size-4" />
                      刷新二维码
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </Card>
    </main>
  )
}

export function LoginGate() {
  const session = useAppStore((state) => state.session)
  const setSession = useAppStore((state) => state.setSession)
  const adding = useAppStore((state) => state.addingAccount)
  const setAddingAccount = useAppStore((state) => state.setAddingAccount)
  const query = useSession()
  const navigate = useNavigate()

  useEffect(() => {
    if (query.data) setSession(query.data)
  }, [query.data, setSession])

  useEffect(() => {
    if (session?.authenticated && !adding) void navigate({ to: "/plans", replace: true })
  }, [session, adding, navigate])

  if (adding) {
    return (
      <LoginPage
        onCancel={session?.authenticated ? () => { setAddingAccount(false); void navigate({ to: "/plans" }) } : undefined}
      />
    )
  }
  if (query.isLoading && !session) return <Busy label="正在连接后台服务..." />
  return session?.authenticated ? <Busy /> : <LoginPage />
}
