import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

if (!OPENAI_API_KEY) {
  console.error("Falta OPENAI_API_KEY en .env");
  process.exit(1);
}

if (!BRAVE_API_KEY) {
  console.error("Falta BRAVE_API_KEY en .env");
  process.exit(1);
}

// ==========================
// 🧠 HELPERS
// ==========================

function cleanText(text = "") {
  return String(text).replace(/\s+/g, " ").trim();
}

function normalizeLang(lang = "en") {
  const value = String(lang || "en").toLowerCase();

  if (value.startsWith("es")) return "es";
  if (value.startsWith("en")) return "en";
  if (value.startsWith("pt")) return "pt";
  if (value.startsWith("fr")) return "fr";
  if (value.startsWith("it")) return "it";
  if (value.startsWith("de")) return "de";

  return "en";
}

function detectLikelyInputLang(text = "", fallbackLang = "es") {
  const value = String(text || "").trim();
  const lower = value.toLowerCase();

  if (!value) return normalizeLang(fallbackLang);

  const hasSpanishChars = /[ñáéíóúü¿¡]/i.test(value);
  const hasFrenchChars = /[àâçéèêëîïôûùüÿœ]/i.test(value);
  const hasGermanChars = /[äöüß]/i.test(value);
  const hasItalianChars = /[àèéìíîòóùú]/i.test(value);
  const hasPortugueseChars = /[ãõçáàâéêíóôõúü]/i.test(value);

  const wordScore = (words) =>
    words.reduce((score, word) => {
      const pattern = new RegExp(`(^|\\W)${word}(\\W|$)`, "i");
      return score + (pattern.test(lower) ? 1 : 0);
    }, 0);

  const scores = {
    es:
      (hasSpanishChars ? 6 : 0) +
      wordScore([
        "el", "la", "los", "las", "un", "una", "de", "que", "en",
        "por", "para", "con", "actual", "presidente", "gobierno",
        "hoy", "ayer", "mañana", "también", "está", "son", "fue"
      ]),

    en:
      wordScore([
        "the", "is", "are", "was", "were", "current", "president",
        "government", "of", "and", "in", "to", "for", "with",
        "today", "yesterday", "tomorrow", "also", "this", "that"
      ]),

    pt:
      (hasPortugueseChars ? 6 : 0) +
      wordScore([
        "o", "a", "os", "as", "um", "uma", "de", "que", "em",
        "para", "com", "atual", "presidente", "governo", "não",
        "hoje", "ontem", "amanhã", "também", "você", "isso",
        "este", "esta", "são", "foi"
      ]),

    fr:
      (hasFrenchChars ? 6 : 0) +
      wordScore([
        "le", "la", "les", "un", "une", "des", "est", "sont",
        "dans", "pour", "avec", "actuel", "président", "gouvernement",
        "aujourd", "hui", "hier", "demain", "aussi", "être",
        "cette", "ceci", "cela"
      ]),

    it:
      (hasItalianChars ? 5 : 0) +
      wordScore([
        "il", "lo", "la", "gli", "le", "un", "una", "di", "che",
        "è", "sono", "per", "con", "attuale", "presidente",
        "governo", "oggi", "ieri", "domani", "anche", "perché",
        "questo", "questa", "stato"
      ]),

    de:
      (hasGermanChars ? 6 : 0) +
      wordScore([
        "der", "die", "das", "ein", "eine", "ist", "sind", "und",
        "für", "mit", "aktuelle", "präsident", "regierung",
        "nicht", "heute", "gestern", "morgen", "auch", "über",
        "zwischen", "dieser", "diese", "dieses"
      ])
  };

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];

  if (best && best[1] > 0) return best[0];

  return normalizeLang(fallbackLang);
}

function getLanguageName(lang = "es") {
  const names = {
    es: "Spanish",
    en: "English",
    pt: "Portuguese",
    fr: "French",
    it: "Italian",
    de: "German"
  };

  return names[normalizeLang(lang)] || "Spanish";
}

function getResponseLangRule(text = "", fallbackLang = "es") {
  const requestedLang = normalizeLang(fallbackLang);
  const languageName = getLanguageName(requestedLang);

  return {
    detectedLang: requestedLang,
    languageName,
    instruction: `
LANGUAGE CONTRACT - CRITICAL:
- The final user-facing answer MUST be written in ${languageName}.
- Do NOT answer in Spanish unless ${languageName} is Spanish.
- Do NOT answer in English unless ${languageName} is English.
- Do NOT answer in French unless ${languageName} is French.
- Do NOT answer in Portuguese unless ${languageName} is Portuguese.
- Do NOT answer in Italian unless ${languageName} is Italian.
- Do NOT answer in German unless ${languageName} is German.
- Ignore the language of the sources when choosing the response language.
- Keep internal JSON keys and enum values exactly as requested.
- Translate every user-facing message, title, label and value to ${languageName}.
- NEVER mix languages.
`.trim()
  };
}

function getSearchLocale(lang = "es") {
  const code = normalizeLang(lang);

  const locales = {
    es: { search_lang: "es", country: "AR" },
    en: { search_lang: "en", country: "US" },

    // Portugués: Brave anda mejor sin encerrar tanto en BR
    pt: { search_lang: "pt-br", country: "US" },

    fr: { search_lang: "fr", country: "FR" },
    it: { search_lang: "it", country: "IT" },
    de: { search_lang: "de", country: "DE" }
  };

  return locales[code] || locales.es;
}

function getDisplayLabel(label = "dudoso", lang = "es") {
  const code = normalizeLang(lang);

  const labels = {
    es: { verdadero: "🟢 Verdadero", dudoso: "🟡 Dudoso", falso: "🔴 Falso" },
    en: { verdadero: "🟢 True", dudoso: "🟡 Unclear", falso: "🔴 False" },
    pt: { verdadero: "🟢 Verdadeiro", dudoso: "🟡 Duvidoso", falso: "🔴 Falso" },
    fr: { verdadero: "🟢 Vrai", dudoso: "🟡 Incertain", falso: "🔴 Faux" },
    it: { verdadero: "🟢 Vero", dudoso: "🟡 Incerto", falso: "🔴 Falso" },
    de: { verdadero: "🟢 Wahr", dudoso: "🟡 Unklar", falso: "🔴 Falsch" }
  };

  return (labels[code] || labels.es)[label] || (labels[code] || labels.es).dudoso;
}

function getDataTitlePrefix(lang = "es") {
  const prefixes = {
    es: "Ficha de",
    en: "Profile of",
    pt: "Ficha de",
    fr: "Fiche de",
    it: "Scheda di",
    de: "Steckbrief von"
  };

  return prefixes[normalizeLang(lang)] || prefixes.es;
}


function safeJsonParse(text) {
  try {
    if (typeof text !== "string") return null;

    let cleaned = text.trim();

    if (cleaned.startsWith("```json")) {
      cleaned = cleaned.slice(7).trim();
    }

    if (cleaned.startsWith("```")) {
      cleaned = cleaned.slice(3).trim();
    }

    if (cleaned.endsWith("```")) {
      cleaned = cleaned.slice(0, -3).trim();
    }

    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

async function askOpenAI(prompt) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature: 0.2
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("OPENAI ERROR STATUS:", response.status);
    console.error("OPENAI ERROR DATA:", data);
    throw new Error(data?.error?.message || "Error al consultar OpenAI");
  }

  const text =
    data?.output_text ||
    data?.output
      ?.map(item => item?.content?.map(c => c?.text || "").join(""))
      .join("\n") ||
    "";

  if (!text.trim()) {
    console.error("OPENAI RESPONSE SIN TEXTO:", data);
    throw new Error("No response from AI");
  }

  return text.trim();
}

function extractSourceFromUrl(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

app.get("/test-openai", async (req, res) => {
  try {
    console.log("TEST 1");
    const raw = await askOpenAI("Respondé solo OK");
    console.log("TEST 2", raw);

    return res.json({
      ok: true,
      raw
    });
  } catch (err) {
    console.error("TEST ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: String(err.message || err)
    });
  }
});

// ==========================
// 🌐 BRAVE SEARCH
// ==========================

async function searchWeb(query, lang = "es") {
  const locale = getSearchLocale(lang);
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10&search_lang=${locale.search_lang}&country=${locale.country}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": BRAVE_API_KEY
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Brave API ${response.status}: ${text}`);
  }

  const data = await response.json();

  return (data?.web?.results || []).map(item => ({
    title: item.title || "",
    url: item.url || "",
    snippet: item.description || "",
    source: extractSourceFromUrl(item.url)
  }));
}

async function searchNews(query, lang = "es") {
  const locale = getSearchLocale(lang);
  const url = `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(query)}&count=10&search_lang=${locale.search_lang}&country=${locale.country}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": BRAVE_API_KEY
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Brave News API ${response.status}: ${text}`);
  }

  const data = await response.json();

  return (data?.results || []).map(item => ({
    title: item.title || "",
    url: item.url || "",
    snippet: item.description || "",
    source: extractSourceFromUrl(item.url)
  }));
}

async function askOpenAIJson({ prompt, schemaName, schema }) {
  const data = await openAIRequest({
    model: "gpt-4.1-mini",
    input: prompt,
    temperature: 0.1,
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        schema,
        strict: true
      }
    }
  });

  const text = extractOutputText(data);

  if (!text) {
    console.error("OPENAI JSON RESPONSE SIN TEXTO:", data);
    throw new Error("No response from AI with structured output");
  }

  const parsed = safeJsonParse(text);

  if (!parsed) {
    console.error("JSON INVALIDO:", text);
    throw new Error("La IA no devolvió JSON válido");
  }

  return parsed;
}

// ==========================
// 🧾 FUENTES
// ==========================

const TRUSTED_SOURCE_PATTERNS = [
  // 🇦🇷 ARGENTINA
  /indec\.gob\.ar/i,
  /argentina\.gob\.ar/i,
  /infobae\.com/i,
  /lanacion\.com\.ar/i,
  /clarin\.com/i,
  /ambito\.com/i,
  /perfil\.com/i,
  /pagina12\.com\.ar/i,
  /cronista\.com/i,

  // 🌍 INTERNACIONALES
  /reuters\.com/i,
  /apnews\.com/i,
  /bbc\.com/i,
  /nytimes\.com/i,
  /washingtonpost\.com/i,
  /ft\.com/i,
  /theguardian\.com/i,
  /cnn\.com/i,
  /usatoday\.com/i,
  /bloomberg\.com/i,
  /forbes\.com/i,
  /cnbc\.com/i,
  /dw\.com/i,
  /euronews\.com/i,
  /politico\.com/i,
  /axios\.com/i,

  // 🇧🇷 PORTUGUÉS / BRASIL
   /g1\.globo\.com/i,
  /oglobo\.globo\.com/i,
  /g1\.globo\.com/i,
  /uol\.com\.br/i,
  /folha\.uol\.com\.br/i,
  /estadao\.com\.br/i,
  /cnnbrasil\.com\.br/i,
  /gov\.br/i,

  // 🇫🇷 FRANCÉS
  /lemonde\.fr/i,
  /lefigaro\.fr/i,
  /france24\.com/i,
  /liberation\.fr/i,
  /tf1info\.fr/i,
  /francetvinfo\.fr/i,
  /gouvernement\.fr/i,

  // 🇮🇹 ITALIANO
  /repubblica\.it/i,
  /corriere\.it/i,
  /ansa\.it/i,
  /ilsole24ore\.com/i,
  /rai\.it/i,
  /governo\.it/i,

  // 🇩🇪 ALEMÁN
  /spiegel\.de/i,
  /welt\.de/i,
  /faz\.net/i,
  /tagesschau\.de/i,
  /zeit\.de/i,
  /bundesregierung\.de/i,

  // 🇪🇸 ESPAÑA
  /elpais\.com/i,
  /elmundo\.es/i,
  /abc\.es/i,
  /lavanguardia\.com/i,
  /rtve\.es/i
];

const LOW_PRIORITY_SOURCE_PATTERNS = [
  /blog/i,
  /wordpress/i,
  /substack/i,
  /foro/i,
  /medium\.com/i,
  /radio/i,
  /fm/i
];

const CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    label: {
      type: "string"
    },
    message: {
      type: "string"
    },
    confidence: {
      type: "string"
    },
    links: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          source: { type: "string" }
        },
        required: ["title", "url", "source"]
      }
    }
  },
  required: ["label", "message", "confidence", "links"]
};

// ==========================
// 🧠 FILTROS
// ==========================

function filterTrustedSources(items = []) {
  return items.filter(item =>
    TRUSTED_SOURCE_PATTERNS.some(pattern => pattern.test(item.url))
  );
}

function filterWeakSources(items = []) {
  return items.filter(item =>
    !LOW_PRIORITY_SOURCE_PATTERNS.some(pattern => pattern.test(item.url))
  );
}

// ==========================
// 📊 SCORE
// ==========================

function scoreSource(item = {}) {
  const url = item.url || "";
  let score = 0;

  // 🔥 Top mundial
  if (/reuters\.com|apnews\.com|bbc\.com|ft\.com|theguardian\.com|nytimes\.com/.test(url)) score += 100;

  // 🇦🇷 Medios fuertes
  if (/lanacion\.com\.ar|clarin\.com|infobae\.com|ambito\.com|perfil\.com/.test(url)) score += 80;

  // 🇧🇷 Medios fuertes Brasil / Portugués
   if (/g1\.globo\.com|oglobo\.globo\.com|uol\.com\.br|folha\.uol\.com\.br|estadao\.com\.br|cnnbrasil\.com\.br/.test(url)) score += 90;

 // 🇧🇷 Oficiales Brasil
   if (/gov\.br/.test(url)) score += 120;

  // 🏛️ Oficiales
  if (/\.gob\.ar|indec\.gob\.ar/.test(url)) score += 120;

  // ❌ basura
  if (/wikipedia|youtube|facebook|instagram|tiktok|x\.com|twitter/.test(url)) score -= 60;
  if (/blog|foro|medium|wordpress/.test(url)) score -= 40;

  // contenido útil
  if (item.snippet?.length > 80) score += 5;
  if (item.title?.length > 20) score += 3;

  return score;
}

// ==========================
// 🏆 SELECCIÓN FINAL
// ==========================

function pickBestSources(items = [], limit = 3) {
  const seen = new Set();

  return items
    .sort((a, b) => scoreSource(b) - scoreSource(a))
    .filter(item => {
      const source = item.source;
      if (!source || seen.has(source)) return false;
      seen.add(source);
      return true;
    })
    .slice(0, limit);
}

const BLOCKED_FIELDS = [
  "Patrimonio",
  "Controversia",
  "Escándalo",
  "Acusación",
  "Denuncia",
  "Investigación",
  "Rumor"
];

function sanitizeDataItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => {
      const label = String(item?.label || "").toLowerCase();
      return !BLOCKED_FIELDS.some((field) =>
        label.includes(field.toLowerCase())
      );
    })
    .slice(0, 5);
}

/* ---------------------------
   CHECK / REAL
---------------------------- */
app.post("/real", async (req, res) => {
  try {
    const text = cleanText(req.body?.text);
    const langInfo = getResponseLangRule(text, req.body?.responseLang || req.body?.lang || req.body?.userLang || "es");
    console.log("REAL text:", text);
    console.log("REAL detectedLang:", langInfo.detectedLang);

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: "Falta texto para verificar."
      });
    }

    let results = [];

    try {
      results = await searchNews(text, langInfo.detectedLang);
      console.log("REAL newsResults count:", results.length);
      console.log("REAL newsResults sample:", results.slice(0, 3));
    } catch (err) {
      console.error("REAL searchNews error:", err?.message || err);
    }

    if (!results.length) {
      try {
        results = await searchWeb(text, langInfo.detectedLang);
        console.log("REAL webResults count:", results.length);
        console.log("REAL webResults sample:", results.slice(0, 3));
      } catch (err) {
        console.error("REAL searchWeb error:", err?.message || err);
      }
    }

    const nonWeakResults = filterWeakSources(results);
    const trustedResults = filterTrustedSources(nonWeakResults);

    const ptFallbackResults =
     langInfo.detectedLang === "pt"
     ? results.filter(item =>
        /g1\.globo\.com|globo\.com|uol\.com\.br|folha\.uol\.com\.br|estadao\.com\.br|cnnbrasil\.com\.br|gov\.br|bbc\.com\/portuguese|cnnbrasils\.com\.br/i.test(item.url || "")
      )
    : [];

    console.log("REAL nonWeakResults count:", nonWeakResults.length);
    console.log("REAL trustedResults count:", trustedResults.length);

    let sourcePool = [];

   if (langInfo.detectedLang === "pt" && ptFallbackResults.length > 0) {
      sourcePool = ptFallbackResults;
   } else if (trustedResults.length >= 2) {
      sourcePool = trustedResults;
   } else if (nonWeakResults.length >= 2) {
     sourcePool = nonWeakResults;
  } else {
    sourcePool = results;
  }

    const safeLinks =
      pickBestSources(sourcePool, 3).length > 0
      ? pickBestSources(sourcePool, 3)
      : pickBestSources(results, 3);

    console.log("REAL safeLinks:", safeLinks);

    if (safeLinks.length === 0 && results.length === 0) {
      return res.json({
        ok: true,
        result: {
          status: "doubtful",
          label: "🟡 Dudoso",
          message:
            langInfo.detectedLang === "en"
              ? "Not enough reliable sources were found to verify this text."
              : langInfo.detectedLang === "pt"
              ? "Não foram encontradas fontes confiáveis suficientes para verificar este texto."
              : langInfo.detectedLang === "fr"
              ? "Aucune source fiable suffisante n’a été trouvée pour vérifier ce texte."
              : langInfo.detectedLang === "it"
              ? "Non sono state trovate fonti affidabili sufficienti per verificare questo testo."
              : langInfo.detectedLang === "de"
              ? "Es wurden nicht genügend zuverlässige Quellen gefunden, um diesen Text zu überprüfen."
              : "No se encontraron fuentes suficientes para verificar este texto.",
          confidence: "baja",
          sources: []
        }
      });
    }

    const sourcesText = safeLinks
      .map(
        (s, i) =>
          `${i + 1}. ${s.title}\nURL: ${s.url}\nFuente: ${s.source}\nResumen: ${s.snippet}`
      )
      .join("\n\n");

    const prompt = `
You verify whether a claim is supported by the provided evidence.
Use ONLY the evidence below.

${langInfo.instruction}

Claim to verify:
"${text}"

Evidence sources:
${sourcesText}

Rules:
- Return ONLY valid JSON.
- JSON keys and enum values must stay exactly as specified.
- "label" must be one of: "verdadero", "falso", "dudoso".
- "verdadero" = the evidence mostly supports the claim.
- "falso" = the evidence clearly contradicts the claim.
- "dudoso" = evidence is insufficient, ambiguous, or partially supports the claim.
- Do not be excessively conservative.
- If there is strong evidence and no clear contradiction, you may answer "verdadero".
- Do not answer "falso" only because evidence is missing.
- "message" is user-facing: write it only in ${langInfo.languageName}, maximum 180 characters.
- "confidence" must be one of: "alta", "media", "baja".
- "links" must be [].

Exact format:
{
  "label": "verdadero",
  "message": "short user-facing text in ${langInfo.languageName}",
  "confidence": "alta",
  "links": []
}
`;

    const raw = await askOpenAI(prompt);
    console.log("REAL raw AI:", raw);

    const parsed = safeJsonParse(raw);

    if (!parsed) {
      console.error("REAL JSON inválido:", raw);
      throw new Error("La IA no devolvió JSON válido");
    }

    console.log("REAL parsed:", parsed);

    let safeLabel = "dudoso";
    const rawLabel = String(parsed?.label || "")
      .trim()
      .toLowerCase();

    if (rawLabel === "verdadero") safeLabel = "verdadero";
    else if (rawLabel === "falso") safeLabel = "falso";

    let safeConfidence = "baja";
    const rawConfidence = String(parsed?.confidence || "")
      .trim()
      .toLowerCase();

    if (rawConfidence === "alta") safeConfidence = "alta";
    else if (rawConfidence === "media") safeConfidence = "media";

    let safeMessage =
      typeof parsed?.message === "string" && parsed.message.trim()
        ? parsed.message.trim()
        : "No se pudo determinar una respuesta confiable.";

    const interpretationWords = [
      "interpreta",
      "justifica",
      "avala",
      "respalda implícitamente"
    ];

    if (
      safeLabel === "falso" &&
      interpretationWords.some((w) => text.toLowerCase().includes(w))
    ) {
      safeLabel = "dudoso";
    }

    const weakFalsePhrases = [
      "no hay evidencia",
      "no se encontró evidencia",
      "no hay pruebas",
      "no se pudo confirmar",
      "no se encontraron pruebas"
    ];

    if (
      safeLabel === "falso" &&
      weakFalsePhrases.some((p) => safeMessage.toLowerCase().includes(p))
    ) {
      safeLabel = "dudoso";
    }

    const statusMap = {
      verdadero: "true",
      dudoso: "doubtful",
      falso: "false"
    };

    const labelMap = {
      verdadero: getDisplayLabel("verdadero", langInfo.detectedLang),
      dudoso: getDisplayLabel("dudoso", langInfo.detectedLang),
      falso: getDisplayLabel("falso", langInfo.detectedLang)
    };

    return res.json({
      ok: true,
      result: {
        status: statusMap[safeLabel],
        label: labelMap[safeLabel],
        message: safeMessage,
        confidence: safeConfidence,
        sources: safeLinks.map((item) => ({
          title: (item.title || "").trim(),
          url: (item.url || "").trim(),
          source: (item.source || "").trim()
        }))
      }
    });
  } catch (error) {
    console.error("Error en /real:", error);

    return res.json({
      ok: true,
      result: {
        status: "doubtful",
        label: "🟡 Dudoso",
        message: `Error interno: ${error?.message || "desconocido"}`,
        confidence: "baja",
        sources: []
      }
    });
  }
});

/* ---------------------------
   INFO
---------------------------- */
app.post("/info", async (req, res) => {
  try {
    const text = cleanText(req.body?.text);
    const langInfo = getResponseLangRule(text, req.body?.responseLang || req.body?.lang || req.body?.userLang || "es");

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: "Falta texto."
      });
    }

    // 🔥 usar Brave
    let results = [];

    try {
      results = await searchWeb(text, langInfo.detectedLang);
    } catch (e) {
      console.error("INFO search error:", e);
    }

    const nonWeak = filterWeakSources(results);
    const best =
        pickBestSources(nonWeak, 3).length > 0
        ? pickBestSources(nonWeak, 3)
        : pickBestSources(results, 3);

    if (best.length === 0) {
      return res.json({
        ok: true,
        result: {
          content:
            langInfo.detectedLang === "en"
              ? "Not enough reliable information was found."
              : langInfo.detectedLang === "pt"
              ? "Não foram encontradas informações suficientemente confiáveis."
              : langInfo.detectedLang === "fr"
              ? "Aucune information suffisamment fiable n’a été trouvée."
              : langInfo.detectedLang === "it"
              ? "Non sono state trovate informazioni sufficientemente affidabili."
              : langInfo.detectedLang === "de"
              ? "Es wurden keine ausreichend zuverlässigen Informationen gefunden."
              : "No se encontró información suficientemente confiable.",
          sources: []
        }
      });
    }

    const sourcesText = best
      .map(
        (s, i) =>
          `${i + 1}. ${s.title}\n${s.snippet}`
      )
      .join("\n\n");

    const prompt = `
Explain the following topic briefly using ONLY the provided information.

${langInfo.instruction}

Text:
"${text}"

Information:
${sourcesText}

Rules:
- Maximum 3 lines.
- Clear and direct.
- Do not invent anything.
- User-facing answer must be only in ${langInfo.languageName}.
`;

    const answer = await askOpenAI(prompt);

    return res.json({
      ok: true,
      result: {
        content: answer.trim(),
        sources: best.map(s => ({
          title: s.title,
          url: s.url,
          source: s.source
        }))
      }
    });

  } catch (err) {
    console.error("Error en /info:", err);

    return res.json({
      ok: true,
      result: {
        content:
          typeof langInfo !== "undefined" && langInfo.detectedLang === "en"
            ? "Could not get information."
            : "No se pudo obtener información.",
        sources: []
      }
    });
  }
});

/* ---------------------------
   DATA 
---------------------------- */

app.post("/data", async (req, res) => {
  try {
    const text = cleanText(req.body?.text);
    const langInfo = getResponseLangRule(text, req.body?.responseLang || req.body?.lang || req.body?.userLang || "es");

    if (!text) {
      return res.status(400).json({ ok: false });
    }

    let results = [];

    try {
      results = await searchWeb(text, langInfo.detectedLang);
    } catch (e) {
      console.error("DATA search error:", e);
    }

    const nonWeak = filterWeakSources(results);
    const best = pickBestSources(nonWeak, 3);

    const sourcesText = best
      .map((s) => `${s.title}\n${s.snippet}`)
      .join("\n\n");

    const prompt = `
You generate short, clear and reliable DATA profile cards.
Act as a data analyst. Extract only current, concrete and verifiable information.
Return ONLY valid JSON.

${langInfo.instruction}

Goal:
Create a short profile card with concrete, current and verifiable facts.
Do not invent.
Do not complete fields with assumptions.

Strict rules:
- Temporality: for people, current roles must come from recent or clearly current sources.
- Exclusion: ignore any role that mentions former, previous, past, ex, or ended dates.
- Verification: prioritize official sites, recent media, or updated corporate/public profiles.
- Use only firm and current facts.
- If a fact is uncertain, OMIT it.
- For current public figures, companies, institutions or news topics, prioritize current information.
- Avoid unnecessary biography.
- Avoid irrelevant personal details.
- Fewer fields are better than a doubtful card.
- Do not include generic phrases like "public figure" or "known person".
- Do not include controversies, rumors, private life or irrelevant information.
- Maximum 5 items.
- Each value must be short, clear and precise.
- "title", every "label", and every "value" are user-facing: write them only in ${langInfo.languageName}.

Adapt by entity type, but include ONLY clearly verifiable fields:

PERSON:
- Name
- Nationality
- Age
- Activity
- Current role
- Party or organization, if applicable and clear

COUNTRY or CITY:
- Type
- Location
- Capital, if applicable
- Main language
- Approximate population, only if reliable

COMPANY or CLUB:
- Type
- Country of origin
- Main activity
- Organization or league, if applicable
- Year founded, only if reliable

CONCEPT:
- Brief definition
- Use or context
- Key fact, only if clear

Input text:
"${text}"

Information:
${sourcesText}

Required format:
{
  "title": "${getDataTitlePrefix(langInfo.detectedLang)} ...",
  "items": [
    { "label": "Name", "value": "..." }
  ]
}
`;

    const raw = await askOpenAI(prompt);
    const parsed = safeJsonParse(raw);

    if (!parsed) {
      throw new Error("JSON inválido");
    }

    parsed.items = sanitizeDataItems(parsed.items);

    if (!parsed.items || parsed.items.length === 0) {
      parsed.items = [
        {
          label: langInfo.detectedLang === "en" ? "Fact" : "Dato",
          value:
            langInfo.detectedLang === "en"
              ? "No reliable information was found."
              : "No se encontró información confiable."
        }
      ];
    }

    if (!parsed.title) {
      parsed.title = `${getDataTitlePrefix(langInfo.detectedLang)} ${text}`;
    }

    return res.json({
      ok: true,
      result: parsed
    });
  } catch (err) {
    console.error("Error en /data:", err);

    return res.json({
      ok: true,
      result: {
        title: "Información limitada",
        items: [{ label: "Dato", value: "No disponible" }]
      }
    });
  }
});

/* ---------------------------
   TRANSLATE
---------------------------- */
app.post("/translate", async (req, res) => {
  try {
    const rawText = req.body?.text;
    const text = cleanText(rawText);
    const targetLang = req.body?.targetLang || "es";

    if (!text) {
      return res.status(400).json({
        sourceLang: "auto",
        targetLang,
        result: "Falta texto para traducir."
      });
    }

    const langNames = {
      es: "Spanish",
      en: "English",
      pt: "Portuguese",
      fr: "French",
      it: "Italian",
      de: "German"
    };

    const targetLanguageName = langNames[targetLang] || "Spanish";

    const prompt = `
You are a translation engine.

Task:
1. Detect the source language of the text.
2. Translate the text into ${targetLanguageName}.
3. Return your answer ONLY as valid JSON with this exact structure:

{
  "sourceLang": "en",
  "targetLang": "${targetLang}",
  "result": "translated text here"
}

Rules:
- sourceLang must be one of: es, en, pt, fr, it, de, auto
- targetLang must be exactly "${targetLang}"
- result must contain only the translation
- no markdown
- no explanations
- no extra text

Text:
"""${text}"""
`;

    const raw = await askOpenAI(prompt);
    console.log("RAW AI RESPONSE:", raw);

    let parsed = null;

    parsed = safeJsonParse(raw);

    if (!parsed) {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = safeJsonParse(match[0]);
      }
    }

    if (!parsed) {
      parsed = {
        sourceLang: "auto",
        targetLang,
        result: raw.trim() || "No se pudo traducir."
      };
    }

    return res.json({
      ok: true,
      sourceLang: parsed.sourceLang || "auto",
      targetLang: parsed.targetLang || targetLang,
      result: parsed.result || "No se pudo traducir."
    });
  } catch (error) {
    console.error("Translate error:", error);
    return res.status(500).json({
      ok: false,
      sourceLang: "auto",
      targetLang: req.body?.targetLang || "es",
      result: "❌ Error al traducir."
    });
  }
});

/* ---------------------------
   MEANING
---------------------------- */
app.post("/meaning", async (req, res) => {
  try {
    const rawText = req.body?.text;
    const text = cleanText(rawText);
    const langInfo = getResponseLangRule(text, req.body?.responseLang || req.body?.lang || req.body?.userLang || "es");

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: "Falta texto para definición."
      });
    }

    const prompt = `
Give the meaning of the following term or expression.

${langInfo.instruction}

Rules:
- If it is a single word, include:
  1) grammatical category
  2) brief meaning
  3) synonyms if applicable
  4) antonyms if applicable
- If a section does not apply, do not force it.
- Keep the answer brief, ordered and clear.
- Do not invent unusual facts.
- User-facing answer must be only in ${langInfo.languageName}.

Text:
"""${text}"""
`;

    const answer = await askOpenAI(prompt);

    return res.json({
      ok: true,
      result: {
        title: "Meaning",
        content: answer
      }
    });
  } catch (error) {
    console.error("Error en /meaning:", error);
    return res.status(500).json({
      ok: false,
      error: "No se pudo obtener el significado."
    });
  }
});

/* ---------------------------
   HEALTH
---------------------------- */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "TrueCheck server",
    status: "running"
  });
});

app.listen(PORT, async () => {
  console.log(`✅ TrueCheck server running on http://localhost:${PORT}`);

  // 🔥 Warm-up automático
  try {
    console.log("🔥 Warm-up iniciado...");

    await fetch(`http://localhost:${PORT}/real`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Test" })
    });

    console.log("✅ Warm-up completo");
  } catch (error) {
    console.log("⚠️ Warm-up falló:", error.message);
  }
});