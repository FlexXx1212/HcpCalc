function roundToTenth(value) {
  return Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON) * 10) / 10
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function getUsedScoreCount(totalScores) {
  if (totalScores <= 0) return 0
  if (totalScores <= 5) return 1
  if (totalScores <= 8) return 2
  if (totalScores <= 11) return 3
  if (totalScores <= 14) return 4
  if (totalScores <= 16) return 5
  if (totalScores <= 18) return 6
  if (totalScores === 19) return 7
  return 8
}

function calculateHandicapFromDifferentials(differentials) {
  if (differentials.length === 0) return null

  const usedCount = getUsedScoreCount(differentials.length)
  const usedDifferentials = differentials.slice(0, usedCount)
  const bestScore = usedDifferentials[0].scoreDifferential

  if (differentials.length <= 3) {
    return roundToTenth(bestScore - 2)
  }

  if (differentials.length === 4) {
    return roundToTenth(bestScore - 1)
  }

  return roundToTenth(
    average(usedDifferentials.map((entry) => entry.scoreDifferential)),
  )
}

export function calculateScoreDifferential({
  holes,
  gbe,
  courseRating,
  slope,
  pcc = 0,
  handicapIndexAtTime,
}) {
  if (!Number.isFinite(gbe) || !Number.isFinite(courseRating) || !Number.isFinite(slope)) {
    throw new Error('Für die Berechnung werden GBE, Course Rating und Slope benötigt.')
  }

  if (slope <= 0) {
    throw new Error('Slope muss größer als 0 sein.')
  }

  const rawScore = (gbe - courseRating - pcc) * (113 / slope)

  if (holes === 9) {
    if (!Number.isFinite(handicapIndexAtTime)) {
      throw new Error('Für 9-Loch-Runden ist ein HCPI vor der Runde erforderlich.')
    }

    const expectedNineHole = ((handicapIndexAtTime * 1.04) + 2.4) / 2
    return roundToTenth(rawScore + expectedNineHole)
  }

  return roundToTenth(rawScore)
}

function buildDifferentials(rounds) {
  return rounds
    .filter((round) => Number.isFinite(round.scoreDifferential))
    .map((round) => ({
      ...round,
      scoreDifferential: roundToTenth(round.scoreDifferential),
    }))
    .sort((left, right) => left.scoreDifferential - right.scoreDifferential)
    .slice(0, 20)
}

export function buildHandicapSummary(rounds) {
  const activeDifferentials = buildDifferentials(rounds)
  const rawHcp = calculateHandicapFromDifferentials(activeDifferentials)
  const usedCount = getUsedScoreCount(activeDifferentials.length)

  // Rule: HCP in range [26.5, 54] can never get worse than the best (lowest)
  // value previously achieved in that range.
  const chronologicalRounds = [...rounds].reverse()
  let lowestInRange = null

  for (let i = 1; i <= chronologicalRounds.length; i++) {
    const diffs = buildDifferentials(chronologicalRounds.slice(0, i))
    const hcp = calculateHandicapFromDifferentials(diffs)
    if (hcp !== null && hcp >= 26.5 && hcp <= 54) {
      if (lowestInRange === null || hcp < lowestInRange) {
        lowestInRange = hcp
      }
    }
  }

  const currentHcp =
    rawHcp !== null && lowestInRange !== null && rawHcp > lowestInRange
      ? lowestInRange
      : rawHcp

  return {
    currentHcp,
    activeDifferentials,
    usedDifferentials: activeDifferentials.slice(0, usedCount),
  }
}

export function formatScoreDifferential(value) {
  if (!Number.isFinite(value)) return '—'

  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(roundToTenth(value))
}
