import { useEffect, useState, type FormEvent } from 'react'
import { Logo } from '../components/Logo'
import { inputCls } from '../components/ui'

type GateState = 'loading' | 'authenticated' | 'login' | 'unavailable'
const desktopRuntime = (): boolean => window.location.protocol === 'file:' || window.api?.isDesktop === true

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>(desktopRuntime() ? 'authenticated' : 'loading')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const check = async (): Promise<void> => {
    try {
      const response = await fetch('/api/auth/status', { cache: 'no-store', credentials: 'same-origin' })
      if (!response.ok) throw new Error('status')
      const result = (await response.json()) as { authenticated?: boolean }
      setState(result.authenticated ? 'authenticated' : 'login')
      if (result.authenticated) window.dispatchEvent(new Event('bang-story-authenticated'))
      setError('')
    } catch {
      setState('unavailable')
    }
  }

  useEffect(() => {
    if (desktopRuntime()) return
    void check()
    const expired = (): void => {
      setState('login')
      setPassword('')
      setError('Sesi berakhir. Masuk lagi untuk melanjutkan.')
    }
    window.addEventListener('bang-story-auth-expired', expired)
    return () => window.removeEventListener('bang-story-auth-expired', expired)
  }, [])

  const login = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username, password, remember })
      })
      const result = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Nama pengguna atau password salah.')
      setPassword('')
      setState('authenticated')
      window.dispatchEvent(new Event('bang-story-authenticated'))
    } catch (cause) {
      setPassword('')
      setError(cause instanceof Error ? cause.message : 'Login gagal.')
    } finally {
      setBusy(false)
    }
  }

  if (state === 'authenticated') return <>{children}</>

  return (
    <main className="flex min-h-screen items-center justify-center bg-paper px-5 py-10">
      <section className="w-full max-w-[420px] rounded-3xl border-[1.5px] border-ink bg-surface p-7 shadow-ink-lg sm:p-9">
        <Logo />
        {state === 'loading' ? (
          <p className="mt-8 text-sm text-ink-2">Memeriksa sesi…</p>
        ) : state === 'unavailable' ? (
          <div className="mt-8">
            <p className="font-semibold">Situs belum bisa dihubungi.</p>
            <button type="button" onClick={() => void check()} className="mt-4 rounded-xl bg-ink px-4 py-2.5 font-semibold text-paper">
              Coba lagi
            </button>
          </div>
        ) : (
          <form className="mt-8 flex flex-col gap-5" onSubmit={(event) => void login(event)}>
            <div>
              <h1 className="font-display text-2xl font-bold">Masuk ke Bang Story</h1>
              <p className="mt-1 text-sm text-ink-2">Situs ini hanya untuk pengguna yang masuk.</p>
            </div>
            <label className="flex flex-col gap-2 text-sm font-semibold">
              Nama pengguna
              <input
                autoComplete="username"
                autoFocus
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-2 text-sm font-semibold">
              Password
              <input
                autoComplete="current-password"
                required
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={inputCls}
              />
            </label>
            <label className="flex items-center gap-2.5 text-sm text-ink-2">
              <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="size-4 accent-accent" />
              Ingat saya di browser ini
            </label>
            {error && <p role="alert" className="rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-800">{error}</p>}
            <button
              type="submit"
              disabled={busy || !username || !password}
              className="rounded-xl border-[1.5px] border-ink bg-accent px-4 py-3 font-bold text-white shadow-ink transition hover:translate-y-0.5 hover:shadow-none disabled:cursor-wait disabled:opacity-60"
            >
              {busy ? 'Memeriksa…' : 'Masuk'}
            </button>
          </form>
        )}
      </section>
    </main>
  )
}
