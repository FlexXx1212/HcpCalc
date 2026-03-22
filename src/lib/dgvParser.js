import { extractLinesFromTextContent, parseDgvRecordText } from './dgvTextParser.js'

export async function parseDgvPdfFile(file) {
  const [{ GlobalWorkerOptions, getDocument }, workerModule] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.mjs?url'),
  ])

  GlobalWorkerOptions.workerSrc = workerModule.default

  const documentData = await file.arrayBuffer()
  const pdf = await getDocument({ data: documentData }).promise
  const allLines = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const textContent = await page.getTextContent()
    allLines.push(...extractLinesFromTextContent(textContent.items))
  }

  return parseDgvRecordText(allLines.join('\n'))
}

export { parseDgvRecordText }
