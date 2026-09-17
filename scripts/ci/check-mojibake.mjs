#!/usr/bin/env node

/**
 * Repository UTF-8 / mojibake gate.
 *
 * Scans tracked source and config files for replacement characters (U+FFFD) and
 * cp1251-decoded-as-UTF-8 fragments. Optional positional arguments narrow the
 * walk to one or more directory prefixes. Exit code 1 means the tree is dirty.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { extname } from "node:path"

const INCLUDED_ROOT_PREFIXES = [
  "apps/",
  "core/",
  "packages/",
  "docs/",
  "context/",
  "infra/",
  "scripts/",
]

const INCLUDED_ROOT_FILES = new Set([
  ".sourcecraft/ci.yaml",
  ".sourcecraft/branches.yaml",
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".dockerignore",
  ".gitleaks.toml",
  "AGENTS.md",
  "README.md",
  "docker-compose.yml",
  "package.json",
  "pnpm-workspace.yaml",
  "biome.json",
])

const INCLUDED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".md",
  ".mdx",
  ".yml",
  ".yaml",
  ".toml",
  ".py",
  ".sh",
  ".ps1",
  ".sql",
  ".css",
  ".scss",
  ".html",
  ".txt",
  ".svg",
])

const INCLUDED_BASENAMES = new Set([
  "Dockerfile",
  "Dockerfile.dev",
  "Dockerfile.local",
  ".env",
  ".env.example",
])

const EXCLUDED_PATH_PARTS = [
  "/node_modules/",
  "/.next/",
  "/dist/",
  "/dist-test/",
  "/build/",
  "/coverage/",
  "/.cache/",
  "/.pnpm-store/",
  "/generated/",
  "/.venv/",
  "/context/legacy_code/",
  "/context/sources/",
]

const replacementCharPattern = /\uFFFD/u
const suspiciousMarkerPattern =
  /(?:Р[А-яЁёA-Za-z]|С[А-яЁёA-Za-z]|Г[А-яЁёA-Za-z]|в[ЂЃ€„…†‡€‰™љ›њќћџ])/u
const cyrillicPattern = /[А-Яа-яЁё]/gu
const mojibakeHintPattern = /[РСГв][^\s]{0,1}[РСГв]/u
const mojibakeRareCharPattern = /[ЎўЃѓЂђЉљЊњЌќЋћЏџ€‚„…†‡‰‹›™№«»]/gu
const mojibakePairPattern = /[РСГв][ЎўЃѓЂђЉљЊњЌќЋћЏџ€‚„…†‡‰‹›™№«»]/gu

const CP1251_TABLE = [
  "\u0402", "\u0403", "\u201A", "\u0453", "\u201E", "\u2026", "\u2020", "\u2021",
  "\u20AC", "\u2030", "\u0409", "\u2039", "\u040A", "\u040C", "\u040B", "\u040F",
  "\u0452", "\u2018", "\u2019", "\u201C", "\u201D", "\u2022", "\u2013", "\u2014",
  "\u0098", "\u2122", "\u0459", "\u203A", "\u045A", "\u045C", "\u045B", "\u045F",
  "\u00A0", "\u040E", "\u045E", "\u0408", "\u00A4", "\u0490", "\u00A6", "\u00A7",
  "\u0401", "\u00A9", "\u0404", "\u00AB", "\u00AC", "\u00AD", "\u00AE", "\u0407",
  "\u00B0", "\u00B1", "\u0406", "\u0456", "\u0491", "\u00B5", "\u00B6", "\u00B7",
  "\u0451", "\u2116", "\u0454", "\u00BB", "\u0458", "\u0405", "\u0455", "\u0457",
]

const UNICODE_TO_CP1251 = new Map()

for (let byte = 0x80; byte <= 0xbf; byte += 1) {
  UNICODE_TO_CP1251.set(CP1251_TABLE[byte - 0x80], byte)
}
for (let byte = 0xc0; byte <= 0xff; byte += 1) {
  UNICODE_TO_CP1251.set(String.fromCodePoint(0x0410 + (byte - 0xc0)), byte)
}

function normalizeScope(scope) {
  return scope.replace(/\\/g, "/").replace(/\/+$/u, "")
}

function normalizePath(path) {
  return path.replace(/\\/g, "/").replace(/^\.\/+/u, "")
}

function isExcludedPath(path) {
  return EXCLUDED_PATH_PARTS.some((part) => `${path}/`.includes(part))
}

function collectFilesFromDirectory(root) {
  const files = []

  function visit(directory) {
    if (isExcludedPath(directory)) return

    const entries = readdirSync(directory, { withFileTypes: true })
    for (const entry of entries) {
      const childPath = normalizePath(`${directory}/${entry.name}`)

      if (entry.isDirectory()) {
        visit(childPath)
        continue
      }

      if (entry.isFile()) files.push(childPath)
    }
  }

  visit(root)
  return files
}

function listRepositoryFiles() {
  const files = []

  for (const file of INCLUDED_ROOT_FILES) {
    if (existsSync(file)) files.push(file)
  }

  for (const prefix of INCLUDED_ROOT_PREFIXES) {
    const root = normalizeScope(prefix)
    if (existsSync(root)) files.push(...collectFilesFromDirectory(root))
  }

  return [...new Set(files)].sort()
}

function matchesScopes(path, scopes) {
  if (scopes.length === 0) return true
  return scopes.some((scope) => path === scope || path.startsWith(`${scope}/`))
}

function shouldScan(path, scopes) {
  if (isExcludedPath(path)) return false
  if (!matchesScopes(path, scopes)) return false

  const isIncludedRootFile = INCLUDED_ROOT_FILES.has(path)
  const isIncludedRootPrefix = INCLUDED_ROOT_PREFIXES.some((prefix) =>
    path.startsWith(prefix),
  )

  if (!isIncludedRootFile && !isIncludedRootPrefix) return false

  const extension = extname(path)
  const basename = path.split("/").at(-1) ?? path

  return (
    INCLUDED_EXTENSIONS.has(extension) ||
    INCLUDED_BASENAMES.has(basename) ||
    basename.startsWith(".env")
  )
}

function isProbablyBinary(buffer) {
  const sampleLength = Math.min(buffer.length, 4096)
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) return true
  }
  return false
}

function encodeCp1251(value) {
  const bytes = []

  for (const char of value) {
    const code = char.codePointAt(0)
    if (code === undefined) return null

    if (code <= 0x7f) {
      bytes.push(code)
      continue
    }

    const mapped = UNICODE_TO_CP1251.get(char)
    if (mapped !== undefined) {
      bytes.push(mapped)
      continue
    }

    return null
  }

  return Buffer.from(bytes)
}

function getCyrillicCount(value) {
  return value.match(cyrillicPattern)?.length ?? 0
}

function getMojibakeScore(value) {
  const rareChars = value.match(mojibakeRareCharPattern)?.length ?? 0
  const pairs = value.match(mojibakePairPattern)?.length ?? 0
  return rareChars + pairs * 2
}

function isMeaningfulRepair(original, repaired) {
  if (!repaired || repaired === original) return false
  if (replacementCharPattern.test(repaired)) return false

  const originalScore = getMojibakeScore(original)
  const repairedScore = getMojibakeScore(repaired)
  const repairedCyrillic = getCyrillicCount(repaired)

  if (repairedCyrillic < 3) return false
  if (originalScore === 0) return false
  if (repairedScore >= originalScore) return false

  return true
}

function tryRepairValue(value) {
  if (!suspiciousMarkerPattern.test(value)) return null
  const encoded = encodeCp1251(value)
  if (!encoded) return null

  const repaired = encoded.toString("utf8")
  return isMeaningfulRepair(value, repaired) ? repaired : null
}

function collectQuotedFragments(line) {
  const fragments = []
  const patterns = [
    /"([^"\n]*[РСГв][^"\n]*)"/gu,
    /'([^'\n]*[РСГв][^'\n]*)'/gu,
    /`([^`\n]*[РСГв][^`\n]*)`/gu,
  ]

  for (const pattern of patterns) {
    for (const match of line.matchAll(pattern)) {
      if (match[1]) fragments.push(match[1])
    }
  }

  const commentIndex = line.indexOf("//")
  if (commentIndex >= 0) {
    const comment = line.slice(commentIndex + 2).trim()
    if (comment) fragments.push(comment)
  }

  return fragments
}

function collectSuspiciousLines(content) {
  const hits = []
  const lines = content.split(/\r?\n/u)

  lines.forEach((line, index) => {
    if (!line) return

    if (replacementCharPattern.test(line)) {
      hits.push({
        line: index + 1,
        reason: "replacement-character",
        snippet: line,
      })
      return
    }

    const fragments = collectQuotedFragments(line)
    for (const fragment of fragments) {
      const repaired = tryRepairValue(fragment)
      if (!repaired) continue
      hits.push({
        line: index + 1,
        reason: `suspicious-fragment -> ${repaired}`,
        snippet: line,
      })
      return
    }

    if (!mojibakeHintPattern.test(line)) return
    const repairedWholeLine = tryRepairValue(line.trim())
    if (!repairedWholeLine) return

    hits.push({
      line: index + 1,
      reason: `suspicious-line -> ${repairedWholeLine}`,
      snippet: line,
    })
  })

  return hits
}

function shorten(value, maxLength = 220) {
  const normalized = value.replace(/\t/g, "  ").trim()
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized
}

function parseScopes(argv) {
  return argv
    .filter((value) => !value.startsWith("--"))
    .map(normalizeScope)
    .filter(Boolean)
}

function main() {
  const scopes = parseScopes(process.argv.slice(2))
  const files = listRepositoryFiles().filter((file) => shouldScan(file, scopes))
  const findings = []

  for (const file of files) {
    const buffer = readFileSync(file)
    if (isProbablyBinary(buffer)) continue

    const content = buffer.toString("utf8")
    const hits = collectSuspiciousLines(content)
    if (hits.length === 0) continue

    findings.push({
      file,
      hits: hits.slice(0, 20),
    })
  }

  const scopeLabel = scopes.length > 0 ? `scope=${scopes.join(",")}` : "full-repo"

  if (findings.length === 0) {
    console.log(`check-mojibake: OK (${files.length} files scanned, ${scopeLabel})`)
    return
  }

  console.error(`check-mojibake: suspicious mojibake detected (${scopeLabel})`)
  for (const finding of findings) {
    console.error(`\n${finding.file}`)
    for (const hit of finding.hits) {
      console.error(`  L${hit.line} [${hit.reason}] ${shorten(hit.snippet)}`)
    }
  }

  process.exitCode = 1
}

main()
