const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/oracle", async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada no servidor." });
  }
  const { system, messages } = req.body || {};
  if (!system || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Requisição inválida." });
  }
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1500,
        system,
        messages: messages.map((m) => ({ role: m.role, content: String(m.content) })),
      }),
    });
    const data = await r.json();
    if (data.error) {
      return res.status(502).json({ error: data.error.message || "Erro na API da Anthropic." });
    }
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    res.json({ text });
  } catch (e) {
    res.status(502).json({ error: "Falha ao consultar o Oráculo." });
  }
});

app.listen(PORT, () => console.log(`O Oráculo ativo na porta ${PORT}`));
