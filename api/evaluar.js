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

const MAX_RETRIES = 4;
const INITIAL_DELAY_MS = 15000; // 15s — enough to let the rate limit window reset

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callClaudeWithRetry(apiKey, fileBase64, fileMediaType) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 15s, 30s, 60s, 60s
      const delay = Math.min(INITIAL_DELAY_MS * Math.pow(2, attempt - 1), 60000);
      console.log(`Retry ${attempt}/${MAX_RETRIES} after ${delay / 1000}s...`);
      await sleep(delay);
    }

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: fileMediaType || 'application/pdf', data: fileBase64 },
              },
              { type: 'text', text: 'Evalua este documento. Responde SOLO con JSON valido.' },
            ],
          }],
        }),
      });

      // Rate limit — retry
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        lastError = new Error(`Rate limit (intento ${attempt + 1}/${MAX_RETRIES + 1})`);
        if (retryAfter && attempt < MAX_RETRIES) {
          await sleep(parseInt(retryAfter, 10) * 1000);
          continue;
        }
        continue;
      }

      // Overloaded — retry
      if (response.status === 529) {
        lastError = new Error(`API sobrecargada (intento ${attempt + 1}/${MAX_RETRIES + 1})`);
        continue;
      }

      if (!response.ok) {
        const err = await response.text();
        throw new Error(err);
      }

      const data = await response.json();
      const text = (data.content?.[0]?.text || '').trim();

      // Parse JSON
      let jsonStr = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
      const start = jsonStr.indexOf('{');
      const end = jsonStr.lastIndexOf('}');
      if (start === -1 || end === -1) {
        lastError = new Error('Respuesta sin JSON');
        continue; // retry — model might give valid JSON on next attempt
      }
      jsonStr = jsonStr.substring(start, end + 1);

      const parsed = JSON.parse(jsonStr); // throws if invalid
      parsed._retries = attempt;
      return parsed;

    } catch (err) {
      lastError = err;
      // JSON parse errors — worth retrying
      if (err instanceof SyntaxError && attempt < MAX_RETRIES) continue;
      // Other errors — don't retry
      if (!(err.message || '').includes('Rate limit') &&
          !(err.message || '').includes('sobrecargada') &&
          !(err.message || '').includes('JSON') &&
          !(err instanceof SyntaxError)) {
        throw err;
      }
    }
  }

  throw lastError || new Error('Max retries exceeded');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const { fileBase64, fileMediaType } = req.body || {};
    if (!fileBase64) return res.status(400).json({ error: 'No se ha proporcionado un archivo' });

    const result = await callClaudeWithRetry(apiKey, fileBase64, fileMediaType);

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
