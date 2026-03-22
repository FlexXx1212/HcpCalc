const LOCAL_STATE_KEY = 'hcpcalc.app-state.v1'

export function loadLocalAppState() {
  if (typeof window === 'undefined') return null

  try {
    const rawValue = window.localStorage.getItem(LOCAL_STATE_KEY)
    if (!rawValue) return null
    const parsed = JSON.parse(rawValue)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (error) {
    console.error(error)
    return null
  }
}

export function saveLocalAppState(state) {
  if (typeof window === 'undefined') return

  window.localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state))
}
