# Mini Cook — publicação

## Render
Build: `npm install`
Start: `npm start`
Plano: Free

Variáveis básicas:
- NODE_ENV = production
- JWT_SECRET = uma chave forte
- APP_URL = URL do serviço Render
- DATABASE_URL = Session pooler do Supabase
- OPENROUTER_API_KEY = sua chave
- OPENROUTER_MODEL = openrouter/free
- OPENROUTER_VISION_MODEL = modelo de visão disponível
- PREMIUM_CODE = seu código secreto

## Stripe
1. Crie um produto no Stripe.
2. Crie três preços recorrentes: R$ 19,90/mês; R$ 49,90/3 meses; R$ 149,90/ano.
3. Copie os IDs `price_...` para os campos `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_QUARTERLY` e `STRIPE_PRICE_YEARLY`.
4. Coloque a chave secreta em `STRIPE_SECRET_KEY`.
5. Crie um endpoint de webhook em `https://SEU-APP.onrender.com/api/stripe/webhook`.
6. Assine os eventos `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` e `customer.subscription.deleted`.
7. Copie o segredo `whsec_...` para `STRIPE_WEBHOOK_SECRET`.

Nunca coloque chaves secretas no código do site ou em mensagens públicas.
