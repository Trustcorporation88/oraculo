const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-5";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function guard(req, res) {
  if (!API_KEY) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada no servidor." });
    return false;
  }
  const { system, messages } = req.body || {};
  if (!system || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "Requisição inválida." });
    return false;
  }
  return true;
}

const anthropicBody = (req, stream) =>
  JSON.stringify({
    model: MODEL,
    max_tokens: 2000,
    stream,
    system: req.body.system,
    messages: req.body.messages.map((m) => ({ role: m.role, content: String(m.content) })),
  });

const anthropicHeaders = {
  "Content-Type": "application/json",
  "x-api-key": API_KEY,
  "anthropic-version": "2023-06-01",
};

// Resposta em streaming (SSE) — o texto chega em tempo real no navegador
app.post("/api/oracle/stream", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: anthropicHeaders,
      body: anthropicBody(req, true),
    });

    if (!upstream.ok || !upstream.body) {
      const err = await upstream.json().catch(() => ({}));
      return res.status(502).json({ error: err.error?.message || "Erro na API da Anthropic." });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const ev = JSON.parse(payload);
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            res.write(`data: ${JSON.stringify({ t: ev.delta.text })}\n\n`);
          }
          if (ev.type === "error") {
            res.write(`data: ${JSON.stringify({ error: ev.error?.message || "erro" })}\n\n`);
          }
        } catch {}
      }
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch {
    if (!res.headersSent) res.status(502).json({ error: "Falha ao consultar o Oráculo." });
    else res.end();
  }
});

// Fallback sem streaming
app.post("/api/oracle", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: anthropicHeaders,
      body: anthropicBody(req, false),
    });
    const data = await r.json();
    if (data.error) return res.status(502).json({ error: data.error.message });
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    res.json({ text });
  } catch {
    res.status(502).json({ error: "Falha ao consultar o Oráculo." });
  }
});

// Gera flashcards em JSON a partir da conversa
app.post("/api/flashcards", async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada." });
  const { tema, excerpt } = req.body || {};
  if (!tema || !excerpt) return res.status(400).json({ error: "Requisição inválida." });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: anthropicHeaders,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        system:
          "Você gera flashcards de estudo. Responda APENAS com um array JSON válido, sem markdown, sem comentários, sem texto antes ou depois. Formato: [{\"q\":\"pergunta\",\"a\":\"resposta\"}]. Perguntas que testam aplicação e compreensão, não decoreba. Respostas com no máximo 3 frases. Em português brasileiro.",
        messages: [
          {
            role: "user",
            content: `Tema: ${tema}\n\nTrecho da sessão de estudo:\n${String(excerpt).slice(0, 6000)}\n\nGere de 5 a 8 flashcards sobre os conceitos mais importantes desse trecho.`,
          },
        ],
      }),
    });
    const data = await r.json();
    if (data.error) return res.status(502).json({ error: data.error.message });
    const raw = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .replace(/```json|```/g, "")
      .trim();
    const cards = JSON.parse(raw);
    if (!Array.isArray(cards)) throw new Error("formato");
    res.json({ cards: cards.filter((c) => c.q && c.a).slice(0, 10) });
  } catch {
    res.status(502).json({ error: "Não foi possível gerar os flashcards. Tente novamente." });
  }
});

app.listen(PORT, () => console.log(`O Oráculo v2 ativo na porta ${PORT}`));
