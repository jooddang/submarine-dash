import fs from "node:fs";
import { ProfanityEngine } from "@coffeeandfun/google-profanity-words";

// This project uses @coffeeandfun/google-profanity-words as the primary English source.
// Upstream currently documents English (default) + Spanish; Korean is maintained locally.
// Repo: https://github.com/coffee-and-fun/google-profanity-words

const KO_WORDS_FILE_URL = new URL("./profanity-words-ko.txt", import.meta.url);
const EXTRA_WORDS_FILE_URL = new URL("./profanity-words.txt", import.meta.url);

const profanityEn = new ProfanityEngine({ language: "en" });

let cachedKoNorms = null;
let cachedExtraNorms = null;

const leetMap = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  "$": "s",
  "!": "i",
};

function normalizeForMatch(input) {
  if (typeof input !== "string") return "";
  const lower = input.toLowerCase();
  const deAccented = lower.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const leetFixed = Array.from(deAccented, (ch) => leetMap[ch] ?? ch).join("");
  // Keep all letters/numbers across scripts (Hangul 포함) and strip punctuation/spacing.
  const lettersNumbersOnly = leetFixed.replace(/[^\p{L}\p{N}]+/gu, "");
  // Collapse long repeats: "fuuuuuck" -> "fuuck"
  return lettersNumbersOnly.replace(/(.)\1{2,}/g, "$1$1");
}

function loadNormsFromFile(fileUrl) {
  const text = fs.readFileSync(fileUrl, "utf8");
  return text
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map(normalizeForMatch)
    .filter(Boolean);
}

function loadKoreanNorms() {
  if (cachedKoNorms) return cachedKoNorms;
  try {
    cachedKoNorms = loadNormsFromFile(KO_WORDS_FILE_URL).filter((w) => w && w.length >= 2);
  } catch {
    cachedKoNorms = [];
  }
  return cachedKoNorms;
}

function loadExtraNorms() {
  if (cachedExtraNorms) return cachedExtraNorms;
  try {
    cachedExtraNorms = loadNormsFromFile(EXTRA_WORDS_FILE_URL).filter((w) => w && w.length >= 2);
  } catch {
    cachedExtraNorms = [];
  }
  return cachedExtraNorms;
}

// Levenshtein distance with early-exit threshold (maxDistance <= 1)
function levenshteinWithin1(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === 0 || lb === 0) return false;

  // Same length: allow 1 substitution
  if (la === lb) {
    let mismatches = 0;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        mismatches++;
        if (mismatches > 1) return false;
      }
    }
    return mismatches === 1;
  }

  // Length differs by 1: allow 1 insertion/deletion
  const longer = la > lb ? a : b;
  const shorter = la > lb ? b : a;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < longer.length && j < shorter.length) {
    if (longer[i] === shorter[j]) {
      i++;
      j++;
      continue;
    }
    edits++;
    if (edits > 1) return false;
    i++; // skip one char in longer
  }
  return true;
}

function containsApproxOrExact(haystackNorm, needleNorm) {
  if (!needleNorm) return false;
  // For short needles, only do exact substring match to avoid false-positives.
  // Approx matching is only meaningful for longer terms.
  if (needleNorm.length < 4) {
    return haystackNorm.includes(needleNorm);
  }

  if (haystackNorm.includes(needleNorm)) return true;

  const minLen = Math.max(1, needleNorm.length - 1);
  const maxLen = needleNorm.length + 1;
  for (let winLen = minLen; winLen <= maxLen; winLen++) {
    if (winLen > haystackNorm.length) continue;
    for (let i = 0; i <= haystackNorm.length - winLen; i++) {
      const window = haystackNorm.slice(i, i + winLen);
      if (levenshteinWithin1(window, needleNorm)) return true;
    }
  }
  return false;
}

async function isProfaneTokenAsync(token) {
  if (!token) return false;

  // 1) English: use the library's exact matching (no fuzzy, no substring) to avoid false positives.
  // This means "roar" will NOT be flagged by an entry like "hoar".
  try {
    if (await profanityEn.search(token)) return true;
  } catch {
    // ignore; fall through to local lists
  }

  // 2) Korean: exact token match against our local list (no fuzzy/substring).
  const ko = loadKoreanNorms();
  const norm = normalizeForMatch(token);
  for (const term of ko) {
    if (norm === term) return true;
  }

  // 3) Extra stopwords (curated): allow fuzzy/substring to catch evasions like fuxking/focking.
  const extra = loadExtraNorms();
  for (const term of extra) {
    if (containsApproxOrExact(norm, term)) return true;
  }

  return false;
}

function splitNameTokens(name) {
  return name
    .trim()
    .split(/\s+/g)
    .flatMap((t) => t.split(/[_\-]+/g))
    .filter(Boolean);
}

export function sanitizeLeaderboardNameSync(name) {
  return typeof name === "string" && name.trim() ? name.trim().slice(0, 40) : "Anonymous";
}

export async function sanitizeLeaderboardName(name) {
  if (typeof name !== "string") return "Anonymous";
  const trimmed = name.trim();
  if (!trimmed) return "Anonymous";

  const tokens = splitNameTokens(trimmed);
  const kept = [];
  for (const token of tokens) {
    if (await isProfaneTokenAsync(token)) continue;
    kept.push(token);
  }

  const result = kept.join(" ").trim();
  if (!result) return "Anonymous";

  // Catch "spaced out" profanity evasions like "f u c k" without creating cross-token false positives.
  // Only apply when the name is made of very short tokens (<= 2 chars each).
  const allTokensShort = tokens.length > 1 && tokens.every((t) => t.length <= 2);
  if (allTokensShort) {
    const combinedNorm = normalizeForMatch(tokens.join(""));
    // For combined short tokens, check:
    // - English exact match via library
    // - Korean exact match via local list
    // - Extra fuzzy list (for evasions)
    try {
      if (await profanityEn.search(combinedNorm)) return "Anonymous";
    } catch {
      // ignore
    }
    const ko = loadKoreanNorms();
    for (const term of ko) {
      if (combinedNorm === term) return "Anonymous";
    }
    const extra = loadExtraNorms();
    for (const term of extra) {
      if (containsApproxOrExact(combinedNorm, term)) return "Anonymous";
    }
  }

  return result.slice(0, 40);
}


