import { useState, useEffect, useCallback } from 'react'
import {
  api,
  reportUrl,
  type RunHistoryEntry,
  type ScheduleConfig,
  type RepoWithType,
  type RunProgress,
  type KTSummary,
  type KTDetail,
  type RepoSettings,
  type KTApi,
} from './api'

const POLL_INTERVAL = 3000

// ── Icon Components ──────────────────────────────────────────────

function IconDashboard({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  )
}

function IconGitPR({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <line x1="6" y1="9" x2="6" y2="21" />
    </svg>
  )
}

function IconBeaker({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 3h15" />
      <path d="M6 3v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V3" />
      <path d="M6 14h12" />
    </svg>
  )
}

function IconBrain({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
    </svg>
  )
}

function IconHistory({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  )
}

function IconFile({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  )
}

function IconClock({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

function IconPlay({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  )
}

function IconX({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function IconExternal({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  )
}

// ── Reusable UI Components ───────────────────────────────────────

type Section = 'overview' | 'pr' | 'test-request' | 'knowledge' | 'history' | 'tests' | 'schedule'

const sidebarItems: { id: Section; label: string; icon: React.ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <IconDashboard /> },
  { id: 'pr', label: 'PR Testing', icon: <IconGitPR /> },
  { id: 'test-request', label: 'Test Request', icon: <IconBeaker /> },
  { id: 'knowledge', label: 'Knowledge', icon: <IconBrain /> },
  { id: 'history', label: 'History', icon: <IconHistory /> },
  { id: 'tests', label: 'Tests', icon: <IconFile /> },
  { id: 'schedule', label: 'Schedule', icon: <IconClock /> },
]

function Card({ title, children, className = '' }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-[#13161c] border border-[#1e2229] rounded-xl overflow-hidden card-hover ${className}`}>
      {title && (
        <div className="px-5 py-3.5 border-b border-[#1e2229]">
          <h3 className="text-sm font-semibold text-[#e1e3e6] m-0">{title}</h3>
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  )
}

function StatCard({ label, value, color = '#e1e3e6' }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="flex flex-col gap-1 min-w-[80px]">
      <span className="text-2xl font-bold tracking-tight" style={{ color }}>{value}</span>
      <span className="text-[11px] font-medium text-[#555d6e] uppercase tracking-wider">{label}</span>
    </div>
  )
}

function Badge({ children, color }: { children: React.ReactNode; color: 'orange' | 'green' | 'red' | 'blue' | 'purple' | 'yellow' | 'gray' }) {
  const styles: Record<string, string> = {
    orange: 'bg-[#ff983018] text-[#ffad57] border-[#ff983025]',
    green: 'bg-[#4ade8018] text-[#4ade80] border-[#4ade8025]',
    red: 'bg-[#f8717118] text-[#f87171] border-[#f8717125]',
    blue: 'bg-[#60a5fa18] text-[#60a5fa] border-[#60a5fa25]',
    purple: 'bg-[#a78bfa18] text-[#a78bfa] border-[#a78bfa25]',
    yellow: 'bg-[#facc1518] text-[#facc15] border-[#facc1525]',
    gray: 'bg-[#8b92a018] text-[#8b92a0] border-[#8b92a025]',
  }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium border ${styles[color]}`}>
      {children}
    </span>
  )
}

function Input({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full py-2.5 px-3.5 rounded-lg border border-[#1e2229] bg-[#0a0c10] text-[#e1e3e6] text-[13px] placeholder:text-[#555d6e] focus:outline-none focus:border-[#ff983060] focus:ring-2 focus:ring-[#ff983015] transition-colors ${className}`}
    />
  )
}

function Select({ className = '', children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { children: React.ReactNode }) {
  return (
    <select
      {...props}
      className={`py-2.5 px-3.5 rounded-lg border border-[#1e2229] bg-[#0a0c10] text-[#e1e3e6] text-[13px] focus:outline-none focus:border-[#ff983060] focus:ring-2 focus:ring-[#ff983015] transition-colors ${className}`}
    >
      {children}
    </select>
  )
}

function Textarea({ className = '', ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full py-2.5 px-3.5 rounded-lg border border-[#1e2229] bg-[#0a0c10] text-[#e1e3e6] text-[13px] placeholder:text-[#555d6e] focus:outline-none focus:border-[#ff983060] focus:ring-2 focus:ring-[#ff983015] transition-colors resize-y ${className}`}
    />
  )
}

function Button({ variant = 'primary', children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' }) {
  const base = 'inline-flex items-center gap-2 py-2.5 px-4 rounded-lg font-medium text-[13px] transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed'
  const variants: Record<string, string> = {
    primary: 'bg-[#ff9830] text-[#08090b] hover:bg-[#ffad57] active:bg-[#e88a28] shadow-[0_1px_2px_#0004]',
    secondary: 'bg-[#1a1d24] text-[#e1e3e6] border border-[#1e2229] hover:bg-[#22262f] hover:border-[#2a2e38]',
    danger: 'bg-transparent text-[#f87171] border border-[#f8717140] hover:bg-[#f8717115]',
    ghost: 'bg-transparent text-[#8b92a0] hover:text-[#e1e3e6] hover:bg-[#1a1d24]',
  }
  return <button {...props} className={`${base} ${variants[variant]} ${className}`}>{children}</button>
}

function EmptyState({ message }: { message: string }) {
  return <p className="text-[#555d6e] text-[13px] py-10 text-center">{message}</p>
}

// ── Main App ─────────────────────────────────────────────────────

function App() {
  const [runs, setRuns] = useState<RunHistoryEntry[]>([])
  const [currentRun, setCurrentRun] = useState<{ running: boolean; jobId?: string; progress?: RunProgress } | null>(null)
  const [schedule, setSchedule] = useState<ScheduleConfig | null>(null)
  const [lastRun, setLastRun] = useState<{ lastRun: { date: string; status: string } | null; lastSuccessfulRun: { date: string } | null } | null>(null)
  const [tests, setTests] = useState<{ repos: string[]; testsByRepo: Record<string, string[]>; reposWithType: RepoWithType[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeSection, setActiveSection] = useState<Section>('overview')

  // Filters
  const [filterStatus, setFilterStatus] = useState('')
  const [filterTrigger, setFilterTrigger] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')

  // Generate tests
  const [genUrl, setGenUrl] = useState('')
  const [genType, setGenType] = useState<'frontend' | 'backend'>('frontend')
  const [genContext, setGenContext] = useState('')
  const [genRepo, setGenRepo] = useState('')
  const [genApiBaseUrl, setGenApiBaseUrl] = useState('')
  const [genSampleResponse, setGenSampleResponse] = useState('')
  const [genSecretsAndParams, setGenSecretsAndParams] = useState('')
  const [genLoading, setGenLoading] = useState(false)

  // Add cases
  const [addCasesPrompt, setAddCasesPrompt] = useState('')
  const [addCasesRepo, setAddCasesRepo] = useState('')
  const [addCasesEndpoint, setAddCasesEndpoint] = useState('')
  const [addCasesSampleReq, setAddCasesSampleReq] = useState('')
  const [addCasesSecretsParams, setAddCasesSecretsParams] = useState('')
  const [addCasesLoading, setAddCasesLoading] = useState(false)

  // Schedule
  const [scheduleEnabled, setScheduleEnabled] = useState(true)
  const [scheduleCron, setScheduleCron] = useState('0 0,4,8,12,16,20 * * *')

  // PR Mode
  const [prRepo, setPrRepo] = useState('')
  const [prNumber, setPrNumber] = useState('')
  const [prLoading, setPrLoading] = useState(false)

  // Test Request Mode
  const [trRepo, setTrRepo] = useState('')
  const [trModule, setTrModule] = useState('')
  const [trType, setTrType] = useState<'' | 'frontend' | 'backend'>('')
  const [trApiBaseUrl, setTrApiBaseUrl] = useState('')
  const [trUiBaseUrl, setTrUiBaseUrl] = useState('')
  const [trLoading, setTrLoading] = useState(false)

  // KT
  const [ktList, setKtList] = useState<{ repos: string[]; kts: Record<string, KTSummary>; settings?: Record<string, RepoSettings> }>({ repos: [], kts: {} })
  const [ktDetail, setKtDetail] = useState<KTDetail | null>(null)
  const [ktDetailRepo, setKtDetailRepo] = useState('')
  const [ktGenRepo, setKtGenRepo] = useState('')
  const [ktGenRepoType, setKtGenRepoType] = useState<'frontend' | 'backend' | ''>('')
  const [ktGenLoading, setKtGenLoading] = useState(false)

  // Repo Settings
  const [repoSettings, setRepoSettings] = useState<Record<string, RepoSettings>>({})

  // Test param inputs (when selecting a test in Tests section)
  const [selectedTest, setSelectedTest] = useState<{ repo: string; file: string } | null>(null)
  const [selectedTestApi, setSelectedTestApi] = useState<KTApi | null>(null)
  const [testParamValues, setTestParamValues] = useState<Record<string, string>>({})
  const [testAuthValue, setTestAuthValue] = useState('')

  // ── Data fetching ──────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    try {
      const [runsRes, currentRes, scheduleRes, lastRes, testsRes, ktRes] = await Promise.all([
        api.getRuns({
          limit: 50,
          ...(filterStatus && { status: filterStatus }),
          ...(filterTrigger && { trigger: filterTrigger }),
          ...(filterDateFrom && { dateFrom: filterDateFrom }),
          ...(filterDateTo && { dateTo: filterDateTo }),
        }),
        api.getCurrentRun(),
        api.getSchedule(),
        api.getLastRun(),
        api.getTests(),
        api.getKTList().catch(() => ({ repos: [], kts: {} })),
      ])
      setRuns(runsRes.runs)
      setCurrentRun(currentRes)
      setSchedule(scheduleRes)
      setLastRun(lastRes)
      setTests(testsRes)
      setScheduleEnabled(scheduleRes.enabled)
      setScheduleCron(scheduleRes.cronExpression)
      setKtList(ktRes)
      if (ktRes.settings) setRepoSettings(prev => ({ ...prev, ...ktRes.settings }))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch')
    } finally {
      setLoading(false)
    }
  }, [filterStatus, filterTrigger, filterDateFrom, filterDateTo])

  useEffect(() => {
    fetchData()
    const id = setInterval(fetchData, POLL_INTERVAL)
    return () => clearInterval(id)
  }, [fetchData])

  // ── Handlers ───────────────────────────────────────────────────

  const withError = async (fn: () => Promise<void>) => {
    try {
      setError(null)
      await fn()
      fetchData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed')
    }
  }

  const handleTrigger = () => withError(() => api.triggerTest().then(() => {}))
  const handleRerun = () => withError(() => api.rerunTests().then(() => {}))
  const handleRerunFailed = () => withError(() => api.rerunFailedTests().then(() => {}))
  const handleCancel = () => withError(() => api.cancelTest().then(() => {}))

  const handleGenerateTests = async () => {
    if (!genUrl.trim() || !genContext.trim() || !genRepo.trim()) return
    setGenLoading(true)
    try {
      setError(null)
      let sampleResponse: object | undefined
      if (genSampleResponse.trim()) {
        try { sampleResponse = JSON.parse(genSampleResponse.trim()) }
        catch { setError('sampleResponse must be valid JSON'); setGenLoading(false); return }
      }
      await api.generateTests({
        url: genUrl.trim(), type: genType, context: genContext.trim(),
        repo: genRepo.trim(), apiBaseUrl: genApiBaseUrl.trim() || undefined,
        sampleResponse, secretsAndParams: genSecretsAndParams.trim() || undefined,
      })
      setGenUrl(''); setGenContext(''); setGenRepo(''); setGenApiBaseUrl('')
      setGenSampleResponse(''); setGenSecretsAndParams('')
      fetchData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generate failed')
    } finally { setGenLoading(false) }
  }

  const handleAddCases = async () => {
    if (!addCasesPrompt.trim() || !addCasesRepo.trim()) return
    setAddCasesLoading(true)
    try {
      setError(null)
      let sampleReq: object | undefined
      if (addCasesSampleReq.trim()) {
        try { sampleReq = JSON.parse(addCasesSampleReq.trim()) }
        catch { setError('sampleReq must be valid JSON'); setAddCasesLoading(false); return }
      }
      await api.addTestCases({
        userPrompt: addCasesPrompt, repo: addCasesRepo,
        endpoint: addCasesEndpoint.trim() || undefined, sampleReq,
        secretsAndParams: addCasesSecretsParams.trim() || undefined,
      })
      setAddCasesPrompt(''); setAddCasesEndpoint(''); setAddCasesSampleReq(''); setAddCasesSecretsParams('')
      fetchData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Add cases failed')
    } finally { setAddCasesLoading(false) }
  }

  const handleScheduleToggle = async () => {
    await withError(async () => {
      const updated = await api.updateSchedule({ enabled: !scheduleEnabled })
      setScheduleEnabled(updated.enabled); setSchedule(updated)
    })
  }

  const handleScheduleCron = async () => {
    await withError(async () => {
      const updated = await api.updateSchedule({ cronExpression: scheduleCron })
      setSchedule(updated)
    })
  }

  const handlePRTest = async () => {
    if (!prRepo.trim() || !prNumber.trim()) return
    setPrLoading(true)
    await withError(async () => {
      await api.testPR({ repo: prRepo.trim(), prNumber: parseInt(prNumber, 10) })
      setPrRepo(''); setPrNumber('')
    })
    setPrLoading(false)
  }

  const handleTestRequest = async () => {
    if (!trRepo.trim()) return
    setTrLoading(true)
    await withError(async () => {
      await api.testRequest({
        repo: trRepo.trim(),
        module: trModule.trim() || undefined,
        type: (trType || undefined) as 'frontend' | 'backend' | undefined,
        apiBaseUrl: trApiBaseUrl.trim() || undefined,
        uiBaseUrl: trUiBaseUrl.trim() || undefined,
      })
      setTrModule(''); setTrApiBaseUrl(''); setTrUiBaseUrl('')
    })
    setTrLoading(false)
  }

  const handleKTGenerate = async () => {
    if (!ktGenRepo.trim()) return
    setKtGenLoading(true)
    await withError(async () => {
      const repoType = ktGenRepoType || undefined
      await api.generateKT(ktGenRepo.trim(), repoType)
      setKtGenRepo('')
      setKtGenRepoType('')
    })
    setKtGenLoading(false)
  }

  const handleViewKT = async (repo: string) => {
    try {
      const detail = await api.getKTDetail(repo)
      setKtDetail(detail)
      setKtDetailRepo(repo)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load KT')
    }
  }

  const handleRepoTypeChange = async (repo: string, repoType: 'frontend' | 'backend') => {
    try {
      const existing = repoSettings[repo] || { repoType }
      const updated = { ...existing, repoType }
      await api.saveRepoSettings(repo, updated)
      setRepoSettings(prev => ({ ...prev, [repo]: updated }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save repo type')
    }
  }

  const handleSelectTest = async (repo: string, file: string) => {
    setSelectedTest({ repo, file })
    setTestParamValues({})
    setTestAuthValue('')
    setSelectedTestApi(null)
    // Try to find matching API from KT
    try {
      const detail = await api.getKTDetail(repo)
      if (detail?.kt?.apis?.length) {
        // Match test file name to API endpoint
        const baseName = file.replace('.api.spec.ts', '').replace('.ui.spec.ts', '')
        const matchedApi = detail.kt.apis.find(a => {
          const endpointName = a.endpoint.split('/').filter(Boolean).find(p => !['api', 'v1', 'v2', 'v3'].includes(p)) || ''
          return endpointName.toLowerCase() === baseName.toLowerCase()
        }) || detail.kt.apis[0]
        if (matchedApi) {
          setSelectedTestApi(matchedApi)
          // Load existing param values from settings
          const settings = repoSettings[repo]
          const key = `${matchedApi.method} ${matchedApi.endpoint}`
          if (settings?.endpointParams?.[key]) {
            setTestParamValues(settings.endpointParams[key])
          }
          if (settings?.auth?.value) {
            setTestAuthValue(settings.auth.value)
          }
        }
      }
    } catch { /* KT might not exist yet */ }
  }

  const handleSaveTestParams = async () => {
    if (!selectedTest || !selectedTestApi) return
    const repo = selectedTest.repo
    const key = `${selectedTestApi.method} ${selectedTestApi.endpoint}`
    const existing = repoSettings[repo] || { repoType: 'backend' }
    const updated: RepoSettings = {
      ...existing,
      auth: testAuthValue ? {
        type: (selectedTestApi.authType as 'bearer' | 'apiKey' | 'none') || 'bearer',
        headerName: selectedTestApi.authHeader || 'Authorization',
        value: testAuthValue,
      } : existing.auth,
      endpointParams: {
        ...(existing.endpointParams || {}),
        [key]: testParamValues,
      },
    }
    try {
      await api.saveRepoSettings(repo, updated)
      setRepoSettings(prev => ({ ...prev, [repo]: updated }))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save params')
    }
  }

  // ── Derived data ───────────────────────────────────────────────

  const runningEntry = runs.find(r => r.status === 'running')
  const liveProgress = currentRun?.progress
  const totalTests = liveProgress?.total ?? runningEntry?.total ?? 0
  const completedTests = liveProgress
    ? liveProgress.passed + liveProgress.failed + liveProgress.skipped
    : runningEntry ? runningEntry.passed + runningEntry.failed + runningEntry.skipped : 0
  const progressPct = totalTests > 0 ? (completedTests / totalTests) * 100 : 0
  const isRunning = currentRun?.running ?? false

  const triggerColor = (t: string): 'blue' | 'green' | 'orange' | 'purple' =>
    t === 'manual' ? 'blue' : t === 'scheduled' ? 'green' : t === 'auto' ? 'orange' : 'purple'

  const statusColor = (s: string): 'green' | 'red' | 'orange' | 'gray' =>
    s === 'passed' ? 'green' : s === 'failed' ? 'red' : s === 'running' ? 'orange' : 'gray'

  const recentPassed = runs.filter(r => r.status === 'passed').length
  const recentFailed = runs.filter(r => r.status === 'failed').length
  const totalRuns = runs.length

  // ── Loading ────────────────────────────────────────────────────

  if (loading && !runs.length) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-[#ff9830] border-t-transparent rounded-full animate-spin" />
          <span className="text-[#555d6e] text-sm">Loading dashboard...</span>
        </div>
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-[220px] bg-[#0d0f13] border-r border-[#1e2229] flex flex-col flex-shrink-0">
        <div className="px-5 py-5 border-b border-[#1e2229]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#ff983020] flex items-center justify-center">
              <IconBeaker size={16} />
            </div>
            <div>
              <h1 className="text-[15px] font-bold text-[#e1e3e6] leading-tight m-0">AutoTest</h1>
              <span className="text-[10px] font-medium text-[#555d6e] uppercase tracking-widest">AI Platform</span>
            </div>
          </div>
        </div>

        <nav className="flex-1 py-3 px-3">
          {sidebarItems.map(item => (
            <button
              key={item.id}
              onClick={() => setActiveSection(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13px] font-medium transition-all duration-150 mb-0.5 ${
                activeSection === item.id
                  ? 'bg-[#ff983015] text-[#ff9830]'
                  : 'text-[#8b92a0] hover:text-[#e1e3e6] hover:bg-[#1a1d24]'
              }`}
            >
              <span className={activeSection === item.id ? 'text-[#ff9830]' : 'text-[#555d6e]'}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        {/* Connection status */}
        <div className="px-5 py-4 border-t border-[#1e2229]">
          <div className="flex items-center gap-2">
            <span className={`status-dot ${error ? 'bg-[#f87171]' : 'bg-[#4ade80]'} animate-glow-pulse`} />
            <span className="text-[11px] text-[#555d6e]">{error ? 'Connection error' : 'Connected'}</span>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="h-14 bg-[#0d0f13] border-b border-[#1e2229] flex items-center justify-between px-6 flex-shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-[15px] font-semibold text-[#e1e3e6] m-0 capitalize">
              {sidebarItems.find(s => s.id === activeSection)?.label || 'Overview'}
            </h2>
            {isRunning && (
              <Badge color="orange">
                <span className="status-dot bg-[#ff9830] animate-glow-pulse mr-1.5" />
                Running
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-4 text-[12px] text-[#555d6e]">
              <span><span className="text-[#4ade80] font-semibold">{recentPassed}</span> passed</span>
              <span><span className="text-[#f87171] font-semibold">{recentFailed}</span> failed</span>
              <span><span className="text-[#8b92a0] font-semibold">{totalRuns}</span> total</span>
            </div>
          </div>
        </header>

        <main className="flex-1 p-6 overflow-y-auto">
          {error && (
            <div className="mb-5 py-3 px-4 bg-[#f8717110] border border-[#f8717130] rounded-lg text-[#f87171] text-[13px] flex items-center justify-between animate-fade-in">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="text-[#f87171] hover:text-[#fca5a5] p-1"><IconX size={14} /></button>
            </div>
          )}

          <div className="animate-fade-in">
            {/* ── OVERVIEW ────────────────────────────────────── */}
            {activeSection === 'overview' && (
              <div className="flex flex-col gap-5">
                {/* Current Run */}
                <Card title="Current Run">
                  {isRunning ? (
                    <>
                      <div className="flex gap-8 flex-wrap mb-4">
                        <StatCard label="Total" value={totalTests} color="#ff9830" />
                        <StatCard label="Completed" value={completedTests} />
                        <StatCard label="Remaining" value={Math.max(0, totalTests - completedTests)} />
                        {liveProgress && (
                          <>
                            <StatCard label="Passed" value={liveProgress.passed} color="#4ade80" />
                            <StatCard label="Failed" value={liveProgress.failed} color="#f87171" />
                          </>
                        )}
                      </div>
                      <div className="h-2 bg-[#0a0c10] rounded-full overflow-hidden mb-3">
                        <div
                          className={`h-full rounded-full ${totalTests === 0 ? 'w-[25%] animate-progress-slide bg-[#ff9830]' : 'transition-[width] duration-500 ease-out'}`}
                          style={totalTests > 0 ? {
                            width: `${progressPct}%`,
                            background: `linear-gradient(90deg, #ff9830 0%, #ffad57 100%)`,
                          } : undefined}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <p className="text-[12px] text-[#555d6e]">
                          <code className="font-mono text-[11px] text-[#8b92a0] bg-[#0a0c10] px-1.5 py-0.5 rounded">{currentRun?.jobId}</code>
                          <span className="mx-2">|</span>
                          {runningEntry?.startTime ? new Date(runningEntry.startTime).toLocaleString() : ''}
                        </p>
                        <div className="flex items-center gap-3">
                          <a href={reportUrl(currentRun!.jobId!)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[#60a5fa] text-[13px] font-medium no-underline hover:text-[#93c5fd]">
                            Report <IconExternal />
                          </a>
                          <Button variant="danger" onClick={handleCancel}><IconX size={14} /> Cancel</Button>
                        </div>
                      </div>
                    </>
                  ) : (
                    <EmptyState message="No tests currently running" />
                  )}
                </Card>

                {/* Actions + Last Run */}
                <div className="grid grid-cols-2 gap-5 max-[900px]:grid-cols-1">
                  <Card title="Quick Actions">
                    <div className="flex gap-2.5 flex-wrap">
                      <Button onClick={handleTrigger} disabled={isRunning}><IconPlay /> Run All</Button>
                      <Button variant="secondary" onClick={handleRerun} disabled={isRunning}>Rerun All</Button>
                      <Button variant="secondary" onClick={handleRerunFailed} disabled={isRunning}>Rerun Failed</Button>
                    </div>
                  </Card>
                  <Card title="Last Run">
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] text-[#555d6e] w-24">Latest:</span>
                        {lastRun?.lastRun ? (
                          <span className="text-[13px]">
                            {new Date(lastRun.lastRun.date).toLocaleString()}
                            <Badge color={lastRun.lastRun.status === 'passed' ? 'green' : 'red'} >{lastRun.lastRun.status}</Badge>
                          </span>
                        ) : <span className="text-[13px] text-[#555d6e]">Never</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] text-[#555d6e] w-24">Last success:</span>
                        <span className="text-[13px]">
                          {lastRun?.lastSuccessfulRun ? new Date(lastRun.lastSuccessfulRun.date).toLocaleString() : <span className="text-[#555d6e]">Never</span>}
                        </span>
                      </div>
                    </div>
                  </Card>
                </div>

                {/* Generate Tests */}
                <Card title="Generate New Tests">
                  <p className="text-[12px] text-[#555d6e] mb-4">AI agent analyzes your repo and generates comprehensive test suites.</p>
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-[1fr_auto_auto] gap-2.5 max-[800px]:grid-cols-1">
                      <Input placeholder="URL (required) — e.g. https://explorer.garden.finance" value={genUrl} onChange={e => setGenUrl(e.target.value)} />
                      <Select value={genType} onChange={e => setGenType(e.target.value as 'frontend' | 'backend')}>
                        <option value="frontend">Frontend</option>
                        <option value="backend">Backend</option>
                      </Select>
                      <Input placeholder="Repo (required) — e.g. hashiraio/quote" value={genRepo} onChange={e => setGenRepo(e.target.value)} className="min-w-[180px]" />
                    </div>
                    <Textarea placeholder="Context (required) — Describe what to test, which flows/endpoints to cover, edge cases, validation rules..." value={genContext} onChange={e => setGenContext(e.target.value)} rows={3} />
                    {genType === 'backend' && (
                      <div className="grid grid-cols-1 gap-2.5">
                        <Input placeholder="API Base URL" value={genApiBaseUrl} onChange={e => setGenApiBaseUrl(e.target.value)} />
                        <Textarea placeholder="Sample Response (JSON)" value={genSampleResponse} onChange={e => setGenSampleResponse(e.target.value)} rows={3} className="font-mono text-[12px]" />
                      </div>
                    )}
                    <Textarea
                      placeholder="Secrets & Params (optional) — API keys, auth tokens, headers, param values, request bodies the tests should use. e.g.&#10;Authorization: Bearer sk-test-xxx&#10;X-API-Key: my-key-123&#10;order_pair: BTC/ETH&#10;body.address: 0xabc..."
                      value={genSecretsAndParams}
                      onChange={e => setGenSecretsAndParams(e.target.value)}
                      rows={4}
                      className="font-mono text-[12px]"
                    />
                    <Button onClick={handleGenerateTests} disabled={genLoading || isRunning || !genRepo.trim()} className="self-start">
                      {genLoading ? 'Generating...' : 'Generate & Run'}
                    </Button>
                  </div>
                </Card>

                {/* Add Cases */}
                <Card title="Add Test Cases">
                  <p className="text-[12px] text-[#555d6e] mb-4">Append new test cases to existing test suites.</p>
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-[1fr_auto_auto] gap-2.5 max-[800px]:grid-cols-1">
                      <Input placeholder="Describe tests to add..." value={addCasesPrompt} onChange={e => setAddCasesPrompt(e.target.value)} />
                      <Select value={addCasesRepo} onChange={e => setAddCasesRepo(e.target.value)}>
                        <option value="">Select repo</option>
                        {(tests?.reposWithType?.length ? tests.reposWithType : (tests?.repos ?? []).map(r => ({ name: r, type: 'backend' as const }))).map(r => (
                          <option key={r.name} value={r.name}>{r.name} ({r.type})</option>
                        ))}
                      </Select>
                      <Button onClick={handleAddCases} disabled={addCasesLoading || isRunning}>
                        {addCasesLoading ? 'Adding...' : 'Add & Run'}
                      </Button>
                    </div>
                    {addCasesRepo && tests?.reposWithType?.find(r => r.name === addCasesRepo)?.type === 'backend' && (
                      <div className="grid grid-cols-1 gap-2.5">
                        <Input placeholder="Endpoint (e.g. GET /api/quote)" value={addCasesEndpoint} onChange={e => setAddCasesEndpoint(e.target.value)} />
                        <Textarea placeholder="Sample request (JSON)" value={addCasesSampleReq} onChange={e => setAddCasesSampleReq(e.target.value)} rows={2} className="font-mono text-[12px]" />
                      </div>
                    )}
                    {addCasesRepo && (
                      <Textarea
                        placeholder="Secrets & Params (optional) — API keys, auth tokens, headers, param values, request bodies the tests should use. e.g.&#10;Authorization: Bearer sk-test-xxx&#10;X-API-Key: my-key-123&#10;order_pair: BTC/ETH&#10;body.address: 0xabc..."
                        value={addCasesSecretsParams}
                        onChange={e => setAddCasesSecretsParams(e.target.value)}
                        rows={3}
                        className="font-mono text-[12px]"
                      />
                    )}
                  </div>
                </Card>
              </div>
            )}

            {/* ── PR TESTING ─────────────────────────────────── */}
            {activeSection === 'pr' && (
              <div className="flex flex-col gap-5">
                <Card title="Pull Request Testing">
                  <p className="text-[12px] text-[#555d6e] mb-5">
                    Analyze a PR diff and automatically generate tests targeting the changed code.
                    The agent ensures a KT document exists, fetches the PR diff, identifies changed modules, and generates targeted tests.
                  </p>
                  <div className="flex flex-col gap-4">
                    <div className="grid grid-cols-[1fr_150px] gap-3 max-[600px]:grid-cols-1">
                      <Input placeholder="Repository (e.g. hashiraio/explorer-api)" value={prRepo} onChange={e => setPrRepo(e.target.value)} />
                      <Input type="number" placeholder="PR #" value={prNumber} onChange={e => setPrNumber(e.target.value)} />
                    </div>
                    <Button onClick={handlePRTest} disabled={prLoading || isRunning || !prRepo.trim() || !prNumber.trim()}>
                      <IconGitPR size={16} />
                      {prLoading ? 'Analyzing PR...' : 'Analyze & Test PR'}
                    </Button>
                  </div>
                </Card>

                <Card title="How PR Mode Works">
                  <div className="grid grid-cols-4 gap-4 max-[800px]:grid-cols-2 max-[500px]:grid-cols-1">
                    {[
                      { step: '1', title: 'KT Check', desc: 'Loads or generates Knowledge Transfer document for the repo' },
                      { step: '2', title: 'Diff Analysis', desc: 'Fetches all changed files, functions, and endpoints from the PR' },
                      { step: '3', title: 'Test Generation', desc: 'Creates targeted tests for changed frontend & backend code' },
                      { step: '4', title: 'Execution', desc: 'Runs generated tests and produces a detailed report' },
                    ].map(s => (
                      <div key={s.step} className="flex flex-col gap-2 p-4 rounded-lg bg-[#0a0c10] border border-[#1e2229]">
                        <div className="w-7 h-7 rounded-full bg-[#ff983020] text-[#ff9830] flex items-center justify-center text-[12px] font-bold">{s.step}</div>
                        <h4 className="text-[13px] font-semibold text-[#e1e3e6] m-0">{s.title}</h4>
                        <p className="text-[12px] text-[#555d6e] m-0 leading-relaxed">{s.desc}</p>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>
            )}

            {/* ── TEST REQUEST ────────────────────────────────── */}
            {activeSection === 'test-request' && (
              <div className="flex flex-col gap-5">
                <Card title="Test Request">
                  <p className="text-[12px] text-[#555d6e] mb-5">
                    Request tests for a specific module or feature. The agent checks for KT staleness, updates if needed, and generates focused tests.
                  </p>
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-[1fr_1fr] gap-3 max-[600px]:grid-cols-1">
                      <Input placeholder="Repository (e.g. hashiraio/quote)" value={trRepo} onChange={e => setTrRepo(e.target.value)} />
                      <Input placeholder="Module (optional, e.g. auth, payments)" value={trModule} onChange={e => setTrModule(e.target.value)} />
                    </div>
                    <div className="grid grid-cols-[auto_1fr_1fr] gap-3 max-[600px]:grid-cols-1">
                      <Select value={trType} onChange={e => setTrType(e.target.value as '' | 'frontend' | 'backend')}>
                        <option value="">Auto-detect type</option>
                        <option value="frontend">Frontend</option>
                        <option value="backend">Backend</option>
                      </Select>
                      <Input placeholder="API Base URL (optional)" value={trApiBaseUrl} onChange={e => setTrApiBaseUrl(e.target.value)} />
                      <Input placeholder="UI Base URL (optional)" value={trUiBaseUrl} onChange={e => setTrUiBaseUrl(e.target.value)} />
                    </div>
                    <Button onClick={handleTestRequest} disabled={trLoading || isRunning || !trRepo.trim()}>
                      <IconBeaker size={16} />
                      {trLoading ? 'Generating...' : 'Generate & Run Tests'}
                    </Button>
                  </div>
                </Card>

                <Card title="How Test Request Mode Works">
                  <div className="grid grid-cols-3 gap-4 max-[700px]:grid-cols-1">
                    {[
                      { step: '1', title: 'KT Check', desc: 'Loads existing KT or generates one from main branch' },
                      { step: '2', title: 'Staleness Check', desc: 'If module is newer than KT, re-scans and updates only that module' },
                      { step: '3', title: 'Test Generation', desc: 'Generates unit, integration, UI, and API tests for the requested scope' },
                    ].map(s => (
                      <div key={s.step} className="flex flex-col gap-2 p-4 rounded-lg bg-[#0a0c10] border border-[#1e2229]">
                        <div className="w-7 h-7 rounded-full bg-[#60a5fa20] text-[#60a5fa] flex items-center justify-center text-[12px] font-bold">{s.step}</div>
                        <h4 className="text-[13px] font-semibold text-[#e1e3e6] m-0">{s.title}</h4>
                        <p className="text-[12px] text-[#555d6e] m-0 leading-relaxed">{s.desc}</p>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>
            )}

            {/* ── KNOWLEDGE (KT) ─────────────────────────────── */}
            {activeSection === 'knowledge' && (
              <div className="flex flex-col gap-5">
                <Card title="Generate Knowledge Transfer">
                  <p className="text-[12px] text-[#555d6e] mb-4">
                    Generate a KT document for a repository. This scans the main branch and produces a comprehensive analysis of architecture, modules, APIs, and UI components.
                  </p>
                  <div className="flex gap-3 items-center">
                    <Input placeholder="Repository (e.g. hashiraio/explorer-api)" value={ktGenRepo} onChange={e => setKtGenRepo(e.target.value)} className="max-w-[400px]" />
                    <Select
                      value={ktGenRepoType}
                      onChange={e => setKtGenRepoType(e.target.value as 'frontend' | 'backend' | '')}
                      className="min-w-[130px]"
                    >
                      <option value="">Auto-detect</option>
                      <option value="frontend">Frontend</option>
                      <option value="backend">Backend</option>
                    </Select>
                    <Button onClick={handleKTGenerate} disabled={ktGenLoading || !ktGenRepo.trim()}>
                      <IconBrain size={16} />
                      {ktGenLoading ? 'Generating...' : 'Generate KT'}
                    </Button>
                  </div>
                </Card>

                <Card title="Knowledge Transfer Documents">
                  {ktList.repos.length > 0 ? (
                    <div className="flex flex-col gap-3">
                      {ktList.repos.map(repo => {
                        const kt = ktList.kts[repo]
                        if (!kt) return null
                        const settings = repoSettings[repo]
                        return (
                          <div
                            key={repo}
                            className="p-4 rounded-lg bg-[#0a0c10] border border-[#1e2229] hover:border-[#2a2e38] transition-colors"
                          >
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-3 cursor-pointer" onClick={() => handleViewKT(repo)}>
                                <h4 className="text-[13px] font-semibold text-[#e1e3e6] m-0">{repo}</h4>
                                <span className="text-[11px] text-[#555d6e]">{new Date(kt.generated_at).toLocaleDateString()}</span>
                              </div>
                              <Select
                                value={settings?.repoType || ''}
                                onChange={e => { e.stopPropagation(); handleRepoTypeChange(repo, e.target.value as 'frontend' | 'backend') }}
                                className="!py-1.5 !px-2.5 !text-[11px] min-w-[110px]"
                              >
                                <option value="">Select type</option>
                                <option value="frontend">Frontend</option>
                                <option value="backend">Backend</option>
                              </Select>
                            </div>
                            <div className="flex gap-4 flex-wrap cursor-pointer" onClick={() => handleViewKT(repo)}>
                              <Badge color="blue">{kt.modules} modules</Badge>
                              <Badge color="green">{kt.apis} APIs</Badge>
                              <Badge color="purple">{kt.ui_components} components</Badge>
                              <Badge color="orange">{kt.tests.api + kt.tests.playwright} tests</Badge>
                              {settings?.repoType && <Badge color={settings.repoType === 'backend' ? 'yellow' : 'purple'}>{settings.repoType}</Badge>}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <EmptyState message="No KT documents yet. Generate one above." />
                  )}
                </Card>

                {/* KT Detail Modal */}
                {ktDetail && (
                  <Card title={`KT: ${ktDetailRepo}`}>
                    <div className="flex items-center justify-between mb-4">
                      <span className="text-[12px] text-[#555d6e]">Generated: {new Date(ktDetail.kt.generated_at).toLocaleString()}</span>
                      <Button variant="ghost" onClick={() => { setKtDetail(null); setKtDetailRepo('') }}>
                        <IconX size={14} /> Close
                      </Button>
                    </div>

                    <div className="mb-5">
                      <h4 className="text-[12px] font-semibold text-[#8b92a0] uppercase tracking-wider mb-2">Architecture</h4>
                      <p className="text-[13px] text-[#e1e3e6] bg-[#0a0c10] p-4 rounded-lg border border-[#1e2229] leading-relaxed whitespace-pre-wrap">
                        {ktDetail.kt.architecture}
                      </p>
                    </div>

                    {ktDetail.kt.modules.length > 0 && (
                      <div className="mb-5">
                        <h4 className="text-[12px] font-semibold text-[#8b92a0] uppercase tracking-wider mb-2">Modules ({ktDetail.kt.modules.length})</h4>
                        <div className="grid grid-cols-2 gap-2 max-[700px]:grid-cols-1">
                          {ktDetail.kt.modules.map((m, i) => (
                            <div key={i} className="p-3 bg-[#0a0c10] border border-[#1e2229] rounded-lg">
                              <div className="text-[13px] font-medium text-[#e1e3e6]">{m.name}</div>
                              <div className="text-[11px] text-[#555d6e] mt-0.5">{m.path}</div>
                              <div className="text-[12px] text-[#8b92a0] mt-1">{m.description}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {ktDetail.kt.apis.length > 0 && (
                      <div className="mb-5">
                        <h4 className="text-[12px] font-semibold text-[#8b92a0] uppercase tracking-wider mb-2">API Endpoints ({ktDetail.kt.apis.length})</h4>
                        <div className="flex flex-col gap-3">
                          {ktDetail.kt.apis.map((a, i) => (
                            <div key={i} className="p-4 bg-[#0a0c10] border border-[#1e2229] rounded-lg">
                              <div className="flex items-center gap-3 mb-2">
                                <Badge color="blue">{a.method}</Badge>
                                <code className="font-mono text-[12px] text-[#8b92a0]">{a.endpoint}</code>
                                {a.authType && a.authType !== 'none' && <Badge color="yellow">{a.authType}</Badge>}
                              </div>
                              <p className="text-[12px] text-[#8b92a0] mb-2">{a.description}</p>
                              {a.requiredParams && a.requiredParams.length > 0 && (
                                <div className="mb-2">
                                  <span className="text-[11px] font-medium text-[#f87171] uppercase">Required Params:</span>
                                  <div className="flex gap-2 flex-wrap mt-1">
                                    {a.requiredParams.map((p, j) => (
                                      <span key={j} className="text-[11px] bg-[#f8717115] text-[#f87171] px-2 py-0.5 rounded border border-[#f8717130]">
                                        {p.name}: {p.type}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {a.optionalParams && a.optionalParams.length > 0 && (
                                <div className="mb-2">
                                  <span className="text-[11px] font-medium text-[#555d6e] uppercase">Optional Params:</span>
                                  <div className="flex gap-2 flex-wrap mt-1">
                                    {a.optionalParams.map((p, j) => (
                                      <span key={j} className="text-[11px] bg-[#1a1d24] text-[#8b92a0] px-2 py-0.5 rounded border border-[#1e2229]">
                                        {p.name}: {p.type}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {a.requestBody && a.requestBody.fields?.length > 0 && (
                                <div className="mb-2">
                                  <span className="text-[11px] font-medium text-[#60a5fa] uppercase">Request Body:</span>
                                  <div className="flex gap-2 flex-wrap mt-1">
                                    {a.requestBody.fields.map((f, j) => (
                                      <span key={j} className={`text-[11px] px-2 py-0.5 rounded border ${f.required ? 'bg-[#f8717115] text-[#f87171] border-[#f8717130]' : 'bg-[#1a1d24] text-[#8b92a0] border-[#1e2229]'}`}>
                                        {f.name}: {f.type} {f.required ? '*' : ''}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {a.responseFormat && (
                                <div>
                                  <span className="text-[11px] font-medium text-[#4ade80] uppercase">Response:</span>
                                  <pre className="text-[11px] text-[#8b92a0] bg-[#13161c] p-2 rounded mt-1 overflow-x-auto">{a.responseFormat}</pre>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {ktDetail.kt.ui_components.length > 0 && (
                      <div>
                        <h4 className="text-[12px] font-semibold text-[#8b92a0] uppercase tracking-wider mb-2">UI Components ({ktDetail.kt.ui_components.length})</h4>
                        <div className="grid grid-cols-2 gap-3 max-[700px]:grid-cols-1">
                          {ktDetail.kt.ui_components.map((c, i) => (
                            <div key={i} className="p-3 bg-[#0a0c10] border border-[#1e2229] rounded-lg">
                              <div className="text-[13px] font-medium text-[#a78bfa]">{c.name}</div>
                              <div className="text-[11px] text-[#555d6e] font-mono mt-0.5">{c.path}</div>
                              <div className="text-[12px] text-[#8b92a0] mt-1">{c.description}</div>
                              {c.buttons && c.buttons.length > 0 && (
                                <div className="mt-2">
                                  <span className="text-[10px] font-medium text-[#ff9830] uppercase">Buttons:</span>
                                  <div className="flex gap-1.5 flex-wrap mt-1">
                                    {c.buttons.map((b, j) => (
                                      <span key={j} className="text-[10px] bg-[#ff983015] text-[#ffad57] px-1.5 py-0.5 rounded border border-[#ff983025]" title={b.className || ''}>
                                        {b.text}{b.className ? ` (.${b.className.split(' ')[0]})` : ''}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {c.distinguishingFactors && c.distinguishingFactors.length > 0 && (
                                <div className="mt-2">
                                  <span className="text-[10px] font-medium text-[#4ade80] uppercase">Identifying:</span>
                                  <ul className="mt-1 list-none p-0">
                                    {c.distinguishingFactors.map((f, j) => (
                                      <li key={j} className="text-[10px] text-[#8b92a0] leading-relaxed">{f}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </Card>
                )}
              </div>
            )}

            {/* ── HISTORY ─────────────────────────────────────── */}
            {activeSection === 'history' && (
              <Card title="Run History">
                <div className="flex gap-2.5 mb-5 flex-wrap">
                  <Select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="min-w-[130px]">
                    <option value="">All statuses</option>
                    <option value="passed">Passed</option>
                    <option value="failed">Failed</option>
                    <option value="running">Running</option>
                    <option value="cancelled">Cancelled</option>
                  </Select>
                  <Select value={filterTrigger} onChange={e => setFilterTrigger(e.target.value)} className="min-w-[130px]">
                    <option value="">All triggers</option>
                    <option value="manual">Manual</option>
                    <option value="scheduled">Scheduled</option>
                    <option value="auto">Auto</option>
                    <option value="add-cases">Add cases</option>
                  </Select>
                  <Input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)} className="min-w-[140px] !w-auto" />
                  <Input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)} className="min-w-[140px] !w-auto" />
                </div>

                {runs.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[13px]">
                      <thead>
                        <tr className="border-b border-[#1e2229]">
                          <th className="text-left py-3 px-3 text-[11px] font-medium text-[#555d6e] uppercase tracking-wider">Status</th>
                          <th className="text-left py-3 px-3 text-[11px] font-medium text-[#555d6e] uppercase tracking-wider">Job</th>
                          <th className="text-left py-3 px-3 text-[11px] font-medium text-[#555d6e] uppercase tracking-wider">Date</th>
                          <th className="text-left py-3 px-3 text-[11px] font-medium text-[#555d6e] uppercase tracking-wider">Results</th>
                          <th className="text-left py-3 px-3 text-[11px] font-medium text-[#555d6e] uppercase tracking-wider">Duration</th>
                          <th className="text-left py-3 px-3 text-[11px] font-medium text-[#555d6e] uppercase tracking-wider">Trigger</th>
                          <th className="text-left py-3 px-3"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.map(r => (
                          <tr key={r.jobId} className="border-b border-[#1e222915] hover:bg-[#1a1e2640] transition-colors">
                            <td className="py-3 px-3">
                              <Badge color={statusColor(r.status)}>{r.status}</Badge>
                            </td>
                            <td className="py-3 px-3">
                              <code className="font-mono text-[11px] text-[#8b92a0] bg-[#0a0c10] px-1.5 py-0.5 rounded">{r.jobId}</code>
                            </td>
                            <td className="py-3 px-3 text-[#8b92a0]">{new Date(r.startTime).toLocaleString()}</td>
                            <td className="py-3 px-3">
                              <div className="flex items-center gap-2">
                                <span className="text-[#4ade80] font-medium">{r.passed}</span>
                                <span className="text-[#555d6e]">/</span>
                                <span className="text-[#f87171] font-medium">{r.failed}</span>
                                <span className="text-[#555d6e]">/</span>
                                <span className="text-[#facc15] font-medium">{r.skipped}</span>
                                <span className="text-[#555d6e] text-[11px]">of {r.total}</span>
                              </div>
                            </td>
                            <td className="py-3 px-3 text-[#8b92a0]">{r.duration ? `${(r.duration / 1000).toFixed(1)}s` : '--'}</td>
                            <td className="py-3 px-3"><Badge color={triggerColor(r.triggerType)}>{r.triggerType}</Badge></td>
                            <td className="py-3 px-3">
                              {r.status !== 'running' && (
                                <a href={reportUrl(r.jobId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[#60a5fa] text-[12px] font-medium no-underline hover:text-[#93c5fd]">
                                  Report <IconExternal size={12} />
                                </a>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState message="No test runs yet" />
                )}
              </Card>
            )}

            {/* ── TESTS ───────────────────────────────────────── */}
            {activeSection === 'tests' && (
              <div className="flex flex-col gap-5">
                <Card title="Generated Tests">
                  {tests?.repos?.length ? (
                    <div className="flex flex-col gap-4">
                      {tests.repos.map(repo => {
                        const repoType = repoSettings[repo]?.repoType || tests.reposWithType?.find(r => r.name === repo)?.type
                        return (
                          <div key={repo} className="p-4 rounded-lg bg-[#0a0c10] border border-[#1e2229]">
                            <div className="flex items-center gap-3 mb-3">
                              <h4 className="text-[13px] font-semibold text-[#e1e3e6] m-0">{repo}</h4>
                              {repoType && <Badge color={repoType === 'backend' ? 'blue' : 'purple'}>{repoType}</Badge>}
                              <span className="text-[11px] text-[#555d6e]">{(tests.testsByRepo[repo] || []).length} files</span>
                            </div>
                            <div className="flex flex-col gap-1.5">
                              {(tests.testsByRepo[repo] || []).map(f => (
                                <div
                                  key={f}
                                  className={`flex items-center gap-2 py-1.5 px-2 rounded cursor-pointer transition-colors ${
                                    selectedTest?.repo === repo && selectedTest?.file === f
                                      ? 'bg-[#ff983015] border border-[#ff983030]'
                                      : 'hover:bg-[#1a1d24]'
                                  }`}
                                  onClick={() => handleSelectTest(repo, f)}
                                >
                                  <span className={`status-dot ${f.endsWith('.ui.spec.ts') ? 'bg-[#a78bfa]' : 'bg-[#60a5fa]'}`} />
                                  <code className="text-[12px] font-mono text-[#8b92a0]">{f}</code>
                                </div>
                              ))}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <EmptyState message="No generated tests yet" />
                  )}
                </Card>

                {/* Test Parameter Configuration Panel */}
                {selectedTest && selectedTestApi && (repoSettings[selectedTest.repo]?.repoType === 'backend' || selectedTest.file.endsWith('.api.spec.ts')) && (
                  <Card title={`Configure: ${selectedTestApi.method} ${selectedTestApi.endpoint}`}>
                    <p className="text-[12px] text-[#555d6e] mb-4">
                      Set parameter values for this endpoint. These will be saved to <code className="text-[11px]">memory/{selectedTest.repo}/settings.json</code>.
                    </p>

                    {/* Auth */}
                    {(selectedTestApi.authRequired || selectedTestApi.authType) && selectedTestApi.authType !== 'none' && (
                      <div className="mb-4 p-3 bg-[#0a0c10] rounded-lg border border-[#facc1530]">
                        <label className="block text-[11px] font-medium text-[#facc15] uppercase tracking-wider mb-1.5">
                          {selectedTestApi.authType === 'apiKey' ? 'API Key' : 'Bearer Token'} ({selectedTestApi.authHeader || 'Authorization'}) *
                        </label>
                        <Input
                          type="password"
                          placeholder={selectedTestApi.authType === 'apiKey' ? 'Enter API key...' : 'Enter bearer token...'}
                          value={testAuthValue}
                          onChange={e => setTestAuthValue(e.target.value)}
                        />
                      </div>
                    )}

                    {/* Required Params */}
                    {selectedTestApi.requiredParams && selectedTestApi.requiredParams.length > 0 && (
                      <div className="mb-4">
                        <h5 className="text-[11px] font-medium text-[#f87171] uppercase tracking-wider mb-2">Required Parameters</h5>
                        <div className="flex flex-col gap-2">
                          {selectedTestApi.requiredParams.map((p, i) => (
                            <div key={i}>
                              <label className="block text-[11px] text-[#8b92a0] mb-1">{p.name} <span className="text-[#555d6e]">({p.type})</span> — {p.description}</label>
                              <Input
                                placeholder={`${p.name} (required)`}
                                value={testParamValues[p.name] || ''}
                                onChange={e => setTestParamValues(prev => ({ ...prev, [p.name]: e.target.value }))}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Request Body */}
                    {selectedTestApi.requestBody && selectedTestApi.requestBody.fields?.length > 0 && (
                      <div className="mb-4">
                        <h5 className="text-[11px] font-medium text-[#60a5fa] uppercase tracking-wider mb-2">Request Body Fields</h5>
                        <div className="flex flex-col gap-2">
                          {selectedTestApi.requestBody.fields.map((f, i) => (
                            <div key={i}>
                              <label className="block text-[11px] text-[#8b92a0] mb-1">
                                {f.name} <span className="text-[#555d6e]">({f.type})</span>
                                {f.required && <span className="text-[#f87171]"> *</span>}
                                {' '} — {f.description}
                              </label>
                              <Input
                                placeholder={`${f.name}${f.required ? ' (required)' : ' (optional)'}`}
                                value={testParamValues[`body.${f.name}`] || ''}
                                onChange={e => setTestParamValues(prev => ({ ...prev, [`body.${f.name}`]: e.target.value }))}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Optional Params */}
                    {selectedTestApi.optionalParams && selectedTestApi.optionalParams.length > 0 && (
                      <div className="mb-4">
                        <h5 className="text-[11px] font-medium text-[#555d6e] uppercase tracking-wider mb-2">Optional Parameters</h5>
                        <div className="flex flex-col gap-2">
                          {selectedTestApi.optionalParams.map((p, i) => (
                            <div key={i}>
                              <label className="block text-[11px] text-[#8b92a0] mb-1">{p.name} <span className="text-[#555d6e]">({p.type})</span> — {p.description}</label>
                              <Input
                                placeholder={`${p.name} (optional)`}
                                value={testParamValues[p.name] || ''}
                                onChange={e => setTestParamValues(prev => ({ ...prev, [p.name]: e.target.value }))}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Response format preview */}
                    {selectedTestApi.responseFormat && (
                      <div className="mb-4">
                        <h5 className="text-[11px] font-medium text-[#4ade80] uppercase tracking-wider mb-2">Expected Response</h5>
                        <pre className="text-[11px] text-[#8b92a0] bg-[#0a0c10] p-3 rounded border border-[#1e2229] overflow-x-auto">{selectedTestApi.responseFormat}</pre>
                      </div>
                    )}

                    <div className="flex gap-3">
                      <Button onClick={handleSaveTestParams}>Save Parameters</Button>
                      <Button variant="ghost" onClick={() => { setSelectedTest(null); setSelectedTestApi(null) }}>
                        <IconX size={14} /> Close
                      </Button>
                    </div>
                  </Card>
                )}
              </div>
            )}

            {/* ── SCHEDULE ────────────────────────────────────── */}
            {activeSection === 'schedule' && (
              <Card title="Cron Scheduler">
                <div className="flex flex-col gap-5">
                  <div className="flex items-center gap-5 flex-wrap">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <div className={`relative w-11 h-6 rounded-full transition-colors ${scheduleEnabled ? 'bg-[#ff9830]' : 'bg-[#1e2229]'}`} onClick={handleScheduleToggle}>
                        <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${scheduleEnabled ? 'left-6' : 'left-1'}`} />
                      </div>
                      <span className="text-[13px] text-[#e1e3e6] font-medium">{scheduleEnabled ? 'Enabled' : 'Disabled'}</span>
                    </label>
                  </div>

                  <div className="flex gap-3 items-center max-[600px]:flex-col max-[600px]:items-stretch">
                    <div className="flex-1">
                      <label className="block text-[11px] font-medium text-[#555d6e] uppercase tracking-wider mb-1.5">Cron Expression</label>
                      <Input value={scheduleCron} onChange={e => setScheduleCron(e.target.value)} placeholder="0 0,4,8,12,16,20 * * *" className="font-mono" />
                    </div>
                    <Button variant="secondary" onClick={handleScheduleCron} className="mt-5 max-[600px]:mt-0">Update</Button>
                  </div>

                  <div className="p-4 bg-[#0a0c10] rounded-lg border border-[#1e2229]">
                    <div className="flex items-center gap-2 mb-2">
                      <IconClock size={14} />
                      <span className="text-[13px] font-medium text-[#e1e3e6]">Next Scheduled Run</span>
                    </div>
                    <p className="text-[13px] text-[#8b92a0] m-0">
                      {schedule?.nextRun ? new Date(schedule.nextRun).toLocaleString() : 'Not scheduled'}
                    </p>
                    {schedule?.lastRun && (
                      <p className="text-[12px] text-[#555d6e] mt-1 m-0">
                        Last run: {new Date(schedule.lastRun).toLocaleString()}
                      </p>
                    )}
                  </div>
                </div>
              </Card>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}

export default App
