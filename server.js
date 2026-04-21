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

async function searchWeb(query) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10&search_lang=es&country=AR`;

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

async function searchNews(query) {
  const url = `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(query)}&count=10&search_lang=es&country=AR`;

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
  /indec\.gob\.ar/i,
  /argentina\.gob\.ar/i,

  /reuters\.com/i,
  /apnews\.com/i,
  /bbc\.com/i,
  /nytimes\.com/i,
  /washingtonpost\.com/i,
  /ft\.com/i,
  /lemonde\.fr/i,
  /asahi\.com/i,
  /efe\.com/i,
  /cnn\.com/i,
  /usatoday\.com/i,
  /theguardian\.com/i,

  /infobae\.com/i,
  /lanacion\.com\.ar/i,
  /clarin\.com/i,
  /ambito\.com/i,
  /perfil\.com/i,
  /pagina12\.com\.ar/i,
  /cronista\.com/i
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
    console.log("REAL text:", text);

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: "Falta texto para verificar."
      });
    }

    let results = [];

    try {
      results = await searchNews(text);
      console.log("REAL newsResults count:", results.length);
      console.log("REAL newsResults sample:", results.slice(0, 3));
    } catch (err) {
      console.error("REAL searchNews error:", err?.message || err);
    }

    if (!results.length) {
      try {
        results = await searchWeb(text);
        console.log("REAL webResults count:", results.length);
        console.log("REAL webResults sample:", results.slice(0, 3));
      } catch (err) {
        console.error("REAL searchWeb error:", err?.message || err);
      }
    }

    const nonWeakResults = filterWeakSources(results);
    const trustedResults = filterTrustedSources(nonWeakResults);

    console.log("REAL nonWeakResults count:", nonWeakResults.length);
    console.log("REAL trustedResults count:", trustedResults.length);

    let sourcePool = [];

    if (trustedResults.length >= 2) {
      sourcePool = trustedResults;
    } else if (nonWeakResults.length >= 2) {
      sourcePool = nonWeakResults;
    } else {
      sourcePool = results;
    }

    const safeLinks = pickBestSources(sourcePool, 3);
    console.log("REAL safeLinks:", safeLinks);

    if (safeLinks.length === 0) {
      return res.json({
        ok: true,
        result: {
          status: "doubtful",
          label: "🟡 Dudoso",
          message: "No se encontraron fuentes suficientes para verificar este texto.",
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
Analizá la veracidad de la siguiente afirmación usando SOLO la evidencia provista.

Texto a verificar:
"${text}"

Fuentes encontradas:
${sourcesText}

Reglas:
- Respondé SOLO con JSON válido.
- Todo en español.
- "verdadero" = la evidencia respalda mayormente la afirmación.
- "falso" = la evidencia contradice claramente la afirmación.
- "dudoso" = falta evidencia, hay ambigüedad o la afirmación es parcialmente correcta.
- No seas excesivamente conservador.
- Si hay una fuente fuerte y no hay contradicción clara, podés responder "verdadero".
- No respondas "falso" solo por falta de evidencia.
- "message" debe ser muy breve, máximo 180 caracteres.
- "links" debe ser [].

Formato exacto:
{
  "label": "verdadero",
  "message": "texto breve",
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
      verdadero: "🟢 Verdadero",
      dudoso: "🟡 Dudoso",
      falso: "🔴 Falso"
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

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: "Falta texto."
      });
    }

    // 🔥 usar Brave
    let results = [];

    try {
      results = await searchWeb(text);
    } catch (e) {
      console.error("INFO search error:", e);
    }

    const nonWeak = filterWeakSources(results);
    const best = pickBestSources(nonWeak, 3);

    if (best.length === 0) {
      return res.json({
        ok: true,
        result: {
          content: "No se encontró información suficientemente confiable.",
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
Explicá brevemente el siguiente tema usando SOLO esta información.

Texto:
"${text}"

Información:
${sourcesText}

Reglas:
- Máximo 3 líneas
- Claro, directo
- Sin inventar nada
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
        content: "No se pudo obtener información.",
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

    if (!text) {
      return res.status(400).json({ ok: false });
    }

    let results = [];

    try {
      results = await searchWeb(text);
    } catch (e) {
      console.error("DATA search error:", e);
    }

    const nonWeak = filterWeakSources(results);
    const best = pickBestSources(nonWeak, 3);

    const sourcesText = best
      .map((s) => `${s.title}\n${s.snippet}`)
      .join("\n\n");

    const prompt = `
Sos un asistente que genera fichas DATA breves, claras y confiables.
Actúa como un analista de datos especializado. Investiga y extrae únicamente la información vigente y cargos actuales.
Devolvé SOLO JSON válido.

Objetivo:
Crear una ficha corta con datos concretos, actuales y verificables.
No inventes.
No completes campos con suposiciones.

Reglas estrictas:
- Temporalidad: Si se trata de personas, para su cargo, usa solo fuentes publicadas en los últimos 6 meses.
- Exclusión: Ignora cualquier cargo que mencione 'ex', 'anterior', 'pasado' o fechas de finalización (ej. 2019-2023).
- Verificación: Prioriza sitios oficiales (gobierno, prensa reciente o perfiles corporativos actualizados).

Reglas generales:
- Usar solo datos firmes y actuales.
- Priorizar información actual.
- Si un dato no es seguro, OMITIRLO.
- Si se trata de una persona, cargo público, institución, empresa o tema de actualidad, priorizá la información actual.
- Si se trata de una persona, solo especificar el cargo que tiene hoy.
- No inventes datos.
- Priorizá fuentes oficiales y/o medios mas importante.
- Priorizá información actual y pública.
- Evitá biografía innecesaria.
- Evitá datos personales irrelevantes.
- Mejor menos campos que una ficha dudosa.
- No incluir frases genéricas como "figura pública" o "persona conocida".
- No incluir controversias, rumores, vida privada ni información irrelevante.
- Máximo 5 items.
- Cada valor debe ser corto, claro y preciso.

Regla clave:
- Si hoy tiene un cargo, usarlo tal cual.
- No usar cargos del pasado, solo del presente.
- Evitar cargos del pasado, cotejarlos con su actividad actual.
- No reemplazarlo ni modificarlo.
- No inventar cargos.
- Evitá fechas específicas si no son necesarias.

Adaptar según el tipo de entidad, pero SOLO incluir campos claramente verificables:

Si es PERSONA:
- Nombre
- Nacionalidad
- Edad
- Actividad
- Cargo actual (solo el presente, no usar del pasado)
- Partido u organización (si aplica y es claro)

Si es PAÍS o CIUDAD:
- Tipo
- Ubicación
- Capital (si aplica)
- Idioma principal
- Población aproximada (solo si es segura)

Si es EMPRESA o CLUB:
- Tipo
- País de origen
- Actividad principal
- Organización o liga (si aplica)
- Año de fundación (solo si es seguro)

Si es CONCEPTO:
- Definición breve
- Uso o contexto
- Dato clave (solo si es claro)

Reglas específicas para personas políticas:
- Usar SOLO el cargo actual vigente.
- NO usar cargos históricos o pasados.
- Si hay duda sobre el cargo actual, OMITIR ese campo.
- Para figuras ampliamente conocidas, incluir actividad y partido si son claros.

Texto:
"${text}"

Información:
${sourcesText}

Formato obligatorio:
{
  "title": "Ficha de ...",
  "items": [
    { "label": "Nombre", "value": "..." }
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
        { label: "Dato", value: "No se encontró información confiable." }
      ];
    }

    if (!parsed.title) {
      parsed.title = `Ficha de ${text}`;
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
      De: "Deutsch"
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

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: "Falta texto para definición."
      });
    }

    const prompt = `
Dá el significado del siguiente término o expresión en español.

Reglas:
- Si es una sola palabra, incluí:
  1) categoría gramatical
  2) significado breve
  3) sinónimos si corresponde
  4) antónimos si corresponde
- Si no aplica, no fuerces secciones.
- Respuesta breve, ordenada y clara.
- No inventes datos raros.

Texto:
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

app.listen(PORT, () => {
  console.log(`TrueCheck server running on http://localhost:${PORT}`);
});