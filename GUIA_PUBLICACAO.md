# Mini Cook PRO — publicação e pagamentos

## O que já está pronto no código
- contas e login
- limite grátis de 5 usos/dia
- 12.000 receitas
- busca e detalhes de receitas
- favoritos
- perfil e metas
- lista de compras
- histórico de análises
- Mini Cook chat
- Mini Cook Vision
- planos mensal/trimestral/anual
- Stripe Checkout + webhook + portal
- sincronização de assinatura pelo servidor

## O que somente o dono da conta precisa fazer
Não é possível que o código crie contas externas ou receba dinheiro sem que o proprietário faça a verificação/aceitação dos termos.

### Stripe
1. Criar/verificar a conta Stripe.
2. Criar 3 produtos/preços recorrentes:
   - monthly
   - quarterly
   - yearly
3. Copiar os `price_...` para:
   - STRIPE_PRICE_MONTHLY
   - STRIPE_PRICE_QUARTERLY
   - STRIPE_PRICE_YEARLY
4. Copiar a chave secreta para STRIPE_SECRET_KEY.
5. Criar um endpoint de webhook apontando para:
   https://SEU-ENDERECO.onrender.com/api/stripe/webhook
6. Ativar os eventos:
   - checkout.session.completed
   - customer.subscription.created
   - customer.subscription.updated
   - customer.subscription.deleted
7. Colocar o signing secret `whsec_...` em STRIPE_WEBHOOK_SECRET.

O webhook é obrigatório para o servidor conceder/remover Premium com segurança.

### Banco
Para produção, defina DATABASE_URL de um PostgreSQL gerenciado. Sem isso, o modo local usa memória e não é apropriado para produção.

### Android
Para assinaturas de conteúdo digital vendidas dentro do app Android publicado no Google Play, implemente Google Play Billing e valide as compras no servidor. Não use uma chave Stripe do navegador para desbloquear o Premium.
