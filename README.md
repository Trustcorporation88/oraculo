# O Oráculo

Mentor de aprendizado acelerado com IA. Diagnóstico, revelação do conhecimento oculto, plano 80/20, método socrático e teste em 3 níveis.

## Rodar localmente

```
npm install
ANTHROPIC_API_KEY=sua-chave npm start
```

Abra http://localhost:3000

## Banco de dados (opcional, recomendado)

No Railway: New → Database → PostgreSQL dentro do mesmo projeto. Depois, no serviço do app, adicione a variável DATABASE_URL como referência: ${{Postgres.DATABASE_URL}}. As tabelas são criadas sozinhas no primeiro boot. Sem banco, o app funciona em modo navegador (localStorage).

## Deploy no Railway

1. Suba este projeto para um repositório no GitHub
2. No Railway: New Project → Deploy from GitHub repo
3. Em Variables, adicione: ANTHROPIC_API_KEY = sua chave da Anthropic
4. Em Settings → Networking, clique em Generate Domain

A chave fica só no servidor — nunca é exposta no navegador.
