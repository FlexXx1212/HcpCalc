import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getUserState,
  onAuthChange,
  saveUserState,
  signInWithGoogle,
  signOutUser,
} from '../firebase.js'
import {
  buildHandicapSummary,
  calculateScoreDifferential,
  formatScoreDifferential,
} from './lib/hcp.js'
import { parseDgvPdfFile } from './lib/dgvParser.js'
import './App.css'

const TODAY = new Date().toISOString().slice(0, 10)

const DEFAULT_COURSE_DEFAULTS = {
  courseName: '',
  clubNumber: '',
  tee: 'Gelb',
  holes: '18',
  type: 'S',
  par: '72',
  courseRating: '72.0',
  slope: '113',
  pcc: '0',
}

const createRoundDraft = (defaults = {}, handicapIndexAtTime = '') => ({
  date: TODAY,
  eventName: '',
  gbe: '',
  handicapIndexAtTime,
  ...DEFAULT_COURSE_DEFAULTS,
  ...defaults,
})

const createEmptyState = (user = null) => ({
  profile: {
    displayName: user?.displayName ?? '',
    email: user?.email ?? '',
    currentHcp: null,
    lastUsedCourseDefaults: { ...DEFAULT_COURSE_DEFAULTS },
  },
  rounds: [],
  calculationSnapshot: {
    computedHcp: null,
    activeCount: 0,
    usedScores: [],
    updatedAt: null,
  },
})

function parseNumeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(',', '.')
  if (!normalized) return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function ensureArray(value) {
  return Array.isArray(value) ? value : []
}

function normalizeLastUsedDefaults(defaults) {
  return {
    ...DEFAULT_COURSE_DEFAULTS,
    ...(defaults && typeof defaults === 'object' ? defaults : {}),
  }
}

function normalizeRound(round) {
  const normalized = {
    id: round?.id ?? crypto.randomUUID(),
    source: round?.source === 'import' ? 'import' : 'manual',
    date: typeof round?.date === 'string' ? round.date : TODAY,
    courseName: round?.courseName ?? '',
    clubNumber: round?.clubNumber ?? '',
    eventName: round?.eventName ?? '',
    tee: round?.tee ?? '',
    holes: round?.holes === 9 ? 9 : 18,
    type: round?.type ?? 'S',
    gbe: parseNumeric(round?.gbe),
    par: parseNumeric(round?.par),
    courseRating: parseNumeric(round?.courseRating),
    slope: parseNumeric(round?.slope),
    pcc: parseNumeric(round?.pcc) ?? 0,
    handicapIndexAtTime: parseNumeric(round?.handicapIndexAtTime),
    courseHandicap: parseNumeric(round?.courseHandicap),
    scoreDifferential: parseNumeric(round?.scoreDifferential),
    createdAt: round?.createdAt ?? new Date().toISOString(),
  }

  return normalized
}

function normalizeLoadedState(data, user) {
  const base = createEmptyState(user)
  const rounds = ensureArray(data?.rounds).map(normalizeRound)
  const summary = buildHandicapSummary(rounds)

  return {
    profile: {
      ...base.profile,
      ...(data?.profile && typeof data.profile === 'object' ? data.profile : {}),
      displayName:
        data?.profile?.displayName ??
        user?.displayName ??
        base.profile.displayName,
      email: data?.profile?.email ?? user?.email ?? base.profile.email,
      currentHcp: summary.currentHcp,
      lastUsedCourseDefaults: normalizeLastUsedDefaults(
        data?.profile?.lastUsedCourseDefaults,
      ),
    },
    rounds: sortRounds(rounds),
    calculationSnapshot: {
      computedHcp: summary.currentHcp,
      activeCount: summary.activeDifferentials.length,
      usedScores: summary.usedDifferentials.map((entry) => ({
        id: entry.id,
        scoreDifferential: entry.scoreDifferential,
      })),
      updatedAt: data?.calculationSnapshot?.updatedAt ?? null,
    },
  }
}

function sortRounds(rounds) {
  return [...rounds].sort((left, right) => {
    const leftDate = new Date(left.date).getTime()
    const rightDate = new Date(right.date).getTime()
    return rightDate - leftDate
  })
}

function roundKey(round) {
  return [
    round.date,
    round.clubNumber,
    round.eventName.trim().toLowerCase(),
    round.holes,
    round.gbe,
    round.scoreDifferential,
  ].join('|')
}

function mergeImportedRounds(existingRounds, importedRounds) {
  const seen = new Set(existingRounds.map(roundKey))
  const additions = []

  for (const round of importedRounds) {
    const key = roundKey(round)
    if (seen.has(key)) continue
    seen.add(key)
    additions.push(round)
  }

  return {
    merged: sortRounds([...existingRounds, ...additions]),
    importedCount: additions.length,
    skippedCount: importedRounds.length - additions.length,
  }
}

function buildPersistedState(currentState, user, nextRounds, lastUsedCourseDefaults) {
  const summary = buildHandicapSummary(nextRounds)

  return {
    profile: {
      displayName: user?.displayName ?? currentState.profile.displayName,
      email: user?.email ?? currentState.profile.email,
      currentHcp: summary.currentHcp,
      lastUsedCourseDefaults: normalizeLastUsedDefaults(lastUsedCourseDefaults),
    },
    rounds: sortRounds(nextRounds),
    calculationSnapshot: {
      computedHcp: summary.currentHcp,
      activeCount: summary.activeDifferentials.length,
      usedScores: summary.usedDifferentials.map((entry) => ({
        id: entry.id,
        scoreDifferential: entry.scoreDifferential,
      })),
      updatedAt: new Date().toISOString(),
    },
  }
}

function numberDisplay(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)
}

function formatDate(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(
    new Date(value),
  )
}

function toInputValue(value) {
  return value === null || value === undefined ? '' : String(value)
}

function App() {
  const [authUser, setAuthUser] = useState(null)
  const [appState, setAppState] = useState(createEmptyState())
  const [draft, setDraft] = useState(createRoundDraft())
  const [authStatus, setAuthStatus] = useState('loading')
  const [actionStatus, setActionStatus] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const fileInputRef = useRef(null)

  useEffect(() => {
    const unsubscribe = onAuthChange(async (user) => {
      setAuthUser(user)

      if (!user) {
        setAppState(createEmptyState())
        setDraft(createRoundDraft())
        setAuthStatus('ready')
        return
      }

      setAuthStatus('loading')

      try {
        const remoteState = await getUserState(user.uid)
        const normalized = normalizeLoadedState(remoteState ?? {}, user)
        setAppState(normalized)
        setDraft(
          createRoundDraft(
            normalized.profile.lastUsedCourseDefaults,
            toInputValue(normalized.profile.currentHcp),
          ),
        )
        setActionStatus('Profil geladen.')
      } catch (error) {
        console.error(error)
        const fallback = createEmptyState(user)
        setAppState(fallback)
        setDraft(createRoundDraft())
        setActionStatus('Profil konnte nicht geladen werden.')
      } finally {
        setAuthStatus('ready')
      }
    })

    return () => unsubscribe()
  }, [])

  const summary = useMemo(
    () => buildHandicapSummary(appState.rounds),
    [appState.rounds],
  )

  const usedScoreIds = useMemo(
    () => new Set(summary.usedDifferentials.map((entry) => entry.id)),
    [summary.usedDifferentials],
  )

  async function persistState(nextState) {
    if (!authUser) return

    setIsSaving(true)

    try {
      await saveUserState(authUser.uid, nextState)
      setAppState(nextState)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSignIn() {
    try {
      await signInWithGoogle()
      setActionStatus('Google-Login erfolgreich.')
    } catch (error) {
      console.error(error)
      setActionStatus('Google-Login fehlgeschlagen.')
    }
  }

  async function handleSignOut() {
    try {
      await signOutUser()
      setActionStatus('Abgemeldet.')
    } catch (error) {
      console.error(error)
      setActionStatus('Abmelden fehlgeschlagen.')
    }
  }

  function handleDraftChange(event) {
    const { name, value } = event.target
    setDraft((currentDraft) => ({ ...currentDraft, [name]: value }))
  }

  async function handleManualSubmit(event) {
    event.preventDefault()

    if (!authUser) {
      setActionStatus('Bitte zuerst anmelden.')
      return
    }

    const holes = Number(draft.holes)
    const gbe = parseNumeric(draft.gbe)
    const par = parseNumeric(draft.par)
    const courseRating = parseNumeric(draft.courseRating)
    const slope = parseNumeric(draft.slope)
    const pcc = parseNumeric(draft.pcc) ?? 0
    const handicapIndexAtTime =
      parseNumeric(draft.handicapIndexAtTime) ?? summary.currentHcp

    if (!draft.date || !draft.courseName.trim() || gbe === null) {
      setActionStatus('Bitte Datum, Platz und GBE ausfüllen.')
      return
    }

    if (par === null || courseRating === null || slope === null) {
      setActionStatus('Bitte Par, Course Rating und Slope angeben.')
      return
    }

    if (holes === 9 && handicapIndexAtTime === null) {
      setActionStatus(
        'Für 9-Loch-Runden wird ein HCPI vor der Runde benötigt.',
      )
      return
    }

    let scoreDifferential

    try {
      scoreDifferential = calculateScoreDifferential({
        holes,
        gbe,
        courseRating,
        slope,
        pcc,
        handicapIndexAtTime,
      })
    } catch (error) {
      console.error(error)
      setActionStatus(error.message)
      return
    }

    const round = normalizeRound({
      id: crypto.randomUUID(),
      source: 'manual',
      date: draft.date,
      courseName: draft.courseName.trim(),
      clubNumber: draft.clubNumber.trim(),
      eventName: draft.eventName.trim() || 'Manueller Eintrag',
      tee: draft.tee.trim(),
      holes,
      type: draft.type,
      gbe,
      par,
      courseRating,
      slope,
      pcc,
      handicapIndexAtTime,
      scoreDifferential,
      createdAt: new Date().toISOString(),
    })

    const lastUsedCourseDefaults = {
      courseName: round.courseName,
      clubNumber: round.clubNumber,
      tee: round.tee,
      holes: String(round.holes),
      type: round.type,
      par: String(round.par ?? ''),
      courseRating: String(round.courseRating ?? ''),
      slope: String(round.slope ?? ''),
      pcc: String(round.pcc ?? 0),
    }

    const nextState = buildPersistedState(
      appState,
      authUser,
      [round, ...appState.rounds],
      lastUsedCourseDefaults,
    )

    try {
      await persistState(nextState)
      setDraft(
        createRoundDraft(
          lastUsedCourseDefaults,
          toInputValue(nextState.profile.currentHcp),
        ),
      )
      setActionStatus('Neue Runde gespeichert und Handicap aktualisiert.')
    } catch (error) {
      console.error(error)
      setActionStatus('Runde konnte nicht gespeichert werden.')
    }
  }

  async function handleImport(event) {
    const file = event.target.files?.[0]

    if (!file || !authUser) return

    setIsImporting(true)
    setActionStatus('')

    try {
      const importedRounds = await parseDgvPdfFile(file)

      if (importedRounds.length === 0) {
        setActionStatus('Im PDF wurden keine DGV-Runden erkannt.')
        return
      }

      const { merged, importedCount, skippedCount } = mergeImportedRounds(
        appState.rounds,
        importedRounds,
      )

      const nextState = buildPersistedState(
        appState,
        authUser,
        merged,
        appState.profile.lastUsedCourseDefaults,
      )

      await persistState(nextState)
      setDraft((currentDraft) => ({
        ...currentDraft,
        handicapIndexAtTime: toInputValue(nextState.profile.currentHcp),
      }))
      setActionStatus(
        `${importedCount} Runde(n) importiert, ${skippedCount} Dublette(n) übersprungen.`,
      )
    } catch (error) {
      console.error(error)
      setActionStatus('PDF konnte nicht importiert werden.')
    } finally {
      setIsImporting(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const statCards = [
    {
      label: 'Aktueller HCPI',
      value: numberDisplay(summary.currentHcp),
      hint:
        summary.currentHcp === null
          ? 'Noch keine auswertbaren Runden'
          : `${summary.usedDifferentials.length} Score(s) in der Berechnung`,
    },
    {
      label: 'Gespeicherte Runden',
      value: String(appState.rounds.length),
      hint: 'Importierte und manuelle Einträge',
    },
    {
      label: 'Aktive Score-Liste',
      value: String(summary.activeDifferentials.length),
      hint: 'Maximal 20 Scores laut Vorgabe',
    },
  ]

  return (
    <div className="app-shell">
      <header className="hero-panel">
        <div className="hero-copy">
          <span className="eyebrow">Let&apos;s golf</span>
          <h1>Golf HCPI Rechner mit DGV-Import und eigenem Profil.</h1>
          <p>
            Importiere deinen DGV-Scoring-Record, speichere neue GBE-Runden und
            berechne dein Handicap direkt in einer modernen Single Page
            Application.
          </p>
          <div className="hero-actions">
            {authUser ? (
              <>
                <button className="primary-button" onClick={handleSignOut}>
                  Abmelden
                </button>
                <span className="soft-badge">
                  {authUser.displayName || authUser.email}
                </span>
              </>
            ) : (
              <button className="primary-button" onClick={handleSignIn}>
                Mit Google anmelden
              </button>
            )}
          </div>
        </div>

        <div className="hero-card">
          <div className="grass-grid" />
          <div className="hero-card-content">
            <p className="hero-card-label">Live Vorschau</p>
            <strong>{numberDisplay(summary.currentHcp)}</strong>
            <span>Handicap-Index nach deinem aktuellen Profilstand</span>
          </div>
        </div>
      </header>

      <main className="content-stack">
        <section className="stats-grid">
          {statCards.map((card) => (
            <article className="stat-card" key={card.label}>
              <span>{card.label}</span>
              <strong>{card.value}</strong>
              <p>{card.hint}</p>
            </article>
          ))}
        </section>

        <section className="panel intro-panel">
          <div>
            <h2>Was die App abdeckt</h2>
            <p>
              Grundlage sind die gelieferten Rechenregeln inklusive 9-Loch-
              Ergänzung, kaufmännischer Rundung, Best-N-Auswahl und einer
              aktiven Score-Liste mit maximal 20 Differentials.
            </p>
          </div>
          <ul className="feature-list">
            <li>DGV-PDF-Import pro Benutzerprofil</li>
            <li>Persistente Course-Defaults für neue GBE-Einträge</li>
            <li>Firebase Login und Firestore-Speicherung</li>
            <li>Transparente Anzeige der verwendeten Scores</li>
          </ul>
        </section>

        {!authUser ? (
          <section className="panel auth-panel">
            <h2>Starte mit deinem Profil</h2>
            <p>
              Melde dich an, um Runden dauerhaft zu speichern, DGV-Exporte zu
              importieren und deinen HCPI jederzeit wieder aufzurufen.
            </p>
            <button
              className="primary-button"
              onClick={handleSignIn}
              disabled={authStatus === 'loading'}
            >
              {authStatus === 'loading' ? 'Lade…' : 'Mit Google anmelden'}
            </button>
          </section>
        ) : (
          <>
            <section className="workspace-grid">
              <article className="panel">
                <div className="section-header">
                  <div>
                    <h2>DGV-Export importieren</h2>
                    <p>
                      Lade eine PDF wie den DGV Scoring Record hoch. Die Runden
                      werden deinem Profil hinzugefügt und Dubletten werden
                      ausgelassen.
                    </p>
                  </div>
                  <span className="soft-badge">PDF</span>
                </div>

                <label className="upload-box">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/pdf"
                    onChange={handleImport}
                    disabled={isImporting}
                  />
                  <span>
                    {isImporting
                      ? 'Import läuft…'
                      : 'PDF auswählen und DGV-Runden importieren'}
                  </span>
                </label>
              </article>

              <article className="panel">
                <div className="section-header">
                  <div>
                    <h2>Neues GBE eintragen</h2>
                    <p>
                      Zuletzt verwendete Platzdaten bleiben gespeichert, damit
                      du Course Rating, Slope oder PCC nicht jedes Mal neu
                      erfassen musst.
                    </p>
                  </div>
                  <span className="soft-badge">GBE</span>
                </div>

                <form className="round-form" onSubmit={handleManualSubmit}>
                  <div className="form-grid">
                    <label>
                      Datum
                      <input
                        name="date"
                        type="date"
                        value={draft.date}
                        onChange={handleDraftChange}
                      />
                    </label>
                    <label>
                      Turnier / Anlass
                      <input
                        name="eventName"
                        value={draft.eventName}
                        onChange={handleDraftChange}
                        placeholder="z. B. Monatsbecher"
                      />
                    </label>
                    <label>
                      Platz
                      <input
                        name="courseName"
                        value={draft.courseName}
                        onChange={handleDraftChange}
                        placeholder="Golfclub"
                      />
                    </label>
                    <label>
                      Club-Nr.
                      <input
                        name="clubNumber"
                        value={draft.clubNumber}
                        onChange={handleDraftChange}
                        placeholder="8822"
                      />
                    </label>
                    <label>
                      Tees
                      <input
                        name="tee"
                        value={draft.tee}
                        onChange={handleDraftChange}
                        placeholder="Gelb"
                      />
                    </label>
                    <label>
                      Löcher
                      <select
                        name="holes"
                        value={draft.holes}
                        onChange={handleDraftChange}
                      >
                        <option value="18">18</option>
                        <option value="9">9</option>
                      </select>
                    </label>
                    <label>
                      Art
                      <select
                        name="type"
                        value={draft.type}
                        onChange={handleDraftChange}
                      >
                        <option value="S">Stableford</option>
                        <option value="Z">Zählspiel</option>
                        <option value="H">Höchstergebnis</option>
                        <option value="P">Gegen Par</option>
                        <option value="G">Gemischt</option>
                      </select>
                    </label>
                    <label>
                      GBE
                      <input
                        name="gbe"
                        value={draft.gbe}
                        onChange={handleDraftChange}
                        inputMode="decimal"
                        placeholder="95"
                      />
                    </label>
                    <label>
                      Par
                      <input
                        name="par"
                        value={draft.par}
                        onChange={handleDraftChange}
                        inputMode="decimal"
                      />
                    </label>
                    <label>
                      Course Rating
                      <input
                        name="courseRating"
                        value={draft.courseRating}
                        onChange={handleDraftChange}
                        inputMode="decimal"
                      />
                    </label>
                    <label>
                      Slope
                      <input
                        name="slope"
                        value={draft.slope}
                        onChange={handleDraftChange}
                        inputMode="numeric"
                      />
                    </label>
                    <label>
                      PCC
                      <input
                        name="pcc"
                        value={draft.pcc}
                        onChange={handleDraftChange}
                        inputMode="numeric"
                      />
                    </label>
                    <label className="wide-field">
                      HCPI vor Runde
                      <input
                        name="handicapIndexAtTime"
                        value={draft.handicapIndexAtTime}
                        onChange={handleDraftChange}
                        inputMode="decimal"
                        placeholder="Wichtig für 9-Loch-Runden"
                      />
                    </label>
                  </div>

                  <div className="form-actions">
                    <button className="primary-button" disabled={isSaving}>
                      {isSaving ? 'Speichere…' : 'Runde speichern'}
                    </button>
                    <span className="form-hint">
                      Aktueller HCPI als Referenz:{' '}
                      <strong>{numberDisplay(summary.currentHcp)}</strong>
                    </span>
                  </div>
                </form>
              </article>
            </section>

            <section className="workspace-grid lower-grid">
              <article className="panel">
                <div className="section-header">
                  <div>
                    <h2>Score-Historie</h2>
                    <p>
                      Alle importierten und manuell erfassten Runden im Profil.
                    </p>
                  </div>
                  <span className="soft-badge">
                    {appState.rounds.length} Einträge
                  </span>
                </div>

                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>Datum</th>
                        <th>Runde</th>
                        <th>Löcher</th>
                        <th>GBE</th>
                        <th>SD</th>
                        <th>Quelle</th>
                      </tr>
                    </thead>
                    <tbody>
                      {appState.rounds.length === 0 ? (
                        <tr>
                          <td colSpan="6" className="empty-cell">
                            Noch keine Runden gespeichert.
                          </td>
                        </tr>
                      ) : (
                        appState.rounds.map((round) => (
                          <tr key={round.id}>
                            <td>{formatDate(round.date)}</td>
                            <td>
                              <div className="round-title">
                                <strong>{round.eventName}</strong>
                                <span>{round.courseName}</span>
                              </div>
                            </td>
                            <td>{round.holes}</td>
                            <td>{numberDisplay(round.gbe, 0)}</td>
                            <td>
                              <span
                                className={
                                  usedScoreIds.has(round.id)
                                    ? 'score-pill score-pill-active'
                                    : 'score-pill'
                                }
                              >
                                {formatScoreDifferential(round.scoreDifferential)}
                              </span>
                            </td>
                            <td>{round.source === 'import' ? 'Import' : 'Manuell'}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </article>

              <article className="panel">
                <div className="section-header">
                  <div>
                    <h2>Berechnungsdetails</h2>
                    <p>
                      Diese Score Differentials fließen aktuell in den HCPI ein.
                    </p>
                  </div>
                  <span className="soft-badge">
                    {summary.usedDifferentials.length} genutzt
                  </span>
                </div>

                <div className="calculation-stack">
                  <div className="highlight-card">
                    <span>Berechneter HCPI</span>
                    <strong>{numberDisplay(summary.currentHcp)}</strong>
                    <p>
                      {summary.currentHcp === null
                        ? 'Sobald importierte oder manuelle Runden vorhanden sind, erscheint hier dein HCPI.'
                        : 'Auf Basis der gelieferten Rechenregeln ohne ESR und ohne Caps.'}
                    </p>
                  </div>

                  <div className="score-list">
                    {summary.activeDifferentials.length === 0 ? (
                      <p className="muted-copy">
                        Noch keine auswertbaren Differentials vorhanden.
                      </p>
                    ) : (
                      summary.activeDifferentials.map((entry, index) => (
                        <div className="score-row" key={`${entry.id}-${index}`}>
                          <span>{entry.eventName}</span>
                          <strong>{formatScoreDifferential(entry.scoreDifferential)}</strong>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </article>
            </section>
          </>
        )}

        {actionStatus ? (
          <section className="panel status-panel">
            <p>{actionStatus}</p>
          </section>
        ) : null}
      </main>
    </div>
  )
}

export default App
