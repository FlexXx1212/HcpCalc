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
import { loadLocalAppState, saveLocalAppState } from './lib/localState.js'
import './App.css'

const DEFAULT_COURSE_DEFAULTS = {
  courseName: '',
  tee: 'Gelb',
  holes: '9',
  par: '',
  courseRating: '35.8',
  slope: '134',
  pcc: '0',
}

const HOLE_DEFAULTS = {
  9: {
    holes: '9',
    courseRating: '35.8',
    slope: '134',
  },
  18: {
    holes: '18',
    courseRating: '69.2',
    slope: '128',
  },
}

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

function normalizeLastUsedDefaults(defaults) {
  return {
    ...DEFAULT_COURSE_DEFAULTS,
    ...(defaults && typeof defaults === 'object' ? defaults : {}),
  }
}

function getHoleDefaults(holes) {
  return holes === '18' ? HOLE_DEFAULTS[18] : HOLE_DEFAULTS[9]
}

function normalizeRound(round) {
  return {
    id: round?.id ?? crypto.randomUUID(),
    source: round?.source === 'import' ? 'import' : 'manual',
    date:
      typeof round?.date === 'string'
        ? round.date
        : new Date().toISOString().slice(0, 10),
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
}

function sortRounds(rounds) {
  return [...rounds].sort((left, right) => {
    const leftDate = new Date(left.date).getTime()
    const rightDate = new Date(right.date).getTime()

    if (rightDate !== leftDate) return rightDate - leftDate

    const leftCreated = new Date(left.createdAt ?? left.date).getTime()
    const rightCreated = new Date(right.createdAt ?? right.date).getTime()
    return rightCreated - leftCreated
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

function createRoundDraft(defaults = {}) {
  const normalized = normalizeLastUsedDefaults(defaults)
  const holeDefaults = getHoleDefaults(normalized.holes)

  return {
    holes: holeDefaults.holes,
    gbe: '',
    courseRating: holeDefaults.courseRating,
    slope: holeDefaults.slope,
    pcc: normalized.pcc,
  }
}

function createEmptyState(user = null) {
  return {
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
  }
}

function normalizeLoadedState(data, user) {
  const base = createEmptyState(user)
  const rounds = ensureArray(data?.rounds).map(normalizeRound)
  const sortedRounds = sortRounds(rounds)
  const summary = buildHandicapSummary(sortedRounds)
  const storedDefaults = normalizeLastUsedDefaults(data?.profile?.lastUsedCourseDefaults)

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
      lastUsedCourseDefaults: storedDefaults,
    },
    rounds: sortedRounds,
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

function mergeRoundCollections(primaryRounds, secondaryRounds) {
  const seen = new Set(primaryRounds.map(roundKey))
  const additions = []

  for (const round of secondaryRounds) {
    const key = roundKey(round)
    if (seen.has(key)) continue
    seen.add(key)
    additions.push(round)
  }

  return sortRounds([...primaryRounds, ...additions])
}

function buildPersistedState(currentState, user, nextRounds) {
  const sortedRounds = sortRounds(nextRounds)
  const summary = buildHandicapSummary(sortedRounds)
  const derivedDefaults = normalizeLastUsedDefaults(
    currentState.profile.lastUsedCourseDefaults,
  )

  return {
    profile: {
      displayName: user?.displayName ?? currentState.profile.displayName,
      email: user?.email ?? currentState.profile.email,
      currentHcp: summary.currentHcp,
      lastUsedCourseDefaults: derivedDefaults,
    },
    rounds: sortedRounds,
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

function mergeAppStates(localState, remoteState, user) {
  const mergedRounds = mergeRoundCollections(localState.rounds, remoteState.rounds)

  return buildPersistedState(
    {
      profile: {
        displayName:
          user?.displayName ??
          remoteState.profile.displayName ??
          localState.profile.displayName,
        email: user?.email ?? remoteState.profile.email ?? localState.profile.email,
        lastUsedCourseDefaults: normalizeLastUsedDefaults(
          remoteState.profile.lastUsedCourseDefaults ??
            localState.profile.lastUsedCourseDefaults,
        ),
      },
    },
    user,
    mergedRounds,
  )
}

function App() {
  const [authUser, setAuthUser] = useState(null)
  const [appState, setAppState] = useState(createEmptyState())
  const [draft, setDraft] = useState(createRoundDraft())
  const [authStatus, setAuthStatus] = useState('loading')
  const [actionStatus, setActionStatus] = useState('')
  const [isImporting, setIsImporting] = useState(false)
  const [deletingRoundId, setDeletingRoundId] = useState(null)
  const fileInputRef = useRef(null)

  useEffect(() => {
    const localState = normalizeLoadedState(loadLocalAppState() ?? {}, null)
    setAppState(localState)
    setDraft(createRoundDraft(localState.profile.lastUsedCourseDefaults))

    const unsubscribe = onAuthChange(async (user) => {
      setAuthUser(user)

      if (!user) {
        const currentLocalState = normalizeLoadedState(loadLocalAppState() ?? {}, null)
        setAppState(currentLocalState)
        setDraft(createRoundDraft(currentLocalState.profile.lastUsedCourseDefaults))
        setAuthStatus('ready')
        return
      }

      setAuthStatus('loading')

      try {
        const currentLocalState = normalizeLoadedState(loadLocalAppState() ?? {}, user)
        const remoteState = normalizeLoadedState((await getUserState(user.uid)) ?? {}, user)
        const mergedState = mergeAppStates(currentLocalState, remoteState, user)

        saveLocalAppState(mergedState)
        setAppState(mergedState)
        setDraft(createRoundDraft(mergedState.profile.lastUsedCourseDefaults))

        try {
          await saveUserState(user.uid, mergedState)
          setActionStatus('Cloud-Sync aktiv. Daten werden lokal und online gespeichert.')
        } catch (syncError) {
          console.error(syncError)
          setActionStatus(
            'Lokal geladen. Cloud-Sync konnte nicht vollständig aktualisiert werden.',
          )
        }
      } catch (error) {
        console.error(error)
        const fallback = normalizeLoadedState(loadLocalAppState() ?? {}, user)
        setAppState(fallback)
        setDraft(createRoundDraft(fallback.profile.lastUsedCourseDefaults))
        setActionStatus('Lokale Daten geladen. Cloud-Profil konnte nicht gelesen werden.')
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

  const latestDefaults = useMemo(
    () => normalizeLastUsedDefaults(appState.profile.lastUsedCourseDefaults),
    [appState.profile.lastUsedCourseDefaults],
  )

  const usedScoreIds = useMemo(
    () => new Set(summary.usedDifferentials.map((entry) => entry.id)),
    [summary.usedDifferentials],
  )

  const preview = useMemo(() => {
    const holes = Number(draft.holes)
    const gbe = parseNumeric(draft.gbe)
    const courseRating = parseNumeric(draft.courseRating)
    const slope = parseNumeric(draft.slope)
    const pcc = parseNumeric(draft.pcc) ?? 0
    const handicapIndexAtTime = holes === 9 ? summary.currentHcp : null

    if (gbe === null) {
      return {
        scoreDifferential: null,
        previewHcp: null,
        status: 'Trage ein GBE ein, um dein neues HCP live zu sehen.',
      }
    }

    if (courseRating === null || slope === null) {
      return {
        scoreDifferential: null,
        previewHcp: null,
        status: 'Für die Live-Berechnung werden Course Rating und Slope benötigt.',
      }
    }

    if (holes === 9 && handicapIndexAtTime === null) {
      return {
        scoreDifferential: null,
        previewHcp: null,
        status: 'Für 9-Loch wird zuerst ein aktueller HCP aus vorhandenen Runden benötigt.',
      }
    }

    try {
      const scoreDifferential = calculateScoreDifferential({
        holes,
        gbe,
        courseRating,
        slope,
        pcc,
        handicapIndexAtTime,
      })

      const previewRound = normalizeRound({
        id: 'preview-round',
        source: 'manual',
        date: new Date().toISOString().slice(0, 10),
        eventName: 'Live-Vorschau',
        courseName: latestDefaults.courseName,
        tee: latestDefaults.tee,
        holes,
        gbe,
        par: parseNumeric(latestDefaults.par),
        courseRating,
        slope,
        pcc,
        handicapIndexAtTime,
        scoreDifferential,
      })

      const previewSummary = buildHandicapSummary([previewRound, ...appState.rounds])

      return {
        scoreDifferential,
        previewHcp: previewSummary.currentHcp,
        status:
          holes === 9
            ? 'Die Vorschau aktualisiert sich sofort. Der HCP vor der Runde wird automatisch aus deinen vorhandenen Runden abgeleitet.'
            : 'Die Vorschau aktualisiert sich bei jeder Eingabe sofort.',
      }
    } catch (error) {
      return {
        scoreDifferential: null,
        previewHcp: null,
        status: error.message,
      }
    }
  }, [appState.rounds, draft, latestDefaults, summary.currentHcp])

  async function persistState(nextState) {
    saveLocalAppState(nextState)
    setAppState(nextState)

    if (!authUser) {
      return { syncedToCloud: false, localOnly: true }
    }

    try {
      await saveUserState(authUser.uid, nextState)
      return { syncedToCloud: true, localOnly: false }
    } catch (error) {
      console.error(error)
      return { syncedToCloud: false, localOnly: false, error }
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
    if (name === 'holes') {
      const holeDefaults = getHoleDefaults(value)
      setDraft((currentDraft) => ({
        ...currentDraft,
        holes: holeDefaults.holes,
        courseRating: holeDefaults.courseRating,
        slope: holeDefaults.slope,
      }))
      return
    }

    setDraft((currentDraft) => ({
      ...currentDraft,
      [name]: value,
    }))
  }

  function handleCopyRoundToCalculator(round) {
    setDraft({
      holes: String(round.holes ?? 18),
      gbe:
        round.gbe === null || round.gbe === undefined ? '' : String(round.gbe),
      courseRating:
        round.courseRating === null || round.courseRating === undefined
          ? ''
          : String(round.courseRating),
      slope:
        round.slope === null || round.slope === undefined
          ? ''
          : String(round.slope),
      pcc:
        round.pcc === null || round.pcc === undefined ? '0' : String(round.pcc),
    })
    setActionStatus('Rundenwerte in den Rechner übernommen.')
  }

  async function handleImport(event) {
    const file = event.target.files?.[0]

    if (!file) return

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

      const nextState = buildPersistedState(appState, authUser, merged)
      const persistenceResult = await persistState(nextState)
      setDraft(createRoundDraft(nextState.profile.lastUsedCourseDefaults))
      setActionStatus(
        persistenceResult.syncedToCloud
          ? `${importedCount} Runde(n) importiert, ${skippedCount} Dublette(n) übersprungen. Cloud-Sync aktualisiert.`
          : `${importedCount} Runde(n) importiert, ${skippedCount} Dublette(n) übersprungen. Daten lokal gespeichert.`,
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

  async function handleDeleteRound(roundId) {
    const round = appState.rounds.find((entry) => entry.id === roundId)
    if (!round) return

    const shouldDelete = window.confirm(
      `Runde "${round.eventName}" vom ${formatDate(round.date)} wirklich löschen?`,
    )

    if (!shouldDelete) return

    setDeletingRoundId(roundId)

    try {
      const nextRounds = appState.rounds.filter((entry) => entry.id !== roundId)
      const nextState = buildPersistedState(appState, authUser, nextRounds)
      const persistenceResult = await persistState(nextState)
      setDraft(createRoundDraft(nextState.profile.lastUsedCourseDefaults))
      setActionStatus(
        persistenceResult.syncedToCloud
          ? 'Runde gelöscht und Cloud-Sync aktualisiert.'
          : 'Runde gelöscht und lokal gespeichert.',
      )
    } catch (error) {
      console.error(error)
      setActionStatus('Runde konnte nicht gelöscht werden.')
    } finally {
      setDeletingRoundId(null)
    }
  }

  const statCards = [
    {
      label: 'Aktueller HCP',
      value: numberDisplay(summary.currentHcp),
      hint: 'Dein gespeicherter Profilstand',
    },
    {
      label: 'Live neues HCP',
      value: numberDisplay(preview.previewHcp),
      hint: 'Ändert sich sofort mit GBE, CR oder Slope',
    },
    {
      label: 'Vorschau-SD',
      value: formatScoreDifferential(preview.scoreDifferential),
      hint: 'Score Differential der Live-Eingabe',
    },
  ]

  return (
    <div className="app-shell">
      <header className="hero-panel">
        <div className="hero-copy">
          <span className="eyebrow">Let&apos;s golf</span>
          <h1>HcpCalc</h1>
          <p>
            Importiere deinen DGV-Scoring-Record und simuliere dein neues HCP
            mit einer minimalen Live-Eingabe auf Basis deiner neuesten Runde.
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
                Mit Google anmelden für Sync
              </button>
            )}
          </div>
        </div>

        <div className="hero-card">
          <div className="grass-grid" />
          <div className="hero-card-content">
            <p className="hero-card-label">Live Vorschau</p>
            <strong>{numberDisplay(preview.previewHcp ?? summary.currentHcp)}</strong>
            <span>
              {preview.previewHcp === null
                ? 'Aktueller HCP aus deinem Profil'
                : 'Neuer HCP auf Basis deiner aktuellen Eingabe'}
            </span>
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

        <>
          <section>
            <article className="panel wide-panel">
                <div className="section-header">
                  <div>
                    <h2>Live neues HCP berechnen</h2>
                    <p>
                      GBE ändern und sofort sehen, wie sich dein HCP verändert
                      – auch ohne Login.
                    </p>
                  </div>
                  <span className="soft-badge">Live</span>
                </div>

                <div className="round-form">
                  <div className="form-grid">
                    <label>
                      Löcher
                      <select
                        name="holes"
                        value={draft.holes}
                        onChange={handleDraftChange}
                      >
                        <option value="9">9</option>
                        <option value="18">18</option>
                      </select>
                    </label>
                    <label>
                      Gewertetes Brutto Ergebniss (GBE)
                      <input
                        name="gbe"
                        value={draft.gbe}
                        onChange={handleDraftChange}
                        inputMode="decimal"
                        placeholder="z. B. 95"
                      />
                    </label>
                    <label>
                      Course Rating (CR)
                      <input
                        name="courseRating"
                        value={draft.courseRating}
                        onChange={handleDraftChange}
                        inputMode="decimal"
                      />
                    </label>
                    <label>
                      Slope Rating (SR)
                      <input
                        name="slope"
                        value={draft.slope}
                        onChange={handleDraftChange}
                        inputMode="numeric"
                      />
                    </label>
                    <label>
                      Playing Conditions Calculation (PCC)
                      <input
                        name="pcc"
                        value={draft.pcc}
                        onChange={handleDraftChange}
                        inputMode="numeric"
                      />
                    </label>
                  </div>

                  <div className="form-actions">
                    <span className="form-hint">{preview.status}</span>
                  </div>
                </div>
            </article>
          </section>

          <section>
            <article className="panel wide-panel">
                <div className="section-header">
                  <div>
                    <h2>Score-Historie</h2>
                    <p>
                      Alle gespeicherten Runden auf diesem Gerät
                      {authUser ? ' und im verknüpften Sync-Profil.' : '.'}
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
                        <th>Aktion</th>
                      </tr>
                    </thead>
                    <tbody>
                      {appState.rounds.length === 0 ? (
                        <tr>
                          <td colSpan="7" className="empty-cell">
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
                            <td>
                              <div className="row-action-group">
                                <button
                                  type="button"
                                  className="row-copy-button"
                                  onClick={() => handleCopyRoundToCalculator(round)}
                                >
                                  In Rechner
                                </button>
                                <button
                                  type="button"
                                  className="row-delete-button"
                                  onClick={() => handleDeleteRound(round.id)}
                                  disabled={deletingRoundId === round.id}
                                >
                                  {deletingRoundId === round.id ? 'Lösche…' : 'Löschen'}
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
            </article>
          </section>

          <section>
            <article className="panel wide-panel">
                <div className="section-header">
                  <div>
                    <h2>DGV-Export importieren</h2>
                    <p>
                      Lade eine PDF wie den DGV Scoring Record hoch. Der Import
                      funktioniert auch ohne Login und bleibt auf diesem Gerät
                      gespeichert.
                    </p>
                  </div>
                  <span className="soft-badge">PDF</span>
                </div>

                <div className="import-help">
                  <p>So bekommst du die richtige PDF:</p>
                  <ol>
                    <li>
                      Gehe auf{' '}
                      <a
                        href="https://www.golf.de/mein-bereich/scoring-record.html"
                        target="_blank"
                        rel="noreferrer"
                      >
                        golf.de/mein-bereich/scoring-record.html
                      </a>
                    </li>
                    <li>Klicke unten rechts auf den Button „Drucken“.</li>
                    <li>Wähle danach den Button „Detailiert“.</li>
                    <li>Diese PDF kannst du hier hochladen und importieren.</li>
                  </ol>
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
                      : 'PDF auswählen und Runden ins Profil übernehmen'}
                  </span>
                </label>
            </article>
          </section>
        </>

        <section className="panel auth-panel">
          <h2>{authUser ? 'Cloud-Sync aktiv' : 'Ohne Login direkt nutzbar'}</h2>
          <p>
            {authUser
              ? 'Deine Runden werden lokal im Browser und zusätzlich in Firebase gespeichert. So kannst du sie auf mehreren Geräten nutzen.'
              : 'Rechner, Import, Historie und Löschen funktionieren direkt im Browser. Mit Google-Login aktivierst du zusätzlich den geräteübergreifenden Sync.'}
          </p>
          {!authUser ? (
            <button
              className="primary-button"
              onClick={handleSignIn}
              disabled={authStatus === 'loading'}
            >
              {authStatus === 'loading'
                ? 'Lade…'
                : 'Mit Google anmelden für Sync'}
            </button>
          ) : null}
        </section>

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
