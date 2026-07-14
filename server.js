const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-5";

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ================= BANCO DE DADOS (Postgres do Railway) ================= */
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("railway.internal") ? false : { rejectUnauthorized: false },
  });
  (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          ctx JSONB NOT NULL,
          messages JSONB NOT NULL DEFAULT '[]',
          duel_best INTEGER DEFAULT 0,
          created_at BIGINT,
          updated_at BIGINT
        );
        CREATE TABLE IF NOT EXISTS cards (
          id TEXT PRIMARY KEY,
          session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
          q TEXT NOT NULL,
          a TEXT NOT NULL,
          due BIGINT,
          ivl INTEGER DEFAULT 0,
          ease REAL DEFAULT 2.5,
          reps INTEGER DEFAULT 0
        );
      `);
      console.log("Postgres conectado — memória eterna ativa.");
    } catch (e) {
      console.error("Falha ao preparar o Postgres:", e.message);
      pool = null;
    }
  })();
}

app.get("/api/health", (req, res) => res.json({ db: !!pool, ai: !!API_KEY }));

const dbGuard = (res) => {
  if (!pool) {
    res.status(503).json({ error: "Banco de dados não configurado." });
    return false;
  }
  return true;
};

/* -------- Sessões -------- */
app.get("/api/sessions", async (req, res) => {
  if (!dbGuard(res)) return;
  try {
    const r = await pool.query(
      "SELECT id, ctx, duel_best, updated_at, jsonb_array_length(messages) AS msg_count FROM sessions ORDER BY updated_at DESC"
    );
    res.json({ sessions: r.rows });
  } catch { res.status(500).json({ error: "Erro ao listar sessões." }); }
});

app.get("/api/sessions/:id", async (req, res) => {
  if (!dbGuard(res)) return;
  try {
    const r = await pool.query("SELECT * FROM sessions WHERE id = $1", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Sessão não encontrada." });
    res.json({ session: r.rows[0] });
  } catch { res.status(500).json({ error: "Erro ao carregar sessão." }); }
});

app.post("/api/sessions", async (req, res) => {
  if (!dbGuard(res)) return;
  const { id, ctx, messages, duel_best, created_at, updated_at } = req.body || {};
  if (!id || !ctx) return res.status(400).json({ error: "Sessão inválida." });
  try {
    await pool.query(
      `INSERT INTO sessions (id, ctx, messages, duel_best, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET ctx = $2, messages = $3, duel_best = GREATEST(sessions.duel_best, $4), updated_at = $6`,
      [id, JSON.stringify(ctx), JSON.stringify(messages || []), duel_best || 0, created_at || Date.now(), updated_at || Date.now()]
    );
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Erro ao salvar sessão." }); }
});

app.delete("/api/sessions/:id", async (req, res) => {
  if (!dbGuard(res)) return;
  try {
    await pool.query("DELETE FROM sessions WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Erro ao apagar sessão." }); }
});

/* -------- Flashcards -------- */
app.get("/api/cards", async (req, res) => {
  if (!dbGuard(res)) return;
  try {
    const r = req.query.due
      ? await pool.query("SELECT * FROM cards WHERE due <= $1 ORDER BY due ASC", [Date.now()])
      : await pool.query("SELECT * FROM cards");
    res.json({ cards: r.rows });
  } catch { res.status(500).json({ error: "Erro ao listar cartões." }); }
});

app.post("/api/cards", async (req, res) => {
  if (!dbGuard(res)) return;
  const { cards } = req.body || {};
  if (!Array.isArray(cards) || !cards.length) return res.status(400).json({ error: "Cartões inválidos." });
  try {
    for (const c of cards) {
      await pool.query(
        `INSERT INTO cards (id, session_id, q, a, due, ivl, ease, reps) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [c.id, c.sessionId, c.q, c.a, c.due, c.ivl || 0, c.ease || 2.5, c.reps || 0]
      );
    }
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Erro ao salvar cartões." }); }
});

app.put("/api/cards/:id", async (req, res) => {
  if (!dbGuard(res)) return;
  const { due, ivl, ease, reps } = req.body || {};
  try {
    await pool.query("UPDATE cards SET due = $2, ivl = $3, ease = $4, reps = $5 WHERE id = $1", [
      req.params.id, due, ivl, ease, reps,
    ]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Erro ao atualizar cartão." }); }
});

/* ================= IA ================= */
function aiGuard(req, res, needMessages = true) {
  if (!API_KEY) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada no servidor." });
    return false;
  }
  if (needMessages) {
    const { system, messages } = req.body || {};
    if (!system || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "Requisição inválida." });
      return false;
    }
  }
  return true;
}

const anthropicHeaders = () => ({
  "Content-Type": "application/json",
  "x-api-key": API_KEY,
  "anthropic-version": "2023-06-01",
});

async function askModel({ system, messages, max_tokens = 1500 }) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify({ model: MODEL, max_tokens, system, messages }),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || "Erro na API.");
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

const parseJson = (raw) => JSON.parse(raw.replace(/```json|```/g, "").trim());

// Streaming SSE
app.post("/api/oracle/stream", async (req, res) => {
  if (!aiGuard(req, res)) return;
  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        stream: true,
        system: req.body.system,
        messages: req.body.messages.map((m) => ({ role: m.role, content: String(m.content) })),
      }),
    });
    if (!upstream.ok || !upstream.body) {
      const err = await upstream.json().catch(() => ({}));
      return res.status(502).json({ error: err.error?.message || "Erro na API da Anthropic." });
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
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
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta")
            res.write(`data: ${JSON.stringify({ t: ev.delta.text })}\n\n`);
          if (ev.type === "error")
            res.write(`data: ${JSON.stringify({ error: ev.error?.message || "erro" })}\n\n`);
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

// Flashcards
app.post("/api/flashcards", async (req, res) => {
  if (!aiGuard(req, res, false)) return;
  const { tema, excerpt } = req.body || {};
  if (!tema || !excerpt) return res.status(400).json({ error: "Requisição inválida." });
  try {
    const raw = await askModel({
      system:
        'Você gera flashcards de estudo. Responda APENAS com um array JSON válido, sem markdown, sem texto antes ou depois. Formato: [{"q":"pergunta","a":"resposta"}]. Perguntas que testam aplicação e compreensão, não decoreba. Respostas com no máximo 3 frases. Português brasileiro.',
      messages: [{ role: "user", content: `Tema: ${tema}\n\nTrecho da sessão:\n${String(excerpt).slice(0, 6000)}\n\nGere de 5 a 8 flashcards sobre os conceitos mais importantes.` }],
    });
    const cards = parseJson(raw);
    if (!Array.isArray(cards)) throw new Error("formato");
    res.json({ cards: cards.filter((c) => c.q && c.a).slice(0, 10) });
  } catch { res.status(502).json({ error: "Não foi possível gerar os flashcards." }); }
});

// Modo Duelo — 5 perguntas de múltipla escolha
app.post("/api/duel", async (req, res) => {
  if (!aiGuard(req, res, false)) return;
  const { tema, excerpt, nivel } = req.body || {};
  if (!tema) return res.status(400).json({ error: "Requisição inválida." });
  try {
    const raw = await askModel({
      max_tokens: 2000,
      system:
        'Você é O Oráculo criando um duelo de conhecimento. Responda APENAS com um array JSON válido, sem markdown, sem texto antes ou depois. Formato: [{"q":"pergunta","options":["opção A","opção B","opção C","opção D"],"correct":0,"why":"explicação curta de por que essa é a resposta"}]. Exatamente 5 perguntas de múltipla escolha sobre situações REAIS e aplicação prática — nada de decoreba de definição. As 4 opções devem ser plausíveis; as erradas representam erros que iniciantes realmente cometem. "correct" é o índice (0 a 3) da resposta certa, variando a posição entre as perguntas. Dificuldade crescente: 2 fáceis, 2 médias, 1 difícil. Português brasileiro.',
      messages: [
        {
          role: "user",
          content: `Tema: ${tema}\nNível do jogador: ${nivel || "Iniciante"}\n${excerpt ? `Baseie-se também neste trecho da sessão de estudo:\n${String(excerpt).slice(0, 4000)}` : "Sem sessão de estudo — use as situações mais comuns do tema."}\n\nGere as 5 perguntas do duelo.`,
        },
      ],
    });
    const qs = parseJson(raw);
    if (!Array.isArray(qs) || qs.length < 3) throw new Error("formato");
    res.json({
      questions: qs
        .filter((x) => x.q && Array.isArray(x.options) && x.options.length === 4 && x.correct >= 0 && x.correct <= 3)
        .slice(0, 5),
    });
  } catch { res.status(502).json({ error: "Não foi possível preparar o duelo." }); }
});

app.listen(PORT, () => console.log(`O Oráculo v3 ativo na porta ${PORT}${pool ? " (com Postgres)" : " (sem banco — modo navegador)"}`));
