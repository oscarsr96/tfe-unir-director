export const config = { maxDuration: 120 };

const SYSTEM_PROMPT = `Eres un evaluador experto de TFEs del Master en IA de la UNIR. Evalua la Entrega 1 (borrador inicial).

Contenido esperado: analisis del contexto, estado del arte inicial, objetivos claros.
Evalua: Estilo (formato, redaccion), Alcance (tema justificado), Marco Teorico (inicio del estado del arte), y formulacion de objetivos.
NO penalizar la falta de: conclusiones, desarrollo de la contribucion, extension insuficiente.

IMPORTANTE: Responde UNICAMENTE con JSON valido (sin markdown, sin backticks, sin texto antes ni despues):

{"nota":7.5,"dictamen":"APTO","resumen":"Resumen de 2-3 frases.","secciones":[{"nombre":"Estilo y formato","nota":7.0,"positivos":["Punto 1"],"mejoras":[{"texto":"Mejora 1","ref":"Rubrica > Indicador 1: Estilo y formato academico"}],"urgente":[]},{"nombre":"Alcance y justificacion","nota":8.0,"positivos":[],"mejoras":[],"urgente":[]},{"nombre":"Marco Teorico","nota":7.0,"positivos":[],"mejoras":[],"urgente":[]},{"nombre":"Objetivos","nota":6.5,"positivos":[],"mejoras":[],"urgente":[]}],"checklist":[{"criterio":"Analisis del contexto","cumple":true,"comentario":""},{"criterio":"Estado del arte con bibliografia","cumple":true,"comentario":""},{"criterio":"Objetivos claros y medibles","cumple":false,"comentario":"No usan verbos en infinitivo"},{"criterio":"Redaccion academica","cumple":true,"comentario":""},{"criterio":"Formato APA en citas","cumple":false,"comentario":""},{"criterio":"Introduccion con motivacion","cumple":true,"comentario":""}],"prioridades":[{"texto":"Prioridad 1","ref":"Guia > Seccion 4.4: Entrega 2"},{"texto":"Prioridad 2","ref":"Rubrica > Indicador 6"}],"alertas":["Alerta 1"]}

Referencias (ref) deben apuntar al documento concreto:
- "Rubrica > Indicador X: [nombre]"
- "Instrucciones > Seccion X.X: [nombre]"
- "Guia > Seccion X.X: [nombre]"
- "Reglamento > Articulo X: [nombre]"

La nota global = media de las 4 secciones. Se riguroso. Cita paginas concretas.`;

const MAX_RETRIES = 5;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callClaudeWithRetry(apiKey, payload) {
  let lastError;

  const userContent = payload.fileText
    ? [
        {
          type: "text",
          text:
            "Evalua el siguiente documento (transcripcion de un Word entregado por el estudiante). Responde SOLO con JSON valido.\n\n---\n\n" +
            payload.fileText,
        },
      ]
    : [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: payload.fileMediaType || "application/pdf",
            data: payload.fileBase64,
          },
        },
        {
          type: "text",
          text: "Evalua este documento. Responde SOLO con JSON valido.",
        },
      ];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userContent }],
        }),
      });

      // Rate limit or overloaded — wait for the exact reset time from headers
      if (response.status === 429 || response.status === 529) {
        if (attempt >= MAX_RETRIES) {
          const body = await response.text();
          throw new Error(
            `Rate limit tras ${MAX_RETRIES + 1} intentos. Espera 1 minuto y reintenta.`,
          );
        }

        // Calculate wait time from headers
        let waitMs = 10000; // default 10s
        const retryAfter = response.headers.get("retry-after");
        const resetTime = response.headers.get(
          "anthropic-ratelimit-input-tokens-reset",
        );

        if (retryAfter) {
          waitMs = parseInt(retryAfter, 10) * 1000;
        } else if (resetTime) {
          const resetDate = new Date(resetTime);
          waitMs = Math.max(resetDate.getTime() - Date.now() + 1000, 2000); // +1s buffer
        }

        // Cap wait to avoid function timeout (max 60s per wait)
        waitMs = Math.min(waitMs, 60000);

        console.log(
          `Attempt ${attempt + 1}: rate limited, waiting ${Math.round(waitMs / 1000)}s until reset`,
        );
        lastError = new Error(`Rate limit (intento ${attempt + 1})`);
        await sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        const err = await response.text();
        throw new Error(err);
      }

      const data = await response.json();
      const text = (data.content?.[0]?.text || "").trim();

      // Parse JSON
      let jsonStr = text
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "");
      const start = jsonStr.indexOf("{");
      const end = jsonStr.lastIndexOf("}");
      if (start === -1 || end === -1) {
        if (attempt < MAX_RETRIES) {
          lastError = new Error("Respuesta sin JSON");
          continue;
        }
        throw new Error("La IA no devolvio JSON. Intentalo de nuevo.");
      }
      jsonStr = jsonStr.substring(start, end + 1);

      const parsed = JSON.parse(jsonStr);
      parsed._retries = attempt;
      return parsed;
    } catch (err) {
      lastError = err;
      if (err instanceof SyntaxError && attempt < MAX_RETRIES) continue;
      if (
        !(err.message || "").includes("Rate limit") &&
        !(err.message || "").includes("intento") &&
        !(err instanceof SyntaxError)
      ) {
        throw err;
      }
    }
  }

  throw lastError || new Error("Max retries. Espera 1 minuto y reintenta.");
}

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key not configured" });

  try {
    const { fileBase64, fileMediaType, fileText } = req.body || {};
    if (!fileBase64 && !fileText)
      return res
        .status(400)
        .json({ error: "No se ha proporcionado un archivo" });

    const result = await callClaudeWithRetry(apiKey, {
      fileBase64,
      fileMediaType,
      fileText,
    });

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
