function parseGermanNumber(value) {
  const normalized = value?.trim().replace(',', '.')
  if (!normalized) return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function toIsoDate(value) {
  const [day, month, year] = value.split('.')
  return `${year}-${month}-${day}`
}

function cleanLine(value) {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s+([:,])/g, '$1')
    .trim()
}

function parseMainLine(line) {
  return line.match(
    /^(\d+)\s+(\d{2}\.\d{2}\.\d{4})\s+(\d+)\s+(.+?)\s+(9|18)\s+([A-Z])\s+(\d+(?:[.,]\d+)?)\s+(\d+(?:[.,]\d+)?)$/,
  )
}

function parseClubLine(line) {
  return line.match(
    /^Club:\s+(.+?)\s+Country:\s+(\d+)\s+Rd\.:?\s+(\d+)\s+PCC:\s+(-?\d+(?:[.,]\d+)?)$/,
  )
}

function parseTeesLine(line) {
  return line.match(
    /^Tees:\s*(.*?)\s+Par:\s+(\d+(?:[.,]\d+)?)\s+CR:\s+(\d+(?:[.,]\d+)?)\s+Slope:\s+(\d+)\s+HCPI:\s+(\d+(?:[.,]\d+)?)\s+CH:\s+(-?\d+(?:[.,]\d+)?)\s+ExSc:\s+(-?\d+(?:[.,]\d+)?)$/,
  )
}

export function parseDgvRecordText(text) {
  const lines = text
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean)

  const rounds = []

  for (let index = 0; index < lines.length; index += 1) {
    const mainMatch = parseMainLine(lines[index])

    if (!mainMatch) continue

    const clubMatch = parseClubLine(lines[index + 1] ?? '')
    const teesMatch = parseTeesLine(lines[index + 2] ?? '')

    if (!clubMatch || !teesMatch) continue

    const [
      ,
      rowNumber,
      roundDate,
      clubNumber,
      eventName,
      holes,
      type,
      gbe,
      scoreDifferential,
    ] = mainMatch

    const [, courseName, , , pcc] = clubMatch
    const [, tee, par, courseRating, slope, handicapIndexAtTime, courseHandicap] =
      teesMatch

    rounds.push({
      id: `import-${roundDate}-${rowNumber}-${clubNumber}`,
      source: 'import',
      date: toIsoDate(roundDate),
      courseName,
      clubNumber,
      eventName,
      tee,
      holes: Number(holes),
      type,
      gbe: parseGermanNumber(gbe),
      par: parseGermanNumber(par),
      courseRating: parseGermanNumber(courseRating),
      slope: parseGermanNumber(slope),
      pcc: parseGermanNumber(pcc) ?? 0,
      handicapIndexAtTime: parseGermanNumber(handicapIndexAtTime),
      courseHandicap: parseGermanNumber(courseHandicap),
      scoreDifferential: parseGermanNumber(scoreDifferential),
      createdAt: new Date().toISOString(),
    })

    index += 2
  }

  return rounds
}

export function extractLinesFromTextContent(items) {
  const lines = []
  let currentLine = []

  for (const item of items) {
    if (!('str' in item)) continue

    if (item.str) {
      currentLine.push(item.str)
    }

    if (item.hasEOL) {
      const line = cleanLine(currentLine.join(' '))
      if (line) lines.push(line)
      currentLine = []
    }
  }

  if (currentLine.length > 0) {
    const line = cleanLine(currentLine.join(' '))
    if (line) lines.push(line)
  }

  return lines
}
