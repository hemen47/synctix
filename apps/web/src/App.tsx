import { useQuery } from "@tanstack/react-query"

/**
 * M0 shell.
 *
 * The layout is the real three-pane frame the editor will fill in at M4 (palette |
 * canvas | inspector, with a bottom drawer for the agent chat). For now the canvas pane
 * shows live stack health, which makes M0's exit criterion visible end to end: the
 * browser reaches Caddy, Caddy reaches web, web calls /api/health, and the API reports
 * on every downstream service.
 */

type DependencyStatus = "up" | "down" | "disabled" | "unknown"

interface HealthReport {
  status: "ok" | "degraded" | "down"
  service: string
  version: string
  uptimeSec: number
  checkedAt: string
  dependencies: Array<{
    name: string
    status: DependencyStatus
    latencyMs?: number
    detail?: string
  }>
}

const fetchHealth = async (): Promise<HealthReport> => {
  const res = await fetch("/api/health")
  // A 503 still carries a usable report body — the point is to show which service is
  // down, so we parse it rather than throwing on status alone.
  const body = (await res.json()) as HealthReport
  return body
}

export const App = () => {
  const { data, error, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 10_000,
  })

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__brand">SYNTRIX</span>
        <span className="app__tagline">agentic EDA — schematic, simulation, PCB</span>
        <StatusPill status={data?.status} loading={isLoading} failed={Boolean(error)} />
      </header>

      <div className="app__body">
        <aside className="pane pane--left">
          <h2 className="pane__title">Palette</h2>
          <p className="pane__placeholder">
            Parts search works in the engine (M2) — run <code>pnpm demo</code>. This palette is
            wired up with the editor at M4.
          </p>
        </aside>

        <main className="pane pane--center">
          <h2 className="pane__title">Stack status</h2>
          {error ? (
            <p className="error">
              Could not reach the API. Is the stack up? Try <code>make dev</code>.
            </p>
          ) : isLoading ? (
            <p className="pane__placeholder">Probing services…</p>
          ) : data ? (
            <ServiceTable report={data} updatedAt={dataUpdatedAt} />
          ) : null}
        </main>

        <aside className="pane pane--right">
          <h2 className="pane__title">Inspector</h2>
          <p className="pane__placeholder">Selection properties arrive at M4.</p>
        </aside>
      </div>

      <footer className="app__drawer">
        <h2 className="pane__title">Agent</h2>
        <p className="pane__placeholder">Chat and live trace arrive at M7.</p>
      </footer>
    </div>
  )
}

const StatusPill = ({
  status,
  loading,
  failed,
}: {
  status?: HealthReport["status"]
  loading: boolean
  failed: boolean
}) => {
  const label = failed ? "unreachable" : loading ? "checking" : (status ?? "unknown")
  const tone = failed ? "down" : loading ? "unknown" : (status ?? "unknown")
  return <span className={`pill pill--${tone}`}>{label}</span>
}

const ServiceTable = ({ report, updatedAt }: { report: HealthReport; updatedAt: number }) => (
  <>
    <table className="services">
      <thead>
        <tr>
          <th>Service</th>
          <th>Status</th>
          <th>Latency</th>
          <th>Detail</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>api</td>
          <td>
            <span className="pill pill--up">up</span>
          </td>
          <td>—</td>
          <td>
            v{report.version}, up {formatUptime(report.uptimeSec)}
          </td>
        </tr>
        {report.dependencies.map((dep) => (
          <tr key={dep.name}>
            <td>{dep.name}</td>
            <td>
              <span className={`pill pill--${dep.status}`}>{dep.status}</span>
            </td>
            <td>{dep.latencyMs === undefined ? "—" : `${dep.latencyMs} ms`}</td>
            <td className="services__detail">{dep.detail ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <p className="services__footnote">
      Checked {new Date(updatedAt).toLocaleTimeString()} · refreshes every 10s
    </p>
  </>
)

const formatUptime = (sec: number): string => {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}
