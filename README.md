# Mini Cook PRO

Aplicativo web full-stack com:
- Mini Cook IA
- análise de fotos de alimentos (OpenRouter Vision)
- estimativa de calorias e macros com faixa de incerteza
- 12.000+ receitas catalogadas
- busca de receitas
- chat com histórico recente
- dicas de treino semanal
- planos mensal, trimestral e anual
- integração Stripe preparada
- limite grátis de 5 mensagens/análises por dia
- pronto para Render

## Variáveis
Veja `.env.example`.

IMPORTANTE: a chave OpenRouter e as chaves Stripe devem ficar somente no servidor/Render, nunca no frontend.

## Rodar
npm install
npm start

Abra http://localhost:3000

## Observações
As estimativas nutricionais por foto são aproximadas. O app não deve ser usado como diagnóstico ou substituto de nutricionista, médico ou educador físico.
